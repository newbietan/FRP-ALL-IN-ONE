"""
客户端和隧道管理路由
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core import get_current_user, get_db
import crud
from database import SessionLocal
import models
import schemas
from websocket_manager import manager as ws_manager

router = APIRouter(prefix="/clients", tags=["客户端管理"])


def _build_client_agent_info(db: Session, client_id: str) -> dict:
    """获取客户端的 agent_info，合并内存缓存与数据库持久化数据"""
    cached = ws_manager.agent_system_info.get(client_id, {})
    agent_info = dict(cached)
    db_agent = db.query(models.AgentInfo).filter(
        models.AgentInfo.client_id == client_id
    ).first()
    if db_agent:
        if not agent_info.get("hostname"):
            agent_info["hostname"] = db_agent.hostname
        if not agent_info.get("os"):
            agent_info["os"] = db_agent.os
        if not agent_info.get("arch"):
            agent_info["arch"] = db_agent.arch
        if not agent_info.get("agent_version"):
            agent_info["agent_version"] = db_agent.agent_version
        if not agent_info.get("platform"):
            agent_info["platform"] = db_agent.platform
        if not agent_info.get("ip"):
            agent_info["ip"] = db_agent.ip
        if not agent_info.get("ips") and db_agent.ips:
            try:
                agent_info["ips"] = json.loads(db_agent.ips) if db_agent.ips.startswith("[") else [x.strip() for x in db_agent.ips.split(",") if x.strip()]
            except Exception:
                agent_info["ips"] = [db_agent.ips]

    agent_info["online"] = ws_manager.is_agent_online(client_id)
    agent_ver = agent_info.get("agent_version") or ""
    current_server_ver = f"v{models.APP_VERSION}"
    if agent_ver:
        agent_info["has_update"] = models.is_newer_version(current_server_ver, agent_ver)
    else:
        agent_info["has_update"] = False
    agent_info["latest_version"] = current_server_ver
    return agent_info


def _render_frpc_toml(db: Session, client: models.Client) -> str | None:
    """渲染 FRPC 配置文件"""
    server_ip = crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP)
    frps_port = crud.get_config(db, models.ConfigKeys.FRPS_PORT)
    auth_token = crud.get_config(db, models.ConfigKeys.FRPS_AUTH_TOKEN)
    if not server_ip or not frps_port or not auth_token:
        return None

    lines = [
        f'serverAddr = "{server_ip}"',
        f"serverPort = {int(frps_port or 7000)}",
        f'auth.token = "{auth_token}"',
        "",
        '# Admin API',
        'webServer.addr = "127.0.0.1"',
        "webServer.port = 7400",
        "",
    ]

    for t in (client.tunnels or []):
        if hasattr(t, "enabled") and not t.enabled:
            continue

        proxy_type = t.type.value if hasattr(t.type, "value") else str(t.type)
        # 清洗名称，防止 TOML 语法错误 (例如包含双引号)
        safe_client_name = (client.name or "unknown").replace('"', '').strip()
        safe_tunnel_name = (t.name or f"tun_{t.id}").replace('"', '').strip()
        proxy_name = f"{safe_client_name}.{safe_tunnel_name}"
        lines.append("[[proxies]]")
        lines.append(f'name = "{proxy_name}"')
        lines.append(f'type = "{proxy_type}"')
        # 防御性清洗：防止 TOML 注入
        safe_local_ip = (t.local_ip or "127.0.0.1").replace('"', '').replace('\n', '').replace('\r', '').strip()
        lines.append(f'localIP = "{safe_local_ip}"')
        lines.append(f"localPort = {int(t.local_port or 0)}")

        if t.remote_port:
            lines.append(f"remotePort = {int(t.remote_port)}")
        if t.custom_domains:
            domains = [d.strip().replace('"', '').replace('\n', '') for d in (t.custom_domains or "").split(",") if d.strip()]
            if domains:
                items = '", "'.join(domains)
                lines.append(f'customDomains = ["{items}"]')
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


async def _broadcast_dashboard_sync(db: Session):
    """向所有 Dashboard 广播最新全量状态"""
    from services.dashboard import build_full_sync_data
    full_data = build_full_sync_data(db)
    await ws_manager.broadcast_dashboard({"type": "full_sync", "data": full_data})


async def _push_config_for_client(client_id: str):
    """推送配置到 Agent，并触发 Dashboard 界面刷新"""
    db = SessionLocal()
    try:
        client = crud.get_client(db, client_id=client_id)
        if not client:
            return False
        toml = _render_frpc_toml(db, client)
        if not toml:
            return False

        ok = await ws_manager.push_config_to_agent(client_id, toml)
        await _broadcast_dashboard_sync(db)
        return ok
    finally:
        db.close()


@router.post("/", response_model=schemas.Client)
def create_client(
    client: schemas.ClientCreate,
    db: Session = Depends(get_db)
):
    """创建客户端（仅允许 Agent 自动注册）"""
    raise HTTPException(status_code=403, detail="Clients must be created by agent registration")


@router.get("/", response_model=list[schemas.Client])
def read_clients(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取客户端列表"""
    clients = crud.get_clients(db, skip=skip, limit=limit)
    for client in clients:
        client.agent_info = _build_client_agent_info(db, client.id)
    return clients


