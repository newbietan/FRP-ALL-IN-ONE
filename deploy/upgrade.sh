#!/bin/bash
# 可回滚的短暂停机升级：不重写 Compose，不先删旧容器，不使用可变 latest。
# 用法: bash upgrade.sh [vX.Y.Z]；异常断电后: bash upgrade.sh vX.Y.Z --recover
set -euo pipefail

VERSION="${1:-${FRP_UPGRADE_VERSION:-}}"
ROLE="${FRP_UPGRADE_ROLE:-server}"
CONTAINER="${FRP_UPGRADE_CONTAINER:-frp-server}"
CLI="${FRP_CONTAINER_CLI:-}"
if [ "$ROLE" != "server" ] && [ "$ROLE" != "agent" ]; then
    echo "[ERROR] 未知容器角色" >&2; exit 1
fi
if [ -z "$CLI" ]; then
    for candidate in docker podman; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" inspect "$CONTAINER" >/dev/null 2>&1; then
            CLI="$candidate"; break
        fi
    done
fi
if [ -z "$CLI" ] || ! command -v "$CLI" >/dev/null 2>&1; then
    echo "[ERROR] 未找到原容器的引擎；可设置 FRP_CONTAINER_CLI=docker 或 podman" >&2; exit 1
fi
"$CLI" inspect "$CONTAINER" >/dev/null

if [ -z "$VERSION" ]; then
    # Release 仅在所有版本镜像构建及匿名拉取验证通过后公开。
    RELEASE=$(curl -fsSL --connect-timeout 10 --max-time 30 https://api.github.com/repos/newbietan/FRP-ALL-IN-ONE/releases/latest)
    VERSION=$(printf '%s' "$RELEASE" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9.]*\)".*/\1/p')
fi
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[ERROR] 版本号必须为 vX.Y.Z；无法确认版本时不会重建容器" >&2; exit 1
fi
VERSION="v${VERSION#v}"
IMAGE="sgccr.ccs.tencentyun.com/frp-all-in-one/frp-${ROLE}:${VERSION}"
SOCKET="${FRP_UPGRADE_HOST_SOCKET:-/var/run/docker.sock}"
if [ "$CLI" = "podman" ] && [ -z "${FRP_UPGRADE_HOST_SOCKET:-}" ]; then
    SOCKET="${XDG_RUNTIME_DIR:-/run}/podman/podman.sock"
    [ -S "$SOCKET" ] || SOCKET="/run/podman/podman.sock"
fi
if [ ! -S "$SOCKET" ]; then
    echo "[ERROR] 引擎 Socket 不可用: $SOCKET；请先启动 Docker 或 podman.socket" >&2; exit 1
fi

# 拉取或镜像协议验证失败时原服务完全不变。
echo "[INFO] 拉取固定版本 $IMAGE（切换时连接会短暂中断）"
"$CLI" pull "$IMAGE"
IMAGE_ID=$("$CLI" image inspect --format '{{.Id}}' "$IMAGE")
LABEL_VERSION=$("$CLI" image inspect --format '{{index .Config.Labels "io.frp-all-in-one.version"}}' "$IMAGE_ID")
PROTOCOL=$("$CLI" image inspect --format '{{index .Config.Labels "io.frp-all-in-one.upgrade-protocol"}}' "$IMAGE_ID")
if [ "$LABEL_VERSION" != "$VERSION" ] || [ "$PROTOCOL" != "1" ]; then
    echo "[ERROR] 镜像不支持事务升级或版本不匹配，原容器未改动" >&2; exit 1
fi
DATA_DIR="/app/data"
[ "$ROLE" = "server" ] || DATA_DIR="/opt/frp"
ARGS=(--container "$CONTAINER" --version "$VERSION" --role "$ROLE" --wait)
if [ "${2:-}" = "--recover" ]; then ARGS=(--role "$ROLE" --recover); fi

# 仅启动独立事务，不自行删除/重建旧容器。状态和备份继承原数据卷。
# --wait 根据最终健康结果返回退出码；rolled_back 不会被报告为成功。
"$CLI" run --rm --user 0 \
  --volumes-from "$CONTAINER:rw" \
  -v "$SOCKET:/var/run/docker.sock" \
  -e "FRP_UPGRADE_HOST_SOCKET=$SOCKET" \
  -e "FRP_UPGRADE_DATA_DIR=$DATA_DIR" \
  --entrypoint python3 "$IMAGE_ID" /usr/local/lib/frp/container_upgrade.py "${ARGS[@]}"
