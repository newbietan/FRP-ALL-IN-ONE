#!/usr/bin/env bash
# Docker 配置保留升级：固定版本、独立事务执行器、真实健康检查、失败回滚。
# 切换容器时现有连接会短暂中断，不承诺零停机。
set -euo pipefail

VERSION="${1:-${FRP_UPGRADE_VERSION:-}}"
CONTAINER="${FRP_UPGRADE_CONTAINER:-frp-server}"
SOCKET="${FRP_UPGRADE_HOST_SOCKET:-/var/run/docker.sock}"
DATA_DIR="${FRP_UPGRADE_DATA_DIR:-/app/data}"

if [ "$#" -gt 1 ] || [ "${FRP_CONTAINER_CLI:-docker}" != docker ]; then
    echo "用法: bash upgrade.sh [vX.Y.Z]（仅支持 Docker）" >&2
    exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "[ERROR] 请先安装 Docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "[ERROR] Docker 不可访问，请检查服务、权限与上下文" >&2; exit 1; }
# Docker API 执行器通过本地 Socket 工作；不能把远程上下文误当成本机。
ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
if [ "$ENDPOINT" != "unix://$SOCKET" ] || [ ! -S "$SOCKET" ]; then
    echo "[ERROR] Docker 上下文与本地 Socket 不匹配；请设置 FRP_UPGRADE_HOST_SOCKET 或切回本机上下文" >&2
    exit 1
fi
docker inspect "$CONTAINER" >/dev/null

if [ -z "$VERSION" ]; then
    RELEASE=$(curl -fsSL --connect-timeout 10 --max-time 30 https://api.github.com/repos/newbietan/FRP-ALL-IN-ONE/releases/latest) || {
        echo "[ERROR] 无法获取已发布版本，请显式指定 vX.Y.Z；原容器未改变" >&2; exit 1;
    }
    VERSION=$(printf '%s' "$RELEASE" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9.]*\)".*/\1/p')
fi
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[ERROR] 目标必须是正式版本号，例如 v3.2.9；原容器未改变" >&2
    exit 2
fi
VERSION="v${VERSION#v}"
IMAGE="sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:$VERSION"
echo "[INFO] 将升级 $CONTAINER 到 ${VERSION}；保留挂载、环境变量、端口和配置，切换时连接短暂中断"
# 先拉取，再用目标镜像自带的执行器，兼容尚未安装执行器的旧服务端。
docker pull "$IMAGE"
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
docker run --rm --user 0 --network none \
    --volumes-from "$CONTAINER:rw" \
    -v "$SOCKET:/var/run/docker.sock" \
    -e "FRP_UPGRADE_HOST_SOCKET=$SOCKET" \
    -e "FRP_UPGRADE_DATA_DIR=$DATA_DIR" \
    --entrypoint python3 "$IMAGE_ID" /usr/local/lib/frp/container_upgrade.py \
    --container "$CONTAINER" --role server --version "$VERSION" --enable-socket --wait
# --wait 只有在真实健康检查通过时才返回成功；回滚/失败返回非零。
echo "[OK] $VERSION 已通过健康检查。请勿用旧 Compose 镜像标签覆盖此版本。"
