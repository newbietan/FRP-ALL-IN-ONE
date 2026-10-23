// Package config 提供 Agent 配置管理
package config

// Config Agent 配置
type Config struct {
	// ServerURL 服务端 WebSocket 地址
	ServerURL string

	// ClientID 客户端唯一标识
	ClientID string

	// Token 认证令牌
	Token string

	// FRPCPath frpc 二进制路径
	FRPCPath string

	// ConfigPath frpc 配置文件路径
	ConfigPath string

	// LogPath 日志存储目录
	LogPath string

	// InsecureTLS 允许跳过 CA 证书链校验（仍保留 TLS 传输加密）
	InsecureTLS bool

	// TLSFingerprint 服务端证书 SHA256 指纹（自签名证书 Pinning 锁定）
	TLSFingerprint string
}
