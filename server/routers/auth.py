# pyright: reportMissingImports=false
"""GitHub OAuth for the single-administrator installation."""
from __future__ import annotations

import os
import secrets
import time
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

import auth
import crud
import models
from core import get_current_user, get_db
from core.rate_limit import limiter
from core.security import public_base_url, require_secure_transport

router = APIRouter(prefix="/auth", tags=["认证"])
_COOKIE = "frp_oauth_state"
_COOKIE_PATH = "/api/auth/github"
_STATE_TTL = 600
# Opaque, single-use states: no access/upgrade JWT can substitute for OAuth state.
# Like the former rebind cache, this intentionally fails closed across restarts.
_oauth_states: dict[str, dict[str, Any]] = {}


def _get_safe_frontend_base(request: Request, db: Session) -> str:
    return public_base_url(request, db)


def _build_callback_url(request: Request, db: Session) -> str:
    return f"{_get_safe_frontend_base(request, db)}/api/auth/github/callback"


def _authorize(request: Request, db: Session, admin_id: int | None = None) -> RedirectResponse:
    require_secure_transport(request)
    if not auth.GITHUB_CLIENT_ID or not auth.GITHUB_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="GitHub OAuth 未配置")
    now = time.time()
    for key in list(_oauth_states):
        if _oauth_states[key]["expires"] <= now:
            _oauth_states.pop(key, None)
    if len(_oauth_states) >= 1000:
        raise HTTPException(status_code=429, detail="登录请求过多，请稍后重试")
    state = secrets.token_urlsafe(32)
    base = _get_safe_frontend_base(request, db)
    _oauth_states[state] = {"expires": now + _STATE_TTL, "admin_id": admin_id, "base": base}
    params = urlencode({"client_id": auth.GITHUB_CLIENT_ID,
                        "redirect_uri": f"{base}/api/auth/github/callback",
                        "scope": "read:user", "state": state})
    response = RedirectResponse(url=f"{auth.GITHUB_AUTHORIZE_URL}?{params}")
    response.set_cookie(_COOKIE, state, max_age=_STATE_TTL, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax", path=_COOKIE_PATH)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@router.get("/github")
@limiter.limit("10/minute")
async def github_login(request: Request, db: Session = Depends(get_db)):
    return _authorize(request, db)


@router.post("/github/rebind")
@limiter.limit("3/minute")
async def github_rebind(
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user),
):
    """Require a bearer-authenticated POST, never a long-lived token in a URL."""
    response = _authorize(request, db, admin_id=int(current_user.id))
    # fetch follows redirects by default: return the URL without following GitHub.
    result = JSONResponse({"authorization_url": response.headers.get("location", "")},
                          headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    result.raw_headers.extend((k, v) for k, v in response.raw_headers if k == b"set-cookie")
    return result


@router.get("/github/callback")
async def github_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    db: Session = Depends(get_db),
):
    require_secure_transport(request)
    cookie = request.cookies.get(_COOKIE, "")
    if (not code or not state or not cookie or len(state) > 128 or len(cookie) > 128
            or not secrets.compare_digest(state.encode(), cookie.encode())):
        raise HTTPException(status_code=400, detail="OAuth state 缺失或与当前浏览器不匹配")
    flow = _oauth_states.pop(state, None)
    if not flow or flow["expires"] <= time.time():
        raise HTTPException(status_code=400, detail="OAuth state 已过期或已使用，请重新登录")
    frontend_base = flow["base"]
    callback_url = f"{frontend_base}/api/auth/github/callback"
    async with httpx.AsyncClient(timeout=15) as client:
        token_resp = await client.post(
            auth.GITHUB_TOKEN_URL,
            data={"client_id": auth.GITHUB_CLIENT_ID, "client_secret": auth.GITHUB_CLIENT_SECRET,
                  "code": code, "redirect_uri": callback_url},
            headers={"Accept": "application/json"},
        )
        if token_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="换取 access_token 失败")
        github_access_token = token_resp.json().get("access_token")
        if not github_access_token:
            raise HTTPException(status_code=400, detail="未收到 GitHub access_token")
        user_resp = await client.get(
            auth.GITHUB_USER_API,
            headers={"Authorization": f"Bearer {github_access_token}", "Accept": "application/json"},
        )
        if user_resp.status_code != 200:
            raise HTTPException(status_code=400, detail="获取 GitHub 用户信息失败")
        github_user = user_resp.json()

    github_id = github_user["id"]
    github_username = github_user["login"]
    avatar_url = github_user.get("avatar_url", "")
    admin = crud.get_admin_by_github_id(db, github_id)

    def redirect(suffix: str) -> RedirectResponse:
        response = RedirectResponse(url=f"{frontend_base}/{suffix}")
        response.delete_cookie(_COOKIE, path=_COOKIE_PATH)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    rebind_admin_id = flow["admin_id"]
    if rebind_admin_id is not None:
        admin = db.query(models.Admin).filter(models.Admin.id == rebind_admin_id).first()
        if not admin:
            return redirect("?error=admin_not_found")
        existing = crud.get_admin_by_github_id(db, github_id)
        if existing and int(existing.id) != int(admin.id):
            return redirect("?error=account_in_use")
        crud.update_admin_github_id(db, int(admin.id), github_id, github_username, avatar_url)
    elif not admin:
        if crud.count_admins(db) != 0:
            return redirect("?error=not_authorized")
        expected_id = os.environ.get("INITIAL_ADMIN_GITHUB_ID", "").strip()
        expected_username = os.environ.get("INITIAL_ADMIN_GITHUB_USERNAME", "").strip().lower()
        if not expected_id and not expected_username:
            # A public deployment must never be claimed by an arbitrary first visitor.
            raise HTTPException(status_code=503, detail="请先配置 INITIAL_ADMIN_GITHUB_ID 或 INITIAL_ADMIN_GITHUB_USERNAME")
        matches = str(github_id) == expected_id if expected_id else github_username.lower() == expected_username
        if not matches:
            return redirect("?error=initial_admin_mismatch")
        crud.create_admin_from_github(db, github_id, github_username, avatar_url, is_superadmin=True)
    else:
        crud.update_admin_github_info(db, int(admin.id), github_username, avatar_url)

    access_token = auth.create_access_token(
        data={"sub": str(github_id), "purpose": "access"},
        expires_delta=timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return redirect(f"#access_token={access_token}")


@router.get("/profile")
async def get_profile(current_user: models.Admin = Depends(get_current_user)):
    return {"github_username": current_user.github_username,
            "avatar_url": current_user.avatar_url, "is_superadmin": current_user.is_superadmin}
