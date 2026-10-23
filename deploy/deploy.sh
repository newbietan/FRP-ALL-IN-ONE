#!/bin/bash
# FRP-ALL-IN-ONE - 极速容器一键部署脚本 (腾讯云公开镜像服务)
# 用途: 自动识别 Linux 发行版并拉取全套专属镜像完成极速部署

set -eu

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# 智能确定部署工作目录：若当前目录或子目录有 compose.yml 则就地部署，否则统一使用标准持久化目录 /opt/frp-all-in-one
if [ -f "$PWD/compose.yml" ]; then
    SCRIPT_DIR="$PWD"
elif [ -f "$PWD/deploy/compose.yml" ]; then
    SCRIPT_DIR="$PWD/deploy"
else
    SCRIPT_DIR="/opt/frp-all-in-one"
    mkdir -p "$SCRIPT_DIR"
fi

cd "$SCRIPT_DIR"
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
COMPOSE_MODE=""
CONTAINER_CLI="docker"
LOW_MEM_NO_SWAP="0"
PUBLIC_IP=""
PROJECT_CONTAINERS="frp-server frp-manager-backend frp-manager-web frps"

echo "========================================================"
echo "  FRP-ALL-IN-ONE - 中国大陆设备内网穿透"
echo "========================================================"
echo "[INFO] 推荐境内 Linux 服务器；仅管理自有或已获授权的设备。"
echo "[INFO] 网站服务请先核实备案要求；HTTPS 证书不能替代备案。"
echo "[WARN] 默认 HTTP 面板请限制访问来源；长期公网访问应配置合规 HTTPS。"
echo ""

read_input() {
    local prompt="$1"
    local var_name="$2"
    printf "%b" "$prompt"
    # shellcheck disable=SC2229
    if [ -r /dev/tty ]; then
        read -r "$var_name" < /dev/tty || true
    else
        read -r "$var_name" || true
    fi
}

detect_public_ip() {
    if [ -n "${PUBLIC_IP:-}" ] && [ "$PUBLIC_IP" != "<你的服务器IP>" ]; then
        return
    fi
    echo ""
    echo "[CHECK] 检测服务器公网 IP..."

    PUBLIC_IP=$(curl -4 -s --max-time 3 ifconfig.me 2>/dev/null || \
                curl -4 -s --max-time 3 ip.sb 2>/dev/null || \
                curl -4 -s --max-time 3 api.ipify.org 2>/dev/null || \
                curl -4 -s --max-time 3 icanhazip.com 2>/dev/null || \
                echo "")
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP=$(curl -6 -s --max-time 3 ifconfig.me 2>/dev/null || \
                    curl -6 -s --max-time 3 ip.sb 2>/dev/null || \
                    echo "")
        if [ -n "$PUBLIC_IP" ]; then
            PUBLIC_IP="[${PUBLIC_IP}]"
        fi
    fi
    if [ -z "$PUBLIC_IP" ]; then
        PUBLIC_IP="<你的服务器IP>"
        echo -e "${YELLOW}[WARN] 未能自动获取公网 IP，请手动替换提示中的 <你的服务器IP>${NC}"
    else
        echo -e "${GREEN}[OK] 已自动识别服务器公网 IP: ${PUBLIC_IP}${NC}"
    fi
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}[ERROR] 请使用 root 运行: sudo sh deploy.sh${NC}"
        exit 1
    fi
}

detect_os() {
    if [ ! -f /etc/os-release ]; then
        echo -e "${RED}[ERROR] 无法识别系统发行版（缺少 /etc/os-release）${NC}"
        exit 1
    fi

    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"

    echo "[INFO] 检测到系统: ${PRETTY_NAME:-$OS_ID}"
}

install_docker_stack() {
    echo "[INSTALL] 安装 Docker 与 Compose..."
    case "$OS_ID" in
        alpine)
            apk add --no-cache docker docker-cli-compose curl ca-certificates lsof
            ;;
        debian|ubuntu)
            apt-get update
            apt-get install -y docker.io docker-compose curl ca-certificates lsof
            ;;
        *)
            echo "[ERROR] 请按 https://docs.docker.com/engine/install/ 安装 Docker Engine 和 Compose 后重试" >&2
            exit 1
            ;;
    esac
}

