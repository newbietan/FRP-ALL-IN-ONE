# ==============================================================================
# FRP-ALL-IN-ONE 客户端 Agent 容器镜像 (内置定制 FRP v0.71.1 穿透内核)
# 镜像发布至腾讯云 TCR: sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest
# ==============================================================================
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine AS builder

ARG TARGETOS
ARG TARGETARCH
ARG AGENT_VERSION

WORKDIR /build

RUN apk add --no-cache git ca-certificates

# 复制定制版内核与 Agent 源码
COPY core/ /build/core/
COPY agent/ /build/agent/

WORKDIR /build/agent

# 静态多架构交叉编译客户端 Agent (利用 Go 原生跨平台交叉编译)
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags="-s -w -X main.version=${AGENT_VERSION:-3.3.0}" -o /build/frp-agent ./cmd/frp-agent

# ==============================================================================
# 运行时镜像：Alpine + 标准库 Python 升级事务执行器
# ==============================================================================
FROM alpine:3.23
ARG AGENT_VERSION=3.3.0
LABEL io.frp-all-in-one.version="v${AGENT_VERSION}" \
      io.frp-all-in-one.role="agent" \
      io.frp-all-in-one.upgrade-protocol="1"

RUN apk add --no-cache ca-certificates tzdata python3 tini

WORKDIR /app

COPY --from=builder /build/frp-agent /usr/local/bin/frp-agent
COPY server/services/container_upgrade.py /usr/local/lib/frp/container_upgrade.py

VOLUME /opt/frp

USER root

ENTRYPOINT ["/sbin/tini", "--", "frp-agent"]
CMD ["-help"]
