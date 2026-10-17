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
CONTAINER_CLI="podman"
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

install_podman_stack() {
    echo "[INSTALL] 安装 Podman 与 compose 支持..."

    if command -v podman >/dev/null 2>&1 && (podman compose version >/dev/null 2>&1 || command -v podman-compose >/dev/null 2>&1); then
        echo -e "${GREEN}[OK] Podman 环境已就绪${NC}"
        return
    fi

    case "$OS_ID" in
        alpine)
            apk update
            apk add --no-cache podman podman-compose curl ca-certificates lsof
            ;;
        debian|ubuntu)
            apt-get update
            apt-get install -y podman podman-compose curl ca-certificates lsof
            ;;
        centos|rhel|rocky|almalinux|fedora)
            if command -v dnf >/dev/null 2>&1; then
                dnf install -y podman podman-compose curl ca-certificates lsof
            else
                yum install -y podman podman-compose curl ca-certificates lsof
            fi
            ;;
        *)
            if echo "$OS_LIKE" | grep -q "debian"; then
                apt-get update
                apt-get install -y podman podman-compose curl ca-certificates lsof
            elif echo "$OS_LIKE" | grep -Eq "rhel|fedora|centos"; then
                if command -v dnf >/dev/null 2>&1; then
                    dnf install -y podman podman-compose curl ca-certificates lsof
                else
                    yum install -y podman podman-compose curl ca-certificates lsof
                fi
            else
                echo -e "${RED}[ERROR] 暂不支持该发行版自动安装，请手动安装 Podman + podman-compose${NC}"
                exit 1
            fi
            ;;
    esac

    if ! command -v podman >/dev/null 2>&1; then
        echo -e "${RED}[ERROR] Podman 安装失败${NC}"
        exit 1
    fi
    if ! podman compose version >/dev/null 2>&1 && ! command -v podman-compose >/dev/null 2>&1; then
        echo -e "${RED}[ERROR] podman compose 不可用，请安装 podman-compose${NC}"
        exit 1
    fi

    echo -e "${GREEN}[OK] Podman 安装完成${NC}"
}

check_podman_version() {
    echo ""
    echo "[CHECK] 检查 Podman 版本..."

    PODMAN_VER=$(podman --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    PODMAN_MAJOR=$(echo "$PODMAN_VER" | cut -d. -f1)

    if [ -z "$PODMAN_VER" ]; then
        echo -e "${RED}[ERROR] 无法获取 Podman 版本${NC}"
        exit 1
    fi

    echo "   当前 Podman 版本: $PODMAN_VER"

    if [ "$PODMAN_MAJOR" -lt 4 ]; then
        echo -e "${YELLOW}[WARN] Podman $PODMAN_VER 版本过低，后端容器要求 4.x${NC}"
        echo "   低版本会导致后端无法管理 FRPS 容器（API 版本不兼容）"
        echo ""

        UPGRADE_DONE="0"
        case "$OS_ID" in
            ubuntu|debian)
                echo "正在通过 Kubic 仓库升级 Podman..."
                mkdir -p /etc/apt/keyrings
                curl -fsSL "https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/unstable/xUbuntu_$(lsb_release -rs)/Release.key" \
                    | gpg --dearmor -o /etc/apt/keyrings/kubic-podman.gpg 2>/dev/null || true
                echo "deb [signed-by=/etc/apt/keyrings/kubic-podman.gpg] https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/unstable/xUbuntu_$(lsb_release -rs)/ /" \
                    > /etc/apt/sources.list.d/kubic-podman.list
                apt-get update -qq
                if apt-get install -y podman; then
                    UPGRADE_DONE="1"
                fi
                ;;
        esac

        if [ "$UPGRADE_DONE" = "1" ]; then
            PODMAN_VER=$(podman --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
            echo -e "${GREEN}[OK] Podman 已升级到 $PODMAN_VER${NC}"
        else
            echo -e "${RED}[ERROR] 自动升级失败，请手动升级 Podman 到 4.x 后重试${NC}"
            echo "   参考: https://podman.io/docs/installation"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] Podman 版本兼容${NC}"
    fi
}

detect_container_stack() {
    echo ""
    echo "[CHECK] 检测容器运行时环境 (Docker / Podman)..."

    # 1. 优先检测 Docker 环境
    if command -v docker >/dev/null 2>&1; then
        if docker compose version >/dev/null 2>&1; then
            CONTAINER_CLI="docker"
            COMPOSE_MODE="docker-compose-plugin"
            echo -e "${GREEN}[OK] 检测到已就绪的容器环境: Docker + docker compose${NC}"
            return
        elif command -v docker-compose >/dev/null 2>&1; then
            CONTAINER_CLI="docker"
            COMPOSE_MODE="docker-compose"
            echo -e "${GREEN}[OK] 检测到已就绪的容器环境: Docker + docker-compose${NC}"
            return
        fi
    fi

    # 2. 其次检测已存在的 Podman 环境
    if command -v podman >/dev/null 2>&1; then
        if podman compose version >/dev/null 2>&1; then
            CONTAINER_CLI="podman"
            COMPOSE_MODE="podman"
            echo -e "${GREEN}[OK] 检测到已就绪的容器环境: Podman + podman compose${NC}"
            check_podman_version
            return
        elif command -v podman-compose >/dev/null 2>&1; then
            CONTAINER_CLI="podman"
            COMPOSE_MODE="podman-compose"
            echo -e "${GREEN}[OK] 检测到已就绪的容器环境: Podman + podman-compose${NC}"
            check_podman_version
            return
        fi
    fi

    # 3. 若均未就绪，自动安装 Podman 栈
    CONTAINER_CLI="podman"
    install_podman_stack
    check_podman_version
    detect_compose_mode
}

