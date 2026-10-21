//go:build !windows

package reaper

import (
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

var (
	mu     sync.Mutex
	paused bool
)

// Start 启动后台孤儿僵尸进程回收器。
// 当且仅当当前进程作为 PID 1 运行（例如在没有 --init 或 tini 的容器中）时生效。
func Start() {
	if os.Getpid() != 1 {
		return
	}

	sigCh := make(chan os.Signal, 64)
	signal.Notify(sigCh, syscall.SIGCHLD)

	log.Printf("[Reaper] frp-agent 作为 PID 1 运行，已激活孤儿僵尸进程回收器")

	go func() {
		for range sigCh {
			Reap()
		}
	}()
}

// Pause 临时暂停回收，供内部执行 exec.Command（如容器升级事务）时避免 wait 竞态
func Pause() {
	mu.Lock()
	defer mu.Unlock()
	paused = true
}

// Resume 恢复回收并立即执行一次僵尸进程清理
func Resume() {
	mu.Lock()
	defer mu.Unlock()
	paused = false
	reapLocked()
}

// Reap 回收所有已退出的孤儿僵尸进程
func Reap() {
	mu.Lock()
	defer mu.Unlock()
	reapLocked()
}

func reapLocked() {
	if paused {
		return
	}

	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			break
		}
	}
}
