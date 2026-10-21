package reaper

import (
	"os/exec"
	"testing"
)

func TestReaperPauseResume(t *testing.T) {
	// 验证 Pause 和 Resume 能够正常被调用且不影响直接子进程的正常等待
	Pause()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatalf("cmd.Run() 在 Pause 状态下执行失败: %v", err)
	}
	Resume()

	// 再次调用 Reap 不抛出 panic
	Reap()
}
