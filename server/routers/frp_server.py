"""
FRP 服务端管理路由
包含 FRPS 部署、端口管理、Agent 安装脚本生成等
"""
from __future__ import annotations

import contextlib
import logging
import subprocess
import time

from core import get_current_user, get_db
from core.container_engine import run_podman
import crud
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
import frp_deploy
import httpx
import models
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/frp", tags=["FRP 服务端管理"])


@router.get("/server-status")
async def get_frps_status(
    db: Session = Depends(get_db),
    current_user: models.Admin | None = Depends(get_current_user)
):
    """
    从 FRPS Dashboard API 获取实时状态
    包括已连接的客户端和代理信息
    """
    import re

    # 获取 Dashboard 密码
    dashboard_pwd = crud.get_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD)
    if not dashboard_pwd:
        return {
            "success": False,
            "message": "FRPS 尚未配置，请先完成服务端部署",
            "clients": [],
            "proxies": []
        }

    # 尝试多种可能的连接地址
    possible_urls = [
        "http://127.0.0.1:7500/api",
        "http://host.containers.internal:7500/api",
        "http://172.17.0.1:7500/api",
        "http://frps:7500/api",
    ]

    base_url = None
    server_info = {}

    async with httpx.AsyncClient(timeout=5, auth=httpx.BasicAuth("admin", dashboard_pwd)) as client:
        for url in possible_urls:
            try:
                resp = await client.get(f"{url}/serverinfo")
                if resp.status_code == 200:
                    base_url = url
                    server_info = resp.json()
                    break
            except Exception as e:
                logger.debug("探测 FRPS Dashboard %s 失败: %s", url, e)
                continue

        if not base_url:
            return {
                "success": False,
                "message": "无法连接到 FRPS Dashboard",
                "clients": [],
                "proxies": []
            }

        try:
            def _get_any(d: dict, keys, default=None):
                for k in keys:
                    if k in d and d.get(k) is not None:
                        return d.get(k)
                return default

            def _to_int(value, default=0):
                try:
                    if value is None:
                        return default
                    if isinstance(value, bool):
                        return int(value)
                    if isinstance(value, (int, float)):
                        return int(value)
                    s = str(value).strip()
                    if not s:
                        return default
                    return int(float(s))
                except Exception:
                    return default

            def _to_bytes(value, default=0):
                if value is None:
                    return default
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return int(value)
                s = str(value).strip()
                if not s:
                    return default
                with contextlib.suppress(Exception):
                    return int(float(s))
                m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([KMGTP]?B)\s*$", s, re.IGNORECASE)
                if not m:
                    return default
                num = float(m.group(1))
                unit = m.group(2).upper()
                scale = {
                    "B": 1,
                    "KB": 1024,
                    "MB": 1024 ** 2,
                    "GB": 1024 ** 3,
                    "TB": 1024 ** 4,
                    "PB": 1024 ** 5,
                }.get(unit, 1)
                return int(num * scale)

            def _normalize_proxy(proxy: dict) -> dict:
                if not isinstance(proxy, dict):
                    return {}
                name = _get_any(proxy, ["name"], "")
                ptype = _get_any(proxy, ["type"], "")
                conf = _get_any(proxy, ["conf"], {}) or {}
                cur_conns = _to_int(_get_any(proxy, ["curConns", "cur_conns"], 0), 0)
                today_in = _to_bytes(_get_any(proxy, ["todayTrafficIn", "today_traffic_in"], 0), 0)
                today_out = _to_bytes(_get_any(proxy, ["todayTrafficOut", "today_traffic_out"], 0), 0)
                return {
                    "name": name,
                    "type": ptype,
                    "conf": conf,
                    "cur_conns": cur_conns,
                    "today_traffic_in": today_in,
                    "today_traffic_out": today_out,
                }

            # 获取各类代理列表
            tcp_proxies, udp_proxies, http_proxies = [], [], []

            with contextlib.suppress(Exception):
                resp = await client.get(f"{base_url}/proxy/tcp")
                if resp.status_code == 200:
                    tcp_proxies = resp.json().get("proxies", []) or []

            with contextlib.suppress(Exception):
                resp = await client.get(f"{base_url}/proxy/udp")
                if resp.status_code == 200:
                    udp_proxies = resp.json().get("proxies", []) or []

            with contextlib.suppress(Exception):
                resp = await client.get(f"{base_url}/proxy/http")
                if resp.status_code == 200:
                    http_proxies = resp.json().get("proxies", []) or []

            all_proxies_raw = tcp_proxies + udp_proxies + http_proxies
            all_proxies = [_normalize_proxy(p) for p in all_proxies_raw]

            # 提取唯一的客户端名称
            client_names = set()
            for proxy in all_proxies:
                name = proxy.get("name", "")
                if "." in name:
                    client_names.add(name.split(".")[0])

            clients = []
            for name in client_names:
                client_proxies = [p for p in all_proxies if p.get("name", "").startswith(f"{name}.")]
                clients.append({
                    "name": name,
                    "status": "online",
                    "proxy_count": len(client_proxies),
                    "proxies": client_proxies
                })

            normalized_server_info = dict(server_info or {})
            normalized_server_info["curConns"] = _to_int(_get_any(normalized_server_info, ["curConns", "cur_conns"], 0), 0)
            normalized_server_info["totalTrafficIn"] = _to_bytes(_get_any(normalized_server_info, ["totalTrafficIn", "total_traffic_in"], 0), 0)
            normalized_server_info["totalTrafficOut"] = _to_bytes(_get_any(normalized_server_info, ["totalTrafficOut", "total_traffic_out"], 0), 0)

            return {
                "success": True,
                "server_info": normalized_server_info,
                "total_clients": len(clients),
                "total_proxies": len(all_proxies),
                "clients": clients,
                "proxies": all_proxies,
                "aggregated_traffic_in": sum(p.get("today_traffic_in", 0) for p in all_proxies),
                "aggregated_traffic_out": sum(p.get("today_traffic_out", 0) for p in all_proxies)
            }

        except Exception as e:
            logger.exception("获取 FRPS 状态失败: %s", e)
            return {
                "success": False,
                "message": "获取 FRPS 状态失败，请检查服务端日志",
                "clients": [],
                "proxies": []
            }