detect_container_stack() {
    if ! command -v docker >/dev/null 2>&1; then
        install_docker_stack
    fi
    # Docker 正在运行不代表已开机自启；每次部署都确保宿主机服务已启用。
    if command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now docker || echo "[WARN] 无法启用 Docker 开机自启，请手动检查 systemctl is-enabled docker" >&2
    elif command -v rc-update >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; then
        rc-update add docker default || echo "[WARN] 无法将 Docker 加入 OpenRC 默认启动级别" >&2
        rc-service docker start || echo "[WARN] Docker 服务启动失败，请检查 rc-service docker status" >&2
    else
        echo "[WARN] 未检测到 systemd/OpenRC，请手动配置 Docker 开机自启；容器重启策略依赖 Docker 启动" >&2
    fi
    docker info >/dev/null 2>&1 || { echo "[ERROR] Docker 不可用，请检查服务和权限" >&2; exit 1; }
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_MODE="docker-compose-plugin"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_MODE="docker-compose"
    else
        echo "[ERROR] 请安装 Docker Compose 后重试" >&2
        exit 1
    fi
}

run_compose() {
    case "$COMPOSE_MODE" in
        "docker-compose-plugin")
            docker compose -f "$COMPOSE_FILE" "$@"
            ;;
        "docker-compose")
            docker-compose -f "$COMPOSE_FILE" "$@"
            ;;
        *)
            echo -e "${RED}[ERROR] 未识别的 compose 模式: $COMPOSE_MODE${NC}"
            exit 1
            ;;
    esac
}

ensure_container_socket() {
    echo ""
    echo "[CHECK] 检查并配置容器管理 Socket（支持 Web 控制台一键平滑升级）..."
    if [ -S "/var/run/docker.sock" ]; then
        echo -e "${GREEN}[OK] 检测到宿主机 Docker Socket: /var/run/docker.sock${NC}"
    else
        echo -e "${YELLOW}[INFO] 未检测到容器管理 Socket，支持通过一键升级脚本完成更新${NC}"
    fi
}

check_memory() {
    echo ""
    echo "[CHECK] 检查服务器内存..."

    total_mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    swap_total=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)

    echo "   当前内存: ${total_mem}MB"

    if [ "$total_mem" -lt 1024 ] && [ "$swap_total" -eq 0 ]; then
        echo -e "${YELLOW}[WARN] 检测到低内存且无 Swap${NC}"

        choice="${AUTO_CREATE_SWAP:-}"
        if [ -z "$choice" ]; then
            if [ -r /dev/tty ]; then
                read_input "是否创建 512MB Swap？(y/N): " choice
            else
                choice="n"
                echo -e "${YELLOW}[WARN] 当前为非交互环境，默认跳过 Swap 创建（可设置 AUTO_CREATE_SWAP=y 自动创建）${NC}"
            fi
        fi

        case "$choice" in
            y|Y|yes|YES)
                chmod +x "$SCRIPT_DIR/setup-swap.sh"
                sh "$SCRIPT_DIR/setup-swap.sh"
                ;;
            *)
                echo -e "${YELLOW}[WARN] 已跳过 Swap 创建，继续部署${NC}"
                LOW_MEM_NO_SWAP="1"
                ;;
        esac
    else
        echo -e "${GREEN}[OK] 内存/Swap 状态可用${NC}"
    fi
}

check_ports() {
    echo ""
    echo "[CHECK] 检查端口占用..."

    for port in "${PORT:-443}" 7000 7500; do
        if command -v lsof >/dev/null 2>&1 && lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${YELLOW}[WARN] 端口 $port 已被占用${NC}"
            echo "   请释放端口或修改 compose.yml 中配置"
            exit 1
        fi
    done

    echo -e "${GREEN}[OK] 端口检查通过${NC}"
}

