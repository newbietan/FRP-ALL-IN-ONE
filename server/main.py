"""
FRP Manager API - 主入口
精简后的主文件，仅保留 WebSocket 和初始化逻辑
其他路由已拆分至 routers/ 目录
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hmac
import json as _json
import os
from pathlib import Path
import re
import time as _time
import traceback
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

import auth
from core.rate_limit import setup_rate_limit
import crud
from database import SessionLocal, engine
import models
from routers import agents as agents_router
from routers import auth as auth_router
from routers import clients as clients_router
from routers import frp_server as frp_router
from routers import settings as settings_router
from routers import system as system_router
from routers.frp_server import get_frps_status
from services.dashboard import build_full_sync_data
from services.tls_manager import tls_manager
from websocket_manager import manager as ws_manager

# FRPS Dashboard 状态缓存（每 5 秒刷新一次，避免 WS 循环每秒调用）
_frps_cache: dict = {"data": None, "ts": 0.0}

def _auto_migrate_db(bind_engine):
    """自动补充 SQLite 数据库中缺失的列"""
    try:
        with bind_engine.connect() as conn:
            res = conn.exec_driver_sql("PRAGMA table_info(agent_info)").fetchall()
            cols = {r[1] for r in res}
            if cols and "ip" not in cols:
                conn.exec_driver_sql("ALTER TABLE agent_info ADD COLUMN ip VARCHAR")
            if cols and "ips" not in cols:
                conn.exec_driver_sql("ALTER TABLE agent_info ADD COLUMN ips VARCHAR")

            client_res = conn.exec_driver_sql("PRAGMA table_info(clients)").fetchall()
            client_cols = {r[1] for r in client_res}
            if client_cols and "remark" not in client_cols:
                conn.exec_driver_sql("ALTER TABLE clients ADD COLUMN remark VARCHAR")

            conn.commit()
    except Exception as e:
        print(f"[WARN] 数据库自动迁移检查异常: {e}")

# 创建数据库表并执行轻量迁移
models.Base.metadata.create_all(bind=engine)
_auto_migrate_db(engine)

app = FastAPI(title="FRP Manager API")

# 注册限流器
setup_rate_limit(app)

# 初始化 JWT Secret Key
auth.init_secret_key()

# 认证路由（无需密码修改检查）
app.include_router(auth_router.router, prefix="/api")

# 系统状态路由（公开访问）
app.include_router(system_router.router, prefix="/api")

# 需要受保护的路由
app.include_router(clients_router.router, prefix="/api")
app.include_router(agents_router.router, prefix="/api")
app.include_router(frp_router.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")


# ===========================
# 数据库初始化与后台任务
# ===========================

@app.on_event("startup")
def init_database():
    """初始化数据库表并启动核心服务"""
    models.Base.metadata.create_all(bind=engine)
    _auto_migrate_db(engine)
    print("[OK] 数据库初始化完成。首个 GitHub 登录的用户将自动成为管理员。")

    # 单容器架构：自动启动内置 FRPS 穿透核心
    try:
        from core.container_engine import restart_frps_service
        res = restart_frps_service()
        if res.returncode == 0:
            print("[OK] 内置 FRPS 服务已启动。")
        else:
            print(f"[WARN] FRPS 启动返回: {res.stderr or res.stdout}")
    except Exception as e:
        print(f"[WARN] 启动 FRPS 核心异常: {e}")

    # 启动后台任务
    asyncio.create_task(background_ping_task())
    asyncio.create_task(background_cert_renew_task())
    asyncio.create_task(background_frps_status_task())


@app.on_event("shutdown")
def shutdown_services():
    """停止后台任务与 FRPS 子进程"""
    try:
        from core.container_engine import FRPSProcessManager
        FRPSProcessManager.stop()
        print("[OK] FRPS 服务已安全停止。")
    except Exception as e:
        print(f"[WARN] 停止 FRPS 异常: {e}")


async def background_ping_task():
    """定期发送 Ping 保持 WebSocket 连接活跃"""
    while True:
        await asyncio.sleep(30)  # 每 30 秒 Ping 一次
        try:
            await ws_manager.broadcast_ping()
        except Exception as e:
            print(f"[Error] Ping 广播失败: {e}")


async def background_cert_renew_task():
    """
    证书自动续期任务
    每天检查一次证书过期情况，过期前 30 天自动续期
    """
    # 延迟 60 秒启动，等待系统完全初始化
    await asyncio.sleep(60)

    while True:
        try:
            db = SessionLocal()
            try:
                # 检查是否启用了 HTTPS 且是自动模式
                domain = crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN)
                tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
                tls_mode = crud.get_config(db, models.ConfigKeys.TLS_MODE)

                if domain and tls_enabled and tls_mode == "auto":
                    # 检查是否需要续期
                    if tls_manager.check_cert_needs_renew(domain, days_before=30):
                        print(f"[CertRenew] 证书将在 30 天内过期，开始续期: {domain}")

                        # 执行续期
                        result = tls_manager.renew_cert(domain)

                        if result["success"]:
                            # 续期成功，重载 Nginx
                            reload_result = tls_manager.reload_nginx()
                            if reload_result["success"]:
                                print(f"[CertRenew] 证书续期成功并已重载 Nginx: {domain}")
                            else:
                                print(f"[CertRenew] 证书续期成功但重载 Nginx 失败: {reload_result['message']}")
                        else:
                            print(f"[CertRenew] 证书续期失败: {result['message']}")
                    else:
                        cert_info = tls_manager.get_cert_info(domain)
                        if cert_info and "days_until_expiry" in cert_info:
                            print(f"[CertRenew] 证书检查完成，还剩 {cert_info['days_until_expiry']} 天过期")
            finally:
                db.close()
        except Exception as e:
            print(f"[CertRenew] 证书续期任务异常: {e}")

        # 每 24 小时检查一次
        await asyncio.sleep(86400)


async def background_frps_status_task():
    """
    每 10 秒轮询一次 FRPS 状态，仅在数据发生变化时向所有 Dashboard 推送。
    取代原先在 WS 循环中每 5 秒全量刷新的方式。
    """
    await asyncio.sleep(15)  # 等待系统完全初始化后再启动
    _last_frps_hash = None

    while True:
        try:
            db = SessionLocal()
            try:
                frps_data = await get_frps_status(db=db, current_user=None)
                current_hash = hash(_json.dumps(frps_data, sort_keys=True, default=str))
                if current_hash != _last_frps_hash:
                    _last_frps_hash = current_hash
                    # 同步更新缓存，供 full_sync 使用
                    _frps_cache["data"] = frps_data
                    _frps_cache["ts"] = _time.time()
                    await ws_manager.broadcast_frps_status(frps_data)
            finally:
                db.close()
        except Exception as e:
            print(f"[FRPSTask] 状态获取失败: {e}")

        await asyncio.sleep(10)


# ===========================
# WebSocket 端点
# ===========================

def _validate_ws_origin(websocket: WebSocket) -> bool:
    """校验 WebSocket Origin 头，防止跨站 WebSocket 劫持"""
    origin = websocket.headers.get("origin", "")
    if not origin:
        # 允许无 Origin（非浏览器客户端，如 Agent）
        return True
    parsed = urlparse(origin)
    origin_host = parsed.hostname or ""
    # 允许 localhost 和 127.0.0.1（开发环境）
    if origin_host in ("localhost", "127.0.0.1", "::1"):
        return True
    # 从数据库校验是否为本服务器的域名或 IP
    db = SessionLocal()
    try:
        server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or ""
        server_domain = (crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or "").strip()
        if origin_host == server_ip or (server_domain and origin_host == server_domain):
            return True
    finally:
        db.close()
    return False


def _get_admin_from_token(db: Session, token: str | None) -> models.Admin | None:
    """从 Token 解析管理员信息"""
    if not token:
        return None
    try:
        payload = auth.jwt.decode(token, auth.get_secret_key(), algorithms=[auth.ALGORITHM])
        github_id_str = payload.get("sub")
        if not github_id_str:
            return None
        github_id = int(github_id_str)
        user = crud.get_admin_by_github_id(db, github_id=github_id)
        return user
    except Exception:
        return None


@app.websocket("/ws/dashboard")
async def websocket_dashboard(websocket: WebSocket):
    """
    Dashboard 实时状态推送（事件驱动模式）
    - 连接建立时发送一次 full_sync 全量数据
    - 后续由 Agent 上报、上下线事件、FRPS 状态变化触发增量推送
    - 服务端每 30 秒发送 ping 保持连接活跃
    """
    if not _validate_ws_origin(websocket):
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    try:
        token = websocket.query_params.get("token")
        admin = _get_admin_from_token(db, token)
        if not admin:
            await websocket.close(code=1008)
            return
    finally:
        db.close()

    await websocket.accept()
    await ws_manager.connect_dashboard(websocket)

    try:
        # 首次连接：发送全量数据供前端初始化，此后所有更新均由事件驱动
        db = SessionLocal()
        try:
            full_data = build_full_sync_data(db)
        finally:
            db.close()
        await websocket.send_json({"type": "full_sync", "data": full_data})

        # 保持连接；每 30 秒发送一次 ping 防止代理层断开空闲连接
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        print("[WS Dashboard] Client disconnected normally")
        ws_manager.disconnect_dashboard(websocket)
    except Exception as e:
        print(f"[WS Dashboard] ERROR: {type(e).__name__}: {e}")
        traceback.print_exc()
        ws_manager.disconnect_dashboard(websocket)


@app.websocket("/ws/agent/{client_id}")
async def websocket_agent(websocket: WebSocket, client_id: str):
    """
    Agent 双向通信通道
    接收 Agent 上报的系统信息、日志等
    """
    header_client_id = (websocket.headers.get("x-client-id") or "").strip()
    header_token = (websocket.headers.get("x-client-token") or "").strip()
    if header_client_id and header_client_id != client_id:
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    try:
        client = crud.get_client(db, client_id=client_id)
        if not client or not header_token or not hmac.compare_digest(header_token, client.auth_token):
            await websocket.close(code=1008)
            return
    finally:
        db.close()

    await websocket.accept()
    await ws_manager.connect_agent(websocket, client_id)

    try:
        while True:
            raw = await websocket.receive_text()
            data = _json.loads(raw)
            await _handle_agent_message(client_id, data)
    except WebSocketDisconnect:
        if await ws_manager.disconnect_agent(client_id, websocket):
            _set_client_offline(client_id)
    except Exception as e:
        print(f"[Error] Agent {client_id} WebSocket 异常: {type(e).__name__}: {e}")
        traceback.print_exc()
        if await ws_manager.disconnect_agent(client_id, websocket):
            _set_client_offline(client_id)


@app.websocket("/ws/logs/{client_id}")
async def websocket_logs(websocket: WebSocket, client_id: str):
    """
    日志实时订阅
    前端订阅某个客户端的日志流
    """
    if not _validate_ws_origin(websocket):
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    try:
        token = websocket.query_params.get("token")
        admin = _get_admin_from_token(db, token)
        if not admin:
            await websocket.close(code=1008)
            return
    finally:
        db.close()

    await websocket.accept()
    await ws_manager.subscribe_logs(websocket, client_id)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.unsubscribe_logs(websocket, client_id)
    except Exception:
        ws_manager.unsubscribe_logs(websocket, client_id)


def _set_client_offline(client_id: str):
    """Agent 断开后将数据库中的客户端状态设为 offline"""
    db = SessionLocal()
    try:
        client = db.query(models.Client).filter(models.Client.id == client_id).first()
        if client:
            client.status = "offline"
            db.commit()
    except Exception as e:
        print(f"[Error] 设置客户端 {client_id} 离线失败: {e}")
    finally:
        db.close()


def _sanitize_agent_str(value, max_len: int = 128) -> str | None:
    """清洗 Agent 上报的字符串字段，防止 XSS 和超长注入"""
    if not isinstance(value, str):
        return None
    # 去除 HTML 标签和控制字符
    value = re.sub(r'[<>"\'&]', '', value)
    value = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', value)
    return value.strip()[:max_len] or None


async def _handle_agent_message(client_id: str, msg: dict):
    """处理 Agent 上报的消息"""
    msg_type = msg.get("type")
    data = msg.get("data")

    if msg_type == "register":
        db = SessionLocal()
        try:
            crud.touch_client(db, client_id=client_id, status="online")

            raw = data if isinstance(data, dict) else {}
            hostname = _sanitize_agent_str(raw.get("hostname"), 64)
            os_name = _sanitize_agent_str(raw.get("os"), 32)
            arch = _sanitize_agent_str(raw.get("arch"), 16)
            version = _sanitize_agent_str(raw.get("version"), 32)
            platform = _sanitize_agent_str(raw.get("platform"), 128)
            ip = _sanitize_agent_str(raw.get("ip"), 64)
            raw_ips = raw.get("ips")
            ips_str = None
            if isinstance(raw_ips, list):
                ips_str = _json.dumps([_sanitize_agent_str(x, 64) for x in raw_ips if x])
            elif isinstance(raw_ips, str):
                ips_str = _sanitize_agent_str(raw_ips, 512)

            if hostname:
                client = crud.get_client(db, client_id=client_id)
                if client and (client.name.startswith("device-") or not client.name):
                    crud.update_client_name(db, client_id=client_id, new_name=hostname)

            agent = db.query(models.AgentInfo).filter(
                models.AgentInfo.client_id == client_id
            ).first()

            if agent:
                agent.hostname = hostname or agent.hostname
                agent.os = os_name or agent.os
                agent.arch = arch or agent.arch
                agent.agent_version = version or agent.agent_version
                agent.platform = platform or agent.platform
                if ip:
                    agent.ip = ip
                if ips_str:
                    agent.ips = ips_str
            else:
                agent = models.AgentInfo(
                    client_id=client_id,
                    hostname=hostname,
                    os=os_name,
                    arch=arch,
                    agent_version=version,
                    platform=platform,
                    ip=ip,
                    ips=ips_str,
                )
                db.add(agent)

            db.commit()

            # 同步更新 WebSocket 内存状态
            cached_update = {
                "hostname": hostname,
                "os": os_name,
                "arch": arch,
                "version": version,
                "platform": platform,
            }
            if ip:
                cached_update["ip"] = ip
            if raw_ips:
                cached_update["ips"] = raw_ips if isinstance(raw_ips, list) else [raw_ips]
            ws_manager.update_agent_system_info(client_id, cached_update)
        finally:
            db.close()

    elif msg_type == "system_info":
        if not isinstance(data, dict):
            return

        # 1. 更新内存缓存
        ws_manager.update_agent_system_info(client_id, data)

        # 2. 立即广播增量指标给所有 Dashboard（事件驱动核心）
        await ws_manager.broadcast_metrics_patch(client_id, data)

        # 3. 数据库写入节流：每 30 秒持久化一次，大幅降低 SQLite 写压力
        now = _time.time()
        last_write = ws_manager._metrics_last_write.get(client_id, 0)
        if now - last_write < 30:
            return  # 距上次写入还不到 30 秒，跳过
        ws_manager._metrics_last_write[client_id] = now

        db = SessionLocal()
        try:
            crud.touch_client(db, client_id=client_id, status="online")

            agent = db.query(models.AgentInfo).filter(
                models.AgentInfo.client_id == client_id
            ).first()

            if agent:
                if "hostname" in data:
                    agent.hostname = _sanitize_agent_str(data["hostname"], 64) or agent.hostname
                if "os" in data:
                    agent.os = _sanitize_agent_str(data["os"], 32) or agent.os
                if "arch" in data:
                    agent.arch = _sanitize_agent_str(data["arch"], 16) or agent.arch
                if "ip" in data and data["ip"]:
                    agent.ip = _sanitize_agent_str(data["ip"], 64) or agent.ip
                if "ips" in data and data["ips"]:
                    raw_ips = data["ips"]
                    if isinstance(raw_ips, list):
                        agent.ips = _json.dumps([_sanitize_agent_str(x, 64) for x in raw_ips if x])
                    elif isinstance(raw_ips, str):
                        agent.ips = _sanitize_agent_str(raw_ips, 512)

            # 持久化当前指标（每 30 秒一条，取代每次都写）
            metrics = models.SystemMetrics(
                client_id=client_id,
                timestamp=datetime.now(timezone.utc),
                cpu_percent=data.get("cpu_percent"),
                memory_used=data.get("memory_used"),
                memory_total=data.get("memory_total"),
                memory_percent=data.get("memory_percent"),
                disk_used=data.get("disk_used"),
                disk_total=data.get("disk_total"),
                disk_percent=data.get("disk_percent"),
                net_bytes_in=data.get("net_bytes_in"),
                net_bytes_out=data.get("net_bytes_out"),
                net_speed_in=data.get("net_speed_in"),
                net_speed_out=data.get("net_speed_out")
            )
            db.add(metrics)

            # 清理超过 1000 条的旧数据（单条 SQL 批量删除，降低锁竞争）
            count = db.query(models.SystemMetrics).filter(
                models.SystemMetrics.client_id == client_id
            ).count()
            if count > 1000:
                oldest_records = db.query(models.SystemMetrics.id).filter(
                    models.SystemMetrics.client_id == client_id
                ).order_by(models.SystemMetrics.timestamp.asc()).limit(count - 1000).all()
                if oldest_records:
                    ids_to_delete = [r[0] for r in oldest_records]
                    db.query(models.SystemMetrics).filter(
                        models.SystemMetrics.id.in_(ids_to_delete)
                    ).delete(synchronize_session=False)

            db.commit()
        finally:
            db.close()

    elif msg_type == "log":
        await ws_manager.broadcast_log(client_id, str(data) if data is not None else "")

    elif msg_type == "upgrade_status":
        raw = data if isinstance(data, dict) else {}
        ws_manager.update_agent_upgrade_status(client_id, raw)
        await ws_manager.broadcast_dashboard({
            "type": "agent_upgrade_status",
            "client_id": client_id,
            "data": ws_manager.get_agent_upgrade_status(client_id),
        })

    elif msg_type == "frpc_status":
        db = SessionLocal()
        try:
            client = db.query(models.Client).filter(
                models.Client.id == client_id
            ).first()

            if client:
                if isinstance(data, dict):
                    status = data.get("status", "unknown")
                elif isinstance(data, str):
                    status = data
                else:
                    status = "unknown"
                client.status = "online" if status == "running" else "offline"
                db.commit()
        finally:
            db.close()


# ===========================
# 前端单页应用 (SPA) 静态资源挂载
# ===========================
def _get_static_dir() -> Path:
    candidates = [
        Path(os.environ.get("STATIC_DIR", "/app/static")),
        Path("./static"),
        Path("../frontend/dist"),
        Path("./frontend/dist"),
    ]
    for c in candidates:
        if c.is_dir() and (c / "index.html").is_file():
            return c
    return Path("/app/static")


_static_dir = _get_static_dir()
if _static_dir.is_dir():
    _assets_dir = _static_dir / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa_frontend(full_path: str):
        if full_path in ("api", "ws") or full_path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404, detail="API route not found")
        target = _static_dir / full_path
        if target.is_file():
            return FileResponse(str(target))
        index_path = _static_dir / "index.html"
        if index_path.is_file():
            return FileResponse(
                str(index_path),
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )
        raise HTTPException(status_code=404, detail="Frontend assets not found")
