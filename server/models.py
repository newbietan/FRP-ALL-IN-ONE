from __future__ import annotations

from datetime import datetime, timezone
import enum

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base

APP_VERSION = "3.2.0"
GITHUB_REPO = "newbietan/FRP-ALL-IN-ONE"


def parse_version_tuple(v: str) -> tuple[int, ...]:
    """解析版本字符串为整型元组供语义化版本对比，例如 'v3.2.0' -> (3, 2, 0)"""
    if not v:
        return (0, 0, 0)
    cleaned = v.lstrip("vV").strip().split("-")[0]
    parts: list[int] = []
    for item in cleaned.split("."):
        try:
            parts.append(int(item))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_newer_version(latest_tag: str, current_tag: str) -> bool:
    """判断 latest_tag 是否比 current_tag 更高"""
    return parse_version_tuple(latest_tag) > parse_version_tuple(current_tag)


class TunnelType(str, enum.Enum):
    TCP = "tcp"
    UDP = "udp"
    HTTP = "http"
    HTTPS = "https"


class Client(Base):
    __tablename__ = "clients"
    __table_args__ = {"extend_existing": True}

    id: Mapped[str] = mapped_column(String, primary_key=True, index=True)  # UUID
    name: Mapped[str] = mapped_column(String, index=True)
    auth_token: Mapped[str] = mapped_column(String)  # For Agent to authenticate
    status: Mapped[str] = mapped_column(String, default="offline")  # online/offline
    last_seen: Mapped[int] = mapped_column(Integer, default=0)  # Timestamp

    tunnels: Mapped[list[Tunnel]] = relationship("Tunnel", back_populates="client", cascade="all, delete-orphan")


class Admin(Base):
    __tablename__ = "admins"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    github_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)  # GitHub 用户 ID（稳定不变）
    github_username: Mapped[str] = mapped_column(String, index=True)  # GitHub 用户名（仅展示，可变）
    avatar_url: Mapped[str | None] = mapped_column(String, nullable=True)  # GitHub 头像 URL
    is_superadmin: Mapped[bool] = mapped_column(Boolean, default=False)  # 超级管理员（首个用户或手动提升）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class AdminInvite(Base):
    """控制哪些 GitHub 用户允许登录"""
    __tablename__ = "admin_invites"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    github_username: Mapped[str] = mapped_column(String, unique=True, index=True)
    added_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class SystemConfig(Base):
    __tablename__ = "system_config"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    key: Mapped[str] = mapped_column(String, unique=True, index=True)  # 配置键
    value: Mapped[str | None] = mapped_column(String, nullable=True)  # 配置值


# 常用配置键常量
class ConfigKeys:
    IS_INITIALIZED = "is_initialized"  # 系统是否已初始化
    FRPS_VERSION = "frps_version"      # FRPS 版本
    FRPS_PORT = "frps_port"            # FRPS 端口
    FRPS_AUTH_TOKEN = "frps_auth_token"  # noqa: S105
    SERVER_PUBLIC_IP = "server_public_ip"  # 服务器公网 IP
    SERVER_DOMAIN = "server_domain"    # 服务器域名（用于 HTTPS）
    FRPS_DASHBOARD_PWD = "frps_dashboard_pwd"  # noqa: S105
    DISABLED_PORTS = "disabled_ports"  # 禁用的端口列表，逗号分隔，如 "6001,6005"
    JWT_SECRET_KEY = "jwt_secret_key"  # noqa: S105
    TLS_ENABLED = "tls_enabled"        # HTTPS 是否启用
    TLS_MODE = "tls_mode"              # HTTPS 模式：auto(Let's Encrypt) / custom(自定义证书)
    PANEL_ACCESS_PORT = "panel_access_port"  # 管理面板公网访问端口（NAT 映射场景，如 10967）
    SERVER_INSTALL_TOKEN = "server_install_token"  # noqa: S105


class Tunnel(Base):
    __tablename__ = "tunnels"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String, index=True)  # e.g., "ssh"
    type: Mapped[TunnelType] = mapped_column(Enum(TunnelType))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # FRP Config Fields
    local_ip: Mapped[str] = mapped_column(String, default="127.0.0.1")
    local_port: Mapped[int] = mapped_column(Integer)
    remote_port: Mapped[int | None] = mapped_column(Integer, nullable=True)  # For TCP/UDP
    custom_domains: Mapped[str | None] = mapped_column(String, nullable=True)  # For HTTP/HTTPS

    client_id: Mapped[str] = mapped_column(String, ForeignKey("clients.id"))
    client: Mapped[Client] = relationship("Client", back_populates="tunnels")


# ===========================
# Agent 相关模型
# ===========================

class AgentInfo(Base):
    """Agent 信息表，存储每个客户端 Agent 的基本信息"""
    __tablename__ = "agent_info"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    client_id: Mapped[str] = mapped_column(String, unique=True, index=True)  # 客户端唯一 ID
    hostname: Mapped[str | None] = mapped_column(String, nullable=True)  # 主机名
    os: Mapped[str | None] = mapped_column(String, nullable=True)  # 操作系统
    arch: Mapped[str | None] = mapped_column(String, nullable=True)  # 架构
    agent_version: Mapped[str | None] = mapped_column(String, nullable=True)  # Agent 版本
    platform: Mapped[str | None] = mapped_column(String, nullable=True)  # 平台详情
    ip: Mapped[str | None] = mapped_column(String, nullable=True)  # 嗅探到的宿主机/局域网主 IP
    ips: Mapped[str | None] = mapped_column(String, nullable=True)  # 候选 IP 列表 (JSON 格式)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class SystemMetrics(Base):
    """系统监控指标表，存储 Agent 上报的系统信息"""
    __tablename__ = "system_metrics"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    client_id: Mapped[str] = mapped_column(String, index=True)  # 客户端 ID
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))  # 采集时间
    cpu_percent: Mapped[float | None] = mapped_column(Float, nullable=True)  # CPU 使用率
    memory_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 已用内存 (bytes)
    memory_total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 总内存 (bytes)
    memory_percent: Mapped[float | None] = mapped_column(Float, nullable=True)  # 内存使用率
    disk_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 已用磁盘 (bytes)
    disk_total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 总磁盘 (bytes)
    disk_percent: Mapped[float | None] = mapped_column(Float, nullable=True)  # 磁盘使用率
    net_bytes_in: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 网络接收累计 (bytes)
    net_bytes_out: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 网络发送累计 (bytes)
    net_speed_in: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 网络接收速率 (bytes/s)
    net_speed_out: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # 网络发送速率 (bytes/s)