cleanup_existing_project_containers() {
    echo ""
    echo "[CHECK] 彻底清理旧容器与历史残留..."

    # 1. 尝试使用 compose down 清理
    if [ -f "$COMPOSE_FILE" ]; then
        run_compose down --remove-orphans >/dev/null 2>&1 || true
    fi

    # 2. 清理 Docker 中残留的项目容器
    for container_name in $PROJECT_CONTAINERS; do
        if $CONTAINER_CLI inspect "$container_name" >/dev/null 2>&1; then
            echo -e "${YELLOW}[WARN] 发现旧容器: ${container_name}，正在强制清理...${NC}"
            $CONTAINER_CLI rm -f "$container_name" >/dev/null 2>&1 || true
        fi
    done

    # 3. 清理历史遗留的多容器独立数据卷
    for vol in frp-all-in-one_frp-data frp-all-in-one_frp-certs frp-all-in-one_nginx-conf; do
        if $CONTAINER_CLI volume inspect "$vol" >/dev/null 2>&1; then
            $CONTAINER_CLI volume rm -f "$vol" >/dev/null 2>&1 || true
        fi
    done

    # 4. 数据目录与历史配置持久化保护：现有数据库、密钥与配置 100% 完整保留，绝不误删
    if [ -f "$SCRIPT_DIR/frps.toml" ] && [ ! -f "$SCRIPT_DIR/data/frps.toml" ]; then
        mkdir -p "$SCRIPT_DIR/data"
        mv "$SCRIPT_DIR/frps.toml" "$SCRIPT_DIR/data/frps.toml"
    fi
    rm -rf "$SCRIPT_DIR/frps.toml"
    mkdir -p "$SCRIPT_DIR/data"

    if [ -f "$SCRIPT_DIR/data/frp_manager.db" ]; then
        echo -e "${GREEN}[OK] 检测到现有数据库，所有客户端与隧道配置已完好保留（零数据丢失）${NC}"
    fi

    echo -e "${GREEN}[OK] 旧容器清理完成，数据持久化已确认${NC}"
}

ensure_compose_file() {
    echo "[CONFIG] 写入最新标准单容器编排配置文件 compose.yml..."
    cat > "$COMPOSE_FILE" << 'COMPOSE_EOF'
---
services:
  server:
    image: >-
      ${FRP_IMAGE:-sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:latest}
    container_name: frp-server
    restart: always
    network_mode: host
    env_file: .env
    volumes:
      - ./data:/app/data
      # Host-side upgrades are the safe default; no Docker Socket in the panel.
    labels:
      - "com.centurylinklabs.watchtower.enable=false"
COMPOSE_EOF
    echo -e "${GREEN}[OK] compose.yml 已就绪${NC}"
}

deploy_services() {
    echo ""
    echo "[DEPLOY] 部署并启动服务..."

    ensure_compose_file

    if [ "$LOW_MEM_NO_SWAP" = "1" ]; then
        echo -e "${YELLOW}[WARN] 检测到低内存且未创建 Swap，继续构建很可能 OOM 失败${NC}"
        if [ -t 0 ]; then
            printf "是否仍继续构建与部署？(y/N): "
            read -r continue_without_swap
            case "$continue_without_swap" in
                y|Y|yes|YES)
                    ;;
                *)
                    echo -e "${RED}[ERROR] 已取消部署。建议先创建 Swap 后重试。${NC}"
                    exit 1
                    ;;
            esac
        else
            echo -e "${RED}[ERROR] 非交互环境下已终止部署。请先创建 Swap，或设置 AUTO_CREATE_SWAP=y。${NC}"
            exit 1
        fi
    fi

    echo "[PULL] 拉取最新全合一镜像..."
    if ! run_compose pull; then
        echo -e "${YELLOW}[WARN] 镜像拉取失败，检查本地缓存...${NC}"
        if ! $CONTAINER_CLI image inspect "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:latest" >/dev/null 2>&1; then
            echo -e "${RED}[ERROR] 镜像拉取失败且无本地缓存，请检查网络或镜像仓库配置${NC}"
            exit 1
        fi
        echo -e "${YELLOW}[OK] 使用本地缓存镜像继续部署${NC}"
    fi

    run_compose up -d

    echo ""
    echo "[CHECK] 验证容器启动状态..."
    sleep 3
    if ! $CONTAINER_CLI ps --filter "name=^frp-server$" --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
        echo -e "${RED}[ERROR] 容器 frp-server 未正常运行${NC}"
        $CONTAINER_CLI logs "frp-server" --tail 20 2>/dev/null || true
        echo ""
        exit 1
    else
        echo -e "${GREEN}[OK] frp-server 运行中${NC}"
    fi

    echo -e "${GREEN}[OK] 服务端单容器启动成功！${NC}"
}

