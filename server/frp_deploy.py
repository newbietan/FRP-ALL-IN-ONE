from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import os
import re
import secrets
from typing import Any

import httpx

from core.container_engine import restart_frps_service

logger = logging.getLogger(__name__)

def get_frps_config_path() -> str:
    """获取当前环境下的 FRPS 配置文件路径（单容器架构优先持久化数据目录，兼容容器与工作区）"""
    env_path = os.environ.get("FRPS_CONFIG_PATH")
    if env_path:
        return env_path
    candidates = [
        "/app/data/frps.toml",
        "./data/frps.toml",
        "/etc/frp/frps.toml",
        "/app/frps.toml",
        "./deploy/frps.toml",
        "./frps.toml",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    if os.path.isdir("/app/data"):
        return "/app/data/frps.toml"
    if os.path.isdir("./data"):
        return "./data/frps.toml"
    if os.path.isdir("/etc/frp"):
        return "/etc/frp/frps.toml"
    return "./data/frps.toml"

# 默认 FRP 版本（最新稳定版 v0.71.1）
DEFAULT_FRP_VERSION = "0.71.1"


async def get_latest_frp_version() -> str:
    """从 GitHub API 获取 FRP 最新发布版本号（超时或失败时立即回退至内置内核版本）"""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(
                "https://api.github.com/repos/fatedier/frp/releases/latest",
                headers={"Accept": "application/vnd.github.v3+json"}
            )
            if response.status_code == 200:
                tag_name: str = response.json().get("tag_name", "")
                if tag_name.startswith("v"):
                    return tag_name[1:]
                return tag_name
    except Exception as e:
        logger.debug("获取 FRP 最新版本失败，使用默认版本: %s", e)
    return DEFAULT_FRP_VERSION


def _is_public_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except Exception:
        return False
    if ip.version == 4 and str(ip).startswith("0."):
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
    )


def _extract_ip(text: str | None) -> str | None:
    if not text:
        return None
    m4 = re.search(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b", text)
    if m4 and _is_public_ip(m4.group(0)):
        return m4.group(0)
    m6 = re.search(r"\b([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b", text)
    if m6 and _is_public_ip(m6.group(0)):
        return m6.group(0)
    return None


async def get_public_ip_details() -> dict[str, Any]:
    urls_env = os.environ.get("PUBLIC_IP_URLS", "").strip()
    if urls_env:
        urls = [u.strip() for u in urls_env.split(",") if u.strip()]
    else:
        urls = [
            "https://4.ipw.cn",
            "https://ip.3322.net",
            "https://api.ipify.org?format=json",
            "https://api64.ipify.org?format=json",
            "https://myip.ipip.net",
            "https://ipinfo.io/ip",
            "https://icanhazip.com",
            "https://ifconfig.me/ip",
            "https://api.ip.sb/ip",
        ]

    headers = {
        "User-Agent": "FRP-ALL-IN-ONE/1.0 (public-ip)",
        "Accept": "application/json,text/plain,*/*",
    }

    errors: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=3.0, read=6.0, write=6.0, pool=6.0)) as client:
        for url in urls:
            try:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    errors.append(f"{url}: http {resp.status_code}")
                    continue

                ip = None
                content_type = (resp.headers.get("content-type") or "").lower()
                if "application/json" in content_type or url.endswith("format=json"):
                    try:
                        data = resp.json()
                        ip = data.get("ip") or data.get("IP")
                    except Exception:
                        ip = None
                if not ip:
                    ip = _extract_ip(resp.text.strip())

                if ip and _is_public_ip(ip):
                    version = 4 if ipaddress.ip_address(ip).version == 4 else 6
                    return {
                        "success": True,
                        "ip": ip,
                        "ip_version": version,
                        "source": url,
                        "errors": errors,
                    }

                errors.append(f"{url}: invalid response")
            except Exception as e:
                errors.append(f"{url}: {type(e).__name__}")

    return {"success": False, "ip": "未知", "ip_version": None, "source": None, "errors": errors}


async def get_public_ip() -> str:
    result = await get_public_ip_details()
    return str(result.get("ip") or "未知")


async def reload_frps_via_api(passwords: list[str]) -> bool:
    """尝试通过 FRPS Admin API 进行热重载（无需重启容器，避免隧道断连）"""
    possible_urls = [
        "http://127.0.0.1:7500",
        "http://localhost:7500",
        "http://host.containers.internal:7500",
        "http://frps:7500",
    ]
    for pwd in passwords:
        if not pwd:
            continue
        for base in possible_urls:
            try:
                async with httpx.AsyncClient(timeout=3.0, auth=httpx.BasicAuth("admin", pwd)) as client:
                    resp = await client.get(f"{base}/api/reload")
                    if resp.status_code == 200:
                        return True
            except Exception as e:
                logger.debug("尝试 FRPS 热重载端点 %s 失败: %s", base, e)
                continue
    return False


