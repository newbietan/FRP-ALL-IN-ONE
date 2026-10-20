/*
FRP Manager Agent - 智能客户端代理

功能:
- 托管 FRPC 进程（启动、停止、重载）
- 系统监控（CPU、内存、网络、磁盘）
- 日志采集（实时推送 + 本地存储）
- 配置热重载（WebSocket 接收配置更新）
- 心跳上报（保持与服务端连接）

使用:

	frp-agent -server wss://your-server.com/ws/agent/CLIENT_ID -token YOUR_TOKEN
*/
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/frp-manager/agent/internal/config"
	"github.com/frp-manager/agent/internal/frpc"
	"github.com/frp-manager/agent/internal/logger"
	"github.com/frp-manager/agent/internal/monitor"
	"github.com/frp-manager/agent/internal/upgrade"
	"github.com/frp-manager/agent/internal/ws"
)

var (
	version   = "3.2.10"
	buildTime = "unknown"
)

// LogBridge 实现 io.Writer，将日志写入 Collector
type LogBridge struct {
	collector *logger.Collector
}

func (l *LogBridge) Write(p []byte) (n int, err error) {
	if len(p) > 0 {
		// 去除末尾换行符
		line := string(p)
		if line[len(line)-1] == '\n' {
			line = line[:len(line)-1]
		}
		l.collector.AddLine(line)
	}
	return len(p), nil
}

func main() {
	// 命令行参数
	serverURL := flag.String("server", "", "服务端 WebSocket 地址 (必填)")
	clientID := flag.String("id", "", "客户端 ID (必填)")
	token := flag.String("token", "", "认证 Token (必填)")
	frpcPath := flag.String("frpc", "", "已废弃：内核已内置，无需外部 frpc 路径")
	configPath := flag.String("config", "/opt/frp/frpc.toml", "frpc 配置文件路径")
	logPath := flag.String("log", "/opt/frp/logs", "日志存储目录")
	showVersion := flag.Bool("version", false, "显示版本信息")
	healthcheck := flag.Bool("healthcheck", false, "检查管理连接、内核与隧道就绪状态")
	expectedVersion := flag.String("expect-version", "", "健康检查期望的精确版本")

	flag.Parse()

	if *healthcheck {
		if err := upgrade.CheckHealth(upgrade.HealthPath, *expectedVersion); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if *showVersion {
		fmt.Printf("FRP Manager Agent v%s (built: %s)\n", version, buildTime)
		os.Exit(0)
	}

	effectiveToken := *token
	if effectiveToken == "" {
		effectiveToken = os.Getenv("FRP_AGENT_TOKEN")
	}

	// 验证必填参数
	if *serverURL == "" || *clientID == "" || effectiveToken == "" {
		fmt.Println("错误: server, id, token (或环境变量 FRP_AGENT_TOKEN) 参数为必填项")
		fmt.Println()
		flag.Usage()
		os.Exit(1)
	}

	log.Printf("FRP Manager Agent v%s 启动中...", version)
	log.Printf("Server: %s", *serverURL)
	log.Printf("Client ID: %s", *clientID)

	// 创建配置
	cfg := &config.Config{
		ServerURL:  *serverURL,
		ClientID:   *clientID,
		Token:      effectiveToken,
		FRPCPath:   *frpcPath,
		ConfigPath: *configPath,
		LogPath:    *logPath,
	}

	// 初始化各模块
	logCollector := logger.NewCollector(cfg.LogPath, cfg.ClientID)

	// 重定向标准日志到 Collector，以便捕获启动日志
	logBridge := &LogBridge{collector: logCollector}
	log.SetOutput(io.MultiWriter(os.Stdout, logBridge)) // 既输出到控制台，也输出到 Collector

	sysMonitor := monitor.NewMonitor()
	frpcManager := frpc.NewManager(cfg.ConfigPath, logCollector)
	wsClient := ws.NewClient(cfg.ServerURL, cfg.ClientID, cfg.Token, version)
	ready := func() bool { return wsClient.IsConnected() && frpcManager.Healthy() }
	upgrader := &upgrade.Runner{
		Directory: filepath.Dir(cfg.ConfigPath), ClientID: cfg.ClientID, Version: version, Ready: ready,
		Send: func(data map[string]interface{}) error { return wsClient.Send("upgrade_status", data) },
	}
	wsClient.OnConnect = func() { upgrader.Report("") }
	stopBackground := make(chan struct{})
	defer close(stopBackground)
	go upgrader.Monitor(stopBackground)
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := upgrade.WriteHealth(version, ready()); err != nil {
					log.Printf("[Health] 写入就绪状态失败: %v", err)
				}
			case <-stopBackground:
				return
			}
		}
	}()

	// 设置 WebSocket 消息处理器
	wsClient.OnMessage = func(msg ws.Message) {
		switch msg.Type {
		case "config_update":
			log.Println("收到配置更新，正在重载 FRPC...")
			if configData, ok := msg.Data.(string); ok {
				if err := frpcManager.UpdateConfig(configData); err != nil {
					log.Printf("配置更新失败: %v", err)
				} else {
					log.Println("配置更新成功")
				}
			}
		case "restart":
			log.Println("收到重启命令...")
			frpcManager.Restart()
		case "upgrade":
			upgrader.Handle(msg.Data)
		case "ping":
			wsClient.Send("pong", nil)
		}
	}

	// 设置日志回调（推送到服务端）
	logCollector.OnLog = func(line string) {
		wsClient.Send("log", line)
	}

	// 设置系统监控回调
	sysMonitor.OnMetrics = func(metrics monitor.SystemInfo) {
		wsClient.Send("system_info", metrics)
	}

	// 设置 FRPC 状态回调（frpc 启动/停止时通知服务端）
	frpcManager.OnStatus = func(status string) {
		wsClient.Send("frpc_status", status)
	}

	// 启动各模块
	go wsClient.Connect()
	go sysMonitor.Start(3) // 每 3 秒采集一次（平衡实时性与资源开销）
	go logCollector.Start()

	// 启动 FRPC
	if err := frpcManager.Start(); err != nil {
		log.Printf("警告: FRPC 启动失败: %v", err)
	}

	// 优雅退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("正在关闭...")
	sysMonitor.Stop()
	_ = upgrade.WriteHealth(version, false)
	frpcManager.Stop()
	wsClient.Close()
	log.Println("Agent 已退出")
}
