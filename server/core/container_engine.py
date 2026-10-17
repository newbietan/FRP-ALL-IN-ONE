"""
服务运行时工具（支持原生系统服务管理与容器模式回退）
统一封装 FRPS 及 Nginx 等服务控制命令，解耦具体部署形式
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess

logger = logging.getLogger(__name__)

PODMAN_BIN = os.environ.get("PODMAN_BIN", "podman")
PODMAN_TIMEOUT = int(os.environ.get("PODMAN_TIMEOUT", "30"))
PODMAN_URL = os.environ.get("PODMAN_URL", "").strip()


def run_podman(
    args: list[str],
    timeout: int | None = None,
    capture_output: bool = True,
    text: bool = True,
    check: bool = False,
) -> subprocess.CompletedProcess:
    """执行 Podman 命令（容器模式回退）"""
    if timeout is None:
        timeout = PODMAN_TIMEOUT

    command = [PODMAN_BIN]
    if PODMAN_URL:
        command.extend(["--url", PODMAN_URL])
    command.extend(args)

    return subprocess.run(
        command,
        check=check,
        capture_output=capture_output,
        timeout=timeout,
        text=text,
    )


def restart_frps_service(timeout: int = 15) -> subprocess.CompletedProcess:
    """
    重启 FRPS 服务：
    1. 优先使用系统原生 systemctl restart frps（原生部署模式，无容器依赖）；
    2. 其次回退至 podman restart frps（兼容容器部署模式）。
    """
    if shutil.which("systemctl"):
        try:
            res = subprocess.run(
                ["systemctl", "restart", "frps"],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            if res.returncode == 0:
                return res
        except Exception as e:
            logger.debug("通过 systemctl 重启 frps 异常: %s", e)

    if shutil.which(PODMAN_BIN):
        try:
            return run_podman(["restart", "frps"], timeout=timeout)
        except Exception as e:
            logger.debug("通过 podman 重启 frps 异常: %s", e)

    return subprocess.CompletedProcess(
        args=["restart", "frps"],
        returncode=1,
        stdout="",
        stderr="未检测到 systemctl frps 服务或 podman 容器，请手动重启 FRPS",
    )