show_info() {
    echo ""
    echo "=========================================="
    echo "  部署完成！"
    echo "=========================================="
    echo ""

    if [ -z "${PUBLIC_IP:-}" ] || [ "$PUBLIC_IP" = "<你的服务器IP>" ]; then
        detect_public_ip
    fi

    echo "[访问地址]"
    echo "   Web 管理界面: ${FRP_PUBLIC_URL:-https://你的面板域名}"
    if [ "${FRP_AUTO_SELF_SIGNED_TLS:-0}" = "1" ]; then
        echo -e "   ${YELLOW}[证书说明] 当前采用 IP 自签名证书模式。首次打开浏览器如提示“证书不受信任/安全警告”，请点击“高级” -> “继续前往”，传输全程受 TLS 1.3 强加密保护，国内免域名、免备案且不会被机房阻断。${NC}"
    else
        echo "   后端如监听 127.0.0.1:443；请按 docs/security.md 配置宿主机 HTTPS 代理。"
    fi
    echo "   FRP 穿透端口: ${PUBLIC_IP}:7000"
    echo ""
    echo "[登录方式]"
    echo "   使用 GitHub 账号登录"
    echo -e "   ${YELLOW}* 仅预设的 GitHub 账号可以完成首次管理员注册${NC}"
    echo ""
    echo "[移除本项目（保留数据库、证书与配置）]"
    printf '   curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server --dir %q\n' "$SCRIPT_DIR"
    echo "   完整清理需在末尾加 --purge 并输入 REMOVE 确认；客户端需在各自设备上单独移除。"
    echo ""
    echo "[开机自启与异常重启]"
    echo "   frp-server 容器已配置 restart: always，Docker 启动后会自动恢复。"
    echo "   请留意上方 Docker 开机自启检查警告；手动 Compose 部署需自行启用 Docker 服务。"
    echo ""
    echo "[常用命令]"
    echo "   部署工作目录: cd $SCRIPT_DIR"
    case "$COMPOSE_MODE" in
        "docker-compose-plugin")
            echo "   查看日志: docker compose -f compose.yml logs -f"
            echo "   重启服务: docker compose -f compose.yml restart"
            echo "   停止服务: docker compose -f compose.yml down"
            ;;
        "docker-compose")
            echo "   查看日志: docker-compose -f compose.yml logs -f"
            echo "   重启服务: docker-compose -f compose.yml restart"
            echo "   停止服务: docker-compose -f compose.yml down"
            ;;
    esac
    echo ""
}

