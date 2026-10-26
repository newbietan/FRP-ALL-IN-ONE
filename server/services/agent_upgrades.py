# pyright: reportMissingImports=false
"""Persisted Agent tasks and short-lived, single-use script capabilities."""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

import auth
import crud
import models
from services.container_upgrade import normalize_version

ACTIVE = {"sent", "queued", "acknowledged", "pulling", "preparing", "stopping", "starting", "verifying", "rolling_back"}
STATES = ACTIVE | {"succeeded", "failed", "rolled_back", "rollback_failed", "unsupported", "unknown"}


def task_key(client_id: str) -> str:
    return "agent_upgrade:" + hashlib.sha256(client_id.encode()).hexdigest()


def get_task(db, client_id: str) -> dict | None:
    raw = crud.get_config(db, task_key(client_id))
    if not raw:
        return None
    try:
        task = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=503, detail="升级任务状态损坏，请检查持久化数据") from exc
    if task.get("status") in ACTIVE and time.time() - task.get("started_at", 0) > 1200:
        task.update(status="unknown", message="升级长时间未确认，请检查客户端任务与容器，勿重复执行", updated_at=time.time())
        crud.set_config(db, task_key(client_id), json.dumps(task))
    return task


def begin_task(db, client_id: str, version: str, *, job_id: str | None = None) -> dict:
    key = task_key(client_id)
    raw = crud.get_config(db, key)
    previous = get_task(db, client_id)
    if previous and previous.get("status") in ACTIVE | {"unknown"}:
        raise HTTPException(status_code=409, detail="该客户端已有升级任务或结果待确认，请勿重复操作")
    task = {"job_id": job_id or uuid.uuid4().hex, "client_id": client_id,
            "target_version": normalize_version(version), "status": "sent",
            "message": "升级指令待客户端确认", "started_at": time.time(), "updated_at": time.time()}
    value = json.dumps(task)
    if raw is None:
        db.add(models.SystemConfig(key=key, value=value))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(status_code=409, detail="并发升级请求，请刷新任务状态") from exc
    else:
        count = db.query(models.SystemConfig).filter(models.SystemConfig.key == key, models.SystemConfig.value == raw).update({"value": value})
        db.commit()
        if count != 1:
            raise HTTPException(status_code=409, detail="升级任务状态已变化，请刷新")
    return task


def update_task(db, client_id: str, data: dict, *, agent_version: str = "") -> dict | None:
    task = get_task(db, client_id)
    status = data.get("status") or data.get("step")
    if (not task or data.get("job_id") != task["job_id"] or status not in STATES
            or data.get("target_version") != task["target_version"]):
        return None
    if task["status"] in {"succeeded", "rolled_back", "rollback_failed", "failed"}:
        return task
    if status == "succeeded" and (agent_version.lstrip("v") != task["target_version"].lstrip("v") or not data.get("ready")):
        return None
    task.update(status=status, message=str(data.get("message") or status)[:500],
                error=str(data.get("error") or "")[:500], updated_at=time.time())
    crud.set_config(db, task_key(client_id), json.dumps(task))
    return task


def issue_grant(db, client_id: str, version: str) -> str:
    version = normalize_version(version)
    nonce = uuid.uuid4().hex
    # Store no bearer token, only the one-time nonce and its bounded scope.
    claims = {"sub": client_id, "purpose": "agent-upgrade-script", "target_version": version, "jti": nonce}
    crud.set_config(db, "upgrade_grant:" + nonce, json.dumps({**claims, "expires": time.time() + 600}))
    return auth.create_access_token(claims, expires_delta=timedelta(minutes=10))


def redeem_grant(db, token: str, client_id: str) -> dict:
    try:
        claims = auth.jwt.decode(token, auth.get_secret_key(), algorithms=[auth.ALGORITHM])
        if claims.get("purpose") != "agent-upgrade-script" or claims.get("sub") != client_id:
            raise ValueError("scope mismatch")
        nonce = claims.get("jti", "")
        if not isinstance(nonce, str) or len(nonce) != 32:
            raise ValueError("invalid nonce")
        key = "upgrade_grant:" + nonce
        raw = crud.get_config(db, key)
        if not raw:
            raise ValueError("already used")
        stored = json.loads(raw)
        if stored["expires"] < time.time() or stored["target_version"] != claims.get("target_version"):
            raise ValueError("expired or wrong version")
        removed = db.query(models.SystemConfig).filter(models.SystemConfig.key == key, models.SystemConfig.value == raw).delete()
        db.commit()
        if removed != 1:
            raise ValueError("already redeemed")
        return claims
    except (auth.JWTError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=403, detail="升级凭据无效、过期或已使用，请从面板重新生成") from exc
