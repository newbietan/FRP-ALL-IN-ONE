// Package upgrade bridges authenticated management requests to the shared,
// independently running Docker transaction helper. It never executes shell text.
package upgrade

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

const RuntimePath = "/usr/local/lib/frp/container_upgrade.py"
const HealthPath = "/tmp/frp-agent-health.json"
const registry = "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:"

var versionPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+$`)
var jobPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Request struct {
	JobID         string `json:"job_id"`
	TargetVersion string `json:"target_version"`
	Image         string `json:"image"`
}

func Validate(request Request) error {
	if !jobPattern.MatchString(request.JobID) || !versionPattern.MatchString(request.TargetVersion) {
		return fmt.Errorf("invalid upgrade job or version")
	}
	if request.Image != registry+"v"+strings.TrimPrefix(request.TargetVersion, "v") {
		return fmt.Errorf("upgrade image does not match the approved versioned repository")
	}
	return nil
}

func SocketPath() string {
	const path = "/var/run/docker.sock"
	if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
		return path
	}
	return ""
}

func Capable() bool {
	_, runtimeErr := os.Stat(RuntimePath)
	_, pythonErr := exec.LookPath("python3")
	return runtimeErr == nil && pythonErr == nil && SocketPath() != ""
}

type Runner struct {
	Directory string
	ClientID  string
	Version   string
	Ready     func() bool
	Send      func(map[string]interface{}) error
	active    atomic.Bool
}

func (r *Runner) statusPath() string { return filepath.Join(r.Directory, "upgrade", "agent.json") }

func (r *Runner) emit(request Request, status, message string) {
	if err := r.Send(map[string]interface{}{
		"job_id": request.JobID, "target_version": request.TargetVersion,
		"status": status, "message": message, "version": r.Version, "ready": r.Ready(),
	}); err != nil {
		log.Printf("[Upgrade] status will be retried from durable state: %v", err)
	}
}

func (r *Runner) Handle(data interface{}) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return
	}
	var request Request
	if err := json.Unmarshal(encoded, &request); err != nil || Validate(request) != nil {
		log.Print("[Upgrade] rejected malformed or unapproved upgrade request")
		return
	}
	if !Capable() {
		r.emit(request, "unsupported", "未挂载引擎 Socket 或未安装容器升级执行器，请使用宿主机命令")
		return
	}
	if !r.active.CompareAndSwap(false, true) {
		return // Python's durable per-volume lock also protects across processes.
	}
	go func() {
		defer r.active.Store(false)
		r.emit(request, "acknowledged", "客户端已确认请求，准备独立升级事务")
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		container := os.Getenv("FRP_CONTAINER_NAME")
		if container == "" {
			container = "frp-agent"
		}
		command := exec.CommandContext(ctx, "python3", RuntimePath,
			"--container", container, "--role", "agent", "--version", request.TargetVersion,
			"--job-id", request.JobID, "--client-id", r.ClientID,
			"--socket", SocketPath(), "--status", r.statusPath())
		command.Env = append(os.Environ(), "FRP_UPGRADE_DATA_DIR="+r.Directory)
		if err := command.Run(); err != nil {
			if !r.Report(request.JobID) {
				r.emit(request, "failed", "升级准备失败，旧容器未切换；请检查任务锁与容器引擎")
			}
			return
		}
		r.Report(request.JobID)
	}()
}

// Report only public progress fields, never engine inspect/environment details.
// Repeated reports allow reconnects and the new/rolled-back process to reconcile.
func (r *Runner) Report(expectedJob string) bool {
	data, err := os.ReadFile(r.statusPath())
	if err != nil {
		return false
	}
	var state map[string]interface{}
	if json.Unmarshal(data, &state) != nil || state["job_id"] == nil {
		return false
	}
	if expectedJob != "" && state["job_id"] != expectedJob {
		return false
	}
	public := map[string]interface{}{"status": state["step"], "version": r.Version, "ready": r.Ready()}
	for _, key := range []string{"job_id", "target_version", "message", "error"} {
		public[key] = state[key]
	}
	return r.Send(public) == nil
}

func (r *Runner) Monitor(stop <-chan struct{}) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			r.Report("")
		case <-stop:
			return
		}
	}
}

type Health struct {
	Version string `json:"version"`
	Ready   bool   `json:"ready"`
	Time    int64  `json:"time"`
}

func WriteHealth(version string, ready bool) error {
	data, err := json.Marshal(Health{Version: version, Ready: ready, Time: time.Now().Unix()})
	if err != nil {
		return err
	}
	if err := os.WriteFile(HealthPath+".tmp", data, 0o600); err != nil {
		return err
	}
	return os.Rename(HealthPath+".tmp", HealthPath)
}

func CheckHealth(path, expectedVersion string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var health Health
	if err := json.Unmarshal(data, &health); err != nil {
		return err
	}
	if !health.Ready || health.Version != expectedVersion || time.Now().Unix()-health.Time > 10 {
		return fmt.Errorf("agent not ready, stale heartbeat or unexpected version")
	}
	return nil
}
