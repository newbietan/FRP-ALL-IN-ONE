"""
TLS 证书管理服务
处理 Let's Encrypt 证书申请、续期、Nginx 配置管理
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

from core.container_engine import run_podman

logger = logging.getLogger(__name__)

# 证书存储路径
CERTS_DIR = Path(os.environ.get("FRP_CERTS_DIR", "/app/certs"))
AUTO_CERTS_DIR = CERTS_DIR / "auto"
NGINX_CONFIG_PATH = Path("/etc/nginx/conf.d")

# acme.sh 路径
ACME_SH = "/opt/acme.sh/acme.sh"


class TLSManager:
    """TLS 证书管理器"""

    def __init__(self):
        AUTO_CERTS_DIR.mkdir(parents=True, exist_ok=True)

    def get_cert_info(self, domain: str) -> dict[str, Any] | None:
        """获取证书信息"""
        cert_path = AUTO_CERTS_DIR / f"{domain}.crt"

        if not cert_path.exists():
            return None

        # 使用 openssl 获取证书过期时间
        try:
            result = subprocess.run(
                ["openssl", "x509", "-in", str(cert_path), "-noout", "-dates", "-subject"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if result.returncode == 0:
                info: dict[str, Any] = {"domain": domain, "cert_path": str(cert_path)}
                for line in result.stdout.split("\n"):
                    if "notAfter=" in line:
                        expiry_str = line.split("=")[1]
                        # 解析日期
                        with contextlib.suppress(Exception):
                            expiry = datetime.strptime(expiry_str, "%b %d %H:%M:%S %Y %Z")
                            # openssl 输出的时间总是 GMT，强制设为 UTC 避免 naive/aware 混用
                            expiry_utc = expiry.replace(tzinfo=timezone.utc)
                            info["expires_at"] = expiry_utc.isoformat()
                            info["days_until_expiry"] = (expiry_utc - datetime.now(timezone.utc)).days
                    if "subject=" in line:
                        info["subject"] = line
                return info
        except Exception as e:
            logger.debug("解析证书 %s 异常: %s", domain, e)
        return None

    def issue_cert(self, domain: str) -> dict[str, Any]:
        """
        使用 acme.sh 申请 Let's Encrypt 证书

        Returns:
            {"success": bool, "message": str, "cert_path": str or None}
        """
        try:
            # 设置环境变量
            env = os.environ.copy()
            env["LE_WORKING_DIR"] = "/opt/acme.sh"

            # 申请证书（使用独立模式，不依赖 Nginx 配置）
            cmd = [
                ACME_SH,
                "--issue",
                "-d", domain,
                "--standalone",
                "--httpport", "9080",  # 使用 9080 端口避免与前端 Nginx (8080) 冲突
                "--certhome", str(AUTO_CERTS_DIR),
                "--force"
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
                check=False,
            )

            if result.returncode == 0:
                # 安装证书到标准位置
                cert_path = AUTO_CERTS_DIR / f"{domain}.crt"
                key_path = AUTO_CERTS_DIR / f"{domain}.key"

                install_cmd = [
                    ACME_SH,
                    "--install-cert",
                    "-d", domain,
                    "--certhome", str(AUTO_CERTS_DIR),
                    "--cert-file", str(cert_path),
                    "--key-file", str(key_path),
                    "--fullchain-file", str(AUTO_CERTS_DIR / f"{domain}.fullchain.crt")
                ]

                install_result = subprocess.run(
                    install_cmd, capture_output=True, text=True, env=env, check=False,
                )

                if install_result.returncode != 0:
                    return {
                        "success": False,
                        "message": f"证书申请成功但安装失败：{install_result.stderr[:200]}",
                        "cert_path": None
                    }

                return {
                    "success": True,
                    "message": f"证书申请成功：{domain}",
                    "cert_path": str(cert_path),
                    "key_path": str(key_path)
                }
            else:
                error_msg = result.stderr or result.stdout
                # 提取有用的错误信息
                if "rate limit" in error_msg.lower():
                    return {
                        "success": False,
                        "message": "Let's Encrypt 申请次数超限，请 1 小时后重试",
                        "cert_path": None
                    }
                elif "DNS" in error_msg or "not resolve" in error_msg:
                    return {
                        "success": False,
                        "message": f"DNS 解析验证失败：域名 {domain} 的 A 记录未正确指向本服务器",
                        "cert_path": None
                    }
                else:
                    return {
                        "success": False,
                        "message": f"证书申请失败：{error_msg[:200]}",
                        "cert_path": None
                    }
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "message": "证书申请超时，请检查网络连接",
                "cert_path": None
            }
        except Exception as e:
            return {
                "success": False,
                "message": f"证书申请异常：{e!s}",
                "cert_path": None
            }

    def renew_cert(self, domain: str) -> dict[str, Any]:
        """续期证书"""
        try:
            env = os.environ.copy()
            env["LE_WORKING_DIR"] = "/opt/acme.sh"

            cmd = [
                ACME_SH,
                "--renew",
                "-d", domain,
                "--certhome", str(AUTO_CERTS_DIR),
                "--force"
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
                check=False,
            )

            if result.returncode == 0:
                return {
                    "success": True,
                    "message": f"证书续期成功：{domain}"
                }
            else:
                return {
                    "success": False,
                    "message": f"证书续期失败：{result.stderr[:200]}"
                }
        except Exception as e:
            return {
                "success": False,
                "message": f"证书续期异常：{e!s}"
            }

    def generate_nginx_config(
        self,
        domain: str,
        cert_path: str = "",
        key_path: str = "",
        enable_https: bool = True,
    ) -> str:
        """生成 Nginx 配置文件"""
        if enable_https:
            if not cert_path or not key_path:
                raise ValueError("启用 HTTPS 时必须提供证书和私钥路径")
            config = f'''server {{
    listen 80;
    server_name {domain};

    # 用于 acme.sh 独立模式的证书申请挑战
    location /.well-known/acme-challenge/ {{
        proxy_pass http://127.0.0.1:9080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    # HTTP 自动跳转 HTTPS
    location / {{
        return 301 https://$host$request_uri;
    }}
}}

server {{
    listen 443 ssl http2;
    server_name {domain};

    # SSL 证书配置
    ssl_certificate {cert_path};
    ssl_certificate_key {key_path};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # 安全响应头
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location /assets/ {{
        root /usr/share/nginx/html;
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }}

    location = /index.html {{
        root /usr/share/nginx/html;
        add_header Cache-Control "no-store";
    }}

    # 前端静态文件
    location / {{
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }}

    # API 代理
    location /api/ {{
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}

    location /token {{
        proxy_pass http://127.0.0.1:8000/token;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    location /clients {{
        proxy_pass http://127.0.0.1:8000/clients;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    # WebSocket 代理
    location /ws/ {{
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }}
}}
'''
        else:
            server_name = domain if domain else "_"
            config = f'''server {{
    listen 80;
    server_name {server_name};

    # 用于 acme.sh 独立模式的证书申请挑战
    location /.well-known/acme-challenge/ {{
        proxy_pass http://127.0.0.1:9080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    location /assets/ {{
        root /usr/share/nginx/html;
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }}

    location = /index.html {{
        root /usr/share/nginx/html;
        add_header Cache-Control "no-store";
    }}

    # 前端静态文件
    location / {{
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }}

    # API 代理
    location /api/ {{
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}

    location /token {{
        proxy_pass http://127.0.0.1:8000/token;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    location /clients {{
        proxy_pass http://127.0.0.1:8000/clients;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    # WebSocket 代理
    location /ws/ {{
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }}
}}
'''
        return config

    def apply_nginx_config(self, config_content: str, config_name: str = "default.conf") -> dict[str, Any]:
        """应用 Nginx 配置：优先直接写入共享卷（避免依赖 podman cp），回退使用 podman cp"""
        target_dir = Path("/etc/nginx/conf.d")
        target_file = target_dir / config_name
        try:
            if target_dir.exists() and os.access(str(target_dir), os.W_OK):
                target_file.write_text(config_content)
                return {"success": True, "message": "Nginx 配置已写入共享数据卷"}
        except Exception as e:
            print(f"[TLSManager] 写入共享卷失败，回退使用 podman cp: {e}")

        # 回退至通过本地 certs 目录复制
        local_path = Path("/app/certs") / config_name
        try:
            local_path.write_text(config_content)
            cp_result = run_podman(
                ["cp", str(local_path), f"frp-manager-web:/etc/nginx/conf.d/{config_name}"],
                timeout=30,
            )
            if cp_result.returncode == 0:
                return {"success": True, "message": "Nginx 配置已通过 podman cp 同步"}
            return {"success": False, "message": f"复制 Nginx 配置失败: {cp_result.stderr}"}
        except Exception as e:
            return {"success": False, "message": f"部署 Nginx 配置失败: {e}"}

    def reload_nginx(self) -> dict[str, Any]:
        """重载 Nginx 配置（原生模式优先，容器模式回退）"""
        # 1. 优先尝试原生主机 Nginx
        if shutil.which("nginx"):
            try:
                test_result = subprocess.run(
                    ["nginx", "-t"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                if test_result.returncode != 0:
                    return {
                        "success": False,
                        "message": f"Nginx 配置测试失败：{test_result.stderr}",
                    }
                reload_result = subprocess.run(
                    ["nginx", "-s", "reload"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                if reload_result.returncode == 0:
                    return {"success": True, "message": "Nginx 配置重载成功 (原生系统服务)"}
            except Exception as e:
                logger.debug("原生 Nginx 重载尝试失败: %s", e)

        # 2. 容器模式回退
        try:
            # 先测试配置
            test_result = run_podman(
                ["exec", "frp-manager-web", "nginx", "-t"],
                timeout=30,
            )

            if test_result.returncode != 0:
                return {
                    "success": False,
                    "message": f"Nginx 配置测试失败：{test_result.stderr}"
                }

            # 重载配置
            reload_result = run_podman(
                ["exec", "frp-manager-web", "nginx", "-s", "reload"],
                timeout=30,
            )

            if reload_result.returncode == 0:
                return {
                    "success": True,
                    "message": "Nginx 配置重载成功"
                }
            else:
                return {
                    "success": False,
                    "message": f"Nginx 重载失败：{reload_result.stderr}"
                }
        except Exception as e:
            return {
                "success": False,
                "message": f"重载 Nginx 异常：{e!s}"
            }

    def check_cert_needs_renew(self, domain: str, days_before: int = 30) -> bool:
        """检查证书是否需要续期"""
        info = self.get_cert_info(domain)
        if info and "days_until_expiry" in info:
            return info["days_until_expiry"] <= days_before
        return False


# 全局实例
tls_manager = TLSManager()