@router.post("/deploy-server")
async def deploy_frp_server(
    port: int = 7000,
    auth_token: str | None = None,
    server_ip: str | None = None,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """生成 FRPS 配置文件"""
    if not (1 <= port <= 65535):
        raise HTTPException(status_code=400, detail="端口必须在 1-65535 之间")
    current_pwd = crud.get_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD)
    result = await frp_deploy.generate_frps_config(port, auth_token, server_ip, current_dashboard_pwd=current_pwd)

    if result["success"]:
        info = result["info"]
        crud.set_config(db, models.ConfigKeys.FRPS_VERSION, info["version"])
        crud.set_config(db, models.ConfigKeys.FRPS_PORT, str(info["port"]))
        crud.set_config(db, models.ConfigKeys.FRPS_AUTH_TOKEN, info["auth_token"])
        crud.set_config(db, models.ConfigKeys.SERVER_PUBLIC_IP, info["public_ip"])
        crud.set_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD, info["dashboard_pwd"])
        crud.set_config(db, models.ConfigKeys.IS_INITIALIZED, "true")

    return result


@router.post("/restart-frps")
async def restart_frps(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """手动重启或热重载 FRPS"""
    dashboard_pwd = crud.get_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD) or ""
    if dashboard_pwd and await frp_deploy.reload_frps_via_api([dashboard_pwd]):
        return {"success": True, "message": "FRPS 已通过 API 成功热重载（零断连）"}
    try:
        import asyncio
        result = await asyncio.to_thread(run_podman, ["restart", "frps"], 30)
        if result.returncode == 0:
            return {"success": True, "message": "FRPS 重启成功"}
        else:
            return {"success": False, "message": f"重启失败: {result.stderr.strip()}"}
    except FileNotFoundError:
        return {"success": False, "message": "未找到 podman 命令"}
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "重启超时"}
    except Exception as e:
        return {"success": False, "message": str(e)}


