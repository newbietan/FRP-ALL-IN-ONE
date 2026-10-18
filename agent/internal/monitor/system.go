// Package monitor 提供系统监控功能
package monitor

import (
	"log"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

// SystemInfo 系统信息
type SystemInfo struct {
	Timestamp     int64    `json:"timestamp"`
	Hostname      string   `json:"hostname"`
	OS            string   `json:"os"`
	Arch          string   `json:"arch"`
	IP            string   `json:"ip"`
	IPs           []string `json:"ips"`
	CPUPercent    float64  `json:"cpu_percent"`
	MemoryUsed    uint64   `json:"memory_used"`
	MemoryTotal   uint64   `json:"memory_total"`
	MemoryPercent float64  `json:"memory_percent"`
	DiskUsed      uint64   `json:"disk_used"`
	DiskTotal     uint64   `json:"disk_total"`
	DiskPercent   float64  `json:"disk_percent"`
	NetBytesIn    uint64   `json:"net_bytes_in"`
	NetBytesOut   uint64   `json:"net_bytes_out"`
	// 实时网络速率（字节/秒）
	NetSpeedIn  uint64 `json:"net_speed_in"`
	NetSpeedOut uint64 `json:"net_speed_out"`
	Uptime      uint64 `json:"uptime"`
}

// Monitor 系统监控器
type Monitor struct {
	isRunning atomic.Bool
	OnMetrics func(SystemInfo)

	// 用于计算网络速率
	lastNetIn   uint64
	lastNetOut  uint64
	lastCollect time.Time
	initialized bool
}

// NewMonitor 创建新的监控器
func NewMonitor() *Monitor {
	return &Monitor{}
}

// Start 开始监控
func (m *Monitor) Start(intervalSeconds int) {
	m.isRunning.Store(true)

	for m.isRunning.Load() {
		info, err := m.Collect()
		if err != nil {
			log.Printf("[Monitor] 采集失败: %v", err)
		} else if m.OnMetrics != nil {
			m.OnMetrics(info)
		}

		time.Sleep(time.Duration(intervalSeconds) * time.Second)
	}
}

// Stop 停止监控
func (m *Monitor) Stop() {
	m.isRunning.Store(false)
}

// Collect 采集一次系统信息
func (m *Monitor) Collect() (SystemInfo, error) {
	info := SystemInfo{
		Timestamp: time.Now().Unix(),
	}

	// 主机信息
	hostInfo, err := host.Info()
	if err == nil {
		info.Hostname = hostInfo.Hostname
		info.OS = hostInfo.OS
		info.Arch = hostInfo.KernelArch
		info.Uptime = hostInfo.Uptime
	}

	// CPU 使用率
	cpuPercent, err := cpu.Percent(time.Second, false)
	if err == nil && len(cpuPercent) > 0 {
		info.CPUPercent = cpuPercent[0]
	}

	// 内存使用
	memInfo, err := mem.VirtualMemory()
	if err == nil {
		info.MemoryUsed = memInfo.Used
		info.MemoryTotal = memInfo.Total
		info.MemoryPercent = memInfo.UsedPercent
	}

	// 磁盘使用（根目录）
	diskInfo, err := disk.Usage("/")
	if err == nil {
		info.DiskUsed = diskInfo.Used
		info.DiskTotal = diskInfo.Total
		info.DiskPercent = diskInfo.UsedPercent
	}

	// 网络流量（累计值）
	netInfo, err := net.IOCounters(false)
	if err == nil && len(netInfo) > 0 {
		currentNetIn := netInfo[0].BytesRecv
		currentNetOut := netInfo[0].BytesSent

		info.NetBytesIn = currentNetIn
		info.NetBytesOut = currentNetOut

		// 计算网络速率（字节/秒）
		if m.initialized {
			elapsed := time.Since(m.lastCollect).Seconds()
			if elapsed > 0 {
				// 处理计数器溢出或重置的情况
				if currentNetIn >= m.lastNetIn {
					info.NetSpeedIn = uint64(float64(currentNetIn-m.lastNetIn) / elapsed)
				}
				if currentNetOut >= m.lastNetOut {
					info.NetSpeedOut = uint64(float64(currentNetOut-m.lastNetOut) / elapsed)
				}
			}
		}

		// 更新上次采集的值
		m.lastNetIn = currentNetIn
		m.lastNetOut = currentNetOut
		m.lastCollect = time.Now()
		m.initialized = true
	}

	// 探测宿主机/局域网 IP
	primaryIP, candidateIPs := DetectHostIP()
	info.IP = primaryIP
	info.IPs = candidateIPs

	return info, nil
}

// GetHostInfo 获取主机基本信息（用于注册）
func GetHostInfo() map[string]string {
	result := make(map[string]string)

	hostInfo, err := host.Info()
	if err == nil {
		result["hostname"] = hostInfo.Hostname
		result["os"] = hostInfo.OS
		result["arch"] = hostInfo.KernelArch
		result["platform"] = hostInfo.Platform
		result["platform_version"] = hostInfo.PlatformVersion
	}

	return result
}
