// Package ws 提供 WebSocket 客户端功能
package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"runtime"
	"sync"

	"github.com/frp-manager/agent/internal/monitor"
	"time"

	"github.com/gorilla/websocket"
)

// Message WebSocket 消息结构
type Message struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
}

// Client WebSocket 客户端
type Client struct {
	serverURL string
	clientID  string
	token     string
	version   string // Agent 版本

	conn         *websocket.Conn
	mu           sync.RWMutex
	writeMu      sync.Mutex
	isRunning    bool
	reconnect    bool
	OnMessage    func(Message)
	OnConnect    func()
	OnDisconnect func()
}

// NewClient 创建新的 WebSocket 客户端
func NewClient(serverURL, clientID, token, version string) *Client {
	return &Client{
		serverURL: serverURL,
		clientID:  clientID,
		token:     token,
		version:   version,
		reconnect: true,
	}
}

// Connect 连接到服务端
func (c *Client) Connect() {
	c.mu.Lock()
	c.isRunning = true
	c.mu.Unlock()
	backoff := 3 * time.Second
	const maxBackoff = 60 * time.Second

	for c.shouldReconnect() {
		if err := c.connect(); err != nil {
			log.Printf("[WebSocket] 连接失败: %v, %v后重试...", err, backoff)
			time.Sleep(backoff)
			backoff = backoff * 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		// 连接成功，重置退避
		backoff = 3 * time.Second

		// 连接成功，开始读取消息
		c.readLoop()

		if c.shouldReconnect() {
			log.Printf("[WebSocket] 连接断开，%v后重连...", backoff)
			time.Sleep(backoff)
			backoff = backoff * 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func (c *Client) shouldReconnect() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.isRunning && c.reconnect
}

func (c *Client) connect() error {
	// 构建带认证的请求头
	header := http.Header{}
	header.Add("X-Client-Token", c.token)
	header.Add("X-Client-ID", c.clientID)

	// 连接服务端
	dialer := websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second

	conn, _, err := dialer.Dial(c.serverURL, header)
	if err != nil {
		return err
	}

	// 限制单条消息最大 1MB，防止恶意服务端发送超大消息导致 OOM
	conn.SetReadLimit(1 << 20)

	c.writeMu.Lock()
	c.mu.Lock()
	oldConn := c.conn
	c.conn = conn
	c.mu.Unlock()
	if oldConn != nil {
		oldConn.Close()
	}
	c.writeMu.Unlock()

	log.Println("[WebSocket] 连接成功")

	// 获取系统信息与探测宿主机局域网 IP
	hostname, _ := os.Hostname()
	hostInfo := monitor.GetHostInfo()
	primaryIP, candidateIPs := monitor.DetectHostIP()

	// 发送注册消息（包含系统信息及嗅探到的宿主机IP）
	c.Send("register", map[string]interface{}{
		"client_id": c.clientID,
		"version":   c.version,
		"hostname":  hostname,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"platform":  hostInfo["platform"],
		"ip":        primaryIP,
		"ips":       candidateIPs,
	})

	if c.OnConnect != nil {
		c.OnConnect()
	}

	return nil
}

func (c *Client) readLoop() {
	for {
		c.mu.RLock()
		conn := c.conn
		c.mu.RUnlock()

		if conn == nil {
			return
		}

		_, data, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[WebSocket] 读取消息失败: %v", err)
			return
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("[WebSocket] 消息解析失败: %v", err)
			continue
		}

		if c.OnMessage != nil {
			c.OnMessage(msg)
		}
	}
}

// Send 发送消息到服务端
func (c *Client) Send(msgType string, data interface{}) error {
	msg := Message{
		Type: msgType,
		Data: data,
	}

	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// Gorilla WebSocket 仅允许一个并发 writer。所有写操作（包括 Close
	// 和重连替换）都通过 writeMu 串行化，避免 concurrent write panic。
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()
	if conn == nil {
		return nil
	}

	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, msgBytes)
}

// Close 关闭连接
func (c *Client) Close() {
	c.mu.Lock()
	c.isRunning = false
	c.reconnect = false
	c.mu.Unlock()

	c.writeMu.Lock()
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
	c.writeMu.Unlock()

	if c.OnDisconnect != nil {
		c.OnDisconnect()
	}
}

// IsConnected 检查是否已连接
func (c *Client) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.conn != nil
}
