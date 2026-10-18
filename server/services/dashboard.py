"""
Dashboard 状态同步服务
分离自 main.py，消除循环依赖
"""
import crud
import models
from websocket_manager import manager as ws_manager


def build_full_sync_data(db) -> dict:
    """构建全量快照，供 Dashboard 初次连接及数据变更时使用"""
    clients = crud.get_clients(db)

    # 批量加载所有 AgentInfo，避免 N+1 查询
    client_ids = [c.id for c in clients]
    agent_infos = db.query(models.AgentInfo).filter(
        models.AgentInfo.client_id.in_(client_ids)
    ).all() if client_ids else []
    agent_info_map = {ai.client_id: ai for ai in agent_infos}

    ws_agents_info = {
        info["client_id"]: info
        for info in ws_manager.get_all_agents_info()
    }
    registered_clients = []
    for c in clients:
        client_data = {
            "id": c.id,
            "name": c.name,
            "auth_token": c.auth_token,
            "status": c.status,
            "last_seen": c.last_seen,
            "tunnels": [
                {
                    "id": t.id,
                    "client_id": t.client_id,
                    "name": t.name,
                    "type": t.type.value if hasattr(t.type, "value") else str(t.type),
                    "enabled": getattr(t, "enabled", True),
                    "local_ip": t.local_ip,
                    "local_port": t.local_port,
                    "remote_port": t.remote_port,
                    "custom_domains": t.custom_domains,
                }
                for t in (c.tunnels or [])
            ],
        }
        agent_info_db = agent_info_map.get(c.id)
        if agent_info_db:
            client_data.update({
                "hostname": agent_info_db.hostname,
                "os": agent_info_db.os,
                "arch": agent_info_db.arch,
                "platform": agent_info_db.platform,
                "agent_version": agent_info_db.agent_version,
                "ip": agent_info_db.ip,
                "ips": agent_info_db.ips,
            })
        is_ws_connected = ws_manager.is_agent_online(c.id)
        ws_info = ws_agents_info.get(c.id, {})
        resolved_ip = ws_info.get("ip") or client_data.get("ip")
        resolved_ips = ws_info.get("ips") or client_data.get("ips")
        client_data.update({
            "is_online": is_ws_connected,
            "ip": resolved_ip,
            "ips": resolved_ips,
            "cpu_percent":    ws_info.get("cpu_percent"),
            "memory_percent": ws_info.get("memory_percent"),
            "memory_used":    ws_info.get("memory_used"),
            "memory_total":   ws_info.get("memory_total"),
            "disk_percent":   ws_info.get("disk_percent"),
            "disk_used":      ws_info.get("disk_used"),
            "disk_total":     ws_info.get("disk_total"),
            "net_bytes_in":   ws_info.get("net_bytes_in"),
            "net_bytes_out":  ws_info.get("net_bytes_out"),
            "net_speed_in":   ws_info.get("net_speed_in"),
            "net_speed_out":  ws_info.get("net_speed_out"),
            "agent_info": {
                "hostname": client_data.get("hostname") or c.name,
                "os": client_data.get("os"),
                "arch": client_data.get("arch"),
                "platform": client_data.get("platform"),
                "agent_version": client_data.get("agent_version"),
                "ip": resolved_ip,
                "ips": resolved_ips,
                "online": is_ws_connected,
                **ws_info,
            }
        })
        agent_ver = client_data.get("agent_version") or ""
        current_server_ver = f"v{models.APP_VERSION}"
        has_update = models.is_newer_version(current_server_ver, agent_ver) if agent_ver else False
        client_data["has_update"] = has_update
        client_data["latest_version"] = current_server_ver
        client_data["agent_info"]["has_update"] = has_update
        client_data["agent_info"]["latest_version"] = current_server_ver
        registered_clients.append(client_data)

    disabled_ports_str = crud.get_config(db, models.ConfigKeys.DISABLED_PORTS) or ""
    disabled_ports = [int(p) for p in disabled_ports_str.split(",") if p.strip()]

    # 延迟导入以避免循环依赖
    from main import _frps_cache

    return {
        "registered_clients": registered_clients,
        "disabled_ports": disabled_ports,
        "frps_status": _frps_cache["data"],
        "conflict_events": ws_manager.get_recent_conflicts(),
        "server_public_ip": crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or "",
    }
