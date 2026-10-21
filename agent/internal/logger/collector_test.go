package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCollectorNoReplay(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "frp-logger-test-*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	clientID := "test-client-1"
	c := NewCollector(tempDir, clientID)
	c.SetFlushInterval(50 * time.Millisecond)

	if err := c.Start(); err != nil {
		t.Fatalf("启动 Collector 失败: %v", err)
	}
	defer c.Stop()

	// 添加 3 条日志
	c.AddLine("line 1: 启动完成")
	c.AddLine("line 2: 握手成功")
	c.AddLine("line 3: 隧道就绪")

	// 手动触发落盘
	c.Flush()

	today := time.Now().Format("2006-01-02")
	lines, err := c.ReadLogFile(today)
	if err != nil {
		t.Fatalf("读取日志文件失败: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("期望 3 行日志，实际读取到 %d 行: %v", len(lines), lines)
	}

	// 再次触发多次 Flush，在没有新日志写入时，绝不能重复回放历史旧缓冲！
	c.Flush()
	c.Flush()
	time.Sleep(120 * time.Millisecond) // 等待后台 ticker 至少触发两次

	linesAfterEmptyFlush, err := c.ReadLogFile(today)
	if err != nil {
		t.Fatalf("读取日志文件失败: %v", err)
	}
	if len(linesAfterEmptyFlush) != 3 {
		t.Fatalf("存在日志回放缺陷！期望仍然为 3 行，实际膨胀到了 %d 行: %v", len(linesAfterEmptyFlush), linesAfterEmptyFlush)
	}

	// 此时 GetRecentLogs 仍然应该完整保留 3 行
	recent := c.GetRecentLogs(10)
	if len(recent) != 3 {
		t.Fatalf("GetRecentLogs 期望 3 条，实际 %d 条", len(recent))
	}

	// 新增 1 条新日志
	c.AddLine("line 4: 新事件")
	c.Flush()

	linesAfterNew, err := c.ReadLogFile(today)
	if err != nil {
		t.Fatalf("读取日志失败: %v", err)
	}
	if len(linesAfterNew) != 4 {
		t.Fatalf("期望 4 行日志，实际读取到 %d 行", len(linesAfterNew))
	}
	if linesAfterNew[3] != "line 4: 新事件" {
		t.Fatalf("期望第 4 行为 'line 4: 新事件'，实际为 '%s'", linesAfterNew[3])
	}
}

func TestCollectorRecentLogsRingBuffer(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "frp-logger-ring-*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	c := NewCollector(tempDir, "ring-client")
	c.maxBuffer = 5 // 设置缓冲区上限为 5

	for i := 1; i <= 10; i++ {
		c.AddLine(fmt.Sprintf("log-%d", i))
	}

	recent := c.GetRecentLogs(10)
	if len(recent) != 5 {
		t.Fatalf("期望内存保留 5 条，实际 %d 条", len(recent))
	}
	if recent[0] != "log-6" || recent[4] != "log-10" {
		t.Fatalf("环形缓冲区内容不符合预期: %v", recent)
	}

	subset := c.GetRecentLogs(2)
	if len(subset) != 2 || subset[0] != "log-9" || subset[1] != "log-10" {
		t.Fatalf("截取最近 2 条不符合预期: %v", subset)
	}
}

func TestCollectorSizeBasedRotation(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "frp-logger-rot-*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	clientID := "rot-client"
	c := NewCollector(tempDir, clientID)
	// 设置极小的文件大小上限以触发切分（120 字节），保留 2 份备份
	c.SetMaxFileSize(120)
	c.SetMaxBackups(2)

	if err := c.Start(); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	defer c.Stop()

	// 写入若干较长的日志行以触发多次轮转
	for i := 1; i <= 15; i++ {
		c.AddLine(fmt.Sprintf("event-%02d: this is a long log message to exceed max file size limit quickly", i))
		c.Flush()
	}

	today := time.Now().Format("2006-01-02")
	baseFile := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.log", clientID, today))
	backup1 := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.1.log", clientID, today))
	backup2 := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.2.log", clientID, today))
	backup3 := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.3.log", clientID, today))

	if _, err := os.Stat(baseFile); err != nil {
		t.Fatalf("当前活跃日志文件未生成: %v", err)
	}
	if _, err := os.Stat(backup1); err != nil {
		t.Fatalf("备份分卷 .1.log 未生成: %v", err)
	}
	if _, err := os.Stat(backup2); err != nil {
		t.Fatalf("备份分卷 .2.log 未生成: %v", err)
	}
	// backup3 不应存在，因为只保留 2 份备份
	if _, err := os.Stat(backup3); !os.IsNotExist(err) {
		t.Fatalf("备份分卷 .3.log 应当被轮转淘汰，但仍存在")
	}

	// ReadLogFile 应能按序无损读出保留的所有分卷日志
	allLines, err := c.ReadLogFile(today)
	if err != nil {
		t.Fatalf("读取合并日志失败: %v", err)
	}
	if len(allLines) == 0 {
		t.Fatalf("合并日志为空")
	}

	// 检查读取到的日志顺序是否由旧到新
	var lastNum int
	for _, l := range allLines {
		if strings.HasPrefix(l, "event-") {
			var num int
			_, _ = fmt.Sscanf(l, "event-%d:", &num)
			if num < lastNum {
				t.Fatalf("日志读取时间序混乱: 上一条 %d, 当前条 %d", lastNum, num)
			}
			lastNum = num
		}
	}
}

func TestCollectorCleanOldLogs(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "frp-logger-clean-*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	clientID := "clean-client"

	// 预先创建 10 天前、3 天前的假日志文件
	oldDate := time.Now().Add(-10 * 24 * time.Hour).Format("2006-01-02")
	recentDate := time.Now().Add(-3 * 24 * time.Hour).Format("2006-01-02")

	oldFile := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.log", clientID, oldDate))
	recentFile := filepath.Join(tempDir, fmt.Sprintf("frpc-%s-%s.log", clientID, recentDate))

	_ = os.WriteFile(oldFile, []byte("old log content\n"), 0600)
	_ = os.WriteFile(recentFile, []byte("recent log content\n"), 0600)

	c := NewCollector(tempDir, clientID)
	c.retention = 7 * 24 * time.Hour // 保留 7 天

	if err := c.Start(); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	defer c.Stop()

	// 10 天前的文件应被清除
	if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
		t.Fatalf("过期 10 天的文件未被清除: %s", oldFile)
	}
	// 3 天前的文件应仍存在
	if _, err := os.Stat(recentFile); err != nil {
		t.Fatalf("未过期的文件被误删: %s", recentFile)
	}
}

func TestCollectorStopFlushesPending(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "frp-logger-stop-*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	clientID := "stop-client"
	c := NewCollector(tempDir, clientID)

	if err := c.Start(); err != nil {
		t.Fatalf("启动失败: %v", err)
	}

	c.AddLine("pending message before stop")
	// 不手动 Flush，直接 Stop
	c.Stop()

	today := time.Now().Format("2006-01-02")
	lines, err := c.ReadLogFile(today)
	if err != nil {
		t.Fatalf("读取日志失败: %v", err)
	}
	if len(lines) != 1 || lines[0] != "pending message before stop" {
		t.Fatalf("Stop 未能完全落盘待写日志: %v", lines)
	}
}
