"""
FastAPI 依赖项
包含数据库会话、用户认证等
"""
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

import auth
import models
from core.security import require_secure_transport
from database import SessionLocal

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/github")


def get_db():
    """获取数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


async def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> models.Admin:
    """
    获取当前登录用户
    验证 JWT Token 并返回用户对象（通过 github_id 查找）
    """
    require_secure_transport(request)
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = auth.jwt.decode(token, auth.get_secret_key(), algorithms=[auth.ALGORITHM], options={"require": ["exp"]})
        github_id_str = payload.get("sub")
        if payload.get("purpose") not in (None, "access") or not isinstance(github_id_str, str):
            raise credentials_exception
        github_id = int(github_id_str)
    except (auth.JWTError, ValueError):
        raise credentials_exception from None

    import crud
    user = crud.get_admin_by_github_id(db, github_id=github_id)
    if user is None:
        raise credentials_exception

    return user
