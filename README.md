<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>面向中国大陆境内自有设备的容器化内网穿透管理工具。</p>
  <p>Linux/NAS 客户端 · TCP/UDP 映射 · Web 管理 · 腾讯云公开镜像</p>
  <p><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.zh-TW.md">繁體中文</a></p>
</div>

## 界面预览

<p align="center"><img src="demo1.png" alt="控制面板预览" width="850" /></p>

<details>
  <summary>展开更多界面截图</summary>
  <table>
    <tr>
      <td width="50%"><img src="demo2.png" alt="设备与隧道" /></td>
      <td width="50%"><img src="demo3.png" alt="设备接入" /></td>
    </tr>
    <tr>
      <td width="50%"><img src="demo4.png" alt="系统设置" /></td>
      <td width="50%"><img src="demo5.png" alt="移动端界面" /></td>
    </tr>
  </table>
</details>

## 项目范围

- **主要场景**：使用中国大陆境内 Linux 云服务器，连接同在境内、由你持有或获授权管理的 Linux/NAS 等设备，用于 SSH、远程桌面、设备维护和内部服务访问。
- **核心功能**：FRPS 配置、容器客户端接入、TCP/UDP 端口映射、设备状态和日志。Agent 内置仓库中定制的 FRP v0.71.1 核心。
- **部署方式**：服务端与客户端各自从 `sgccr.ccs.tencentyun.com/frp-all-in-one` 拉取镜像，不需要克隆源码、安装编译环境或经 VPS 下载客户端二进制。
- **可选能力**：管理面板域名与 HTTPS，默认在高级设置中折叠；HTTP/HTTPS 网站穿透需要额外配置及合规准备，不属于基础 TCP/UDP 向导。
- **支持边界**：服务端以 Linux 宿主网络部署为主。Windows/macOS 客户端依赖容器虚拟机，需自行确认镜像支持的平台、宿主服务地址和 host 网络设置，不保证与 Linux 等价。
- **不提供**：自动备案、规避备案/接入限制、未授权访问、跨境代理服务或对外经营性穿透平台。不得用本项目绕过法律法规或云服务商规则。

## 境内网站、备案与 HTTPS

**不是“使用 HTTPS 才需要备案”。** 是否需要 ICP 备案或许可取决于业务性质、部署位置及适用规定，而非 HTTP/HTTPS 协议本身。在境内提供互联网信息服务应依法办理相应手续；使用 IP、8080 等非标准端口不构成当然豁免。普通 TCP/UDP 设备连接也不能被一概认定为无需合规手续。

境内服务器通过域名提供网站服务时，通常应先通过服务器接入商完成 ICP 备案；有其他行业资质或许可要求的，按相应规定办理。HTTPS 证书只是加密与身份验证凭据，**不能替代备案**。本项目不自动核验备案状态。

