# pyright: reportMissingImports=false
"""
系统设置路由
包含域名设置、HTTPS 配置等
"""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core import get_current_user, get_db
from core.rate_limit import limiter
import crud
import models
from services.dns_checker import check_dns_resolution
from services.tls_manager import tls_manager

router = APIRouter(prefix="/settings", tags=["系统设置"])

# 域名格式校验正则：仅允许字母、数字、连字符和点号
_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$')

def _validate_domain(domain: str) -> str:
    """校验并清洗域名，防止 Nginx 配置注入"""
    domain = domain.strip().lower()
    if not domain or len(domain) > 253:
        raise HTTPException(status_code=400, detail="域名不能为空且长度不超过253个字符")
    if not _DOMAIN_RE.match(domain):
        raise HTTPException(status_code=400, detail="域名格式无效，仅允许字母、数字、连字符和点号")
    return domain


class DomainConfig(BaseModel):
    domain: str


class TLSEnableRequest(BaseModel):
    domain: str
    mode: str = "auto"


@router.get("/domain")
async def get_domain_config(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """获取当前域名配置"""
    domain = crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or ""
    tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
    tls_mode = crud.get_config(db, models.ConfigKeys.TLS_MODE) or "auto"

    cert_info = None
    if domain and tls_enabled:
        cert_info = tls_manager.get_cert_info(domain)

    return {
        "domain": domain,
        "tls_enabled": tls_enabled,
        "tls_mode": tls_mode,
        "public_ip": crud.get_config(db, models.ConfigKeys.SERVER_PUBLIC_IP) or "",
        "cert_info": cert_info
    }


@router.post("/domain")
async def set_domain(
    config: DomainConfig,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """设置域名"""
    domain = _validate_domain(config.domain)

    # 检查 DNS 解析（dns_checker 现在是 async，直接 await）
    check_result = await check_dns_resolution(domain)

    # 保存域名配置（即使 DNS 检查失败也保存）
    crud.set_config(db, models.ConfigKeys.SERVER_DOMAIN, domain)

    return {
        "success": True,
        "domain": domain,
        "dns_check": check_result
    }


@router.post("/check-dns")
async def check_domain_dns(
    domain: str,
    current_user: models.Admin = Depends(get_current_user)
):
    """检查域名 DNS 解析状态"""
    domain = _validate_domain(domain)
    return await check_dns_resolution(domain)


@router.post("/enable-tls")
@limiter.limit("3/hour")  # 证书申请限流：3次/小时（防滥用 Let's Encrypt）
async def enable_tls(
    request: Request,  # slowapi 需要 request 参数
    tls_request: TLSEnableRequest,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """启用 HTTPS（自动申请 Let's Encrypt 证书）"""
    domain = _validate_domain(tls_request.domain)

    # 验证 DNS 解析（dns_checker 现在是 async，直接 await）
    dns_check = await check_dns_resolution(domain)
    if not dns_check["success"]:
        return {
            "success": False,
            "message": f"DNS 检查失败：{dns_check['message']}"
        }

    # 先生成并部署临时 HTTP Nginx 配置，以便 Let's Encrypt 可以通过 80 端口访问验证挑战
    temp_http_config = tls_manager.generate_nginx_config(domain, enable_https=False)
    deploy_temp = tls_manager.apply_nginx_config(temp_http_config, "default.conf")
    if not deploy_temp["success"]:
        return deploy_temp
    tls_manager.reload_nginx()

    # 自动申请 Let's Encrypt 证书（使用 standalone 模式并绑定 9080 端口，前端已通过 80 代理）
    result = await asyncio.to_thread(tls_manager.issue_cert, domain)
    if not result["success"]:
        return result
    cert_path = result["cert_path"]
    key_path = result["key_path"]

    # 证书申请成功后，生成正式的 Nginx HTTPS 配置文件（将后端容器路径转换为 Nginx 容器路径）
    nginx_cert_path = cert_path.replace("/app/certs", "/etc/nginx/certs")
    nginx_key_path = key_path.replace("/app/certs", "/etc/nginx/certs")
    nginx_config = tls_manager.generate_nginx_config(domain, nginx_cert_path, nginx_key_path, enable_https=True)

    deploy_final = tls_manager.apply_nginx_config(nginx_config, "default.conf")
    if not deploy_final["success"]:
        return deploy_final

    reload_result = tls_manager.reload_nginx()
    if not reload_result["success"]:
        return reload_result

    # 保存配置到数据库
    crud.set_config(db, models.ConfigKeys.SERVER_DOMAIN, domain)
    crud.set_config(db, models.ConfigKeys.TLS_ENABLED, "true")
    crud.set_config(db, models.ConfigKeys.TLS_MODE, tls_request.mode)

    return {
        "success": True,
        "message": f"HTTPS 已启用，请访问 https://{domain}",
        "domain": domain,
        "https_url": f"https://{domain}"
    }


@router.post("/disable-tls")
async def disable_tls(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """禁用 HTTPS，切换回 HTTP 模式"""
    domain = crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or ""

    # 生成 HTTP 配置的 Nginx 配置
    nginx_config = tls_manager.generate_nginx_config(domain or "_", "", "", enable_https=False)
    tls_manager.apply_nginx_config(nginx_config, "default.conf")
    tls_manager.reload_nginx()

    # 更新数据库
    crud.set_config(db, models.ConfigKeys.TLS_ENABLED, "false")

    return {
        "success": True,
        "message": "HTTPS 已禁用，恢复 HTTP 访问"
    }


@router.get("/tls-status")
async def get_tls_status(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """
    获取 TLS 状态
    """
    domain = crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN) or ""
    tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"

    cert_info = None
    if domain and tls_enabled:
        cert_info = tls_manager.get_cert_info(domain)

    return {
        "domain": domain,
        "enabled": tls_enabled,
        "ws_protocol": "wss" if tls_enabled else "ws",
        "http_protocol": "https" if tls_enabled else "http",
        "cert_info": cert_info
    }


class PanelPortConfig(BaseModel):
    port: str  # 空字符串表示使用默认端口（80/443）


@router.get("/panel-port")
async def get_panel_port(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """
    获取管理面板公网访问端口配置。
    用于 NAT 场景：公网 IP:port 映射到服务器内网 80 端口。
    留空表示使用默认端口（直连云服务器无需配置）。
    """
    port = crud.get_config(db, models.ConfigKeys.PANEL_ACCESS_PORT) or ""
    return {"port": port}


@router.post("/panel-port")
async def set_panel_port(
    config: PanelPortConfig,
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """
    设置管理面板公网访问端口。
    仅在 NAT 场景下填写（如公网 10967 → 内网 80）。
    """
    port_str = config.port.strip()
    if port_str:
        try:
            port_num = int(port_str)
            if not (1 <= port_num <= 65535):
                raise ValueError()
        except ValueError:
            raise HTTPException(status_code=400, detail="端口号必须是 1-65535 之间的整数") from None
    crud.set_config(db, models.ConfigKeys.PANEL_ACCESS_PORT, port_str)
    return {"success": True, "port": port_str}


@router.post("/renew-cert")
async def renew_certificate(
    db: Session = Depends(get_db),
    current_user: models.Admin = Depends(get_current_user)
):
    """手动续期证书"""
    domain = crud.get_config(db, models.ConfigKeys.SERVER_DOMAIN)
    tls_enabled = crud.get_config(db, models.ConfigKeys.TLS_ENABLED) == "true"
    tls_mode = crud.get_config(db, models.ConfigKeys.TLS_MODE)

    if not domain or not tls_enabled or tls_mode != "auto":
        return {
            "success": False,
            "message": "未开启自动 HTTPS，无法续期证书"
        }

    # 执行续期
    result = await asyncio.to_thread(tls_manager.renew_cert, domain)

    if result["success"]:
        # 续期成功，重载 Nginx
        reload_result = await asyncio.to_thread(tls_manager.reload_nginx)
        if not reload_result["success"]:
            return {
                "success": False,
                "message": f"证书已续期，但重载 Nginx 失败：{reload_result['message']}"
            }
        return {
            "success": True,
            "message": "证书续期成功并已生效"
        }
    else:
        return result
