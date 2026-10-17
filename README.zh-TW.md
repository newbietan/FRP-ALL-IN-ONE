<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>面向中國大陸境內自有設備的容器化內網穿透管理工具。</p>
  <p>Linux/NAS 客戶端 · TCP/UDP 映射 · Web 管理 · 騰訊雲公開鏡像</p>
  <p><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.zh-TW.md">繁體中文</a></p>
</div>

## 介面預覽

<p align="center"><img src="demo1.png" alt="控制面板預覽" width="850" /></p>

<details>
  <summary>展開更多介面截圖</summary>
  <table>
    <tr>
      <td width="50%"><img src="demo2.png" alt="設備與隧道" /></td>
      <td width="50%"><img src="demo3.png" alt="設備接入" /></td>
    </tr>
    <tr>
      <td width="50%"><img src="demo4.png" alt="系統設定" /></td>
      <td width="50%"><img src="demo5.png" alt="行動裝置介面" /></td>
    </tr>
  </table>
</details>

## 項目範圍

- **主要場景**：使用中國大陸境內 Linux 雲伺服器，連接同在境內、由你持有或獲授權管理的 Linux/NAS 等設備，用於 SSH、遠端桌面、設備維護和內部服務存取。
- **核心功能**：FRPS 設定、容器客戶端接入、TCP/UDP 連接埠映射、設備狀態和日誌。Agent 內建倉庫中定制的 FRP v0.71.1 核心。
- **部署方式**：服務端與客戶端各自從 `sgccr.ccs.tencentyun.com/frp-all-in-one` 拉取鏡像，無需複製原始碼、安裝編譯環境或經 VPS 下載客戶端二進位檔。
- **可選能力**：管理面板網域與 HTTPS，預設在進階設定中折疊；HTTP/HTTPS 網站穿透需要額外設定及合規準備，不屬於基礎 TCP/UDP 引導流程。
- **支援邊界**：服務端以 Linux 主機網路部署為主。Windows/macOS 客戶端依賴容器虛擬機，需自行確認鏡像支援的平台、主機服務位址和 host 網路設定，不保證與 Linux 等價。
- **不提供**：自動備案、規避備案或接入限制、未授權存取、跨境代理服務或對外經營性穿透平台。不得用本項目繞過法規或雲服務商規則。

## 境內網站、備案與 HTTPS

**不是「使用 HTTPS 才需要備案」。** 是否需要 ICP 備案或許可取決於業務性質、部署位置及適用規定，而非 HTTP/HTTPS 協定本身。在境內提供網際網路資訊服務應依法辦理相應手續；使用 IP、8080 等非標準連接埠不構成當然豁免。普通 TCP/UDP 設備連線也不能一概認定為無需合規手續。

境內伺服器透過網域提供網站服務時，通常應先透過伺服器接入商完成 ICP 備案；有其他行業資質或許可要求的，按相應規定辦理。HTTPS 憑證只是加密與身分驗證憑據，**不能替代備案**。本項目不自動核驗備案狀態。