- [工信部《非经营性互联网信息服务备案管理办法》](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)
- [工信部备案系统](https://beian.miit.gov.cn/)
- [腾讯云：是否需要备案](https://cloud.tencent.com/document/product/243/19630)

默认 `http://服务器IP:8080` 仅用于初始配置或受限访问，**不建议长期公网明文管理**。请先用安全组限制访问来源；长期远程管理应使用合规配置的 HTTPS 或受保护的访问通道。面板 HTTPS 不等于所有穿透服务自动拥有 HTTPS，后端服务的认证与加密仍需单独配置。

## 服务端部署

准备一台有公网地址的境内 Linux 服务器，优先复用已有容器环境。脚本检测 Docker/Podman；当前后端容器控制通过 Podman 接口，建议优先使用已有的 Podman 环境，Docker 场景需额外核实管理接口兼容性。

1. 在 [GitHub Developer Settings](https://github.com/settings/developers) 创建 OAuth App：
   - Homepage URL：`http://服务器IP:8080`
   - Callback URL：`http://服务器IP:8080/api/auth/github/callback`
   - 记录 Client ID，生成 Client Secret。
2. 执行：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
   ```

3. 按提示填写 OAuth 配置及**管理员 GitHub 数字 ID**。数字 ID 可在 `https://api.github.com/users/你的用户名` 的 `id` 字段查询；也兼容用户名。不要跳过初始管理员限制，不要公开 Client Secret 或设备令牌。
4. 打开面板完成 FRPS 初始化。在「设备管理 → 添加新设备」获取目标系统的容器安装脚本；在目标设备运行后配置端口映射。

默认服务端目录为 `/opt/frp-all-in-one`；如果从已有 Compose 目录运行，脚本可能沿用该目录，以最终输出为准。默认客户端目录为 Linux `/opt/frp`、macOS `~/.frp-all-in-one`、Windows `C:\frp`。

**网络前提**：浏览器与服务器需能访问 GitHub OAuth，下载脚本需能访问 GitHub Raw，容器引擎需能访问镜像仓库。境内部署不代表这些外部服务始终可达；本项目不提供公共镜像代理或可用性保证。

### 端口与安全组

| 端口 | 用途 | 建议 |
| --- | --- | --- |
| TCP 8080 | 初始 HTTP 面板与 Agent 管理连接 | 仅允许可信管理端和客户端来源 |
| TCP 7000 | FRP 主连接 | 尽量限制为客户端来源 |
| 自定义 TCP/UDP 端口 | 业务映射 | 按需放行，业务自身须认证 |
| TCP 80 / 443 | 可选网站验证 / HTTPS | 完成适用合规要求后按需开放 |
| TCP 7500 | FRPS 本地管理接口 | 不对公网放行 |

启用面板域名或 HTTPS 后，同步更新 OAuth App 的 Homepage/Callback URL，并按新地址更新客户端管理连接。证书签发要求 DNS 正确、80 端口验证可达，以及服务器能访问签发服务。

## 一键移除

使用**部署时相同的用户、权限和容器上下文**。脚本会要求输入 `REMOVE` 确认；非交互执行可显式加 `--yes`（Windows 为 `-Force`）。默认只移除本项目容器，保留数据，不卸载 Docker/Podman，不删除镜像、不全局清理，也不会终止其他 FRP 进程。

### 服务端

```bash
# 移除服务，保留数据库、证书、配置，便于重新部署
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server

# 彻底清理本项目数据与 OAuth 凭据，不可恢复
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server --purge
```

非默认部署目录请加 `--dir /实际部署目录`；自定义 Compose 项目名时加 `--project 项目名`。脚本只删除能确认归属的三个服务容器、项目卷及已知数据文件，保留目录中的无关文件。其他机器上的客户端不会随服务器一起卸载。

### 客户端

Linux（使用 rootful 容器部署时）：

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- client
```

macOS（在 Docker Desktop/Podman 所属账号下执行，不加 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | bash -s -- client
```

Windows PowerShell（在容器环境所属账号下执行）：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall-client.ps1')))
```

额外删除客户端配置和日志：Bash 命令末尾加 `--purge`，PowerShell 命令末尾加 `-Purge`。自定义目录分别使用 `--dir /路径`、`-InstallDir 'D:\frp'`。Linux rootless 部署不加 sudo；需要指定引擎时使用 `--runtime podman` / `--runtime docker`，Windows 使用 `-Runtime podman` / `-Runtime docker`。

**卸载后回控制台注销设备及隧道。控制台“注销设备”只删除管理记录，不会代替你卸载远端容器。** 旧版原生二进制服务不在当前容器卸载脚本的清理范围；原 `uninstall-frpc.sh` 地址仅作为当前容器卸载命令的兼容入口。

## 维护者发布

四个镜像仓库 `frps`、`frp-backend`、`frp-frontend`、`frp-agent` 必须在腾讯云控制台分别设为**公开**。Actions 的 `TCR_USERNAME` / `TCR_PASSWORD` 仅用于维护者推送，用户无需登录仓库。

```bash
bash deploy/build-and-push.sh latest
```

CI 按变更构建镜像，再在独立 runner 用空凭据匿名拉取四个镜像。版本发布同时检查版本标签与 `latest`；校验不通过则工作流失败，但不会自动更改腾讯云权限。修正可见性后重跑失败任务即可，不要移动已发布标签。可用 `bash deploy/check-public-images.sh 完整镜像地址:标签` 单独验收。

## 开源协议

[Apache-2.0](LICENSE)。仓库中的定制 FRP 核心保留其[原版许可](core/frp_custom/LICENSE)。
