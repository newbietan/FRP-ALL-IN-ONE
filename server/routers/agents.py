"""
Agent 管理路由
包含 Agent 列表、详情、指标查询、配置推送等
"""
import json

from core import get_current_user, get_db
import crud
from fastapi import APIRouter, Depends, HTTPException, Request
import models
from sqlalchemy.orm import Session
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
        # 检查是否真正在线（WebSocket 连接状态）
        is_ws_connected = ws_manager.is_agent_online(agent.client_id)
        
        # 获取实时系统信息
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
            # 实时系统信息
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
        "last_heartbeat": agent.last_heartbeat.isoformat() if hasattr(agent, 'last_heartbeat') and agent.last_heartbeat else None,
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
    
    # 反转顺序（从旧到新）
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


@router.post("/{client_id}/upgrade")
async def trigger_agent_upgrade(
    client_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """向指定 Agent 下发远程升级信号，并返回对应的升级安装命令"""
    client = crud.get_client(db, client_id=client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    is_online = ws_manager.is_agent_online(client_id)
    agent_info = ws_manager.agent_system_info.get(client_id, {})
    os_type = (agent_info.get("os") or "linux").lower()
    platform = "windows" if os_type == "windows" else ("darwin" if os_type in ("darwin", "macos") else "linux")

    server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or "YOUR_SERVER_IP"
    tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
    scheme = "https" if tls_enabled else "http"
    server_domain = (crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or "").strip()
    host = server_domain if (tls_enabled and server_domain) else server_ip

    if platform == "windows":
        upgrade_cmd = f"& ([scriptblock]::Create((Invoke-RestMethod '{scheme}://{host}/api/frp/agent/install-script/windows?client_id={client_id}')))"
    elif platform == "darwin":
        upgrade_cmd = f"curl -fsSL '{scheme}://{host}/api/frp/agent/install-script/darwin?client_id={client_id}' | bash"
    else:
        upgrade_cmd = f"curl -fsSL '{scheme}://{host}/api/frp/agent/install-script/linux?client_id={client_id}' | sudo bash"

    ws_sent = False
    if is_online:
        ws_sent = await ws_manager.send_to_agent(client_id, {
            "type": "upgrade",
            "data": {
                "target_version": f"v{models.APP_VERSION}",
                "image": "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest",
                "upgrade_command": upgrade_cmd,
            }
        })

    return {
        "success": True,
        "is_online": is_online,
        "signal_sent": ws_sent,
        "client_id": client_id,
        "target_version": f"v{models.APP_VERSION}",
        "upgrade_command": upgrade_cmd,
        "message": "已向客户端下发远程升级信号" if ws_sent else "客户端当前离线，已生成升级执行命令"
    }


@router.post("/batch-upgrade")
async def trigger_batch_agent_upgrade(
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """向所有在线且落后版本的 Agent 批量下发升级信号"""
    clients = crud.get_clients(db)
    results = []
    current_server_ver = f"v{models.APP_VERSION}"
    for c in clients:
        info = ws_manager.agent_system_info.get(c.id, {})
        agent_ver = info.get("agent_version")
        if agent_ver and models.is_newer_version(current_server_ver, agent_ver) and ws_manager.is_agent_online(c.id):
            sent = await ws_manager.send_to_agent(c.id, {
                "type": "upgrade",
                "data": {
                    "target_version": current_server_ver,
                    "image": "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest",
                }
            })
            results.append({"client_id": c.id, "name": c.name, "signal_sent": sent})
    return {
        "success": True,
        "upgraded_count": len(results),
        "details": results
    }
