<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>基於 Web 的全容器化 FRP 内網穿透集中管理系統：用現代化瀏覽器完成 <b>FRPS 服務端配置</b>、<b>設備一鍵容器化入網</b>、<b>端口映射管理</b>，並提供<b>秒級實時流量與系統資源監控</b>。</p>
  <p><b>全容器化架構 · 騰訊雲公開鏡像極速拉取 · 內置定制 FRP v0.71.1 核心</b></p>
  <p>
    <a href="https://github.com/GreenhandTan/FRP-ALL-IN-ONE/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/GreenhandTan/FRP-ALL-IN-ONE?style=flat&logo=github"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/GreenhandTan/FRP-ALL-IN-ONE?style=flat"></a>
    <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white">
    <img alt="Podman" src="https://img.shields.io/badge/Podman-892CA0?style=flat&logo=podman&logoColor=white">
    <img alt="FRP Core" src="https://img.shields.io/badge/FRP_Core-v0.71.1-00ADD8?style=flat">
    <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white">
    <img alt="React" src="https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black">
  </p>
  <p>
    <a href="#highlights">核心優勢</a> ·
    <a href="#architecture">架構說明</a> ·
    <a href="#quick-start-server">服務端部署</a> ·
    <a href="#quick-start-client">客戶端部署</a> ·
    <a href="#ports">端口放行</a> ·
    <a href="#maintainer">維護者發版</a> ·
    <a href="#license">開源協議</a>
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README.en.md">English</a> |
    <a href="README.zh-TW.md">繁體中文</a>
  </p>
</div>

<a id="demo"></a>

## 效果展示

<img src="demo1.png" alt="Demo 1" width="900" />
<br/><br/>
<img src="demo2.png" alt="Demo 2" width="900" />
<br/><br/>
<img src="demo3.png" alt="Demo 3" width="900" />
<br/><br/>
<img src="demo4.png" alt="Demo 4" width="900" />
<br/><br/>
<img src="demo5.png" alt="Demo 5" width="900" />

---

<a id="highlights"></a>

## 核心優勢

- 🚀 **全流程容器化（免拉取源碼編譯）**：服務端與客戶端全面採用容器鏡像部署，無需在宿主機安裝任何 Node.js、Go、Python 編譯環境，告別繁重的本地構建。
- ⚡ **騰訊雲公開鏡像極速分發**：所有組件統一收攏至騰訊雲公開容器鏡像倉庫（TCR），國內外網路均可享受極速秒拉，徹底告別 DockerHub 限流與 GitHub 網路超時。
- 📦 **客戶端單鏡像自閉環**：客戶端統一拉取 `frp-agent:latest` 容器，**不區分芯片型號與硬體架構**（x86/ARM 通用自適應），內置定制裁剪版 FRP v0.71.1 穿透引擎，免去外部解壓配置。
- 🛡️ **生產級安全防護**：
  - 首登超級管理員白名單防護（防止公網搶佔）
  - FRPS 默認強隨機密鑰（防止 7000 端口未授權穿透）
  - 後端嚴格綁定本地回環，具備安全反代感知限流（防止全局誤封）
  - 自動申請 Let's Encrypt TLS 證書並後台無縫續期
- 📊 **毫秒級事件驅動監控**：WebSocket 實時流式推送客戶端 CPU、內存、實時網路出入速率及流量統計，配置變更內存級熱重載生效。

---

<a id="architecture"></a>

## 架構說明

```mermaid
flowchart TB
    subgraph TCR["騰訊雲公開鏡像倉庫 (TCR)"]
        FRPS_IMG["frps:latest<br/>定制裁剪 v0.71.1 核心"]
        BACKEND_IMG["frp-backend:latest<br/>FastAPI + SQLite"]
        FRONTEND_IMG["frp-frontend:latest<br/>React + Nginx"]
        AGENT_IMG["frp-agent:latest<br/>內置穿透引擎統一鏡像"]
    end

    subgraph Server["服務端 VPS (Docker / Podman Compose)"]
        Web["Web 介面<br/>:8080 / :443"]
        Backend["管理後端<br/>127.0.0.1:8000"]
        FRPS["FRPS 核心<br/>:7000 穿透 + 127.0.0.1:7500 API"]
        Web <--> Backend
        Backend <-->|"API 熱重載"| FRPS
    end

    subgraph Clients["客戶端設備 (NAS / 雲主機 / PC / 路由器)"]
        DockerClient["容器化 Agent<br/>frp-agent:latest<br/>內置穿透引擎 + 指標監控"]
    end

    FRPS_IMG -.->|"一鍵拉取"| FRPS
    BACKEND_IMG -.->|"一鍵拉取"| Backend
    FRONTEND_IMG -.->|"一键拉取"| Web
    AGENT_IMG -.->|"高速拉取"| DockerClient

    DockerClient <-.->|"WebSocket 指標/日誌"| Backend
    DockerClient <-->|"FRP 數據隧道"| FRPS
```

---

<a id="quick-start-server"></a>

## 服務端部署指南

> **提示**：無需使用 `git clone` 拷貝項目源碼！服務端僅需通過標準容器編排拉取公開鏡像即可啟動。

### 1. 準備 GitHub OAuth App

本系統使用 GitHub OAuth 進行管理員認證，請先創建屬於你的 OAuth App：