async def generate_frps_config(
    port: int = 7000,
    auth_token: str | None = None,
    server_ip: str | None = None,
    disabled_ports: list[int] | None = None,
    current_dashboard_pwd: str | None = None,
) -> dict[str, Any]:
    """
    生成 FRPS 配置文件

    Args:
        port: FRPS 监听端口
        auth_token: 认证 Token
        server_ip: 公网 IP
        disabled_ports: 禁用的端口列表，例如 [6001, 6005]
    """
    if not auth_token:
        auth_token = secrets.token_hex(16)

    # 生成 Dashboard 密码（用于 FRPS Admin API）
    dashboard_pwd = secrets.token_hex(8)

    # 计算 allowPorts
    # 默认允许所有端口 (1-65535)
    # 只有当存在禁用端口时，才生成 allowPorts 配置来排除它们
    allow_ports_config = ""

    if disabled_ports:
        # 全端口范围
        total_start = 1
        total_end = 65535

        allowed_ranges: list[str] = []
        current_start = total_start

        # 排序并去重
        sorted_disabled = sorted({int(p) for p in disabled_ports if total_start <= int(p) <= total_end})

        for p in sorted_disabled:
            if p > current_start:
                if p - 1 == current_start:
                    allowed_ranges.append(str(current_start))
                else:
                    allowed_ranges.append(f"{current_start}-{p-1}")
            current_start = p + 1

        if current_start <= total_end:
            if current_start == total_end:
                allowed_ranges.append(str(current_start))
            else:
                allowed_ranges.append(f"{current_start}-{total_end}")

        # 如果排除了所有端口（极端情况），allowed_ranges 为空，这将导致 allowPorts = []，即拒绝所有
        if allowed_ranges:
            items_str = ", ".join(f'"{r}"' for r in allowed_ranges)
            allow_ports_config = f"allowPorts = [{items_str}]"
        else:
            allow_ports_config = "allowPorts = []"  # 禁用所有端口

    try:
        # 生成配置内容（包含 Dashboard API 配置，仅监听本地回环地址，严禁公网暴露）
        config_content = f"""bindPort = {port}
auth.token = "{auth_token}"

# Dashboard API (用于管理后台获取客户端状态，仅限本机访问)
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "{dashboard_pwd}"

# 端口访问控制
{allow_ports_config}

# 由 FRP Manager 自动生成
# 修改后需要重载或重启 FRPS
"""

        # 写入配置文件并锁定为 0600 权限（防未授权用户读取凭据）
        config_path = get_frps_config_path()
        with open(config_path, "w") as f:
            f.write(config_content)
        with contextlib.suppress(OSError):
            os.chmod(config_path, 0o600)

        # 优先尝试通过 FRPS Admin API 热重载（无需重启，避免已有隧道断连）
        frps_restarted = False
        restart_message = ""

        # 尝试使用新旧密码热重载
        pwds_to_try = [p for p in [current_dashboard_pwd, dashboard_pwd] if p]
        api_reloaded = await reload_frps_via_api(pwds_to_try)

        if api_reloaded:
            print("[INFO] FRPS 配置已通过 Admin API 热重载生效（零断连）")
            frps_restarted = True
            restart_message = "FRPS 配置已热重载生效"
        else:
            try:
                # 优先原生服务重启（systemctl），回退至容器模式
                result = await asyncio.to_thread(restart_frps_service, 30)
                if result.returncode == 0:
                    print("[INFO] FRPS 服务已成功重启")
                    frps_restarted = True
                    restart_message = "FRPS 已重启"
                    await asyncio.sleep(2)
                else:
                    restart_message = f"FRPS 重启提示: {result.stderr.strip()}"
                    print(f"[WARN] {restart_message}")
            except Exception as e:
                restart_message = f"无法重启 FRPS: {e!s}"
                print(f"[WARN] {restart_message}")

        # 获取公网 IP（优先使用用户提供的）
        if server_ip and server_ip.strip():
            public_ip = server_ip.strip()
        else:
            public_ip = await get_public_ip()

        # 获取 FRP 最新版本号
        frp_version = await get_latest_frp_version()

        return {
            "success": True,
            "message": "FRPS 配置已生成" + (" 并已重启" if frps_restarted else ""),
            "frps_restarted": frps_restarted,
            "restart_message": restart_message,
            "info": {
                "version": frp_version,  # 从 GitHub API 获取的真实版本号
                "port": port,
                "auth_token": auth_token,
                "public_ip": public_ip,
                "dashboard_pwd": dashboard_pwd  # Dashboard API 密码
            }
        }
    except Exception as e:
        print(f"配置生成失败: {e}")
        return {
            "success": False,
            "message": f"配置生成失败: {str(e)}",
            "info": {}
        }
