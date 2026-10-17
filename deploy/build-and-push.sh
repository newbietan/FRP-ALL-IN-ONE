#!/bin/bash
# ==============================================================================
# FRP-ALL-IN-ONE 全套容器镜像构建与推送脚本 (腾讯云 TCR 专属)
# ==============================================================================

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

REGISTRY="sgccr.ccs.tencentyun.com/frp-all-in-one"
TAG="${1:-latest}"

CONTAINER_TOOL="docker"
if ! command -v docker >/dev/null 2>&1; then
    if command -v podman >/dev/null 2>&1; then
        CONTAINER_TOOL="podman"
    else
        echo "[ERROR] 未检测到 docker 或 podman"
        exit 1
    fi
fi

echo "=================================================================="
echo "  FRP-ALL-IN-ONE - 镜像构建与推送 (使用 $CONTAINER_TOOL)"
echo "  目标仓库: $REGISTRY"
echo "  版本标签: $TAG"
echo "=================================================================="
echo ""

cd "$PROJECT_ROOT"

# 1. 构建全合一服务端镜像 (Web 控制台 + 管理 API + 内置 FRPS 核心)
echo ""
echo "[1/2] 构建全合一服务端镜像 (frp-server)..."
$CONTAINER_TOOL build \
    -f server/Dockerfile \
    -t "$REGISTRY/frp-server:$TAG" \
    "$PROJECT_ROOT"

# 2. 构建客户端 Agent 容器镜像
echo ""
echo "[2/2] 构建客户端 Agent 容器镜像 (frp-agent)..."
$CONTAINER_TOOL build \
    -f agent/Dockerfile \
    -t "$REGISTRY/frp-agent:$TAG" \
    "$PROJECT_ROOT"

echo ""
echo "=================================================================="
echo "  镜像构建全部成功！准备推送到腾讯云仓库..."
echo "=================================================================="

echo "正在推送 frp-server..."
$CONTAINER_TOOL push "$REGISTRY/frp-server:$TAG"

echo "正在推送 frp-agent..."
$CONTAINER_TOOL push "$REGISTRY/frp-agent:$TAG"

echo ""
echo "[OK] 所有镜像推送完成: $REGISTRY/frp-server:$TAG 与 $REGISTRY/frp-agent:$TAG"
echo "[INFO] 请确认镜像仓库为公开可见；推送成功不代表可匿名下载。"
