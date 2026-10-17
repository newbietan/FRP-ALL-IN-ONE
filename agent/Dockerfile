# ==============================================================================
# FRP-ALL-IN-ONE 客户端 Agent 容器镜像 (内置定制 FRP v0.71.1 穿透内核)
# 镜像发布至腾讯云 TCR: sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest
# ==============================================================================
FROM golang:1.24-alpine AS builder

WORKDIR /build

RUN apk add --no-cache git ca-certificates

# 复制定制版内核与 Agent 源码
COPY core/ /build/core/
COPY agent/ /build/agent/

WORKDIR /build/agent

# 静态编译客户端 Agent
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /build/frp-agent ./cmd/frp-agent

# ==============================================================================
# 运行时镜像：极简 Alpine（~20MB，非 Root 安全运行）
# ==============================================================================
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /build/frp-agent /usr/local/bin/frp-agent

VOLUME /opt/frp

USER root

ENTRYPOINT ["frp-agent"]
CMD ["-help"]
