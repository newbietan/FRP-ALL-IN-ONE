# ==============================================================================
# FRP-ALL-IN-ONE 专属定制版 FRPS 服务端镜像 (v0.71.1)
# ==============================================================================
FROM golang:1.24-alpine AS builder

WORKDIR /build

# 编译最新稳定版 FRPS 核心 (v0.71.1)，静态链接并去除调试符号
RUN apk add --no-cache git ca-certificates \
    && CGO_ENABLED=0 go install -ldflags="-s -w" github.com/fatedier/frp/cmd/frps@v0.71.1

# ==============================================================================
# 运行时阶段：轻量化 Alpine 镜像（非 Root 用户安全运行）
# ==============================================================================
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /go/bin/frps /usr/local/bin/frps

VOLUME /etc/frp

EXPOSE 7000 7500

USER nobody:nogroup

ENTRYPOINT ["frps", "-c", "/etc/frp/frps.toml"]
