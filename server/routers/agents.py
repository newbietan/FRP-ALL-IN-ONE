# pyright: reportMissingImports=false
"""
Agent 管理路由
包含 Agent 列表、详情、指标查询、配置推送等
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import crud
import models
from core import get_current_user, get_db
from websocket_manager import manager as ws_manager

router = APIRouter(prefix="/agents", tags=["Agent 管理"])


@router.get("/")
async def get_agents(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取所有 Agent 列表"""
    agents = db.query(models.AgentInfo).all()

    result = []
    for agent in agents:
        is_ws_connected = ws_manager.is_agent_online(agent.client_id)
        system_info = ws_manager.agent_system_info.get(agent.client_id, {})

        raw_ips = system_info.get("ips")
        if not raw_ips and agent.ips:
            try:
                raw_ips = json.loads(agent.ips) if agent.ips.startswith("[") else [x.strip() for x in agent.ips.split(",") if x.strip()]
            except Exception:
                raw_ips = [agent.ips]

        result.append({
            "client_id": agent.client_id,
            "hostname": agent.hostname,
            "os": agent.os,
            "arch": agent.arch,
            "agent_version": agent.agent_version,
            "platform": agent.platform,
            "ip": system_info.get("ip") or agent.ip,
            "ips": raw_ips or [],
            "is_online": is_ws_connected,
            "created_at": agent.created_at.isoformat() if agent.created_at else None,
            "cpu_percent": system_info.get("cpu_percent"),
            "memory_percent": system_info.get("memory_percent"),
            "memory_used": system_info.get("memory_used"),
            "memory_total": system_info.get("memory_total"),
            "disk_percent": system_info.get("disk_percent"),
            "disk_used": system_info.get("disk_used"),
            "disk_total": system_info.get("disk_total"),
        })

    return {"agents": result, "total": len(result)}


