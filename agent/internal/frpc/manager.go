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

// Manager 内置 FRP 客户端服务管理器
type Manager struct {
	configPath   string
	logCollector *logger.Collector

	service    *client.Service
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	updateMu   sync.Mutex
	proxyNames []string

	isRunning bool
	OnStatus  func(status string)
}

// NewManager 创建新的内置 FRP 管理器（无需外部 frpc 可执行文件路径）
func NewManager(configPath string, logCollector *logger.Collector) *Manager {
	return &Manager{
		configPath:   configPath,
		logCollector: logCollector,
	}
}

// Start 在当前进程内启动 FRP 客户端服务
func (m *Manager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.isRunning {
		return fmt.Errorf("FRP 内核服务已在运行中")
	}

	if _, err := os.Stat(m.configPath); os.IsNotExist(err) {
		return fmt.Errorf("配置文件不存在: %s", m.configPath)
	}

	log.Printf("[FRP-Core] 正在通过内置内核加载配置: %s", m.configPath)

	result, err := config.LoadClientConfigResult(m.configPath, false)
	if err != nil {
		return fmt.Errorf("加载配置失败: %w", err)
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
	proxyCfgs = config.CompleteProxyConfigurers(proxyCfgs)
	visitorCfgs = config.CompleteVisitorConfigurers(visitorCfgs)

	unsafeFeatures := security.NewUnsafeFeatures([]string{})
	_, err = validation.ValidateAllClientConfig(result.Common, proxyCfgs, visitorCfgs, unsafeFeatures)
	if err != nil {
		return fmt.Errorf("校验配置失败: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.ctx = ctx
	m.cancel = cancel

	svr, err := client.NewService(client.ServiceOptions{
		Common:                 result.Common,
		ConfigSourceAggregator: aggregator,
		UnsafeFeatures:         unsafeFeatures,
		ConfigFilePath:         m.configPath,
	})
	if err != nil {
		cancel()
		return fmt.Errorf("创建 FRP 客户端服务失败: %w", err)
	}

	m.service = svr
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
		m.mu.Lock()
		current := m.service == svr
		if current {
			m.isRunning = false
			m.service = nil
		}
		m.mu.Unlock()
		if current && m.OnStatus != nil {
			m.OnStatus("stopped")
		}
	}()

	if m.OnStatus != nil {
		m.OnStatus("running")
	}

	return nil
}

// Stop 停止 FRP 客户端服务
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.isRunning || m.service == nil {
		return nil
	}

	log.Println("[FRP-Core] 正在停止内置穿透引擎...")
	m.service.GracefulClose(1 * time.Second)
	if m.cancel != nil {
		m.cancel()
	}

	m.isRunning = false
	m.service = nil

	if m.OnStatus != nil {
		m.OnStatus("stopped")
	}

	return nil
}

// Restart 重启内置穿透服务
func (m *Manager) Restart() error {
	log.Println("[FRP-Core] 正在重启内置穿透服务...")
	_ = m.Stop()
	time.Sleep(500 * time.Millisecond)
	return m.Start()
}

// UpdateConfig 更新配置并热重载
func (m *Manager) UpdateConfig(newConfig string) error {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
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
	_, err = validation.ValidateAllClientConfig(result.Common, result.Proxies, result.Visitors, security.NewUnsafeFeatures([]string{}))
	if err != nil {
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
	if err := m.Restart(); err != nil {
		if readErr == nil {
			if restoreErr := os.WriteFile(m.configPath, previous, 0o600); restoreErr != nil {
				return fmt.Errorf("配置启动及恢复失败: %v; %w", err, restoreErr)
			}
			if restoreErr := m.Restart(); restoreErr != nil {
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
