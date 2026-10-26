// Package ws 提供 WebSocket 客户端功能
package ws

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/frp-manager/agent/internal/monitor"
	"github.com/frp-manager/agent/internal/upgrade"

	"github.com/gorilla/websocket"
)

// Message WebSocket 消息结构
type Message struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
}

// Client WebSocket 客户端
type Client struct {
	serverURL      string
	clientID       string
	token          string
	version        string // Agent 版本
	insecureTLS    bool   // 允许自签名证书（跳过 CA 证书链校验）
	tlsFingerprint string // 自签名证书 SHA256 指纹锁定 (hex)

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

// WithTLS 配置自签名证书 TLS 握手及指纹校验策略
func (c *Client) WithTLS(insecure bool, fingerprint string) *Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.insecureTLS = insecure
	c.tlsFingerprint = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(fingerprint, ":", ""), " ", ""))
	return c
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

func validateServerURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("invalid management WebSocket URL")
	}
	if u.Scheme == "wss" {
		return nil
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme == "ws" && (loopback || os.Getenv("FRP_ALLOW_INSECURE_HTTP") == "1") {
		return nil
	}
	return fmt.Errorf("management credentials require TLS; insecure transport requires explicit FRP_ALLOW_INSECURE_HTTP=1")
}

func (c *Client) connect() error {
	if err := validateServerURL(c.serverURL); err != nil {
		return err
	}
	// 构建带认证的请求头
	header := http.Header{}
	header.Add("X-Client-Token", c.token)
	header.Add("X-Client-ID", c.clientID)

	// 连接服务端
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second

	if strings.HasPrefix(c.serverURL, "wss://") {
		tlsConfig := &tls.Config{
			MinVersion: tls.VersionTLS12,
		}
		c.mu.RLock()
		insecure := c.insecureTLS
		fp := c.tlsFingerprint
		c.mu.RUnlock()

		if insecure || fp != "" {
			tlsConfig.InsecureSkipVerify = true
			if fp != "" {
				tlsConfig.VerifyConnection = func(cs tls.ConnectionState) error {
					if len(cs.PeerCertificates) == 0 {
						return fmt.Errorf("no peer certificate presented by server")
					}
					sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
					actualFP := hex.EncodeToString(sum[:])
					if actualFP != fp {
						return fmt.Errorf("certificate fingerprint mismatch: expected %s, got %s", fp, actualFP)
					}
					return nil
				}
			} else {
				log.Printf("[WARN] [Security] TLS 证书未指定指纹校验 (fp='')，已按 FRP_AGENT_INSECURE_TLS 跳过证书链校验，存在中间人劫持风险！强烈建议配置证书指纹。")
			}
		}
		dialer.TLSClientConfig = tlsConfig
	}

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
		"client_id":        c.clientID,
		"version":          c.version,
		"upgrade_protocol": 1,
		"can_self_upgrade": upgrade.Capable(),
		"hostname":         hostname,
		"os":               runtime.GOOS,
		"arch":             runtime.GOARCH,
		"platform":         hostInfo["platform"],
		"ip":               primaryIP,
		"ips":              candidateIPs,
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
			c.writeMu.Lock()
			c.mu.Lock()
			if c.conn == conn {
				c.conn = nil
			}
			c.mu.Unlock()
			conn.Close()
			c.writeMu.Unlock()
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
		return fmt.Errorf("WebSocket is disconnected")
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
