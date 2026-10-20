"""
服务运行时工具（支持直接子进程管理、原生系统服务与容器模式回退）
统一封装 FRPS 控制命令，单容器架构下直接作为内部常驻子进程管理
"""
from __future__ import annotations

import contextlib
import logging
import os
import shutil
import subprocess
import time

logger = logging.getLogger(__name__)

DOCKER_TIMEOUT = int(os.environ.get("DOCKER_TIMEOUT", "30"))


def _is_executable(filepath: str) -> bool:
    try:
        return os.path.isfile(filepath) and os.access(filepath, os.X_OK)
    except (OSError, ValueError):
        return False


class FRPSProcessManager:
    """直接管理 FRPS 常驻子进程（单容器全合一模式核心）"""
    _process: subprocess.Popen | None = None

    @classmethod
    def get_frps_bin(cls) -> str | None:
        candidates = [
            "/usr/local/bin/frps",
            "/usr/bin/frps",
            "/app/bin/frps",
            "./bin/frps",
            "frps",
        ]
        for c in candidates:
            with contextlib.suppress(OSError, ValueError):
                resolved = shutil.which(c)
                if resolved and _is_executable(resolved):
                    return resolved
            if _is_executable(c):
                return c
        return None

    @classmethod
    def start_or_restart(cls, config_path: str | None = None, timeout: int = 15) -> subprocess.CompletedProcess:
        """启动或重启 FRPS 进程"""
        from frp_deploy import get_frps_config_path

        if config_path is None:
            config_path = get_frps_config_path()

        # 先优雅关闭旧进程
        cls.stop()

        frps_bin = cls.get_frps_bin()
        if not frps_bin:
            return subprocess.CompletedProcess(
                args=["frps", "-c", config_path],
                returncode=1,
                stdout="",
                stderr="未在系统中找到可执行的 frps 二进制文件",
            )

        if not os.path.isfile(config_path):
            # 若配置文件尚不存在，初始化一个默认配置文件
            try:
                os.makedirs(os.path.dirname(os.path.abspath(config_path)), exist_ok=True)
                import secrets
                init_token = secrets.token_hex(16)
                with open(config_path, "w", encoding="utf-8") as f:
                    f.write(f"bindPort = 7000\nauth.token = \"{init_token}\"\n")
            except Exception as e:
                return subprocess.CompletedProcess(
                    args=[frps_bin, "-c", config_path],
                    returncode=1,
                    stdout="",
                    stderr=f"创建默认 frps.toml 失败: {e}",
                )

        try:
            logger.info("正在以子进程方式启动 FRPS: %s -c %s", frps_bin, config_path)
            cls._process = subprocess.Popen(
                [frps_bin, "-c", config_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            # 等待 0.5s 确认进程未因配置或端口冲突立即闪退
            time.sleep(0.5)
            if cls._process.poll() is not None:
                err_msg = cls._process.stderr.read() if cls._process.stderr else "FRPS 进程异常退出"
                logger.error("FRPS 启动失败 (退出码 %d): %s", cls._process.poll(), err_msg)
                return subprocess.CompletedProcess(
                    args=[frps_bin, "-c", config_path],
                    returncode=cls._process.poll() or 1,
                    stdout="",
                    stderr=err_msg,
                )

            logger.info("FRPS 子进程已成功启动 (PID %d)", cls._process.pid)
            return subprocess.CompletedProcess(
                args=[frps_bin, "-c", config_path],
                returncode=0,
                stdout=f"FRPS 服务已启动 (PID {cls._process.pid})",
                stderr="",
            )
        except Exception as e:
            logger.exception("启动 FRPS 子进程异常: %s", e)
            return subprocess.CompletedProcess(
                args=[frps_bin, "-c", config_path],
                returncode=1,
                stdout="",
                stderr=str(e),
            )

    @classmethod
    def stop(cls):
        """停止 FRPS 子进程"""
        if cls._process is not None:
            with contextlib.suppress(Exception):
                if cls._process.poll() is None:
                    cls._process.terminate()
                    cls._process.wait(timeout=3)
            with contextlib.suppress(Exception):
                if cls._process.poll() is None:
                    cls._process.kill()
            cls._process = None

    @classmethod
    def is_running(cls) -> bool:
        return cls._process is not None and cls._process.poll() is None


def run_docker(
    args: list[str],
    timeout: int | None = None,
    capture_output: bool = True,
    text: bool = True,
    check: bool = False,
) -> subprocess.CompletedProcess:
    """执行 Docker 命令（仅供历史多容器部署回退使用）。"""
    if timeout is None:
        timeout = DOCKER_TIMEOUT

    command = ["docker", *args]

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
    1. 优先使用内置子进程管理（单容器全合一模式，无任何外部 Socket 或 systemd 依赖）；
    2. 其次回退至原生 systemctl restart frps；
    3. 最后回退至 docker restart frps。
    """
    # 1. 单容器全合一模式：直接检查本地是否存在 frps 可执行文件
    if FRPSProcessManager.get_frps_bin():
        res = FRPSProcessManager.start_or_restart(timeout=timeout)
        if res.returncode == 0:
            return res
        # 若直接启动失败，记录日志并尝试回退
        logger.warning("FRPSProcessManager 启动返回非零: %s", res.stderr)

    # 2. 原生服务回退
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

    # 3. 容器引擎回退
    if shutil.which("docker"):
        try:
            return run_docker(["restart", "frps"], timeout=timeout)
        except Exception as e:
            logger.debug("通过 docker 重启 frps 异常: %s", e)

    return subprocess.CompletedProcess(
        args=["restart", "frps"],
        returncode=1,
        stdout="",
        stderr="未检测到 frps 二进制、systemctl 或 Docker 容器",
    )