@router.get("/{client_id}", response_model=schemas.Client)
def read_client(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取单个客户端详情"""
    db_client = crud.get_client(db, client_id=client_id)
    if db_client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    db_client.agent_info = _build_client_agent_info(db, db_client.id)
    return db_client


@router.delete("/{client_id}")
async def delete_client_endpoint(
    client_id: str,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """删除客户端及其所有隧道"""
    ok = crud.delete_client(db, client_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Client not found")

    await _broadcast_dashboard_sync(db)
    return {"success": True}


@router.patch("/{client_id}", response_model=schemas.Client)
async def update_client(
    client_id: str,
    payload: schemas.ClientUpdate,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """更新客户端名称与备注"""
    client = crud.get_client(db, client_id=client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    if payload.name is not None and payload.name.strip():
        crud.update_client_name(db, client_id=client_id, new_name=payload.name.strip())
        await _push_config_for_client(client_id)
    if payload.remark is not None:
        crud.update_client_remark(db, client_id=client_id, new_remark=payload.remark)

    db.refresh(client)
    client.agent_info = _build_client_agent_info(db, client_id)
    await _broadcast_dashboard_sync(db)
    return client


@router.post("/{client_id}/tunnels/", response_model=schemas.Tunnel)
async def create_tunnel_for_client(
    client_id: str,
    tunnel: schemas.TunnelCreate,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """为客户端创建隧道"""
    created = crud.create_tunnel(db=db, tunnel=tunnel, client_id=client_id)
    await _push_config_for_client(client_id)
    return created


@router.patch("/{client_id}/tunnels/{tunnel_id}", response_model=schemas.Tunnel)
async def update_tunnel_for_client(
    client_id: str,
    tunnel_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """更新隧道状态"""
    tunnel = db.query(models.Tunnel).filter(
        models.Tunnel.id == tunnel_id,
        models.Tunnel.client_id == client_id
    ).first()
    if not tunnel:
        raise HTTPException(status_code=404, detail="Tunnel not found")
    if "enabled" in payload:
        updated = crud.set_tunnel_enabled(db, tunnel_id=tunnel_id, enabled=payload.get("enabled"))
        await _push_config_for_client(client_id)
        return updated
    raise HTTPException(status_code=400, detail="No supported fields")


@router.delete("/{client_id}/tunnels/{tunnel_id}")
async def delete_tunnel_for_client(
    client_id: str,
    tunnel_id: int,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """删除隧道"""
    tunnel = db.query(models.Tunnel).filter(
        models.Tunnel.id == tunnel_id,
        models.Tunnel.client_id == client_id
    ).first()
    if not tunnel:
        raise HTTPException(status_code=404, detail="Tunnel not found")
    ok = crud.delete_tunnel(db, tunnel_id=tunnel_id)
    await _push_config_for_client(client_id)
    return {"success": ok}