run_compose() {
    case "$COMPOSE_MODE" in
        "docker-compose-plugin")
            docker compose -f "$COMPOSE_FILE" "$@"
            ;;
        "docker-compose")
            docker-compose -f "$COMPOSE_FILE" "$@"
            ;;
        "podman")
            podman compose -f "$COMPOSE_FILE" "$@"
            ;;
        "podman-compose")
            podman-compose -f "$COMPOSE_FILE" "$@"
            ;;
        *)
            echo -e "${RED}[ERROR] 未识别的 compose 模式: $COMPOSE_MODE${NC}"
            exit 1
            ;;
    esac
}

ensure_container_socket() {
    echo -e "${GREEN}[OK] 单容器自闭环架构（内部集成 FRPS 核心，无需宿主机 Socket 挂载）${NC}"
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

    for port in 8080 7000 7500; do
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

    # 2. 强制删除所有可能残留的项目容器（无论通过 docker 还是 podman）
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

    # 4. 彻底重置数据目录与历史文件，保证每次部署均完全幂等
    rm -rf "$SCRIPT_DIR/frps.toml"
    rm -rf "$SCRIPT_DIR/data"
    mkdir -p "$SCRIPT_DIR/data"

    echo -e "${GREEN}[OK] 旧容器与历史数据残留已清理完成${NC}"
}

ensure_compose_file() {
    echo "[CONFIG] 写入最新标准单容器编排配置文件 compose.yml..."
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
    echo "   Web 管理界面: http://${PUBLIC_IP}:8080"
    echo "   FRP 穿透端口: ${PUBLIC_IP}:7000"
    echo ""
    echo "[登录方式]"
    echo "   使用 GitHub 账号登录"
    echo -e "   ${YELLOW}* 首个登录的用户将自动成为管理员${NC}"
    echo ""
    echo "[移除本项目（保留数据库、证书与配置）]"
    printf '   curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server --dir %q\n' "$SCRIPT_DIR"
    echo "   完整清理需在末尾加 --purge 并输入 REMOVE 确认；客户端需在各自设备上单独移除。"
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
        "podman")
            echo "   查看日志: podman compose -f compose.yml logs -f"
            echo "   重启服务: podman compose -f compose.yml restart"
            echo "   停止服务: podman compose -f compose.yml down"
            ;;
        *)
            echo "   查看日志: podman-compose -f compose.yml logs -f"
            echo "   重启服务: podman-compose -f compose.yml restart"
            echo "   停止服务: podman-compose -f compose.yml down"
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

    # ---- GITHUB_CLIENT_ID ----
    if [ -z "${GITHUB_CLIENT_ID:-}" ]; then
        echo ""
        echo -e "${YELLOW}本系统使用 GitHub OAuth 登录。${NC}"
        echo "请先在 GitHub 创建 OAuth App: https://github.com/settings/developers"
        echo -e "  - Homepage URL:            ${GREEN}http://${PUBLIC_IP}:8080${NC}"
        echo -e "  - Authorization callback:  ${GREEN}http://${PUBLIC_IP}:8080/api/auth/github/callback${NC}"
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
        echo "  强烈建议指定管理员的 GitHub 账号，仅该账号首次登录可激活为唯一超级管理员。"
        echo -e "  ${BLUE}[获取指引]${NC}"
        echo "   - GitHub 数字ID (推荐，永久不变): 浏览器打开 https://api.github.com/users/你的用户名 查看到 id"
        echo "   - GitHub 用户名: 登录 GitHub 后右上角头像处显示的用户名 (如 newbietan)"
        echo ""
        read_input "请输入管理员 GitHub 数字ID 或 用户名（建议填写，直接回车跳过）: " INITIAL_ADMIN_INPUT
        INITIAL_ADMIN_INPUT=$(echo "${INITIAL_ADMIN_INPUT:-}" | tr -d ' \r\n')
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
    # 每次部署重新生成，使旧 JWT 令牌立即失效
    SECRET_KEY=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 64)
    # 清理系统持久化文件中的旧密钥（不再持久化 SECRET_KEY）
    if [ -f "/etc/frp-all-in-one.env" ]; then
        sed -i '/^SECRET_KEY=/d' /etc/frp-all-in-one.env 2>/dev/null || true
    fi
    echo -e "${GREEN}[OK] 已重新生成 SECRET_KEY（旧登录会话已失效）${NC}"

    # 写入项目 .env 文件（供 docker compose 使用）
    cat > "$ENV_FILE" <<ENVEOF
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
SECRET_KEY=${SECRET_KEY}
INITIAL_ADMIN_GITHUB_ID=${INITIAL_ADMIN_GITHUB_ID:-}
INITIAL_ADMIN_GITHUB_USERNAME=${INITIAL_ADMIN_GITHUB_USERNAME:-}
ENVEOF
    chmod 600 "$ENV_FILE"

    # 导出到当前 shell（供 docker compose 使用）
    export GITHUB_CLIENT_ID
    export GITHUB_CLIENT_SECRET
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
