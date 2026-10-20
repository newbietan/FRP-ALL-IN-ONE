// Package frpc 提供内置嵌入式 FRP 客户端核心引擎（无子进程，单二进制化）
package frpc

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/fatedier/frp/client"
	"github.com/fatedier/frp/client/proxy"
	"github.com/fatedier/frp/pkg/config"
	"github.com/fatedier/frp/pkg/config/source"
	"github.com/fatedier/frp/pkg/config/v1/validation"
	"github.com/fatedier/frp/pkg/policy/security"
	"github.com/frp-manager/agent/internal/logger"
)

// managedService is the lifecycle/readiness contract of the embedded FRP core.
type managedService interface {
	Run(context.Context) error
	GracefulClose(time.Duration)
	IsConnected() bool
	StatusExporter() client.StatusExporter
}

const defaultStopTimeout = 15 * time.Second

// Manager 内置 FRP 客户端服务管理器
type Manager struct {
	configPath   string
	logCollector *logger.Collector

	service     managedService
	ctx         context.Context
	cancel      context.CancelFunc
	done        chan struct{}
	mu          sync.Mutex
	operationMu sync.Mutex // serializes complete start/stop/reload transactions
	proxyNames  []string

	newService  func(client.ServiceOptions) (managedService, error)
	stopTimeout time.Duration
	isRunning   bool
	OnStatus    func(status string)
}

// NewManager 创建新的内置 FRP 管理器（无需外部 frpc 可执行文件路径）
func NewManager(configPath string, logCollector *logger.Collector) *Manager {
	return &Manager{
		configPath:   configPath,
		logCollector: logCollector,
		stopTimeout:  defaultStopTimeout,
		newService: func(options client.ServiceOptions) (managedService, error) {
			return client.NewService(options)
		},
	}
}

// completeAndValidateConfig is shared by initial startup and config preflight.
// Loading completes common settings only; proxy/visitor defaults must be filled
// before validation (for example, an omitted bandwidthLimitMode means client).
func completeAndValidateConfig(result *config.ClientConfigLoadResult) error {
	result.Proxies = config.CompleteProxyConfigurers(result.Proxies)
	result.Visitors = config.CompleteVisitorConfigurers(result.Visitors)
	proxies, visitors := config.FilterClientConfigurers(result.Common, result.Proxies, result.Visitors)
	_, err := validation.ValidateAllClientConfig(result.Common, proxies, visitors, security.NewUnsafeFeatures([]string{}))
	return err
}

// Start 在当前进程内启动 FRP 客户端服务
func (m *Manager) Start() error {
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	return m.startLocked()
}

// startLocked requires operationMu. A stopping service retains its slot until
// Run, including deferred listener cleanup, has completely returned.
func (m *Manager) startLocked() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.isRunning || m.service != nil {
		return fmt.Errorf("FRP 内核服务已在运行中或尚未完成退出")
	}

	if _, err := os.Stat(m.configPath); os.IsNotExist(err) {
		return fmt.Errorf("配置文件不存在: %s", m.configPath)
	}

	log.Printf("[FRP-Core] 正在通过内置内核加载配置: %s", m.configPath)

	result, err := config.LoadClientConfigResult(m.configPath, false)
	if err != nil {
		return fmt.Errorf("加载配置失败: %w", err)
	}
	if err := completeAndValidateConfig(result); err != nil {
		return fmt.Errorf("校验配置失败: %w", err)
	}

	configSource := source.NewConfigSource()
	if err := configSource.ReplaceAll(result.Proxies, result.Visitors); err != nil {
		return fmt.Errorf("设置配置源失败: %w", err)
	}

	aggregator := source.NewAggregator(configSource)
	proxyCfgs, visitorCfgs, err := aggregator.Load()
	if err != nil {
		return fmt.Errorf("加载聚合代理配置失败: %w", err)
	}

	proxyCfgs, visitorCfgs = config.FilterClientConfigurers(result.Common, proxyCfgs, visitorCfgs)
	unsafeFeatures := security.NewUnsafeFeatures([]string{})

	ctx, cancel := context.WithCancel(context.Background())
	m.ctx = ctx
	m.cancel = cancel

	svr, err := m.newService(client.ServiceOptions{
		Common:                 result.Common,
		ConfigSourceAggregator: aggregator,
		UnsafeFeatures:         unsafeFeatures,
		ConfigFilePath:         m.configPath,
	})
	if err != nil {
		cancel()
		m.ctx = nil
		m.cancel = nil
		return fmt.Errorf("创建 FRP 客户端服务失败: %w", err)
	}

	m.service = svr
	done := make(chan struct{})
	m.done = done
	m.proxyNames = nil
	for _, cfg := range proxyCfgs {
		m.proxyNames = append(m.proxyNames, cfg.GetBaseConfig().Name)
	}
	m.isRunning = true

	log.Println("[FRP-Core] 内置穿透引擎已启动")

	go func() {
		if err := svr.Run(ctx); err != nil {
			log.Printf("[FRP-Core] 运行终止: %v", err)
		}
		cancel()
		m.mu.Lock()
		current := m.done == done
		if current {
			m.isRunning = false
		}
		m.mu.Unlock()
		if current && m.OnStatus != nil {
			m.OnStatus("stopped")
		}
		m.mu.Lock()
		if m.done == done {
			m.service = nil
			m.ctx = nil
			m.cancel = nil
			m.done = nil
		}
		// Close after cleanup and the stopped notification, so neither a new
		// listener nor a new running event can overtake the previous core.
		close(done)
		m.mu.Unlock()
	}()

	if m.OnStatus != nil {
		m.OnStatus("running")
	}

	return nil
}

