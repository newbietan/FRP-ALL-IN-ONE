// Package logger 提供日志采集功能
package logger

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultMaxBuffer   = 1000               // 内存最近日志最大条数
	defaultMaxPending  = 10000              // 等待刷盘的最大日志条数上限，防 OOM
	defaultMaxFileSize = 20 * 1024 * 1024   // 20 MB 单文件上限
	defaultMaxBackups  = 3                  // 每个日期最多保留 3 份历史分卷
	defaultInterval    = 5 * time.Second    // 默认刷盘间隔
	defaultRetention   = 7 * 24 * time.Hour // 历史日志保留 7 天
)

// Collector 日志采集器
type Collector struct {
	logDir   string
	clientID string

	// buffer 保持最近的在内存日志，供 GetRecentLogs 查询（如最近 1000 条）
	buffer    []string
	bufferMu  sync.Mutex
	maxBuffer int

	// pending 存放等待落盘的新增日志，落盘后立即清空，避免重复回放
	pending    []string
	maxPending int

	logFile     *os.File
	fileMu      sync.Mutex
	currentDate string
	currentSize int64

	maxFileSize    int64         // 单个日志文件最大大小（超限自动切分）
	maxBackupFiles int           // 每个日期最多保留的历史分卷数
	flushInterval  time.Duration // 定时刷盘间隔
	retention      time.Duration // 日志保留时长

	stopCh    chan struct{}
	wg        sync.WaitGroup
	isRunning atomic.Bool

	OnLog func(string) // 实时推送回调
}

// NewCollector 创建新的日志采集器
func NewCollector(logDir, clientID string) *Collector {
	return &Collector{
		logDir:         logDir,
		clientID:       clientID,
		maxBuffer:      defaultMaxBuffer,
		maxPending:     defaultMaxPending,
		maxFileSize:    defaultMaxFileSize,
		maxBackupFiles: defaultMaxBackups,
		flushInterval:  defaultInterval,
		retention:      defaultRetention,
	}
}

// SetMaxFileSize 设置单文件大小上限
func (c *Collector) SetMaxFileSize(size int64) {
	c.fileMu.Lock()
	defer c.fileMu.Unlock()
	c.maxFileSize = size
}

// SetMaxBackups 设置每个日期保留的历史分卷数
func (c *Collector) SetMaxBackups(n int) {
	c.fileMu.Lock()
	defer c.fileMu.Unlock()
	c.maxBackupFiles = n
}

// SetFlushInterval 设置定时刷盘间隔
func (c *Collector) SetFlushInterval(d time.Duration) {
	c.flushInterval = d
}

// Start 启动日志采集器
func (c *Collector) Start() error {
	if !c.isRunning.CompareAndSwap(false, true) {
		return nil
	}

	// 确保日志目录存在
	if err := os.MkdirAll(c.logDir, 0700); err != nil {
		c.isRunning.Store(false)
		return fmt.Errorf("创建日志目录失败: %v", err)
	}

	// 创建/打开日志文件
	if err := c.rotateLogFile(); err != nil {
		c.isRunning.Store(false)
		return err
	}

	c.stopCh = make(chan struct{})
	c.wg.Add(1)
	// 启动定时刷新协程
	go c.flushLoop()

	log.Printf("[Logger] 日志采集器已启动，目录: %s", c.logDir)
	return nil
}

// Stop 停止日志采集器
func (c *Collector) Stop() {
	if !c.isRunning.CompareAndSwap(true, false) {
		return
	}

	close(c.stopCh)
	c.wg.Wait()

	// 停止前将剩余待写日志全部落盘
	c.flush()

	c.fileMu.Lock()
	if c.logFile != nil {
		_ = c.logFile.Sync()
		_ = c.logFile.Close()
		c.logFile = nil
	}
	c.fileMu.Unlock()
}

// AddLine 添加一行日志
func (c *Collector) AddLine(line string) {
	c.bufferMu.Lock()
	// 1. 维护内存环形缓冲区供 GetRecentLogs 使用
	if len(c.buffer) >= c.maxBuffer {
		c.buffer = c.buffer[1:]
	}
	c.buffer = append(c.buffer, line)

	// 2. 加入待刷盘切片，有上限保护防止异常情况下内存无限膨胀
	if len(c.pending) < c.maxPending {
		c.pending = append(c.pending, line)
	}
	c.bufferMu.Unlock()

	// 3. 实时推送给服务端
	if c.OnLog != nil {
		c.OnLog(line)
	}
}

// GetRecentLogs 获取最近的在内存日志
func (c *Collector) GetRecentLogs(count int) []string {
	c.bufferMu.Lock()
	defer c.bufferMu.Unlock()

	if count <= 0 {
		return nil
	}
	if count > len(c.buffer) {
		count = len(c.buffer)
	}

	result := make([]string, count)
	copy(result, c.buffer[len(c.buffer)-count:])
	return result
}

// Flush 主动刷新待写日志到文件
func (c *Collector) Flush() {
	c.flush()
}

// flush 刷新新增的待落盘日志到文件，落盘后立即清空 pending，绝不重复回放
func (c *Collector) flush() {
	c.bufferMu.Lock()
	if len(c.pending) == 0 {
		c.bufferMu.Unlock()
		return
	}
	lines := c.pending
	c.pending = nil
	c.bufferMu.Unlock()

	c.fileMu.Lock()
	defer c.fileMu.Unlock()

	if c.logFile == nil {
		// 日志文件尚未打开或已关闭，放回 pending 头部避免丢失
		c.bufferMu.Lock()
		c.pending = append(lines, c.pending...)
		c.bufferMu.Unlock()
		return
	}

	var bytesWritten int64
	for _, line := range lines {
		n, err := c.logFile.WriteString(line + "\n")
		if err == nil {
			bytesWritten += int64(n)
		}
	}
	c.currentSize += bytesWritten
	_ = c.logFile.Sync()

	// 达到单文件上限则触发大小轮转
	if c.maxFileSize > 0 && c.currentSize >= c.maxFileSize {
		_ = c.rotateBySizeLocked()
	}
}