- [工信部《非經營性網際網路資訊服務備案管理辦法》](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)
- [工信部備案系統](https://beian.miit.gov.cn/)
- [騰訊雲：是否需要備案](https://cloud.tencent.com/document/product/243/19630)

預設 `http://伺服器IP:8080` 僅用於初始設定或受限存取，**不建議長期公開明文管理**。請先以安全群組限制來源；長期遠端管理應使用合規設定的 HTTPS 或受保護的存取通道。面板 HTTPS 不代表所有穿透服務自動擁有 HTTPS，後端服務的認證與加密仍需單獨設定。

## 服務端部署

準備一台有公網位址的境內 Linux 伺服器，優先沿用既有容器環境。腳本偵測 Docker/Podman；目前後端容器控制透過 Podman 介面，建議優先使用既有 Podman 環境，Docker 場景需額外核實管理介面相容性。

1. 在 [GitHub Developer Settings](https://github.com/settings/developers) 建立 OAuth App：
   - Homepage URL：`http://伺服器IP:8080`
   - Callback URL：`http://伺服器IP:8080/api/auth/github/callback`
   - 記錄 Client ID，產生 Client Secret。
2. 執行：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
   ```

3. 按提示填寫 OAuth 設定及**管理員 GitHub 數字 ID**。數字 ID 可在 `https://api.github.com/users/你的使用者名稱` 的 `id` 欄位查詢；也相容使用者名稱。不要略過初始管理員限制，不要公開 Client Secret 或設備權杖。
4. 開啟面板完成 FRPS 初始化。在「設備管理 → 新增設備」取得目標系統的容器安裝腳本；在目標設備執行後設定連接埠映射。

服務端預設目錄為 `/opt/frp-all-in-one`；從既有 Compose 目錄執行時可能沿用該目錄，以最終輸出為準。客戶端預設目錄為 Linux `/opt/frp`、macOS `~/.frp-all-in-one`、Windows `C:\frp`。

**網路前提**：瀏覽器與伺服器需能存取 GitHub OAuth，腳本下載需能存取 GitHub Raw，容器引擎需能連接鏡像倉庫。境內部署不代表這些外部服務始終可達；本項目不提供公共鏡像代理或可用性保證。

### 連接埠與安全群組

| 連接埠 | 用途 | 建議 |
| --- | --- | --- |
| TCP 8080 | 初始 HTTP 面板與 Agent 管理連線 | 僅允許可信管理端與客戶端來源 |
| TCP 7000 | FRP 主連線 | 儘量限制為客戶端來源 |
| 自訂 TCP/UDP 連接埠 | 業務映射 | 按需開放，業務自身須認證 |
| TCP 80 / 443 | 可選網站驗證 / HTTPS | 完成適用合規要求後按需開放 |
| TCP 7500 | FRPS 本地管理介面 | 不對公網開放 |

啟用面板網域或 HTTPS 後，同步更新 OAuth App 的 Homepage/Callback URL，並更新客戶端管理連線。憑證簽發要求 DNS 正確、80 連接埠驗證可達，以及伺服器能存取簽發服務。

## 一鍵移除

使用**部署時相同的使用者、權限和容器上下文**。腳本要求輸入 `REMOVE` 確認；非互動執行可顯式加 `--yes`（Windows 為 `-Force`）。預設只移除本項目容器，保留資料，不移除 Docker/Podman、鏡像，不全域清理或終止其他 FRP 程序。

### 服務端

```bash
# 移除服務，保留資料庫、憑證與設定
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server

# 徹底清理本項目資料與 OAuth 憑據，不可恢復
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server --purge
```

非預設部署目錄請加 `--dir /實際部署目錄`；自訂 Compose 項目名時加 `--project 項目名`。腳本只刪除能確認歸屬的三個服務容器、項目卷與已知資料檔，保留目錄內無關檔案。其他機器上的客戶端不會隨伺服器一起移除。

### 客戶端

Linux（使用 rootful 容器部署時）：

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- client
```

macOS（在 Docker Desktop/Podman 所屬帳號下執行，不加 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | bash -s -- client
```

Windows PowerShell（在容器環境所屬帳號下執行）：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall-client.ps1')))
```

額外刪除客戶端設定和日誌：Bash 命令末尾加 `--purge`，PowerShell 加 `-Purge`。自訂目錄分別使用 `--dir /路徑`、`-InstallDir 'D:\frp'`。Linux rootless 部署不加 sudo；指定引擎使用 `--runtime podman` / `--runtime docker`，Windows 為 `-Runtime podman` / `-Runtime docker`。

**移除後回控制台註銷設備與隧道。控制台「註銷設備」只刪除管理記錄，不代替你移除遠端容器。** 舊版原生二進位服務不在目前容器移除腳本的清理範圍；舊 `uninstall-frpc.sh` 位址僅作為目前容器移除命令的相容入口。

## 維護者發布

四個鏡像倉庫 `frps`、`frp-backend`、`frp-frontend`、`frp-agent` 必須在騰訊雲控制台分別設為**公開**。Actions 的 `TCR_USERNAME` / `TCR_PASSWORD` 僅供維護者推送，使用者無需登入倉庫。

```bash
bash deploy/build-and-push.sh latest
```

CI 按變更構建鏡像，再於獨立 runner 使用空憑證匿名拉取四個鏡像。版本發布同時驗證版本標籤與 `latest`；失敗時工作流程報錯，但不會自動修改騰訊雲權限。修正可見性後重跑失敗任務即可，請勿移動已發布標籤。可用 `bash deploy/check-public-images.sh 完整鏡像位址:標籤` 單獨驗收。

## 開源協議

[Apache-2.0](LICENSE)。倉庫中的定制 FRP 核心保留其[原版許可](core/frp_custom/LICENSE)。
