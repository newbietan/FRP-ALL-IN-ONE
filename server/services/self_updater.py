"""Durable, version-pinned, rollback-capable server upgrades."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import models
from services.container_upgrade import (
    Engine,
    begin_job,
    data_directory,
    launch_upgrade,
    normalize_version,
    read_status,
)

logger = logging.getLogger(__name__)
_tasks: set[asyncio.Task] = set()
FALLBACK = "curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh -o /tmp/frp-upgrade.sh && sudo bash /tmp/frp-upgrade.sh"


def status_path() -> Path:
    return data_directory("server") / "upgrade" / "server.json"


def get_docker_socket_path() -> str | None:
    for value in ("/var/run/docker.sock", "/run/podman/podman.sock"):
        if Path(value).is_socket():
            return value
    return None


def can_self_upgrade() -> tuple[bool, str]:
    sock = get_docker_socket_path()
    if not sock:
        return False, "未挂载 Docker/Podman Socket，请在宿主机执行升级命令"
    try:
        if not os.access(sock, os.R_OK | os.W_OK):
            return False, "容器引擎 Socket 权限不足"
    except OSError:
        return False, "容器引擎 Socket 不可访问"
    return True, "支持配置保留、健康验证与失败回滚；切换时连接会短暂中断"


def get_upgrade_status() -> dict:
    capable, reason = can_self_upgrade()
    state = read_status(status_path())
    public = {key: state.get(key) for key in (
        "job_id", "target_version", "step", "is_upgrading", "message", "error", "started_at", "updated_at")}
    return {**public, "can_self_upgrade": capable, "reason": reason, "fallback_command": FALLBACK}


async def _prepare(sock: str, job: dict):
    try:
        await asyncio.to_thread(launch_upgrade, Engine(sock), job["container"], job["target_version"],
                                "server", status_path(), job)
    except Exception:
        # The runner persists the failure and releases the transaction lock.
        logger.exception("Server upgrade preparation failed (job=%s)", job["job_id"])


async def trigger_self_upgrade(target_version: str | None = None) -> dict:
    capable, reason = can_self_upgrade()
    if not capable:
        return {"success": False, "message": reason, "can_self_upgrade": False, "fallback_command": FALLBACK}
    try:
        if not target_version:
            from services.update_checker import check_github_update
            release = await check_github_update(force=True)
            if release.get("error"):
                raise ValueError("无法确认已发布版本，请稍后重试")
            target_version = release["latest_version"]
        target_version = normalize_version(target_version)
        if not models.is_newer_version(target_version, models.APP_VERSION):
            raise ValueError("目标版本必须高于当前版本")
        # Fixed per-installation resource name, not host-network HOSTNAME.
        container = os.environ.get("FRP_CONTAINER_NAME", "frp-server")
        job = begin_job(status_path(), target_version, "server", container)
        task = asyncio.create_task(_prepare(get_docker_socket_path() or "", job))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
        return {"success": True, "job_id": job["job_id"], "target_version": target_version,
                "is_upgrading": True, "message": "升级事务已创建；最终结果以健康检查和持久状态为准"}
    except (ValueError, RuntimeError, OSError) as exc:
        return {"success": False, "message": str(exc), "fallback_command": FALLBACK}
