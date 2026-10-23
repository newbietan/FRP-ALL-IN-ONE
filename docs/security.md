# 安全部署与安全升级

## 本次安全变更（有兼容性影响）

- Web/API 默认端口切换为 `443`（开启自签 TLS 时监听 `0.0.0.0:443`，支持浏览器直接通过 `https://<IP>` 访问；亦可在 `.env` 中按需设置 `PORT` 与 `FRP_LISTEN_HOST`）。公网管理必须使用 HTTPS，Agent 必须使用 WSS。
- 初次注册必须预设 `INITIAL_ADMIN_GITHUB_ID`（推荐）或 `INITIAL_ADMIN_GITHUB_USERNAME`；已有管理员仍可登录。数字 ID 优先且不会回退匹配用户名。
- OAuth state 绑定当前浏览器、10 分钟过期、一次有效；换绑改为带 Bearer 鉴权的 POST，不再接受 URL 中的管理员 Token。
- 安装密钥只能创建新设备，不能读取已有设备凭据。已有设备使用管理员授权的一次性升级命令。
- 新服务端/客户端默认不挂载 Docker Socket。远程自升级是显式高权限功能，不是普通监控权限。
- Python 镜像构建使用带 SHA-256 哈希的 `server/requirements.lock`；JWT 迁移到 PyJWT，兼容既有合法 HS256 Token，但拒绝缺失 `exp` 的 Token。

**不要直接把旧 HTTP 面板暴露到公网，也不要因升级后无法登录就关闭安全校验。先配置 HTTPS，再迁移客户端地址。**

## 推荐（国内无备案服务器）：自动 IP SAN 自签名 HTTPS 模式

国内云服务器未备案时，若使用域名在 80/443 等端口部署网站会被服务商机房防火墙阻断（基于 HTTP `Host` 或 TLS `SNI` 域名拦截）。

**解决方案**：直接采用 `IP + 高位端口` 并启用**系统内置的 IP 自签名 TLS**：
- 由于握手及请求中没有域名，**国内云厂商防火墙不会触发未备案域名阻断**。
- 传输层全程受 TLS 1.3 强加密保护，有效防止局域网抓包、机房流量探测或中间人篡改。

### 1. 开启方式
一键部署脚本 `deploy.sh` 默认推荐选择该模式。如需在 Compose 手动配置，在 `.env` 中加入：
```dotenv
FRP_PUBLIC_URL=https://<你的服务器公网IP>
FRP_AUTO_SELF_SIGNED_TLS=1
FRP_LISTEN_HOST=0.0.0.0
INITIAL_ADMIN_GITHUB_ID=你的GitHub数字ID
```
容器首次启动时，会自动调用 OpenSSL 生成带 `subjectAltName = IP:<公网IP>,IP:127.0.0.1,DNS:localhost` 的 10 年期自签名证书，保存在数据卷 `data/certs/self_signed/` 中。

### 2. 访问与客户端连接
- **浏览器访问**：直接在浏览器输入 `https://<服务器公网IP>`（无需输入端口号），首次访问提示证书未知/安全风险时，点击“**高级**” -> “**继续前往**”即可正常使用。
- **Agent 客户端接入**：
  服务端在生成客户端一键命令时，会自动提取证书的 SHA256 指纹（Fingerprint）并注入到启动参数中：
  - 容器启动参数：`-e FRP_AGENT_TLS_FINGERPRINT="<SHA256指纹>"`
  - 二进制命令行：`frp-agent -server wss://... -tls-fingerprint <SHA256指纹>`（精准 Pinning 校验，100% 免疫中间人劫持）
  - 亦可直接指定 `-insecure-tls` 跳过 CA 链验证（仅保留 TLS 传输加密）。

---

## 推荐（已备案独立服务器）：宿主机 HTTPS 反向代理

默认 Compose 使用 host 网络，因此宿主机代理可以访问 `127.0.0.1:443`。在 `.env` 中设置：

```dotenv
FRP_PUBLIC_URL=https://panel.example.com
INITIAL_ADMIN_GITHUB_ID=你的GitHub数字ID
```

`FRP_PUBLIC_URL` 是固定可信访问地址，NAT/非标准端口必须包含端口，例如 `https://panel.example.com:10967`。GitHub OAuth App 回调必须设置为同一地址加 `/api/auth/github/callback`。

先通过你信任的 ACME 客户端取得域名证书，再在宿主机配置 Nginx（证书路径需替换）：

