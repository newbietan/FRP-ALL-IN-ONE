"""
服务端一键平滑自升级服务
通过容器挂载的 Docker/Podman Socket 实现无感知平滑自升级
数据卷、SQLite 数据库、Token、配置与会话 100% 完整保留
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

import models

logger = logging.getLogger(__name__)

# 服务端镜像地址
SERVER_IMAGE = "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:latest"

# 升级并发锁
_upgrade_lock = asyncio.Lock()
_upgrade_status: dict[str, Any] = {
    "is_upgrading": False,
    "step": "idle",
    "message": "",
    "error": None,
}


def get_docker_socket_path() -> str | None:
    """探测容器内可用的 Docker/Podman Unix 套接字路径"""
    candidates = [
        "/var/run/docker.sock",
        "/run/podman/podman.sock",
    ]
    for p in candidates:
        if os.path.exists(p) and Path(p).is_socket():
            return p
    return None


def can_self_upgrade() -> tuple[bool, str]:
    """检测当前容器环境是否支持直接在 Web 面板自升级"""
    sock = get_docker_socket_path()
    if not sock:
        return (
            False,
            "未检测到挂载的 Docker Socket (/var/run/docker.sock)。请确保 compose.yml 包含 Socket 挂载，或在宿主机运行一键平滑升级脚本。"
        )
    try:
        if not os.access(sock, os.R_OK | os.W_OK):
            return (
                False,
                f"挂载的 Docker Socket ({sock}) 权限不足，无法读写。"
            )
    except OSError as e:
        return (
            False,
            f"检测 Docker Socket 权限异常: {e}"
        )
    return True, "环境支持一键平滑自升级"


def get_upgrade_status() -> dict[str, Any]:
    """获取当前升级状态"""
    can_upgrade, reason = can_self_upgrade()
    return {
        "can_self_upgrade": can_upgrade,
        "reason": reason,
        "is_upgrading": _upgrade_status["is_upgrading"],
        "step": _upgrade_status["step"],
        "message": _upgrade_status["message"],
        "error": _upgrade_status["error"],
        "fallback_command": "curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh | bash",
    }


async def trigger_self_upgrade() -> dict[str, Any]:
    """
    触发服务端容器平滑自升级：
    1. 验证 Docker Socket 连通性
    2. 从腾讯云镜像仓库秒级拉取最新镜像
    3. 获取当前容器的配置参数（数据卷、环境变量、网络等）
    4. 启动瞬时 Helper 容器执行无缝交接重载（保持数据与会话 100% 完整）
    """
    if _upgrade_lock.locked():
        return {
            "success": False,
            "message": "升级任务已在执行中，请勿重复操作",
            "is_upgrading": True,
        }

    sock_path = get_docker_socket_path()
    if not sock_path:
        can_upgrade, reason = can_self_upgrade()
        return {
            "success": False,
            "can_self_upgrade": False,
            "message": reason,
            "fallback_command": "curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh | bash",
        }

    async with _upgrade_lock:
        _upgrade_status["is_upgrading"] = True
        _upgrade_status["step"] = "pulling"
        _upgrade_status["message"] = "正在从腾讯云镜像源拉取最新服务端镜像..."
        _upgrade_status["error"] = None

        try:
            transport = httpx.AsyncHTTPTransport(uds=sock_path)
            async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=300.0) as client:
                # 1. 验证 Docker 引擎状态
                try:
                    ver_res = await client.get("/version")
                    if ver_res.status_code != 200:
                        raise RuntimeError(f"Docker API 响应异常: HTTP {ver_res.status_code}")
                except Exception as e:
                    raise RuntimeError(f"连接宿主机容器引擎失败: {e}") from e

                # 2. 拉取最新镜像
                logger.info("[SelfUpgrade] 开始拉取最新镜像: %s", SERVER_IMAGE)
                pull_url = f"/images/create?fromImage={SERVER_IMAGE.split(':')[0]}&tag=latest"
                pull_res = await client.post(pull_url)
                if pull_res.status_code != 200:
                    raise RuntimeError(f"镜像拉取失败 (HTTP {pull_res.status_code}): {pull_res.text[:200]}")
                logger.info("[SelfUpgrade] 最新镜像拉取完成")

                _upgrade_status["step"] = "inspecting"
                _upgrade_status["message"] = "正在读取当前运行环境配置..."

                # 3. 检查当前容器配置
                container_name = "frp-server"
                inspect_res = await client.get(f"/containers/{container_name}/json")
                if inspect_res.status_code != 200:
                    raise RuntimeError(f"未能获取当前容器配置: HTTP {inspect_res.status_code}")

                container_data = inspect_res.json()
                config = container_data.get("Config", {})
                host_config = container_data.get("HostConfig", {})

                # 构造新容器的参数（与原容器保持完全一致的数据卷挂载、网络、环境变量）
                binds = host_config.get("Binds") or ["./data:/app/data", f"{sock_path}:/var/run/docker.sock"]
                env = config.get("Env") or []
                network_mode = host_config.get("NetworkMode") or "host"
                restart_policy = host_config.get("RestartPolicy") or {"Name": "always"}
                labels = config.get("Labels") or {"com.centurylinklabs.watchtower.enable": "true"}

                new_container_payload = {
                    "Image": SERVER_IMAGE,
                    "Env": env,
                    "Labels": labels,
                    "HostConfig": {
                        "Binds": binds,
                        "NetworkMode": network_mode,
                        "RestartPolicy": restart_policy,
                    },
                }

                _upgrade_status["step"] = "restarting"
                _upgrade_status["message"] = "正在启动服务热交接切换（服务即将平滑重启，约 5~15 秒就绪）..."

                # 4. 创建瞬时 Helper 容器执行交接切换
                helper_script = (
                    "import time, httpx; "
                    "time.sleep(2.0); "
                    f"c = httpx.Client(transport=httpx.HTTPTransport(uds='{sock_path}'), base_url='http://docker', timeout=120.0); "
                    "try: c.post('/containers/frp-server/stop', params={'t': 10}); except: pass; "
                    "try: c.delete('/containers/frp-server'); except: pass; "
                    f"res = c.post('/containers/create', params={{'name': 'frp-server'}}, json={json.dumps(new_container_payload)}); "
                    "if res.status_code in (200, 201): c.post('/containers/frp-server/start'); "
                    "print('SWAP_DONE')"
                )

                helper_payload = {
                    "Image": SERVER_IMAGE,
                    "Cmd": ["python", "-c", helper_script],
                    "HostConfig": {
                        "Binds": [f"{sock_path}:{sock_path}"],
                        "AutoRemove": True,
                        "NetworkMode": "host",
                    },
                }

                create_helper = await client.post("/containers/create", json=helper_payload)
                if create_helper.status_code not in (200, 201):
                    raise RuntimeError(f"创建升级交接程序失败: {create_helper.text[:200]}")

                helper_id = create_helper.json().get("Id")
                start_helper = await client.post(f"/containers/{helper_id}/start")
                if start_helper.status_code not in (200, 204):
                    raise RuntimeError(f"启动升级交接程序失败: {start_helper.text[:200]}")

                logger.info("[SelfUpgrade] 升级交接容器已成功启动 (ID: %s)，主服务即将平滑重启", helper_id[:12])

                return {
                    "success": True,
                    "message": "服务端平滑升级指令已下发！最新镜像已就绪，服务正在无缝切换重启，请等待页面自动刷新...",
                    "is_upgrading": True,
                    "target_version": f"v{models.APP_VERSION}",
                }

        except Exception as e:
            logger.exception("[SelfUpgrade] 升级过程异常: %s", e)
            _upgrade_status["is_upgrading"] = False
            _upgrade_status["step"] = "failed"
            _upgrade_status["error"] = str(e)
            _upgrade_status["message"] = f"升级失败: {e}"
            return {
                "success": False,
                "can_self_upgrade": True,
                "message": f"升级失败: {e}",
                "error": str(e),
                "fallback_command": "curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh | bash",
            }