// Stop 停止 FRP 客户端服务，并等待监听及控制连接完全释放。
func (m *Manager) Stop() error {
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	return m.stopLocked()
}

func (m *Manager) stopLocked() error {
	m.mu.Lock()
	if m.service == nil {
		m.mu.Unlock()
		return nil
	}
	svr, cancel, done := m.service, m.cancel, m.done
	m.isRunning = false
	m.mu.Unlock()

	log.Println("[FRP-Core] 正在停止内置穿透引擎...")
	svr.GracefulClose(time.Second)
	if cancel != nil {
		cancel()
	}

	// Do not hold mu while waiting: Run's completion path needs it too.
	timer := time.NewTimer(m.stopTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		// Keep the service slot occupied. A later Start/Restart must not bind
		// another listener while the old core is still shutting down.
		return fmt.Errorf("旧 FRP 核心退出超时，拒绝启动新核心以避免端口冲突")
	}
}

// Restart 重启内置穿透服务
func (m *Manager) Restart() error {
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	return m.restartLocked()
}

func (m *Manager) restartLocked() error {
	log.Println("[FRP-Core] 正在重启内置穿透服务...")
	if err := m.stopLocked(); err != nil {
		return err
	}
	return m.startLocked()
}

// UpdateConfig 更新配置并热重载
func (m *Manager) UpdateConfig(newConfig string) error {
	m.operationMu.Lock()
	defer m.operationMu.Unlock()
	previous, readErr := os.ReadFile(m.configPath)
	if readErr == nil && bytes.Equal(previous, []byte(newConfig)) && m.IsRunning() {
		return nil // normal reconnects must not interrupt working tunnels
	}
	next := m.configPath + ".next"
	if err := os.WriteFile(next, []byte(newConfig), 0o600); err != nil {
		return fmt.Errorf("写入待验证配置失败: %w", err)
	}
	defer os.Remove(next)
	result, err := config.LoadClientConfigResult(next, false)
	if err != nil {
		return fmt.Errorf("新配置解析失败（旧配置未改变）: %w", err)
	}
	if err := completeAndValidateConfig(result); err != nil {
		return fmt.Errorf("新配置校验失败（旧配置未改变）: %w", err)
	}
	if readErr == nil {
		if err := os.WriteFile(m.configPath+".bak", previous, 0o600); err != nil {
			return fmt.Errorf("备份配置失败: %w", err)
		}
	}
	if err := os.Rename(next, m.configPath); err != nil {
		return fmt.Errorf("原子替换配置失败: %w", err)
	}
	if err := m.restartLocked(); err != nil {
		if readErr == nil {
			if restoreErr := os.WriteFile(m.configPath, previous, 0o600); restoreErr != nil {
				return fmt.Errorf("配置启动及恢复失败: %v; %w", err, restoreErr)
			}
			if restoreErr := m.restartLocked(); restoreErr != nil {
				return fmt.Errorf("配置启动及旧核心恢复失败: %v; %w", err, restoreErr)
			}
		}
		return err
	}
	return nil
}

// Healthy requires a live authenticated control connection and registered proxies.
func (m *Manager) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.isRunning || m.service == nil || !m.service.IsConnected() {
		return false
	}
	for _, name := range m.proxyNames {
		status, ok := m.service.StatusExporter().GetProxyStatus(name)
		if !ok || status == nil || status.Phase != proxy.ProxyPhaseRunning || status.Err != "" {
			return false
		}
	}
	return true
}

// IsRunning 检查内置引擎是否在运行
func (m *Manager) IsRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.isRunning
}