// flushLoop 定时刷新协程
func (c *Collector) flushLoop() {
	defer c.wg.Done()

	ticker := time.NewTicker(c.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.flush()

			// 检查是否跨天需要轮转
			currentDate := time.Now().Format("2006-01-02")
			c.fileMu.Lock()
			dateChanged := currentDate != c.currentDate
			c.fileMu.Unlock()

			if dateChanged {
				_ = c.rotateLogFile()
			}
		}
	}
}

// rotateBySizeLocked 在单文件达到上限时切分文件（调用方必须持有 fileMu）
func (c *Collector) rotateBySizeLocked() error {
	if c.logFile != nil {
		_ = c.logFile.Sync()
		_ = c.logFile.Close()
		c.logFile = nil
	}

	baseFile := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.log", c.clientID, c.currentDate))

	if c.maxBackupFiles > 0 {
		// 移除超出保留数的备份
		oldest := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.%d.log", c.clientID, c.currentDate, c.maxBackupFiles))
		_ = os.Remove(oldest)

		// 倒序重命名已有备份: .2 -> .3, .1 -> .2
		for i := c.maxBackupFiles - 1; i >= 1; i-- {
			src := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.%d.log", c.clientID, c.currentDate, i))
			dst := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.%d.log", c.clientID, c.currentDate, i+1))
			_ = os.Rename(src, dst)
		}

		// 将当前 baseFile 重命名为 .1.log
		first := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.1.log", c.clientID, c.currentDate))
		_ = os.Rename(baseFile, first)
	} else {
		_ = os.Remove(baseFile)
	}

	// 重新创建空的当前文件
	file, err := os.OpenFile(baseFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("创建轮转日志文件失败: %v", err)
	}

	c.logFile = file
	c.currentSize = 0
	log.Printf("[Logger] 日志单文件达到上限已切分轮转: %s", baseFile)
	return nil
}

// rotateLogFile 轮转日期日志文件
func (c *Collector) rotateLogFile() error {
	c.fileMu.Lock()
	defer c.fileMu.Unlock()

	// 关闭旧文件
	if c.logFile != nil {
		_ = c.logFile.Sync()
		_ = c.logFile.Close()
		c.logFile = nil
	}

	date := time.Now().Format("2006-01-02")
	c.currentDate = date
	filename := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.log", c.clientID, date))

	if info, err := os.Stat(filename); err == nil {
		c.currentSize = info.Size()
		if c.maxFileSize > 0 && c.currentSize >= c.maxFileSize {
			return c.rotateBySizeLocked()
		}
	} else {
		c.currentSize = 0
	}

	file, err := os.OpenFile(filename, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("打开日志文件失败: %v", err)
	}

	c.logFile = file
	log.Printf("[Logger] 日志文件: %s (大小: %d 字节)", filename, c.currentSize)

	// 清理过期历史日志
	if c.retention > 0 {
		c.cleanOldLogsLocked(c.retention)
	}

	return nil
}

// cleanOldLogsLocked 清理超出保留时长的日志文件（调用方必须持有 fileMu）
func (c *Collector) cleanOldLogsLocked(retention time.Duration) {
	entries, err := os.ReadDir(c.logDir)
	if err != nil {
		return
	}

	prefix := fmt.Sprintf("frpc-%s-", c.clientID)
	now := time.Now()

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".log") {
			continue
		}

		rest := strings.TrimPrefix(name, prefix)
		// rest 形如 "2026-10-21.log" 或 "2026-10-21.1.log"
		datePart := rest
		if idx := strings.Index(datePart, "."); idx != -1 {
			datePart = datePart[:idx]
		}
		fileDate, err := time.Parse("2006-01-02", datePart)
		if err != nil {
			continue
		}
		if now.Sub(fileDate) > retention {
			_ = os.Remove(filepath.Join(c.logDir, name))
		}
	}
}

// ReadLogFile 读取指定日期的日志文件（按时间顺序合并历史分卷与当前文件）
func (c *Collector) ReadLogFile(date string) ([]string, error) {
	c.fileMu.Lock()
	defer c.fileMu.Unlock()

	var allLines []string
	var foundAny bool

	// 1. 读取历史切分卷（从最大编号到 1，即时间由远及近）
	for i := c.maxBackupFiles; i >= 1; i-- {
		partFilename := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.%d.log", c.clientID, date, i))
		lines, err := readLinesFromFile(partFilename)
		if err == nil {
			foundAny = true
			allLines = append(allLines, lines...)
		}
	}

	// 2. 读取当前活跃日志文件
	activeFilename := filepath.Join(c.logDir, fmt.Sprintf("frpc-%s-%s.log", c.clientID, date))
	lines, err := readLinesFromFile(activeFilename)
	if err == nil {
		foundAny = true
		allLines = append(allLines, lines...)
	}

	if !foundAny {
		return nil, os.ErrNotExist
	}

	return allLines, nil
}

func readLinesFromFile(filename string) ([]string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var lines []string
	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines, scanner.Err()
}
