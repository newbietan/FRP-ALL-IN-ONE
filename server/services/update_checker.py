"""
版本检测服务
负责定期或按需检测 GitHub Releases 最新版本并进行语义化对比
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

import models

logger = logging.getLogger(__name__)

# 内存缓存（避免频繁请求触发 GitHub API 60次/小时未授权限流）
_update_cache: dict[str, Any] = {
    "data": None,
    "expires_at": 0.0,
}

CACHE_TTL_SECONDS = 1800.0  # 30 分钟缓存


def parse_version_tuple(v: str) -> tuple[int, ...]:
    """解析版本字符串为整型元组供语义化版本对比，例如 'v3.0.1' -> (3, 0, 1)"""
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


async def check_github_update(force: bool = False) -> dict[str, Any]:
    """
    检查 GitHub Releases 最新版本
    force=True 时绕过缓存强制请求 GitHub API
    """
    now = time.time()
    if not force and _update_cache["data"] is not None and now < _update_cache["expires_at"]:
        return dict(_update_cache["data"])

    current_ver = f"v{models.APP_VERSION}"
    url = f"https://api.github.com/repos/{models.GITHUB_REPO}/releases/latest"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": f"FRP-ALL-IN-ONE-Server/{models.APP_VERSION}",
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                latest_tag = str(data.get("tag_name") or "").strip()
                has_update = models.is_newer_version(latest_tag, current_ver)

                result: dict[str, Any] = {
                    "current_version": current_ver,
                    "latest_version": latest_tag,
                    "has_update": has_update,
                    "release_name": data.get("name") or latest_tag,
                    "release_notes": data.get("body") or "",
                    "published_at": data.get("published_at"),
                    "html_url": data.get("html_url") or f"https://github.com/{models.GITHUB_REPO}/releases",
                    "checked_at": int(now),
                    "error": None,
                }
                _update_cache["data"] = result
                _update_cache["expires_at"] = now + CACHE_TTL_SECONDS
                return result

            elif resp.status_code == 403:
                # 触发 GitHub 速率限制
                logger.warning("GitHub Releases API 触发访问频率限制 (403)")
                err_msg = "GitHub API 请求频率受限，请稍后再试"
            else:
                err_msg = f"GitHub API 响应异常: HTTP {resp.status_code}"

    except Exception as e:
        logger.warning("检查版本更新失败: %s", e)
        err_msg = f"连接 GitHub 失败: {e}"

    # 若有历史缓存则降级使用历史缓存，否则返回当前无更新
    if _update_cache["data"] is not None:
        cached = dict(_update_cache["data"])
        cached["error"] = err_msg
        return cached

    return {
        "current_version": current_ver,
        "latest_version": current_ver,
        "has_update": False,
        "release_name": None,
        "release_notes": "",
        "published_at": None,
        "html_url": f"https://github.com/{models.GITHUB_REPO}/releases",
        "checked_at": int(now),
        "error": err_msg,
    }
