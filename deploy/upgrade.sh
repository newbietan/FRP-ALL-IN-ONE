#!/bin/bash
# FRP-ALL-IN-ONE 服务端极速平滑升级脚本
# 数据、密钥、客户端与隧道 100% 完整保留，零丢失零重新配置

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] 请使用 root 权限运行: sudo bash upgrade.sh${NC}"
    exit 1
fi

VERSION="${1:-${FRP_UPGRADE_VERSION:-}}"
CONTAINER="${FRP_UPGRADE_CONTAINER:-frp-server}"
CLI="${FRP_CONTAINER_CLI:-}"

# 1. 检测容器引擎 (Docker / Podman)
if [ -z "$CLI" ]; then
    for candidate in docker podman; do
        if command -v "$candidate" >/dev/null 2>&1; then
            CLI="$candidate"; break
        fi
    done
fi
if [ -z "$CLI" ]; then
    echo -e "${RED}[ERROR] 未检测到 Docker 或 Podman 环境${NC}" >&2; exit 1
fi

# 2. 确定目标版本
if [ -z "$VERSION" ]; then
    RELEASE=$(curl -fsSL --connect-timeout 10 --max-time 30 https://api.github.com/repos/newbietan/FRP-ALL-IN-ONE/releases/latest 2>/dev/null || true)
    VERSION=$(printf '%s' "$RELEASE" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9.]*\)".*/\1/p' || true)
    if [ -z "$VERSION" ]; then
        VERSION="v3.2.9"
    fi
fi
VERSION="v${VERSION#v}"
IMAGE="sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:${VERSION}"

echo "========================================================"
echo "  FRP-ALL-IN-ONE - 服务端版本平滑升级 (${VERSION})"
echo "========================================================"
echo "[INFO] 现有数据库、Token、客户端和隧道配置将 100% 完整保留"
echo ""

# 3. 智能嗅探正在运行的 frp-server 容器的真实宿主机工作目录与数据目录
SCRIPT_DIR=""
HOST_DATA_DIR=$($CLI inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)
if [ -n "$HOST_DATA_DIR" ] && [ -d "$HOST_DATA_DIR" ]; then
    PARENT_DIR=$(dirname "$HOST_DATA_DIR")
    if [ -f "$PARENT_DIR/compose.yml" ]; then
        SCRIPT_DIR="$PARENT_DIR"
    fi
fi

if [ -z "$SCRIPT_DIR" ]; then
    if [ -f "$PWD/compose.yml" ]; then
        SCRIPT_DIR="$PWD"
    elif [ -f "$PWD/deploy/compose.yml" ]; then
        SCRIPT_DIR="$PWD/deploy"
    elif [ -d "/opt/frp-all-in-one" ]; then
        SCRIPT_DIR="/opt/frp-all-in-one"
    else
        SCRIPT_DIR="$PWD"
    fi
fi

cd "$SCRIPT_DIR"
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
DATA_DIR="${HOST_DATA_DIR:-$SCRIPT_DIR/data}"

# 4. 自动备份数据库
if [ -f "$DATA_DIR/frp_manager.db" ]; then
    BACKUP_DIR="$DATA_DIR/upgrade/backups"
    mkdir -p "$BACKUP_DIR"
    cp -p "$DATA_DIR/frp_manager.db" "$BACKUP_DIR/frp_manager_$(date +%Y%m%d_%H%M%S).db"
    echo -e "${GREEN}[OK] 已创建 SQLite 数据库安全快照${NC}"
fi

# 5. 拉取目标镜像
echo "[1/3] 正在从腾讯云镜像仓库拉取版本镜像: $IMAGE ..."
$CLI pull "$IMAGE"

# 6. 平滑重建容器
echo "[2/3] 正在以最新镜像平滑重建服务端容器..."
UPGRADED=0
if [ -f "$COMPOSE_FILE" ]; then
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        docker compose -f "$COMPOSE_FILE" pull server 2>/dev/null || docker compose -f "$COMPOSE_FILE" pull 2>/dev/null || true
        docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps server && UPGRADED=1
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps server && UPGRADED=1
    elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
        podman compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps server && UPGRADED=1
    elif command -v podman-compose >/dev/null 2>&1; then
        podman-compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps server && UPGRADED=1
    fi
fi

if [ "$UPGRADED" -ne 1 ]; then
    # 直接使用容器原生 CLI 进行平滑交接（保留旧容器为备用）
    OLD_BACKUP_NAME="${CONTAINER}-old-$(date +%s)"
    $CLI stop "$CONTAINER" 2>/dev/null || true
    $CLI rename "$CONTAINER" "$OLD_BACKUP_NAME" 2>/dev/null || $CLI rm -f "$CONTAINER" 2>/dev/null || true

    SOCKET_OPT=""
    if [ -S "/var/run/docker.sock" ]; then
        SOCKET_OPT="-v /var/run/docker.sock:/var/run/docker.sock"
    elif [ -S "/run/podman/podman.sock" ]; then
        SOCKET_OPT="-v /run/podman/podman.sock:/var/run/docker.sock"
    fi

    ENV_OPT=""
    if [ -f "$SCRIPT_DIR/.env" ]; then
        ENV_OPT="--env-file $SCRIPT_DIR/.env"
    fi

    $CLI run -d \
      --name "$CONTAINER" \
      --restart always \
      --network host \
      $ENV_OPT \
      -v "$DATA_DIR:/app/data" \
      $SOCKET_OPT \
      "$IMAGE"
fi

# 7. 验证健康状态
echo "[3/3] 验证服务运行状态..."
sleep 3
READY=0
for _ in {1..15}; do
    if $CLI ps --filter "name=^${CONTAINER}$" --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
        READY=1; break
    fi
    sleep 2
done

if [ "$READY" -eq 1 ]; then
    # 成功启动后，清理旧的备份容器（若存在）
    OLD_IDS=$($CLI ps -a --filter "name=^${CONTAINER}-old-" --format '{{.ID}}' 2>/dev/null || true)
    if [ -n "$OLD_IDS" ]; then
        echo "$OLD_IDS" | xargs -r "$CLI" rm -f 2>/dev/null || true
    fi
    echo -e "${GREEN}[OK] 服务端平滑升级成功 (${VERSION})！所有数据、Token 与客户端连接已自动恢复。${NC}"
else
    echo -e "${YELLOW}[WARN] 容器启动中，请使用 $CLI logs -f $CONTAINER 查看日志${NC}"
fi
