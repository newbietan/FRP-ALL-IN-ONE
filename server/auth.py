from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
    优先级：环境变量 SECRET_KEY，其次持久化数据卷中的私有密钥。
    """
    global SECRET_KEY

    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        SECRET_KEY = env_key
        print("[Security] JWT Secret Key 从环境变量加载")
        return

    key_path = Path(os.environ.get("FRP_SECRET_FILE", "./data/.jwt_secret"))
    key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        SECRET_KEY = key_path.read_text(encoding="utf-8").strip()
        if not SECRET_KEY:
            raise RuntimeError("持久化 JWT 密钥为空，请检查数据卷，拒绝生成新密钥使会话失效") from None
    else:
        SECRET_KEY = secrets.token_urlsafe(64)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(SECRET_KEY)
    print("[Security] JWT Secret Key 从私有持久化文件加载")


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
