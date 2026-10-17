#!/usr/bin/env bash
# 仅移除 FRP-ALL-IN-ONE 容器；不卸载运行时、不执行全局 prune、不杀死其他 FRP 进程。
set -euo pipefail

usage() {
    echo "用法: bash uninstall.sh server|client [--purge] [--yes] [--dir 路径] [--runtime docker|podman] [--project Compose项目名]"
    echo "默认只删除本项目容器，保留配置、数据库、证书和日志。"
    echo "--purge 额外删除已确认归属的项目数据；--yes 跳过确认。"
    echo "必须使用部署时的账号/权限和容器上下文；不会跨 root/rootless 用户搜索。"
}

MODE=${1:-}
case "$MODE" in
    -h|--help) usage; exit 0 ;;
    server|client) shift ;;
    *) usage >&2; exit 2 ;;
esac
PURGE=0
YES=0
RUNTIME="auto"
INSTALL_DIR=""
PROJECT=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
        --yes) YES=1; shift ;;
        --dir|--runtime|--project)
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                echo "[ERROR] $1 缺少参数" >&2; exit 2
            fi
            case "$1" in
                --dir) INSTALL_DIR=$2 ;;
                --runtime) RUNTIME=$2 ;;
                --project) PROJECT=$2 ;;
            esac
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "[ERROR] 未知参数: $1" >&2; exit 2 ;;
    esac
done
case "$RUNTIME" in
    auto) CLIS="docker podman" ;;
    docker|podman) CLIS=$RUNTIME ;;
    *) echo "[ERROR] --runtime 仅支持 docker 或 podman" >&2; exit 2 ;;
esac
if [ "$MODE" = server ]; then
    if [ "$EUID" -ne 0 ]; then
        echo "[ERROR] 服务端请使用部署时的 root 权限运行，例如 sudo bash" >&2; exit 1
    fi
    INSTALL_DIR=${INSTALL_DIR:-/opt/frp-all-in-one}
    NAMES="frp-server frp-manager-backend frp-manager-web frps"
else
    if [ "$(uname -s)" = Darwin ]; then
        INSTALL_DIR=${INSTALL_DIR:-$HOME/.frp-all-in-one}
    else
        INSTALL_DIR=${INSTALL_DIR:-/opt/frp}
    fi
    NAMES="frp-agent"
fi
if [ "$PURGE" -eq 1 ] && [ -L "$INSTALL_DIR" ]; then
    echo "[ERROR] 为避免误删，不能通过符号链接清理数据目录" >&2; exit 1
fi
if [ -d "$INSTALL_DIR" ]; then
    INSTALL_DIR=$(cd -- "$INSTALL_DIR" && pwd -P)