```nginx
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://panel.example.com$request_uri;
}
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    location / {
        proxy_pass https://127.0.0.1:443;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 覆盖外部传入值，不要信任用户自带的代理头。
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600;
    }
}
```

仅开放管理入口 443，以及实际需要的 FRPS/隧道端口；7500 等内部端口不应公网开放。代理必须由可信主体管理。不要将 `FRP_TRUSTED_PROXY_IPS` 设置为 `*`。默认仅信任 `127.0.0.1,::1`；独立代理容器应使用受控网络并配置精确的代理地址。

仓库原有 TLS 管理器保留了旧分离容器部署路径，**不应依赖它为当前默认单容器架构自动配置 HTTPS**；推荐按上述方式在面板之外配置代理与证书。

## 可选：Uvicorn 原生 TLS

挂载宿主机证书目录到容器的只读目录，例如 `/tls`，然后在 `.env` 配置：

```dotenv
FRP_LISTEN_HOST=0.0.0.0
FRP_TLS_CERT=/tls/fullchain.pem
FRP_TLS_KEY=/tls/privkey.pem
FRP_PUBLIC_URL=https://panel.example.com
```

两个证书变量必须同时配置。证书必须由客户端信任，不能通过关闭 TLS 验证来规避证书错误。配置证书续期与服务重启，GitHub 回调地址为 `https://panel.example.com/api/auth/github/callback`。

## Docker Socket 权限

`/var/run/docker.sock` 基本等价于该 Docker 引擎的管理员权限；rootful Linux Docker 通常意味着宿主机 root。即使只读挂载 Socket，也不能阻止通过 Socket 发起写操作。

- 默认不要给公网面板或监控 Agent 挂载 Socket，使用宿主机上的受控升级流程。
- 确实需要服务端自升级时，由管理员在 Compose 中显式添加 Socket 挂载。
- 确实需要新客户端远程自升级时，先在面板环境中显式设置 `FRP_ENABLE_REMOTE_UPGRADE=1`，再生成安装脚本。此选项不会自动给面板自身挂载 Socket。
- 旧安装已有 Socket 挂载不会被程序静默移除；请人工重建容器取消挂载。手动升级/迁移命令中的 `--enable-socket` 仍属于显式高权限操作，执行前应检查脚本。
- FRP 的原始配置支持 Unix Socket、静态文件等插件；能推送原始配置的管理员具有客户端内的高权限。不要将面板权限委托给不可信人员。

## 旧版本断代说明与全新部署建议

> **重要升级决策**：**v3.3.0 彻底废弃 8080 端口，且不再提供针对旧版本的就地平滑升级兜底**。<br>
> 鉴于 `< v3.3.0` 历史版本存在严重安全缺陷（未认证文件读取与管理员身份伪造），**就地升级无法根除历史凭据失窃隐患**。我们强烈要求所有旧版本用户放弃就地升级，采取**手动移除旧容器与旧凭据、全新部署 v3.3.0** 的方式完成升级：

1. **备份必要业务数据**：记录原各客户端中的隧道映射端口和参数，其他由旧版本生成的 `.jwt_secret`、旧 Token 一律废弃。
2. **彻底移除旧容器与旧数据卷**：
   ```bash
   # 停止并清理旧容器
   docker rm -f frp-server frp-agent 2>/dev/null || true
   # 清理旧数据卷中的敏感残留凭据
   rm -rf ./data /app/data /opt/frp
   ```
3. **按全新流程部署 v3.3.0**：
   直接使用一键脚本或 Compose 部署，启用默认的 443 端口自签 IP TLS 或正规域名 HTTPS。
4. **客户端重新执行一键接入**：
   在全新控制台生成带有全新指纹与 Token 的安装命令，在客户端重新运行即可。

`FRP_ALLOW_INSECURE_HTTP=1` 仅供封闭测试网络或短期受控迁移；服务端与客户端均需显式配置。它会重新暴露明文凭据和管理命令，不适合公网、共享局域网或生产环境。不要将此值写入公开示例的默认配置。

## 维护检查

```bash
# 安装生产依赖；更新 lock 时先审计再提交
python -m pip install --require-hashes -r server/requirements.lock
PYTHONPATH=server python -m pytest -q server/tests
cd frontend && npm ci && npm audit && npm test && npm run lint && npm run build
# 在 agent 和 core/frp_custom 各自目录执行
# go test ./...
# govulncheck ./...
```

使用 Go 1.26.9 或更新补丁版（镜像/CI 使用 1.26.10）。定期更新基础镜像、锁文件、系统包并重新执行漏洞扫描。依赖数据库没有报告漏洞不等于应用没有漏洞。