configure_env_vars() {
    echo ""
    echo "=========================================="
    echo "  环境变量配置"
    echo "=========================================="

    # 从系统级持久化文件读取（服务器重启/重新部署后仍有效）
    SYSTEM_ENV="/etc/frp-all-in-one.env"
    if [ -f "$SYSTEM_ENV" ]; then
        . "$SYSTEM_ENV" 2>/dev/null || true
    fi

    # 从项目 .env 文件读取（如果存在）
    ENV_FILE="$SCRIPT_DIR/.env"
    if [ -f "$ENV_FILE" ]; then
        . "$ENV_FILE" 2>/dev/null || true
    fi

    # 自动识别公网 IP 并完整展示给用户
    detect_public_ip

    if [ -z "${FRP_PUBLIC_URL:-}" ]; then
        echo ""
        echo -e "${YELLOW}请选择面板访问协议与部署模式：${NC}"
        echo -e "  ${GREEN}[1] 纯 IP 自签 HTTPS 模式${NC} (推荐国内无备案服务器，直接使用 https://${PUBLIC_IP} 访问，免输端口号、免域名、免备案且全程 TLS 加密)"
        echo -e "  [2] 已备案域名 HTTPS 模式 (需已在当前服务商完成备案，如 https://panel.example.com)"
        echo -e "  [3] 自定义完整 URL"
        read_input "请选择模式 [回车默认: 1]: " DEPLOY_MODE_CHOICE
        DEPLOY_MODE_CHOICE="${DEPLOY_MODE_CHOICE:-1}"

        if [ "$DEPLOY_MODE_CHOICE" = "1" ]; then
            FRP_PUBLIC_URL="https://${PUBLIC_IP}"
            PORT="443"
            FRP_AUTO_SELF_SIGNED_TLS="1"
            FRP_LISTEN_HOST="0.0.0.0"
            _save_to_system_env "PORT" "443"
            _save_to_system_env "FRP_AUTO_SELF_SIGNED_TLS" "1"
            _save_to_system_env "FRP_LISTEN_HOST" "0.0.0.0"
            echo -e "${GREEN}[OK] 已选择纯 IP 自签名 HTTPS 模式: ${FRP_PUBLIC_URL} (默认 443 端口)${NC}"
        elif [ "$DEPLOY_MODE_CHOICE" = "2" ]; then
            while ! [[ "${FRP_PUBLIC_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; do
                read_input "请输入已备案的域名地址（如 https://panel.example.com）: " FRP_PUBLIC_URL
                if ! [[ "${FRP_PUBLIC_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; then
                    echo -e "${RED}必须以 https:// 开头并填写有效域名${NC}"
                fi
            done
        else
            while ! [[ "${FRP_PUBLIC_URL:-}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; do
                read_input "请输入自定义面板访问地址（如 https://...）: " FRP_PUBLIC_URL
            done
        fi
    fi
    FRP_PUBLIC_URL="${FRP_PUBLIC_URL%/}"
    _save_to_system_env "FRP_PUBLIC_URL" "$FRP_PUBLIC_URL"

    # ---- GITHUB_CLIENT_ID ----
    if [ -z "${GITHUB_CLIENT_ID:-}" ]; then
        echo ""
        echo -e "${YELLOW}本系统使用 GitHub OAuth 登录。${NC}"
        echo "请先在 GitHub 创建 OAuth App: https://github.com/settings/developers"
        echo -e "  - Homepage URL:            ${GREEN}${FRP_PUBLIC_URL}${NC}"
        echo -e "  - Authorization callback:  ${GREEN}${FRP_PUBLIC_URL}/api/auth/github/callback${NC}"
        echo ""
        while true; do
            read_input "请输入 GITHUB_CLIENT_ID: " GITHUB_CLIENT_ID
            GITHUB_CLIENT_ID=$(echo "${GITHUB_CLIENT_ID:-}" | tr -d ' \r\n')
            if [ -n "$GITHUB_CLIENT_ID" ]; then
                break
            fi
            echo -e "${RED}不能为空，请重新输入${NC}"
        done
        # 写入系统级持久化文件，后续重新部署无需重复填写
        _save_to_system_env "GITHUB_CLIENT_ID" "$GITHUB_CLIENT_ID"
    fi

    # ---- GITHUB_CLIENT_SECRET ----
    if [ -z "${GITHUB_CLIENT_SECRET:-}" ]; then
        while true; do
            read_input "请输入 GITHUB_CLIENT_SECRET: " GITHUB_CLIENT_SECRET
            GITHUB_CLIENT_SECRET=$(echo "${GITHUB_CLIENT_SECRET:-}" | tr -d ' \r\n')
            if [ -n "$GITHUB_CLIENT_SECRET" ]; then
                break
            fi
            echo -e "${RED}不能为空，请重新输入${NC}"
        done
        # 写入系统级持久化文件，后续重新部署无需重复填写
        _save_to_system_env "GITHUB_CLIENT_SECRET" "$GITHUB_CLIENT_SECRET"
    fi

    # ---- INITIAL_ADMIN (防首登抢占) ----
    if [ -z "${INITIAL_ADMIN_GITHUB_ID:-}" ] && [ -z "${INITIAL_ADMIN_GITHUB_USERNAME:-}" ]; then
        echo ""
        echo -e "${YELLOW}[安全加固] 初始超级管理员限制（防公网抢注）：${NC}"
        echo "  必须指定管理员的 GitHub 账号，否则系统拒绝首次管理员注册。"
        echo -e "  ${BLUE}[获取指引]${NC}"
        echo "   - GitHub 数字ID (推荐，永久不变): 浏览器打开 https://api.github.com/users/你的用户名 查看到 id"
        echo "   - GitHub 用户名: 登录 GitHub 后右上角头像处显示的用户名 (如 newbietan)"
        echo ""
        while true; do
            read_input "请输入管理员 GitHub 数字ID 或 用户名（必填）: " INITIAL_ADMIN_INPUT
            INITIAL_ADMIN_INPUT=$(echo "${INITIAL_ADMIN_INPUT:-}" | tr -d ' \r\n')
            [ -n "$INITIAL_ADMIN_INPUT" ] && break
            echo -e "${RED}管理员身份不能为空，请重新输入${NC}"
        done
        if [ -n "$INITIAL_ADMIN_INPUT" ]; then
            if echo "$INITIAL_ADMIN_INPUT" | grep -Eq '^[0-9]+$'; then
                INITIAL_ADMIN_GITHUB_ID="$INITIAL_ADMIN_INPUT"
                _save_to_system_env "INITIAL_ADMIN_GITHUB_ID" "$INITIAL_ADMIN_GITHUB_ID"
                echo -e "${GREEN}[OK] 已记录管理员 GitHub ID: ${INITIAL_ADMIN_GITHUB_ID}${NC}"
            else
                INITIAL_ADMIN_GITHUB_USERNAME="$INITIAL_ADMIN_INPUT"
                _save_to_system_env "INITIAL_ADMIN_GITHUB_USERNAME" "$INITIAL_ADMIN_GITHUB_USERNAME"
                echo -e "${GREEN}[OK] 已记录管理员 GitHub 用户名: ${INITIAL_ADMIN_GITHUB_USERNAME}${NC}"
            fi
        fi
    fi

    # ---- SECRET_KEY ----
    # 若 .env 或系统持久化配置中已存在 SECRET_KEY，保留沿用，避免现有登录凭证失效
    if [ -z "${SECRET_KEY:-}" ]; then
        SECRET_KEY=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 64)
        echo -e "${GREEN}[OK] 已生成全新 SECRET_KEY${NC}"
    else
        echo -e "${GREEN}[OK] 沿用现有 SECRET_KEY（保持登录态与会话有效）${NC}"
    fi

    # 写入项目 .env 文件（供 docker compose 使用）
    cat > "$ENV_FILE" <<ENVEOF
PORT=${PORT:-443}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
FRP_PUBLIC_URL=${FRP_PUBLIC_URL}
FRP_AUTO_SELF_SIGNED_TLS=${FRP_AUTO_SELF_SIGNED_TLS:-0}
FRP_LISTEN_HOST=${FRP_LISTEN_HOST:-}
SECRET_KEY=${SECRET_KEY}
INITIAL_ADMIN_GITHUB_ID=${INITIAL_ADMIN_GITHUB_ID:-}
INITIAL_ADMIN_GITHUB_USERNAME=${INITIAL_ADMIN_GITHUB_USERNAME:-}
ENVEOF
    chmod 600 "$ENV_FILE"

    # 导出到当前 shell（供 docker compose 使用）
    export PORT
    export GITHUB_CLIENT_ID
    export GITHUB_CLIENT_SECRET
    export FRP_PUBLIC_URL
    export FRP_AUTO_SELF_SIGNED_TLS
    export FRP_LISTEN_HOST
    export SECRET_KEY
    export INITIAL_ADMIN_GITHUB_ID
    export INITIAL_ADMIN_GITHUB_USERNAME

    echo ""
    echo -e "${GREEN}[OK] 环境变量已保存到 .env 文件${NC}"
}

# 将环境变量追加到系统级持久化文件
_save_to_system_env() {
    local key="$1"
    local value="$2"
    local sys_env="/etc/frp-all-in-one.env"
    # 如果文件不存在则创建
    if [ ! -f "$sys_env" ]; then
        touch "$sys_env"
        chmod 600 "$sys_env"
    fi
    # 先删除旧值（如果有），再追加新值
    if grep -q "^${key}=" "$sys_env" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$sys_env"
    else
        echo "${key}=${value}" >> "$sys_env"
    fi
}

ensure_frps_config() {
    mkdir -p "$SCRIPT_DIR/data"
    local frps_file="$SCRIPT_DIR/data/frps.toml"

    local init_token
    init_token=$(head -c 24 /dev/urandom | base64 | tr -d '\n/+=' | head -c 32)

    if [ ! -f "$frps_file" ]; then
        cat > "$frps_file" <<FRPEOF
bindPort = 7000
auth.token = "${init_token}"

# 此文件由系统自动生成
# 请通过 Web 界面配置 FRPS，不要手动编辑
FRPEOF
        chmod 644 "$frps_file"
        echo -e "${GREEN}[OK] 已初始化默认 frps.toml 配置${NC}"
    elif ! grep -q "auth.token" "$frps_file" || grep -q "init_token_placeholder" "$frps_file"; then
        if grep -q "init_token_placeholder" "$frps_file"; then
            sed -i "s|init_token_placeholder|${init_token}|g" "$frps_file"
        else
            echo "auth.token = \"${init_token}\"" >> "$frps_file"
        fi
        chmod 644 "$frps_file"
        echo -e "${GREEN}[OK] 已为 frps.toml 配置安全随机 auth.token${NC}"
    else
        chmod 644 "$frps_file" 2>/dev/null || true
    fi
}

main() {
    require_root
    detect_os
    detect_container_stack
    ensure_container_socket
    check_memory
    ensure_compose_file
    cleanup_existing_project_containers
    check_ports
    ensure_frps_config
    configure_env_vars
    deploy_services
    show_info
}

main
