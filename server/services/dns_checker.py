"""
DNS 检查服务
验证域名解析是否正确指向本服务器
"""
from __future__ import annotations

import asyncio
import logging
import socket
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def get_public_ip() -> str | None:
    """获取本机公网 IP"""
    services = [
        "https://api.ipify.org?format=json",
        "https://httpbin.org/ip",
        "https://ipinfo.io/json",
    ]
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            for url in services:
                try:
                    resp = await client.get(url)
                    data = resp.json()
                    if "ip" in data:
                        return str(data["ip"])
                    if "origin" in data:
                        return str(data["origin"])
                except Exception as e:
                    logger.debug("从服务 %s 获取公网 IP 失败: %s", url, e)
                    continue
    except Exception as e:
        logger.debug("获取公网 IP 失败: %s", e)
    return None


async def check_dns_resolution(domain: str, expected_ip: str | None = None) -> dict[str, Any]:
    """
    检查域名 DNS 解析（异步线程执行，避免阻塞主事件循环）

    Args:
        domain: 要检查的域名
        expected_ip: 期望解析到的 IP（不指定则使用本机公网 IP）

    Returns:
        {
            "success": bool,
            "domain": str,
            "resolved_ip": str or None,
            "expected_ip": str,
            "matches": bool,
            "message": str
        }
    """
    if expected_ip is None:
        fetched_ip = await get_public_ip()
        expected_ip = fetched_ip if fetched_ip is not None else "未知(获取失败)"

    try:
        # 异步线程解析域名，防止 DNS 缓慢时阻塞 FastAPI 的主事件循环
        resolved_ip: str = await asyncio.to_thread(socket.gethostbyname, domain)

        # 检查是否匹配
        matches = resolved_ip == expected_ip

        if matches:
            return {
                "success": True,
                "domain": domain,
                "resolved_ip": resolved_ip,
                "expected_ip": expected_ip,
                "matches": True,
                "message": f"DNS 解析完全匹配：{domain} -> {resolved_ip}",
            }
        else:
            return {
                "success": True,  # 放宽限制：允许 CDN 或多 IP 情况
                "domain": domain,
                "resolved_ip": resolved_ip,
                "expected_ip": expected_ip,
                "matches": False,
                "message": f"DNS 解析成功 ({resolved_ip})。与本机获取的 IP ({expected_ip}) 不一致，若使用了 CDN/NAT 属于正常现象，请确保流量能正常触达本机。",
            }
    except socket.gaierror:
        return {
            "success": False,
            "domain": domain,
            "resolved_ip": None,
            "expected_ip": expected_ip,
            "matches": False,
            "message": f"无法解析域名：{domain}。请确保域名已正确添加 A 记录指向 {expected_ip}",
        }
    except Exception as e:
        return {
            "success": False,
            "domain": domain,
            "resolved_ip": None,
            "expected_ip": expected_ip,
            "matches": False,
            "message": f"DNS 检查失败：{e!s}",
        }