1. 打開 [GitHub Developer Settings](https://github.com/settings/developers)
2. 點擊 **New OAuth App** 填寫：
   - **Application name**：`FRP Manager`（或自定義名稱）
   - **Homepage URL**：`http://<你的服務器IP>:8080`（或你的域名）
   - **Authorization callback URL**：`http://<你的服務器IP>:8080/api/auth/github/callback`
3. 創建後記錄 **Client ID**，並生成 **Client Secret**。

---

### 2. 一鍵極速部署（推薦）

直接在服務器執行自動化部署腳本（自動識別系統、就緒 Docker/Podman 並從騰訊雲鏡像源秒級拉取啟動）：

```bash
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
```

腳本將引導填寫 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` 以及**初始管理員 GitHub 用戶名**（開啟防搶佔防護）。

---

### 3. 或者通過標準 Docker Compose 部署

若習慣手動管理 Compose 配置：

```bash
mkdir -p frp-manager && cd frp-manager

# 下載標準化 compose 編排文件
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/FRP-ALL-IN-ONE/main/deploy/compose.yml -o compose.yml

# 創建環境變量配置文件
cat > .env <<EOF
GITHUB_CLIENT_ID=你的ClientID
GITHUB_CLIENT_SECRET=你的ClientSecret
SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')
INITIAL_ADMIN_GITHUB_USERNAME=你的GitHub用戶名
EOF

# 一鍵拉取並啟動服務
docker compose up -d
```

啟動完成後，打開瀏覽器訪問 `http://<服務器IP>:8080` 即可開始使用。

---

<a id="quick-start-client"></a>

## 客戶端部署指南

客戶端徹底告別傳統的硬體架構選擇（如 x86/ARM/MIPS）與外部解壓流程，**全平台統一運行定制容器鏡像**，零消耗服務端 VPS 出網帶寬。

登錄管理後台，進入「設備管理」→ 點擊「添加新設備」，直接複製對應的自適應命令即可：

### 方式 1：Docker 一鍵運行（NAS / 服務器推薦）

適用於已安裝 Docker 的設備（如群暉/威聯通 NAS、軟路由、Linux 主機）：

```bash
docker run -d \
  --name frp-agent \
  --network host \
  --restart always \
  -e FRP_AGENT_TOKEN="<控制台生成的Token>" \
  sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest \
  -server "ws://<你的服務器IP>:8080/ws/agent/<設備ID>" \
  -id "<設備ID>"
```

### 方式 2：Linux 一鍵腳本（自動檢測安裝容器）

自動檢測本機環境，若未安裝 Docker/Podman 會自動通過官方安全源就緒並啟動客戶端容器：

```bash
curl -fsSL http://<你的服務器IP>:8080/api/frp/agent/install-script/linux?client_id=<設備ID> | sudo bash
```

### 方式 3：Windows 部署（PowerShell）

在以管理員權限運行的 PowerShell 中執行：

```powershell
irm http://<你的服務器IP>:8080/api/frp/agent/install-script/windows?client_id=<設備ID> | iex
```

### 方式 4：macOS 部署（終端）

在終端中執行：

```bash
curl -fsSL http://<你的服務器IP>:8080/api/frp/agent/install-script/darwin?client_id=<設備ID> | bash
```

---

<a id="ports"></a>

## 端口放行建議

請確保雲服務器防火牆 / 安全組放行以下必要端口：

| 端口 | 協議 | 用途說明 |
| :--- | :--- | :--- |
| **8080** | TCP | Web 管理控制台（默認訪問端口） |
| **80** | TCP | HTTP 自動跳轉及 Let's Encrypt 證書申請驗證（啟用 HTTPS 時必選） |
| **443** | TCP | Web 控制台 HTTPS 訪問（啟用 HTTPS 後可選） |
| **7000** | TCP | FRP 穿透隧道主連接端口 |
| **自定義區間** | TCP/UDP | 你映射出的遠程服務端口（如 6001、8081 等） |

---

<a id="maintainer"></a>

## 開源維護者發版說明

本項目為開源維護者提供了一鍵全自動流水線，只需執行一行命令，即可完成定制版核心編譯、前端打包，並全量推送到騰訊雲公開鏡像倉庫：

```bash
# 構建並全量推送到騰訊雲 TCR (frps, frp-backend, frp-frontend, frp-agent)
sh deploy/build-and-push.sh [版本Tag，默認 latest]
```

---

<a id="troubleshooting"></a>

## 常見排障

1. **GitHub 登錄後提示 `initial_admin_mismatch`？**
   - 說明你在 `.env` 中指定了 `INITIAL_ADMIN_GITHUB_USERNAME`，但當前登錄的賬號與預設不符，系統自動攔截了越權激活。
2. **端口映射成功但外網無法訪問？**
   - 檢查雲服務器控制台的安全組規則，確認對應的遠程端口是否已開放 TCP/UDP 流量。
3. **域名 HTTPS 證書申請失敗？**
   - 確認域名 A 記錄已完全解析到服務器公網 IP，且安全組的 **80 端口** 已對外開放（用於 Let's Encrypt 挑戰驗證）。

---

<a id="license"></a>

## 開源協議

本項目採用 [Apache-2.0](LICENSE) 協議開源。定制版核心遵循 [FRP 原版開源許可](https://github.com/fatedier/frp/blob/dev/LICENSE)。
