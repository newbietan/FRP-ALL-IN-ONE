package upgrade

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateOnlyApprovedVersionedImage(t *testing.T) {
	good := Request{JobID: strings.Repeat("a", 32), TargetVersion: "v3.3.0", Image: registry + "v3.3.0"}
	if err := Validate(good); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Request{
		{JobID: good.JobID, TargetVersion: "latest", Image: registry + "latest"},
		{JobID: good.JobID, TargetVersion: "v3.3.0", Image: "attacker/image:v3.3.0"},
		{JobID: "../unsafe", TargetVersion: good.TargetVersion, Image: good.Image},
		{JobID: good.JobID, TargetVersion: "v3.3.0;touch /tmp/x", Image: good.Image},
	} {
		if Validate(bad) == nil {
			t.Fatalf("accepted unsafe request: %+v", bad)
		}
	}
}

func TestHealthRequiresReadyExactVersionAndFreshHeartbeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "health.json")
	write := func(health Health) {
		t.Helper()
		data, _ := json.Marshal(health)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(Health{Version: "3.3.0", Ready: true, Time: time.Now().Unix()})
	if err := CheckHealth(path, "3.3.0"); err != nil {
		t.Fatal(err)
	}
	if CheckHealth(path, "3.2.5") == nil {
		t.Fatal("accepted wrong version")
	}
	write(Health{Version: "3.3.0", Ready: false, Time: time.Now().Unix()})
	if CheckHealth(path, "3.3.0") == nil {
		t.Fatal("accepted unready agent")
	}
	write(Health{Version: "3.3.0", Ready: true, Time: time.Now().Add(-time.Minute).Unix()})
	if CheckHealth(path, "3.3.0") == nil {
		t.Fatal("accepted stale heartbeat")
	}
}

func TestReportFiltersSecretsAndCarriesDurableJob(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "upgrade"), 0o700); err != nil {
		t.Fatal(err)
	}
	data := `{"job_id":"job-a","target_version":"v3.3.0","step":"succeeded","message":"ready","helper_id":"private","Env":["SECRET=secret"]}`
	if err := os.WriteFile(filepath.Join(dir, "upgrade", "agent.json"), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	var received map[string]interface{}
	runner := Runner{Directory: dir, Version: "3.3.0", Ready: func() bool { return true }, Send: func(data map[string]interface{}) error { received = data; return nil }}
	if runner.Report("other-job") {
		t.Fatal("accepted another job")
	}
	if !runner.Report("job-a") {
		t.Fatal("failed report")
	}
	if received["status"] != "succeeded" || received["ready"] != true {
		t.Fatalf("unexpected report: %v", received)
	}
	if _, ok := received["Env"]; ok {
		t.Fatal("leaked environment")
	}
	if _, ok := received["helper_id"]; ok {
		t.Fatal("leaked private metadata")
	}
}
