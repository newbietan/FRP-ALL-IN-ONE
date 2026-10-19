from __future__ import annotations

import secrets
import time
import uuid
from typing import Any

from sqlalchemy.orm import Session

import models
import schemas


# ===========================
# SystemConfig 辅助函数
# ===========================

def get_config(db: Session, key: str) -> str | None:
    config = db.query(models.SystemConfig).filter(models.SystemConfig.key == key).first()
    if config and config.value is not None:
        return str(config.value)
    return None

def set_config(db: Session, key: str, value: str):
    config = db.query(models.SystemConfig).filter(models.SystemConfig.key == key).first()
    if config:
        config.value = value
    else:
        config = models.SystemConfig(key=key, value=value)
        db.add(config)
    db.commit()
    return config


# ===========================
# Admin CRUD（GitHub OAuth）
# ===========================

def get_admin_by_github_id(db: Session, github_id: int) -> models.Admin | None:
    return db.query(models.Admin).filter(models.Admin.github_id == github_id).first()

def create_admin_from_github(db: Session, github_id: int, github_username: str, avatar_url: str, is_superadmin: bool = False) -> models.Admin:
    admin = models.Admin(
        github_id=github_id,
        github_username=github_username,
        avatar_url=avatar_url,
        is_superadmin=is_superadmin,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return admin

def update_admin_github_info(db: Session, admin_id: int, github_username: str, avatar_url: str):
    admin = db.query(models.Admin).filter(models.Admin.id == admin_id).first()
    if admin:
        admin.github_username = github_username
        admin.avatar_url = avatar_url
        db.commit()

def update_admin_github_id(db: Session, admin_id: int, new_github_id: int, github_username: str, avatar_url: str):
    """换绑 GitHub 账号：更新 github_id、username 和 avatar"""
    admin = db.query(models.Admin).filter(models.Admin.id == admin_id).first()
    if admin:
        admin.github_id = new_github_id
        admin.github_username = github_username
        admin.avatar_url = avatar_url
        db.commit()
        db.refresh(admin)
    return admin

def get_all_admins(db: Session) -> list[models.Admin]:
    return list(db.query(models.Admin).all())

def delete_admin(db: Session, admin_id: int) -> bool:
    admin = db.query(models.Admin).filter(models.Admin.id == admin_id).first()
    if admin:
        db.delete(admin)
        db.commit()
        return True
    return False

def count_admins(db: Session) -> int:
    return int(db.query(models.Admin).count())


# ===========================
# Client CRUD
# ===========================

def get_client(db: Session, client_id: str) -> models.Client | None:
    return db.query(models.Client).filter(models.Client.id == client_id).first()

def get_clients(db: Session, skip: int = 0, limit: int = 100) -> list[models.Client]:
    return list(db.query(models.Client).offset(skip).limit(limit).all())

def create_client(db: Session, client: schemas.ClientCreate) -> models.Client:
    db_client = models.Client(
        id=str(uuid.uuid4()),
        name=client.name,
        auth_token=secrets.token_hex(16),
        status="offline"
    )
    db.add(db_client)
    db.commit()
    db.refresh(db_client)
    return db_client

def create_client_with_token(db: Session, name: str) -> models.Client:
    db_client = models.Client(
        id=str(uuid.uuid4()),
        name=name,
        auth_token=secrets.token_hex(16),
        status="offline",
        last_seen=0,
    )
    db.add(db_client)
    db.commit()
    db.refresh(db_client)
    return db_client

def delete_client(db: Session, client_id: str) -> bool:
    client = get_client(db, client_id)
    if not client:
        return False
    db.delete(client)
    db.commit()
    return True

def touch_client(db: Session, client_id: str, status: str = "online") -> models.Client | None:
    client = get_client(db, client_id)
    if not client:
        return None
    client.status = status
    client.last_seen = int(time.time())
    db.commit()
    db.refresh(client)
    return client


# ===========================
# Tunnel CRUD
# ===========================

def get_tunnels(db: Session, client_id: str) -> list[models.Tunnel]:
    return list(db.query(models.Tunnel).filter(models.Tunnel.client_id == client_id).all())

def create_tunnel(db: Session, tunnel: schemas.TunnelCreate, client_id: str) -> models.Tunnel:
    tunnel_data: dict[str, Any] = tunnel.model_dump() if hasattr(tunnel, "model_dump") else tunnel.dict()
    db_tunnel = models.Tunnel(**tunnel_data, client_id=client_id)
    db.add(db_tunnel)
    db.commit()
    db.refresh(db_tunnel)
    return db_tunnel

def delete_tunnel(db: Session, tunnel_id: int) -> bool:
    db_tunnel = db.query(models.Tunnel).filter(models.Tunnel.id == tunnel_id).first()
    if db_tunnel:
        db.delete(db_tunnel)
        db.commit()
        return True
    return False

def update_client_name(db: Session, client_id: str, new_name: str) -> models.Client | None:
    client = get_client(db, client_id=client_id)
    if not client:
        return None
    client.name = new_name
    db.commit()
    db.refresh(client)
    return client

def update_client_remark(db: Session, client_id: str, new_remark: str | None) -> models.Client | None:
    client = get_client(db, client_id=client_id)
    if not client:
        return None
    client.remark = new_remark.strip() if new_remark and new_remark.strip() else None
    db.commit()
    db.refresh(client)
    return client

def set_tunnel_enabled(db: Session, tunnel_id: int, enabled: bool) -> models.Tunnel | None:
    tunnel = db.query(models.Tunnel).filter(models.Tunnel.id == tunnel_id).first()
    if not tunnel:
        return None
    tunnel.enabled = bool(enabled)
    db.commit()
    db.refresh(tunnel)
    return tunnel
