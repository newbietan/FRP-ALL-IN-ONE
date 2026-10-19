#!/usr/bin/env bash
# 发布验收：隔离维护者的 Docker 凭据，确认最终用户可以匿名拉取完整镜像。
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "用法: bash deploy/check-public-images.sh <镜像:标签> [...]" >&2
    exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] 公开镜像验收需要 Docker CLI 和可用的 Docker Engine" >&2
    exit 2
fi

auth_dir=$(mktemp -d)
trap 'rm -rf -- "$auth_dir"' EXIT
printf '{"auths":{}}\n' > "$auth_dir/config.json"

for image in "$@"; do
    pulled=false
    for attempt in 1 2 3; do
        echo "[CHECK] 匿名拉取 $image (amd64 + arm64)（$attempt/3）"
        if docker --config "$auth_dir" pull "$image" && docker --config "$auth_dir" pull --platform linux/arm64 "$image"; then
            pulled=true
            break
        fi
        if [ "$attempt" -lt 3 ]; then
            sleep 5
        fi
    done
    if [ "$pulled" != true ]; then
        echo "[ERROR] 无法匿名拉取 $image (amd64 / arm64)。请检查标签是否存在、多架构 manifest 是否完整，以及腾讯云控制台中该镜像仓库是否为公开。" >&2
        echo "[ERROR] 推送成功不代表镜像公开；不要要求最终用户配置 TCR_USERNAME/TCR_PASSWORD。" >&2
        exit 1
    fi
    echo "[OK] $image (amd64 + arm64) 匿名拉取成功"
done
