#!/bin/bash
set -euo pipefail

PORT="${PORT:-443}"
HOST="${FRP_LISTEN_HOST:-127.0.0.1}"
# Auto-generate or load self-signed certificate if requested (e.g. for direct IP+Port HTTPS)
if [ -z "${FRP_TLS_CERT:-}" ] && [ -z "${FRP_TLS_KEY:-}" ]; then
    if [ "${FRP_AUTO_SELF_SIGNED_TLS:-0}" = "1" ] || [ "${FRP_AUTO_TLS:-0}" = "1" ]; then
        TLS_VARS=$(python -c '
import os, sys
from urllib.parse import urlsplit
from services.tls_manager import tls_manager

host = os.environ.get("FRP_SERVER_IP") or os.environ.get("PUBLIC_IP") or ""
public_url = os.environ.get("FRP_PUBLIC_URL", "")
if public_url:
    try:
        parsed_host = urlsplit(public_url).hostname
        if parsed_host:
            host = parsed_host
    except Exception:
        pass
if not host:
    host = "127.0.0.1"

cert, key, fp = tls_manager.ensure_self_signed_cert(host)
pin = tls_manager.compute_cert_pubkey_pin(cert) or ""
print(f"export FRP_TLS_CERT=\"{cert}\"\nexport FRP_TLS_KEY=\"{key}\"\nexport FRP_TLS_FINGERPRINT=\"{fp}\"\nexport FRP_TLS_PUBKEY_PIN=\"{pin}\"")
' 2>/dev/null || true)
        if [ -n "$TLS_VARS" ]; then
            eval "$TLS_VARS"
            echo "[TLS] 已启用 IP 自签名证书: $FRP_TLS_CERT (SHA256: ${FRP_TLS_FINGERPRINT:-})"
            if [ -z "${FRP_LISTEN_HOST:-}" ]; then
                HOST="0.0.0.0"
            fi
        fi
    fi
fi

ARGS=(--host "$HOST" --port "$PORT" --ws-max-size 1048576
      --proxy-headers --forwarded-allow-ips "${FRP_TRUSTED_PROXY_IPS:-127.0.0.1,::1}")

# Native TLS is optional; the safe default is a local backend behind HTTPS.
if [ -n "${FRP_TLS_CERT:-}" ] || [ -n "${FRP_TLS_KEY:-}" ]; then
    if [ -z "${FRP_TLS_CERT:-}" ] || [ -z "${FRP_TLS_KEY:-}" ]; then
        echo "FRP_TLS_CERT and FRP_TLS_KEY must be configured together" >&2
        exit 1
    fi
    ARGS+=(--ssl-certfile "$FRP_TLS_CERT" --ssl-keyfile "$FRP_TLS_KEY")
fi
exec python -m uvicorn main:app "${ARGS[@]}"
