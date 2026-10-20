#!/bin/sh
# FRP Manager - Swap 设置脚本
# 用途: 为低内存服务器添加 Swap 空间，避免构建时 OOM

set -e

echo "[INFO] 开始配置 Swap 空间..."

# 检查是否已存在 swap（兼容 BusyBox）
if [ -r /proc/swaps ] && awk 'NR>1 {print $1}' /proc/swaps | grep -q '^/swapfile$'; then
    echo "[OK] Swap 已存在，跳过创建"
    cat /proc/swaps
    exit 0
fi

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo "[ERROR] 请使用 root 权限运行此脚本: sudo $0"
    exit 1
fi

SWAP_SIZE="512M"
ZRAM_SIZE="${ZRAM_SIZE:-256M}"
ZRAM_SIZE_BYTES="${ZRAM_SIZE_BYTES:-268435456}"

create_swapfile_standard() {
    rm -f /swapfile
    dd if=/dev/zero of=/swapfile bs=1M count=512
    sync
    chmod 600 /swapfile
    mkswap /swapfile
}

create_swapfile_nocow() {
    rm -f /swapfile
    : > /swapfile
    if command -v chattr >/dev/null 2>&1; then
        chattr +C /swapfile >/dev/null 2>&1 || true
    fi
    dd if=/dev/zero of=/swapfile bs=1M count=512 conv=notrunc
    sync
    chmod 600 /swapfile
    mkswap /swapfile
}

create_swapfile_btrfs() {
    rm -f /swapfile
    btrfs filesystem mkswapfile --size "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
}

persist_zram_alpine() {
    mkdir -p /etc/local.d
    cat > /etc/local.d/zram.start <<EOF
#!/bin/sh
modprobe zram num_devices=1
echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true
echo $ZRAM_SIZE_BYTES > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 100 /dev/zram0
EOF
    chmod +x /etc/local.d/zram.start
    if command -v rc-update >/dev/null 2>&1; then
        rc-update add local default >/dev/null 2>&1 || true
    fi
}

persist_zram_systemd() {
    cat > /etc/systemd/system/zram-setup.service <<EOF
[Unit]
Description=Setup zram swap
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'modprobe zram num_devices=1; echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true; echo $ZRAM_SIZE_BYTES > /sys/block/zram0/disksize; mkswap /dev/zram0; swapon -p 100 /dev/zram0'

[Install]
WantedBy=multi-user.target
EOF

    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload >/dev/null 2>&1 || true
        systemctl enable zram-setup.service >/dev/null 2>&1 || true
    fi
}

enable_zram() {
    echo "[INFO] 尝试启用 zram（${ZRAM_SIZE}）..."

    if ! command -v modprobe >/dev/null 2>&1; then
        echo "[ERROR] 未找到 modprobe，无法启用 zram"
        return 1
    fi

    modprobe zram num_devices=1 || true

    if [ ! -e /sys/block/zram0/disksize ]; then
        echo "[ERROR] zram0 不可用，内核可能不支持 zram"
        return 1
    fi

    echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true
    echo "$ZRAM_SIZE_BYTES" > /sys/block/zram0/disksize

    mkswap /dev/zram0
    swapon -p 100 /dev/zram0

    if [ -f /etc/alpine-release ]; then
        persist_zram_alpine
        echo "[OK] zram 已启用，并已写入 Alpine 开机启动"
    elif command -v systemctl >/dev/null 2>&1; then
        persist_zram_systemd
        echo "[OK] zram 已启用，并已写入 systemd 开机启动"
    else
        echo "[OK] zram 已启用（当前会话有效）"
    fi

    return 0
}

offer_zram_fallback() {
    choice="${AUTO_ENABLE_ZRAM:-}"

    if [ -z "$choice" ]; then
        if [ -t 0 ]; then
            printf "swap 无法启用，是否改为启用 zram（%s）？(y/N): " "$ZRAM_SIZE"
            read -r choice
        else
            choice="n"
            echo "[WARN] 非交互环境默认不启用 zram（可设置 AUTO_ENABLE_ZRAM=y）"
        fi
    fi

    case "$choice" in
        y|Y|yes|YES)
            if enable_zram; then
                echo "[INFO] 当前 swap 状态:"
                cat /proc/swaps
                echo ""
                echo "[OK] 已通过 zram 提供交换空间"
                exit 0
            else
                echo "[ERROR] zram 启用失败"
                exit 1
            fi
            ;;
        *)
            echo "[ERROR] 已拒绝启用 zram，当前没有可用交换空间"
            exit 1
            ;;
    esac
}

echo "[INFO] 创建 ${SWAP_SIZE} Swap 文件..."
create_swapfile_standard

echo "[INFO] 启用 Swap..."
swapon_output="$(swapon /swapfile 2>&1)" || swapon_code=$?
swapon_code=${swapon_code:-0}

if [ "$swapon_code" -eq 0 ]; then
    echo "[OK] Swap 已启用"
else
    echo "$swapon_output"
    if echo "$swapon_output" | grep -qi "file has holes"; then
        echo "[WARN] 检测到 swapfile 空洞问题，尝试使用兼容方式重建..."

        rebuilt=0

        if command -v btrfs >/dev/null 2>&1; then
            if btrfs filesystem mkswapfile --help >/dev/null 2>&1; then
                echo "[INFO] 使用 btrfs 专用 mkswapfile 重建..."
                create_swapfile_btrfs && rebuilt=1
            fi
        fi

        if [ "$rebuilt" -eq 0 ]; then
            echo "[INFO] 使用 NoCOW 方式重建..."
            create_swapfile_nocow && rebuilt=1
        fi

        if [ "$rebuilt" -eq 1 ]; then
            swapon_retry_output="$(swapon /swapfile 2>&1)" || swapon_retry_code=$?
            swapon_retry_code=${swapon_retry_code:-0}

            if [ "$swapon_retry_code" -eq 0 ]; then
                echo "[OK] Swap 已启用（重建后）"
            else
                echo "$swapon_retry_output"
                echo "[ERROR] 仍无法启用 swapfile。当前文件系统可能不支持文件交换。"
                offer_zram_fallback
            fi
        else
            echo "[ERROR] 无法找到可用的重建方式启用 swapfile。"
            offer_zram_fallback
        fi
    else
        echo "[ERROR] 启用 Swap 失败。"
        offer_zram_fallback
    fi
fi

echo "[INFO] 添加到 fstab（重启后自动启用）..."
if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo ""
echo "[OK] Swap 配置完成"
echo "当前内存状态:"
free -h

echo ""
echo "提示: 现在可以安全地运行 docker compose -f compose.yml up -d"
