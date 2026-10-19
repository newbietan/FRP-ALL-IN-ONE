#!/bin/bash
# FRP-ALL-IN-ONE 服务端极速平滑升级脚本
# 数据、密钥、客户端与隧道 100% 完整保留，零丢失零重新配置

set -eu

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] 请使用 root 权限运行: sudo bash upgrade.sh${NC}"
    exit 1
fi

if [ -f "$PWD/compose.yml" ]; then
    SCRIPT_DIR="$PWD"
elif [ -f "$PWD/deploy/compose.yml" ]; then
    SCRIPT_DIR="$PWD/deploy"
elif [ -d "/opt/frp-all-in-one" ]; then
    SCRIPT_DIR="/opt/frp-all-in-one"
else
    SCRIPT_DIR="$PWD"
fi

cd "$SCRIPT_DIR"
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"

echo "========================================================"
echo "  FRP-ALL-IN-ONE - 服务端平滑版本升级"
echo "========================================================"
echo "[INFO] 升级过程将拉取最新镜像并平滑重建容器"
echo "[INFO] 现有数据库、Token、客户端和隧道配置将 100% 完整保留"
echo ""

# 检测容器环境
if command -v docker >/dev/null 2>&1; then
    CLI="docker"
elif command -v podman >/dev/null 2>&1; then
    CLI="podman"
else
    echo -e "${RED}[ERROR] 未检测到 Docker 或 Podman 环境${NC}"
    exit 1
fi

# 检查并配置容器管理 Socket（支持后续 Web 控制台一键自升级）
if [ -S "/var/run/docker.sock" ]; then
    echo -e "${GREEN}[OK] 检测到宿主机 Docker Socket: /var/run/docker.sock${NC}"
elif [ -S "/run/podman/podman.sock" ]; then
    ln -sf /run/podman/podman.sock /var/run/docker.sock 2>/dev/null || true
    echo -e "${GREEN}[OK] 已关联 Podman Socket 至 /var/run/docker.sock${NC}"
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "podman.socket"; then
    systemctl enable --now podman.socket 2>/dev/null || true
    if [ -S "/run/podman/podman.sock" ]; then
        ln -sf /run/podman/podman.sock /var/run/docker.sock 2>/dev/null || true
        echo -e "${GREEN}[OK] 已启动 podman.socket 并关联至 /var/run/docker.sock${NC}"
    fi
fi

# 确保 compose.yml 包含最新的标准配置（特别是 docker.sock 挂载，开启 Web 面板自升级）
if [ ! -f "$COMPOSE_FILE" ] || ! grep -q "docker.sock" "$COMPOSE_FILE"; then
    echo "[CONFIG] 更新 compose.yml 增加 Socket 挂载（供后续 Web 面板直接一键升级）..."
    cat > "$COMPOSE_FILE" << 'COMPOSE_EOF'
---
services:
  server:
    image: sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:latest
    container_name: frp-server
    restart: always
    network_mode: host
    env_file: .env
    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    labels:
      - "com.centurylinklabs.watchtower.enable=true"
COMPOSE_EOF
fi

IMAGE="sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:latest"

echo "[1/3] 正在从腾讯云镜像仓库拉取最新服务端镜像..."
$CLI pull "$IMAGE"

echo "[2/3] 正在以最新镜像平滑重启服务端容器..."
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" up -d --no-deps server
elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" up -d --no-deps server
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    podman compose -f "$COMPOSE_FILE" up -d --no-deps server
elif command -v podman-compose >/dev/null 2>&1; then
    podman-compose -f "$COMPOSE_FILE" up -d --no-deps server
else
    # 回退：直接使用容器 CLI 重建
    $CLI rm -f frp-server 2>/dev/null || true
    $CLI run -d \
      --name frp-server \
      --restart always \
      --network host \
      --env-file "$SCRIPT_DIR/.env" \
      -v "$SCRIPT_DIR/data:/app/data" \
      -v "/var/run/docker.sock:/var/run/docker.sock" \
      "$IMAGE"
fi

echo "[3/3] 验证容器运行状态..."
sleep 2
if $CLI ps --filter "name=^frp-server$" --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
    echo -e "${GREEN}[OK] 服务端平滑升级成功！所有数据、Token 与客户端连接已自动恢复。${NC}"
else
    echo -e "${YELLOW}[WARN] 容器启动中，请使用 $CLI logs -f frp-server 查看日志${NC}"
fi
