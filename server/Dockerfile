# ==============================================================================
# FRP-ALL-IN-ONE 全合一服务端镜像 (Web控制台 + 管理API + 定制FRPS穿透核心)
# ==============================================================================

# ---- 阶段 1: 编译前端 React 静态资源 ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-builder
ARG VITE_APP_VERSION
ENV VITE_APP_VERSION=${VITE_APP_VERSION}
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 阶段 2: 编译定制版 FRPS 服务端核心 (Go 1.26) ----
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS frps-builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /build
COPY core/ /build/core/
WORKDIR /build/core/frp_custom
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -ldflags="-s -w" -o /build/frps ./cmd/frps

# ---- 阶段 3: Python 运行环境与整体组装 ----
FROM python:3.11-slim
ARG APP_VERSION=3.2.9
ENV APP_VERSION=${APP_VERSION}
LABEL io.frp-all-in-one.version="v${APP_VERSION}" \
      io.frp-all-in-one.role="server" \
      io.frp-all-in-one.upgrade-protocol="1"

# 安装必要系统工具
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 Python 依赖
COPY server/requirements.txt ./requirements.txt
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ \
    && pip config set global.trusted-host mirrors.aliyun.com \
    && pip install --no-cache-dir --upgrade "pip<25.0" \
    && pip install --no-cache-dir --timeout 120 -r requirements.txt

# 复制定制 FRPS 二进制
COPY --from=frps-builder /build/frps /usr/local/bin/frps
RUN chmod +x /usr/local/bin/frps

# 复制前端编译产物至静态目录
COPY --from=frontend-builder /build/dist /app/static

# 复制管理后台源码
COPY server/ /app/
COPY server/services/container_upgrade.py /usr/local/lib/frp/container_upgrade.py

# 初始化持久化数据目录
RUN mkdir -p /app/data /app/certs/auto /app/certs/custom

# 数据卷挂载点（SQLite 数据库与 frps.toml 均保存在此）
VOLUME /app/data

# 暴露端口：8080 (Web UI & API), 7000 (FRP 穿透主信令), 7500 (FRPS 内部 API)
EXPOSE 8080 7000 7500

ENV PORT=8080
ENV STATIC_DIR=/app/static
ENV FRPS_CONFIG_PATH=/app/data/frps.toml

# 启动单容器服务：FastAPI 在 0.0.0.0:8080 提供服务并在启动时自动拉起内置 FRPS
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
