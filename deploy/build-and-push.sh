#!/bin/bash
# ==============================================================================
# FRP-ALL-IN-ONE 全套容器镜像构建与推送脚本 (腾讯云 TCR 专属)
# ==============================================================================

set -eu

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

REGISTRY="sgccr.ccs.tencentyun.com/frp-all-in-one"
TAG="${1:-latest}"
VERSION="${FRP_BUILD_VERSION:-$TAG}"
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[ERROR] 请指定正式版本: bash build-and-push.sh vX.Y.Z；构建 latest 时需设置 FRP_BUILD_VERSION=vX.Y.Z" >&2
    exit 2
fi
VERSION="${VERSION#v}"
if [ "$TAG" != latest ] && [ "${TAG#v}" != "$VERSION" ]; then
    echo "[ERROR] 镜像标签与构建版本必须一致" >&2
    exit 2
fi
if [ "$TAG" != latest ]; then TAG="v$VERSION"; fi

CONTAINER_TOOL="docker"
if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] 未检测到 Docker"
    exit 1
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
    --build-arg "APP_VERSION=$VERSION" \
    --build-arg "VITE_APP_VERSION=v$VERSION" \
    -t "$REGISTRY/frp-server:$TAG" \
    "$PROJECT_ROOT"

# 2. 构建客户端 Agent 容器镜像
echo ""
echo "[2/2] 构建客户端 Agent 容器镜像 (frp-agent)..."
$CONTAINER_TOOL build \
    -f agent/Dockerfile \
    --build-arg "AGENT_VERSION=$VERSION" \
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