@router.get("/{client_id}")
async def get_agent_detail(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取单个 Agent 详情"""
    agent = db.query(models.AgentInfo).filter(
        models.AgentInfo.client_id == client_id
    ).first()

    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    is_ws_connected = ws_manager.is_agent_online(client_id)
    system_info = ws_manager.agent_system_info.get(client_id, {})
    raw_ips = system_info.get("ips")
    if not raw_ips and agent.ips:
        try:
            raw_ips = json.loads(agent.ips) if agent.ips.startswith("[") else [x.strip() for x in agent.ips.split(",") if x.strip()]
        except Exception:
            raw_ips = [agent.ips]

    return {
        "client_id": agent.client_id,
        "hostname": agent.hostname,
        "os": agent.os,
        "arch": agent.arch,
        "agent_version": agent.agent_version,
        "platform": agent.platform,
        "ip": system_info.get("ip") or agent.ip,
        "ips": raw_ips or [],
        "is_online": is_ws_connected,
        "last_heartbeat": heartbeat.isoformat() if (heartbeat := getattr(agent, "last_heartbeat", None)) else None,
        "created_at": agent.created_at.isoformat() if agent.created_at else None
    }


@router.get("/{client_id}/metrics")
async def get_agent_metrics(
    client_id: str,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取 Agent 系统指标历史"""
    limit = min(max(limit, 1), 1000)
    metrics = db.query(models.SystemMetrics).filter(
        models.SystemMetrics.client_id == client_id
    ).order_by(models.SystemMetrics.timestamp.desc()).limit(limit).all()

    metrics = list(reversed(metrics))
    result = []
    for m in metrics:
        result.append({
            "timestamp": m.timestamp.isoformat() if m.timestamp else None,
            "cpu_percent": m.cpu_percent,
            "memory_used": m.memory_used,
            "memory_total": m.memory_total,
            "memory_percent": m.memory_percent,
            "disk_used": m.disk_used,
            "disk_total": m.disk_total,
            "disk_percent": m.disk_percent,
            "net_bytes_in": m.net_bytes_in,
            "net_bytes_out": m.net_bytes_out
        })

    return {"metrics": result, "total": len(result)}


@router.get("/{client_id}/metrics/latest")
async def get_agent_latest_metrics(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取 Agent 最新系统指标"""
    latest = db.query(models.SystemMetrics).filter(
        models.SystemMetrics.client_id == client_id
    ).order_by(models.SystemMetrics.timestamp.desc()).first()

    if not latest:
        return {"success": False, "message": "No metrics found"}

    return {
        "success": True,
        "timestamp": latest.timestamp.isoformat() if latest.timestamp else None,
        "cpu_percent": latest.cpu_percent,
        "memory_used": latest.memory_used,
        "memory_total": latest.memory_total,
        "memory_percent": latest.memory_percent,
        "disk_used": latest.disk_used,
        "disk_total": latest.disk_total,
        "disk_percent": latest.disk_percent,
        "net_bytes_in": latest.net_bytes_in,
        "net_bytes_out": latest.net_bytes_out,
        "net_speed_in": latest.net_speed_in,
        "net_speed_out": latest.net_speed_out
    }


@router.post("/{client_id}/push-config")
async def push_config_to_agent(
    client_id: str,
    config: dict,
    current_user: models.Admin = Depends(get_current_user)
):
    """推送配置更新到 Agent"""
    config_content = config.get("config", "")

    if not config_content:
        raise HTTPException(status_code=400, detail="Config content is required")

    success = await ws_manager.push_config_to_agent(client_id, config_content)

    if success:
        return {"success": True, "message": "Config pushed successfully"}
    else:
        return {"success": False, "message": "Agent not connected"}


@router.get("/ws/stats")
async def get_websocket_stats(
    current_user: models.Admin = Depends(get_current_user)
):
    """获取 WebSocket 连接统计"""
    return ws_manager.get_stats()


def _upgrade_command(client, request: Request, db: Session) -> dict:
    from urllib.parse import urlencode

    from core.security import public_base_url, require_secure_transport
    from routers.clients import _build_client_agent_info
    from services.agent_upgrades import issue_grant

    info = _build_client_agent_info(db, client.id)
    os_type = (info.get("os") or "linux").lower()
    platform = "windows" if os_type == "windows" else ("darwin" if os_type in ("darwin", "macos") else "linux")
    require_secure_transport(request)
    base = public_base_url(request, db)
    target = f"v{models.APP_VERSION}"
    grant = issue_grant(db, client.id, target)
    query = urlencode({"client_id": client.id, "grant": grant})
    url = f"{base}/api/frp/agent/upgrade-script/{platform}?{query}"
    if platform == "windows":
        command = f"[System.Net.ServicePointManager]::ServerCertificateValidationCallback = {{$true}}; & ([scriptblock]::Create((Invoke-RestMethod '{url}')))"
    else:
        runner = "bash" if platform == "darwin" else "sudo bash"
        command = f"curl -kfsSL '{url}' -o /tmp/frp-client-upgrade.sh && {runner} /tmp/frp-client-upgrade.sh"
    return {"upgrade_command": command, "target_version": target, "expires_in": 600}


@router.post("/{client_id}/upgrade-command")
async def get_agent_upgrade_command(
    client_id: str, request: Request, db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """仅为受信任面板地址生成 10 分钟、单客户端、单次有效的命令。"""
    client = crud.get_client(db, client_id=client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return _upgrade_command(client, request, db)


@router.post("/{client_id}/upgrade")
async def trigger_agent_upgrade(
    client_id: str, request: Request, db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    from services.agent_upgrades import begin_task, update_task
    from services.container_upgrade import image_for

    client = crud.get_client(db, client_id=client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    online = ws_manager.is_agent_online(client_id)
    info = ws_manager.agent_system_info.get(client_id, {})
    target = f"v{models.APP_VERSION}"
    capable = info.get("upgrade_protocol") == 1 and info.get("can_self_upgrade") is True
    sent = False
    task = None
    if online and capable:
        task = begin_task(db, client_id, target)
        sent = await ws_manager.send_to_agent(client_id, {
            "type": "upgrade", "data": {"job_id": task["job_id"], "target_version": target,
                                         "image": image_for("agent", target)}})
        if not sent:
            task = update_task(db, client_id, {**task, "status": "failed", "message": "发送失败，客户端连接已断开"})
    message = "指令已发送，等待客户端真实确认" if sent else "客户端离线、旧版不支持升级执行器或未挂载 Socket，请使用安全手动命令"
    return {"success": True, "is_online": online, "signal_sent": sent, "client_id": client_id,
            "target_version": target, "job_id": task["job_id"] if task else None,
            "message": message, **(_upgrade_command(client, request, db) if not sent else {})}


@router.get("/{client_id}/upgrade-status")
async def get_agent_upgrade_status_endpoint(
    client_id: str, db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    from services.agent_upgrades import get_task
    return {"client_id": client_id, "status": get_task(db, client_id)}


@router.post("/batch-upgrade")
async def trigger_batch_agent_upgrade(
    request: Request, db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    from routers.clients import _build_client_agent_info

    results = []
    skipped = []
    target = f"v{models.APP_VERSION}"
    for client in db.query(models.Client).all():
        info = _build_client_agent_info(db, client.id)
        version = info.get("agent_version") or info.get("version")
        if not version or not models.is_newer_version(target, version):
            continue
        cached = ws_manager.agent_system_info.get(client.id, {})
        if not ws_manager.is_agent_online(client.id) or not cached.get("can_self_upgrade") or cached.get("upgrade_protocol") != 1:
            skipped.append({"client_id": client.id, "reason": "离线或需要先手动迁移升级执行器/Socket"})
            continue
        try:
            result = await trigger_agent_upgrade(client.id, request, db, current_user)
            results.append({"client_id": client.id, "name": client.name, "signal_sent": result["signal_sent"]})
        except HTTPException as exc:
            skipped.append({"client_id": client.id, "reason": str(exc.detail)})
    sent_count = sum(bool(item["signal_sent"]) for item in results)
    return {"success": True, "upgraded_count": sent_count, "sent_count": sent_count, "details": results, "skipped": skipped}
