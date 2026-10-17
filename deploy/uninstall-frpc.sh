#!/usr/bin/env bash
# 兼容旧卸载地址；当前版本仅部署容器客户端，不再按进程名强杀或删除原生服务。
set -euo pipefail
script=$(mktemp)
trap 'rm -f -- "$script"' EXIT
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh -o "$script"
bash "$script" client "$@"
