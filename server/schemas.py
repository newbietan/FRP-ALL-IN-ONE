from __future__ import annotations

from enum import Enum
import re

from pydantic import BaseModel, field_validator


class TunnelType(str, Enum):
    TCP = "tcp"
    UDP = "udp"
    HTTP = "http"
    HTTPS = "https"


class TunnelBase(BaseModel):
    name: str
    type: TunnelType
    enabled: bool = True
    local_ip: str = "127.0.0.1"
    local_port: int
    remote_port: int | None = None
    custom_domains: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not re.match(r'^[a-zA-Z0-9_\-. ]+$', v):
            raise ValueError("名称只能包含字母、数字、下划线、连字符、点和空格")
        if len(v) > 64:
            raise ValueError("名称长度不能超过 64 个字符")
        return v

    @field_validator("local_ip")
    @classmethod
    def validate_local_ip(cls, v: str) -> str:
        # 允许 IPv4、IPv6、localhost 等合法地址，禁止换行和引号等 TOML 注入字符
        if any(c in v for c in '"\n\r\t[]{}'):
            raise ValueError("local_ip 包含非法字符")
        if "docker.sock" in v.lower() or "/" in v:
            raise ValueError("local_ip 仅支持网络 IP 或主机名，禁止指向 Unix Socket")
        if len(v) > 256:
            raise ValueError("local_ip 长度过长")
        return v

    @field_validator("custom_domains")
    @classmethod
    def validate_custom_domains(cls, v: str | None) -> str | None:
        if not v:
            return v
        for domain in v.split(","):
            domain = domain.strip()
            if not domain:
                continue
            if not re.match(r'^[a-zA-Z0-9\-.]+$', domain):
                raise ValueError(f"域名 '{domain}' 包含非法字符（仅允许字母、数字、连字符和点）")
            if len(domain) > 253:
                raise ValueError(f"域名 '{domain}' 长度超过 253 个字符")
        return v


class TunnelCreate(TunnelBase):
    pass


class Tunnel(TunnelBase):
    id: int
    client_id: str

    class Config:
        from_attributes = True


class ClientBase(BaseModel):
    name: str
    remark: str | None = None


class ClientCreate(ClientBase):
    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not re.match(r'^[a-zA-Z0-9_\-. ]+$', v):
            raise ValueError("名称只能包含字母、数字、下划线、连字符、点和空格")
        if len(v) > 64:
            raise ValueError("名称长度不能超过 64 个字符")
        return v


class ClientUpdate(BaseModel):
    name: str | None = None
    remark: str | None = None


class Client(ClientBase):
    id: str
    auth_token: str
    status: str
    last_seen: int
    remark: str | None = None
    tunnels: list[Tunnel] = []
    agent_info: dict | None = None

    class Config:
        from_attributes = True


class AdminInfo(BaseModel):
    id: int
    github_id: int
    github_username: str
    avatar_url: str | None = None
    is_superadmin: bool

    class Config:
        from_attributes = True
