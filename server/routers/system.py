"""
系统状态相关路由
"""
import contextlib
from datetime import datetime
import os
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import literal, select
from sqlalchemy.orm import Session

from core import get_current_user, get_db
import crud
import frp_deploy
import models

router = APIRouter(prefix="/system", tags=["系统状态"])

# 服务启动时间（模块加载时记录）
_start_time = time.time()


@router.get("/status")
def get_system_status(db: Session = Depends(get_db)):
    """返回系统状态（FRPS 是否已部署）— 无需认证（前端路由判断需要）"""
    frps_deployed = crud.get_config(db, models.ConfigKeys.FRPS_VERSION) is not None
    return {
        "frps_deployed": frps_deployed
    }


@router.get("/public-ip")
async def get_public_ip(
    current_user: models.Admin = Depends(get_current_user)
):
    """自动检测服务器公网 IP（需认证，防止泄露服务器信息）"""
    details = await frp_deploy.get_public_ip_details()
    ip = details.get("ip")
    if ip:
        return {"success": True, "ip": ip}
    return {"success": False, "ip": None}


@router.get("/public-ip/open")
async def get_public_ip_open(db: Session = Depends(get_db)):
    """自动检测服务器公网 IP（无需认证，仅初始化阶段可用）"""
    is_initialized = crud.get_config(db, models.ConfigKeys.IS_INITIALIZED)
    if is_initialized:
        raise HTTPException(status_code=403, detail="系统已完成初始化，此接口不再可用")
    details = await frp_deploy.get_public_ip_details()
    ip = details.get("ip")
    if ip:
        return {"success": True, "ip": ip}
    return {"success": False, "ip": None}


@router.get("/info")
def get_system_info(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取系统运行信息：数据库路径、运行时间、客户端/隧道统计"""
    uptime_seconds = int(time.time() - _start_time)
    days = uptime_seconds // 86400
    hours = (uptime_seconds % 86400) // 3600
    minutes = (uptime_seconds % 3600) // 60

    if days > 0:
        uptime_str = f"{days}天 {hours}小时 {minutes}分钟"
    elif hours > 0:
        uptime_str = f"{hours}小时 {minutes}分钟"
    else:
        uptime_str = f"{minutes}分钟"

    # 数据库文件路径
    db_path = os.path.abspath("./data/frp_manager.db")
    db_size = 0
    with contextlib.suppress(OSError):
        db_size = os.path.getsize("./data/frp_manager.db")

    def format_size(size_bytes):
        if size_bytes >= 1024 * 1024:
            return f"{size_bytes / (1024 * 1024):.1f} MB"
        elif size_bytes >= 1024:
            return f"{size_bytes / 1024:.1f} KB"
        return f"{size_bytes} B"

    # 统计数据
    client_count = db.query(models.Client).count()
    online_clients = db.query(models.Client).filter(models.Client.status == "online").count()
    tunnel_count = db.query(models.Tunnel).count()

    # FRPS 版本
    frps_version = crud.get_config(db, models.ConfigKeys.FRPS_VERSION) or "-"

    # 启动时间
    start_dt = datetime.fromtimestamp(_start_time)

    return {
        "app_version": f"v{models.APP_VERSION}",
        "server_start_time": _start_time,
        "uptime_seconds": uptime_seconds,
        "uptime_display": uptime_str,
        "start_time": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "database_path": db_path,
        "database_size": format_size(db_size),
        "database_size_bytes": db_size,
        "total_clients": client_count,
        "online_clients": online_clients,
        "total_tunnels": tunnel_count,
        "frps_version": frps_version,
    }


@router.get("/check-update")
async def check_system_update(
    force: bool = False,
    current_user: models.Admin = Depends(get_current_user)
):
    """
    检查系统是否有新版本更新
    force=True 时强制跳过缓存直接查询 GitHub Releases
    """
    from services.update_checker import check_github_update
    return await check_github_update(force=force)


class UpgradeRequest(BaseModel):
    target_version: str | None = None


@router.get("/upgrade/health")
def get_upgrade_health():
    """Minimal public readiness: exact build, database and embedded FRPS."""
    from core.container_engine import FRPSProcessManager
    from database import engine
    try:
        with engine.connect() as connection:
            connection.scalar(select(literal(1)))
        ready = FRPSProcessManager.is_running()
    except Exception:
        ready = False
    return {"ready": ready, "app_version": f"v{models.APP_VERSION}"}


@router.post("/upgrade")
async def trigger_system_upgrade(
    payload: UpgradeRequest | None = None,
    current_user: models.Admin = Depends(get_current_user)
):
    """
    触发服务端平滑自升级
    仅限已认证管理员操作
    """
    from services import self_updater
    return await self_updater.trigger_self_upgrade(payload.target_version if payload else None)


@router.get("/upgrade/status")
async def get_system_upgrade_status():
    """获取服务端自升级能力与当前状态"""
    from services import self_updater
    return self_updater.get_upgrade_status()