fi
case "$INSTALL_DIR" in
    /*) ;;
    *) echo "[ERROR] --dir 必须是绝对路径" >&2; exit 2 ;;
esac
case "${INSTALL_DIR%/}" in
    ""|/opt|/etc|/usr|/var|/home|/root|/Users|"$HOME")
        echo "[ERROR] 拒绝使用系统目录或用户主目录作为项目目录" >&2; exit 2 ;;
esac
INSTALL_DIR=${INSTALL_DIR%/}
PROJECT=${PROJECT:-$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}
if [[ ! "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "[ERROR] Compose 项目名格式无效" >&2; exit 2
fi

echo "[INFO] 移除目标: $MODE；数据目录: $INSTALL_DIR"
if [ "$PURGE" -eq 1 ]; then
    echo "[WARN] 将清除已确认归属的配置、日志和数据（服务端还包含数据库、证书及 OAuth 凭据）。此操作不可恢复。"
else
    echo "[INFO] 只删除容器，保留数据；完整清理需显式指定 --purge。"
fi
if [ "$YES" -ne 1 ]; then
    if ! { printf '输入 REMOVE 确认: ' > /dev/tty; IFS= read -r answer < /dev/tty; } 2>/dev/null; then
        echo "[ERROR] 无交互终端，已取消。无人值守时请显式传入 --yes。" >&2; exit 1
    fi
    if [ "$answer" != REMOVE ]; then
        echo "[INFO] 已取消"; exit 0
    fi
fi

REGISTRY="sgccr.ccs.tencentyun.com/frp-all-in-one"
AVAILABLE=0
FAILED=0
CLIENT_OWNED=0
if [ -f "$INSTALL_DIR/.frp-all-in-one-client" ]; then CLIENT_OWNED=1; fi
for cli in $CLIS; do
    if ! command -v "$cli" >/dev/null 2>&1 || ! "$cli" info >/dev/null 2>&1; then
        continue
    fi
    AVAILABLE=1
    projects=""
    if [ "$MODE" = server ] && [ -f "$INSTALL_DIR/compose.yml" ] && grep -Eq "$REGISTRY/(frp-server|frp-backend)" "$INSTALL_DIR/compose.yml"; then
        projects="$PROJECT"
    fi
    for name in $NAMES; do
        if ! image=$("$cli" inspect --format '{{.Config.Image}}' "$name" 2>/dev/null); then
            continue
        fi
        case "$name" in
            frp-server) component=frp-server ;;
            frp-manager-backend) component=frp-backend ;;
            frp-manager-web) component=frp-frontend ;;
            frps) component=frps ;;
            frp-agent) component=frp-agent ;;
        esac
        case "$image" in
            "$REGISTRY/$component"|"$REGISTRY/$component":*|"$REGISTRY/$component"@*) ;;
            *) echo "[WARN] $cli 容器 $name 不使用本项目镜像，跳过且保留主机数据以免误删"; FAILED=1; continue ;;
        esac
        if [ "$MODE" = client ]; then
            source_dir=$("$cli" inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/frp"}}{{.Source}}{{end}}{{end}}' "$name")
            logs_dir=$("$cli" inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/frp/logs"}}{{.Source}}{{end}}{{end}}' "$name")
            if [ "$source_dir" = "$INSTALL_DIR" ] || [ "$logs_dir" = "$INSTALL_DIR/logs" ]; then
                CLIENT_OWNED=1
            fi
        else
            project=$("$cli" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$name")
            if [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
                projects="$projects $project"
            fi
        fi
        echo "[REMOVE] $cli 容器 $name"
        remove_args=(-f)
        if [ "$PURGE" -eq 1 ]; then remove_args+=(-v); fi
        if ! "$cli" rm "${remove_args[@]}" "$name"; then FAILED=1; fi
    done
    if [ "$PURGE" -eq 1 ] && [ "$MODE" = server ] && [ "$FAILED" -eq 0 ]; then
        for project in $projects; do
            for suffix in frp-data frp-certs nginx-conf; do
                volume="${project}_${suffix}"
                label=$("$cli" volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume" 2>/dev/null || true)
                if [ "$label" = "$project" ]; then
                    echo "[REMOVE] $cli 项目卷 $volume"
                    if ! "$cli" volume rm "$volume"; then FAILED=1; fi
                fi
            done
        done
    fi
done
if [ "$AVAILABLE" -eq 0 ]; then
    echo "[ERROR] 当前账号没有可用的容器引擎。请启动引擎，并使用部署时的账号、权限和上下文重试。" >&2; exit 1
fi
if [ "$FAILED" -ne 0 ]; then
    echo "[ERROR] 部分资源移除失败，保留主机数据，请检查占用或权限后重试。" >&2; exit 1
fi
if [ "$PURGE" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
    if [ "$MODE" = server ]; then
        if [ -f "$INSTALL_DIR/compose.yml" ] && grep -Eq "$REGISTRY/(frp-server|frp-backend)" "$INSTALL_DIR/compose.yml"; then
            rm -rf -- "$INSTALL_DIR/data"
            rm -f -- "$INSTALL_DIR/.env" "$INSTALL_DIR/frps.toml" "$INSTALL_DIR/compose.yml"
            rm -f -- /etc/frp-all-in-one.env
        else
            echo "[WARN] 未找到可确认归属的 compose.yml，主机目录和系统凭据文件保持不变。"
        fi
    elif [ "$CLIENT_OWNED" -eq 1 ]; then
        rm -rf -- "$INSTALL_DIR/logs"
        rm -f -- "$INSTALL_DIR/frpc.toml" "$INSTALL_DIR/.frp-all-in-one-client"
    else
        echo "[WARN] 无法确认客户端目录归属，保留数据；旧安装请用 --dir 指定实际绑定的目录。"
    fi
    rmdir -- "$INSTALL_DIR" 2>/dev/null || true
fi
echo "[OK] 容器移除流程完成。镜像、容器引擎、无关容器及其他主机上的客户端均未删除。"
if [ "$MODE" = client ]; then
    echo "[INFO] 请回管理控制台注销对应设备记录及隧道。"
fi
