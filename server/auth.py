from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

__all__ = [
    "ALGORITHM",
    "ACCESS_TOKEN_EXPIRE_MINUTES",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_AUTHORIZE_URL",
    "GITHUB_TOKEN_URL",
    "GITHUB_USER_API",
    "JWTError",
    "create_access_token",
    "get_secret_key",
    "init_secret_key",
    "jwt",
]

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

# GitHub OAuth 配置
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET")
GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"  # noqa: S105
GITHUB_USER_API = "https://api.github.com/user"

# 全局变量，将在 init_secret_key 中初始化
SECRET_KEY: str | None = None


def init_secret_key():
    """
    初始化 JWT Secret Key
    优先级：1. 环境变量 SECRET_KEY  2. 内存中自动生成（重启失效）
    """
    global SECRET_KEY

    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        SECRET_KEY = env_key
        print("[Security] JWT Secret Key 从环境变量加载")
        return

    SECRET_KEY = secrets.token_urlsafe(64)
    print("[WARN] 未配置 SECRET_KEY 环境变量，已生成临时密钥（重启后所有登录会话将失效）")
    print("[Security] 生产环境建议在 compose.yml 中设置: SECRET_KEY=<your-random-key>")


def get_secret_key() -> str:
    """获取当前密钥，如果未初始化则先初始化"""
    if SECRET_KEY is None:
        init_secret_key()
    return SECRET_KEY or ""


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt: str = jwt.encode(to_encode, get_secret_key(), algorithm=ALGORITHM)
    return encoded_jwt