# ===========================
# 端口管理
# ===========================

@router.get("/disabled-ports")
async def get_disabled_ports(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取禁用的端口列表"""
    disabled_ports_str = crud.get_config(db, models.ConfigKeys.DISABLED_PORTS)
    if disabled_ports_str:
        return {"disabled_ports": [int(p) for p in disabled_ports_str.split(",") if p.strip()]}
    return {"disabled_ports": []}


@router.post("/ports/disable")
async def disable_port(
    port: int,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """禁用指定端口"""
    current_str = crud.get_config(db, models.ConfigKeys.DISABLED_PORTS) or ""
    current_ports = [int(p) for p in current_str.split(",") if p.strip()]

    if port not in current_ports:
        current_ports.append(port)
        crud.set_config(db, models.ConfigKeys.DISABLED_PORTS, ",".join(map(str, current_ports)))

        frps_port = int(crud.get_config(db, models.ConfigKeys.FRPS_PORT) or 7000)
        auth_token = crud.get_config(db, models.ConfigKeys.FRPS_AUTH_TOKEN)
        server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP)
        current_pwd = crud.get_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD)

        await frp_deploy.generate_frps_config(frps_port, auth_token, server_ip, current_ports, current_dashboard_pwd=current_pwd)

        return {"success": True, "message": f"端口 {port} 已禁用，FRPS 已生效"}

    return {"success": True, "message": f"端口 {port} 已经是禁用状态"}


@router.post("/ports/enable")
async def enable_port(
    port: int,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """启用指定端口"""
    current_str = crud.get_config(db, models.ConfigKeys.DISABLED_PORTS) or ""
    current_ports = [int(p) for p in current_str.split(",") if p.strip()]

    if port in current_ports:
        current_ports.remove(port)
        crud.set_config(db, models.ConfigKeys.DISABLED_PORTS, ",".join(map(str, current_ports)))

        frps_port = int(crud.get_config(db, models.ConfigKeys.FRPS_PORT) or 7000)
        auth_token = crud.get_config(db, models.ConfigKeys.FRPS_AUTH_TOKEN)
        server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP)
        current_pwd = crud.get_config(db, models.ConfigKeys.FRPS_DASHBOARD_PWD)

        await frp_deploy.generate_frps_config(frps_port, auth_token, server_ip, current_ports, current_dashboard_pwd=current_pwd)

        return {"success": True, "message": f"端口 {port} 已启用，FRPS 已生效"}

    return {"success": True, "message": f"端口 {port} 未被禁用"}


# ===========================
# 客户端 Agent 容器化部署命令与一键脚本
# ===========================


@router.get("/agent/install-script/{platform}")
async def get_agent_install_script(
    platform: str,
    request: Request,
    client_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """
    获取动态生成的 Agent 安装脚本
    platform: linux, darwin, windows
    """
    import crud as crud_module

    platform = "darwin" if platform == "macos" else platform
    if platform not in {"linux", "darwin", "windows"}:
        raise HTTPException(status_code=400, detail="请选择 linux、darwin 或 windows 容器安装脚本")

    auth_token = crud_module.get_config(db, models.ConfigKeys.FRPS_AUTH_TOKEN) or "frp-token"
    server_ip = crud_module.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or "YOUR_SERVER_IP"
    frps_port = crud_module.get_config(db, models.ConfigKeys.FRPS_PORT) or "7000"
    panel_access_port = (crud_module.get_config(db, models.ConfigKeys.PANEL_ACCESS_PORT) or "").strip()

    # 优先级：① 已配置的面板访问端口（NAT 场景显式指定） → ② 请求 Host 头中携带的端口（浏览器经 NAT 访问时）
    # → ③ 启用 HTTPS+域名 → ④ 公网 IP（裸协议 80）
    forwarded_proto = ""
    forwarded_host = ""
    if request is not None:
        forwarded_proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").split(",")[0].strip().lower()
        forwarded_host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()

    if forwarded_proto in ("https", "wss"):
        ws_scheme = "wss"
    else:
        ws_scheme = "ws"

    tls_enabled = crud_module.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
    server_domain = (crud_module.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or "").strip()
    host_name = server_domain if (tls_enabled and server_domain) else server_ip

    if panel_access_port:
        # 显式 NAT 端口配置：使用配置的域名/公网 IP + 配置的端口
        manager_host = f"{host_name}:{panel_access_port}"
    elif forwarded_host:
        manager_host = forwarded_host
    else:
        # 回退逻辑：启用 HTTPS + 域名时使用域名，否则使用公网 IP
        manager_host = host_name

    if client_id:
        client = crud_module.get_client(db, client_id=client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")
    else:
        suffix = str(int(time.time()))[-6:]
        client = crud_module.create_client_with_token(db, name=f"device-{suffix}")

    client_id = client.id
    client_token = client.auth_token

    if platform == "windows":
        script = _generate_windows_script(server_ip, frps_port, auth_token, client_id, client_token, ws_scheme, manager_host)
        return PlainTextResponse(content=script, media_type="text/plain")
    else:
        os_type = "darwin" if platform == "darwin" else "linux"
        script = _generate_unix_script(server_ip, frps_port, auth_token, client_id, client_token, os_type, ws_scheme, manager_host)
        return PlainTextResponse(content=script, media_type="text/plain")


def _generate_windows_script(server_ip, frps_port, auth_token, client_id, client_token, ws_scheme="ws", manager_host=None):
    """生成 Windows PowerShell 容器一键部署脚本"""
    if manager_host is None:
        manager_host = server_ip
    manager_ws_url = f"{ws_scheme}://{manager_host}/ws/agent/{client_id}"
    image = "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest"
    return f'''# FRP Manager Agent - 容器一键部署脚本 (Windows PowerShell)
$ErrorActionPreference = "Stop"

$SERVER_IP = "{server_ip}"
$FRPS_PORT = "{frps_port}"
$FRPS_TOKEN = "{auth_token}"
$CLIENT_TOKEN = "{client_token}"
$CLIENT_ID = "{client_id}"
$IMAGE = "{image}"
$MANAGER_WS_URL = "{manager_ws_url}"
$INSTALL_DIR = "C:\\frp"

Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  FRP Manager Agent 容器一键部署 (Windows)" -ForegroundColor Cyan
Write-Host "  镜像: $IMAGE (腾讯云 TCR 高速拉取)" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1. 检测容器环境
$CONTAINER_CLI = ""
if (Get-Command docker -ErrorAction SilentlyContinue) {{
    $CONTAINER_CLI = "docker"
}} elseif (Get-Command podman -ErrorAction SilentlyContinue) {{
    $CONTAINER_CLI = "podman"
}}

if ($CONTAINER_CLI -eq "") {{
    Write-Host "[WARN] 未检测到 Docker 或 Podman 环境。" -ForegroundColor Yellow
    Write-Host "请先安装 Docker Desktop: https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
    Write-Host "安装完成并启动后，再次执行此脚本即可自动运行客户端。" -ForegroundColor Green
    Exit 1
}}

Write-Host "[OK] 检测到容器环境: $CONTAINER_CLI" -ForegroundColor Green

# 2. 嗅探宿主机局域网 IP
$HOST_IP = ""
try {{
    $HOST_IP = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {{ 
        $_.InterfaceAlias -notmatch 'vEthernet|Loopback|isatap|Teredo' -and $_.IPAddress -notmatch '^(169\\.254|127\\.)' 
    }} | Select-Object -ExpandProperty IPAddress -First 1)
}} catch {{}}

if ($HOST_IP) {{
    Write-Host "[OK] 检测到宿主机局域网 IP: $HOST_IP" -ForegroundColor Green
}} else {{
    Write-Host "[WARN] 未能自动探测到局域网 IP，Agent 启动后将尝试多级网络探测" -ForegroundColor Yellow
}}

# 3. 创建本地配置目录与基础配置
if (!(Test-Path $INSTALL_DIR)) {{ New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null }}
if (!(Test-Path "$INSTALL_DIR\\logs")) {{ New-Item -ItemType Directory -Path "$INSTALL_DIR\\logs" -Force | Out-Null }}

$config = @"
serverAddr = "$SERVER_IP"
serverPort = $FRPS_PORT
auth.token = "$FRPS_TOKEN"
"@

# 4. 标记归属，供卸载脚本安全识别；使用无 BOM 的 UTF-8 配置
[System.IO.File]::WriteAllText("$INSTALL_DIR\\frpc.toml", $config, (New-Object System.Text.UTF8Encoding($false)))
New-Item -ItemType File -Path "$INSTALL_DIR\\.frp-all-in-one-client" -Force | Out-Null
& $CONTAINER_CLI rm -f frp-agent 2>$null | Out-Null

Write-Host "正在从腾讯云公开镜像仓库拉取并启动 frp-agent 容器..." -ForegroundColor Yellow
& $CONTAINER_CLI pull $IMAGE
if ($LASTEXITCODE -ne 0) {{ throw "镜像拉取失败" }}

& $CONTAINER_CLI run -d `
  --name frp-agent `
  --network host `
  --restart always `
  --label io.frp-all-in-one.role=client `
  --label com.centurylinklabs.watchtower.enable=true `
  -v "${{INSTALL_DIR}}:/opt/frp" `
  -e FRP_AGENT_TOKEN="$CLIENT_TOKEN" `
  -e FRP_HOST_IP="$HOST_IP" `
  $IMAGE `
  -server "$MANAGER_WS_URL" `
  -id "$CLIENT_ID" `
  -config /opt/frp/frpc.toml `
  -log /opt/frp/logs
if ($LASTEXITCODE -ne 0) {{ throw "客户端容器启动失败" }}

Write-Host "======================================================" -ForegroundColor Green
Write-Host "  部署成功！FRP-Agent 容器已在后台运行" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host "容器名称: frp-agent"
Write-Host "客户端 ID: $CLIENT_ID"
if ($HOST_IP) {{
    Write-Host "宿主机 IP: $HOST_IP (在管理面板配置隧道时推荐使用此 IP，勿填 127.0.0.1)" -ForegroundColor Cyan
}}
Write-Host "查看状态: $CONTAINER_CLI ps -f name=frp-agent"
Write-Host "查看日志: $CONTAINER_CLI logs -f frp-agent"
Write-Host "卸载（保留配置和日志）:"
Write-Host "& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall-client.ps1')))"
'''


def _generate_unix_script(server_ip, frps_port, auth_token, client_id, client_token, os_type, ws_scheme="ws", manager_host=None):
    """生成 Linux/macOS 容器一键部署脚本（自动检测/就绪容器环境，统一拉取 TCR 客户端镜像）"""
    if manager_host is None:
        manager_host = server_ip
    manager_ws_url = f"{ws_scheme}://{manager_host}/ws/agent/{client_id}"
    image = "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest"
    install_dir = "$HOME/.frp-all-in-one" if os_type == "darwin" else "/opt/frp"
    uninstall_runner = "bash" if os_type == "darwin" else "sudo bash"
    return f'''#!/bin/bash
# FRP Manager Agent - 容器一键部署脚本 ({os_type})
# 架构: 自动检测/就绪 Docker 或 Podman 环境，从腾讯云公开镜像仓库拉取并启动

set -e

SERVER_IP="{server_ip}"
FRPS_PORT="{frps_port}"
FRPS_TOKEN="{auth_token}"
CLIENT_TOKEN="{client_token}"
CLIENT_ID="{client_id}"
IMAGE="{image}"
MANAGER_WS_URL="{manager_ws_url}"
INSTALL_DIR="{install_dir}"

RED='\\033[0;31m'
GREEN='\\033[0;32m'
BLUE='\\033[0;34m'
YELLOW='\\033[1;33m'
NC='\\033[0m'

log_info() {{ echo -e "${{BLUE}}[INFO]${{NC}} $1"; }}
log_ok() {{ echo -e "${{GREEN}}[OK]${{NC}} $1"; }}
log_warn() {{ echo -e "${{YELLOW}}[WARN]${{NC}} $1"; }}
log_error() {{ echo -e "${{RED}}[ERROR]${{NC}} $1"; }}

echo ""
echo -e "${{BLUE}}======================================================${{NC}}"
echo -e "${{BLUE}}  FRP Manager Agent 容器一键部署 ({os_type})${{NC}}"
echo -e "${{BLUE}}  镜像源: $IMAGE (腾讯云 TCR 高速拉取)${{NC}}"
echo -e "${{BLUE}}======================================================${{NC}}"
echo ""

# 1. 检测或自动安装容器环境
log_info "[1/4] 检测容器运行环境..."
CONTAINER_CLI=""

if command -v docker >/dev/null 2>&1; then
    CONTAINER_CLI="docker"
elif command -v podman >/dev/null 2>&1; then
    CONTAINER_CLI="podman"
else
    log_warn "未检测到 Docker 或 Podman 环境，正在尝试就绪..."
    if [ "{os_type}" = "linux" ]; then
        if [ "$EUID" -ne 0 ]; then
            log_error "当前非 root 用户，无法自动安装容器环境。请先安装 Docker: curl -fsSL https://get.docker.com | bash"
            exit 1
        fi
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            case "$ID" in
                ubuntu|debian)
                    apt-get update && apt-get install -y docker.io || apt-get install -y podman
                    ;;
                centos|rhel|fedora|rocky|almalinux)
                    yum install -y docker || yum install -y podman
                    ;;
                alpine)
                    apk update && apk add --no-cache podman
                    ;;
                *)
                    curl -fsSL https://get.docker.com | bash
                    ;;
            esac
        else
            curl -fsSL https://get.docker.com | bash
        fi

        if command -v docker >/dev/null 2>&1; then
            CONTAINER_CLI="docker"
            systemctl enable --now docker 2>/dev/null || true
        elif command -v podman >/dev/null 2>&1; then
            CONTAINER_CLI="podman"
        fi
    elif [ "{os_type}" = "darwin" ]; then
        log_error "macOS 请先启动 Docker Desktop 或通过 Homebrew 安装: brew install --cask docker"
        exit 1
    fi
fi

if [ -z "$CONTAINER_CLI" ]; then
    log_error "容器环境就绪失败，请先安装 Docker: https://docs.docker.com/engine/install/"
    exit 1
fi

log_ok "使用容器引擎: $CONTAINER_CLI"

# 2. 嗅探宿主机实际局域网 IP（供 Agent 回传及配置隧道使用）
log_info "[2/5] 探测宿主机局域网 IP..."
HOST_IP=""
if [ "{os_type}" = "darwin" ]; then
    DEFAULT_IF=$(route -n get default 2>/dev/null | awk '/interface:/{{print $2}}')
    if [ -n "$DEFAULT_IF" ]; then
        HOST_IP=$(ipconfig getifaddr "$DEFAULT_IF" 2>/dev/null || true)
    fi
    if [ -z "$HOST_IP" ]; then
        HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    fi
else
    # Linux: 优先通过路由探测出接口源 IP，回退到 hostname -I
    HOST_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{{for(i=1;i<=NF;i++)if($i=="src")print $(i+1)}}' || true)
    if [ -z "$HOST_IP" ]; then
        HOST_IP=$(hostname -I 2>/dev/null | awk '{{print $1}}' || true)
    fi
fi

if [ -n "$HOST_IP" ]; then
    log_ok "检测到宿主机局域网 IP: $HOST_IP"
else
    log_warn "未能自动探测到局域网 IP，Agent 启动后将尝试多级网络探测"
fi

# 3. 创建本地配置目录与基础配置文件
log_info "[3/5] 创建本地配置目录: $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"

cat > "$INSTALL_DIR/frpc.toml" << 'FRPC_CONFIG'
serverAddr = "{server_ip}"
serverPort = {frps_port}
auth.token = "{auth_token}"
FRPC_CONFIG
chmod 600 "$INSTALL_DIR/frpc.toml"
touch "$INSTALL_DIR/.frp-all-in-one-client"
log_ok "本地配置文件已创建 (0600 权限)"

# 4. 清理已存在的旧 Agent 容器
log_info "[4/5] 检查并清理旧容器..."
$CONTAINER_CLI rm -f frp-agent 2>/dev/null || true

# 5. 从腾讯云公开镜像仓库秒级拉取并启动
log_info "[5/5] 从腾讯云公开镜像仓库拉取并启动 frp-agent 容器..."
$CONTAINER_CLI pull "$IMAGE"

$CONTAINER_CLI run -d \\
  --name frp-agent \\
  --network host \\
  --restart always \\
  --label io.frp-all-in-one.role=client \\
  --label com.centurylinklabs.watchtower.enable=true \\
  -v "$INSTALL_DIR:/opt/frp" \\
  -e FRP_AGENT_TOKEN="$CLIENT_TOKEN" \\
  -e FRP_HOST_IP="$HOST_IP" \\
  "$IMAGE" \\
  -server "$MANAGER_WS_URL" \\
  -id "$CLIENT_ID" \\
  -config /opt/frp/frpc.toml \\
  -log /opt/frp/logs

echo ""
echo -e "${{GREEN}}======================================================${{NC}}"
echo -e "${{GREEN}}  部署成功！FRP-Agent 容器已在后台运行${{NC}}"
echo -e "${{GREEN}}======================================================${{NC}}"
echo "容器名称: frp-agent"
echo "客户端 ID: $CLIENT_ID"
if [ -n "$HOST_IP" ]; then
    echo -e "宿主机 IP: ${{GREEN}}$HOST_IP${{NC}} (在管理面板配置隧道时推荐使用此 IP，勿填 127.0.0.1)"
fi
echo "查看状态: $CONTAINER_CLI ps -f name=frp-agent"
echo "查看日志: $CONTAINER_CLI logs -f frp-agent"
echo "卸载（保留配置和日志）:"
echo "curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | {uninstall_runner} -s -- client"
'''


@router.get("/agent/install-script-info")
async def get_install_script_info(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取安装脚本信息"""
    server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or "YOUR_SERVER_IP"
    frps_port = crud.get_config(db, models.ConfigKeys.FRPS_PORT) or "7000"
    frps_version = crud.get_config(db, models.ConfigKeys.FRPS_VERSION) or "0.61.1"

    tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
    scheme = "https" if tls_enabled else "http"
    server_domain = (crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or "").strip()
    host = server_domain if (tls_enabled and server_domain) else server_ip

    return {
        "server_ip": server_ip,
        "frps_port": frps_port,
        "frps_version": frps_version,
        "scripts": {
            "linux": f"{scheme}://{host}/api/frp/agent/install-script/linux",
            "darwin": f"{scheme}://{host}/api/frp/agent/install-script/darwin",
            "windows": f"{scheme}://{host}/api/frp/agent/install-script/windows"
        }
    }


@router.get("/public-ip")
async def get_public_ip(
    current_user: models.Admin = Depends(get_current_user)
):
    """获取服务器公网 IP"""
    return await frp_deploy.get_public_ip_details()
