"""
API 限流配置
使用 slowapi 实现基于内存的限流（无需 Redis）
"""
from __future__ import annotations

from fastapi import Request
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded


def get_real_client_ip(request: Request) -> str:
    """
    安全提取客户端真实 IP：
    仅在直接对端为本地回环地址（Nginx 反向代理）时，信任 X-Forwarded-For 与 X-Real-IP。
    防止 Nginx 反向代理下所有外部用户共享 127.0.0.1 限流配额导致 DoS。
    """
    client_host = request.client.host if request.client else "127.0.0.1"
    if client_host in ("127.0.0.1", "::1", "localhost"):
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # 取最左侧首个非代理公网客户端 IP
            return forwarded.split(",")[0].strip()
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
    return client_host


# 创建限流器（使用内存存储，基于安全提取的真实客户端 IP）
limiter = Limiter(
    key_func=get_real_client_ip,
    default_limits=["100/minute"]  # 默认限制：100次/分钟
)


def setup_rate_limit(app):
    """
    在 FastAPI 应用中注册限流器

    Args:
        app: FastAPI 应用实例
    """
    # 注册限流器状态
    app.state.limiter = limiter

    # 注册限流异常处理
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
