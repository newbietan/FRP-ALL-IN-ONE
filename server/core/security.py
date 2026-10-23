"""Shared transport and public-origin policy for credential-bearing endpoints."""
from __future__ import annotations

import ipaddress
import os
import re
from urllib.parse import urlsplit

from fastapi import HTTPException
from starlette.requests import HTTPConnection


def _is_loopback(value: str | None) -> bool:
    try:
        return ipaddress.ip_address(value or "").is_loopback
    except ValueError:
        return value == "localhost"


def secure_transport_allowed(connection: HTTPConnection) -> bool:
    if connection.url.scheme in {"https", "wss"}:
        return True
    if os.environ.get("FRP_ALLOW_INSECURE_HTTP") == "1":
        return True  # Explicit migration/development escape hatch, never the default.
    return bool(
        connection.client and _is_loopback(connection.client.host)
        and _is_loopback(connection.url.hostname)
    )


def require_secure_transport(connection: HTTPConnection) -> None:
    if not secure_transport_allowed(connection):
        raise HTTPException(status_code=400, detail="管理凭据仅允许通过 HTTPS/WSS 传输；请配置可信 HTTPS 反向代理")


def public_base_url(request: HTTPConnection, db=None) -> str:
    """Never trust raw X-Forwarded-Host/Proto or Origin supplied by a client.

    Uvicorn handles Forwarded-Proto only for its configured trusted proxy peers.
    FRP_PUBLIC_URL is recommended behind a reverse proxy or NAT.
    """
    configured = os.environ.get("FRP_PUBLIC_URL", "").strip().rstrip("/")
    if configured:
        base = configured
    else:
        base = str(request.base_url).rstrip("/")
        if db is not None:
            import crud
            import models
            domain = (crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or "").strip()
            if domain:
                tls = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
                scheme = "https" if tls else request.url.scheme
                port = (crud.get_config(db, models.ConfigKeys.PANEL_ACCESS_PORT) or "").strip()
                base = f"{scheme}://{domain}" + (f":{port}" if port else "")
    try:
        parsed = urlsplit(base)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}
                or not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]+", parsed.netloc)):
            raise ValueError("invalid origin")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError("invalid port")
        if (parsed.scheme == "http" and os.environ.get("FRP_ALLOW_INSECURE_HTTP") != "1"
                and not (request.client and _is_loopback(request.client.host) and _is_loopback(parsed.hostname))):
            raise ValueError("public credential URLs require HTTPS")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="管理面板访问地址无效，请设置 FRP_PUBLIC_URL") from exc
    return base
