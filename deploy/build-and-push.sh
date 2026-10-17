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

# 仅构建容器镜像，Go 编译在镜像构建阶段完成，不再要求宿主机 make all。
# 1. 构建定制版 FRPS 穿透核心镜像 (v0.71.1)
echo ""
echo "[1/4] 构建专属定制版 FRPS 服务端镜像..."
$CONTAINER_TOOL build \
    -f deploy/frps.Dockerfile \
    -t "$REGISTRY/frps:$TAG" \
    "$PROJECT_ROOT"

# 2. 构建 Python 管理后端镜像
echo ""
echo "[2/4] 构建 Python 管理后台镜像..."
$CONTAINER_TOOL build \
    -f server/Dockerfile \
    -t "$REGISTRY/frp-backend:$TAG" \
    "$PROJECT_ROOT"

# 3. 构建 React 前端静态镜像
echo ""
echo "[3/4] 构建 React 前端 Web 镜像..."
$CONTAINER_TOOL build \
    -f frontend/Dockerfile \
    -t "$REGISTRY/frp-frontend:$TAG" \
    "$PROJECT_ROOT/frontend"

# 4. 构建客户端 Agent 容器镜像
echo ""
echo "[4/4] 构建客户端 Agent 容器镜像..."
$CONTAINER_TOOL build \
    -f agent/Dockerfile \
    -t "$REGISTRY/frp-agent:$TAG" \
    "$PROJECT_ROOT"

echo ""
echo "=================================================================="
echo "  镜像构建全部成功！准备推送到腾讯云仓库..."
echo "=================================================================="

echo "正在推送 frps..."
$CONTAINER_TOOL push "$REGISTRY/frps:$TAG"

echo "正在推送 frp-backend..."
$CONTAINER_TOOL push "$REGISTRY/frp-backend:$TAG"

echo "正在推送 frp-frontend..."
$CONTAINER_TOOL push "$REGISTRY/frp-frontend:$TAG"

echo "正在推送 frp-agent..."
$CONTAINER_TOOL push "$REGISTRY/frp-agent:$TAG"

echo ""
echo "[OK] 所有镜像推送完成: $REGISTRY/*:$TAG"
echo "[INFO] 请确认四个镜像仓库均为公开；推送成功不代表可匿名下载。"
