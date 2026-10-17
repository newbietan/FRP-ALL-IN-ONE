<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>A web-based, fully containerized FRP reverse proxy management platform: configure <b>FRPS server</b>, <b>onboard client devices via containers</b>, manage <b>port mappings</b>, and view <b>real-time streaming traffic & system resource monitoring</b> directly in your browser.</p>
  <p><b>100% Containerized Architecture · High-Speed Tencent Cloud Registry CDN · Embedded Tailored FRP v0.71.1 Core</b></p>
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
    <a href="#highlights">Highlights</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#quick-start-server">Server Deployment</a> ·
    <a href="#quick-start-client">Client Deployment</a> ·
    <a href="#ports">Ports</a> ·
    <a href="#maintainer">Maintainers</a> ·
    <a href="#license">License</a>
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README.en.md">English</a> |
    <a href="README.zh-TW.md">繁體中文</a>
  </p>
</div>

<a id="demo"></a>

## Demo

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

## Highlights

- 🚀 **100% Container-Driven (Zero Source Compilation)**: Both server and client deploy via ready-to-run container images. No need to install Node.js, Go, or Python build tools on host machines.
- ⚡ **Tencent Cloud Registry (TCR) Fast Distribution**: Distributed via public Tencent Cloud registry with high-speed CDN, eliminating DockerHub throttling and GitHub connection timeouts.
- 📦 **Hardware-Independent Single Client Image**: Clients run a unified `frp-agent:latest` container regardless of CPU architectures (x86/ARM compatible), embedding a tailored FRP v0.71.1 in-process engine.
- 🛡️ **Production-Grade Security**:
  - Initial login superadmin whitelist protection (prevents public hijack)
  - Pre-generated cryptographically secure tokens on port 7000
  - Reverse-proxy aware rate limiting and localhost isolation
  - Automatic Let's Encrypt TLS certificate issue and renewal
- 📊 **Real-Time Streaming Monitoring**: WebSocket stream for client CPU, memory, real-time traffic in/out rates, and aggregated bandwidth statistics.

---

<a id="architecture"></a>

## Architecture

```mermaid
flowchart TB
    subgraph TCR["Public Tencent Cloud Registry (TCR)"]
        FRPS_IMG["frps:latest<br/>Tailored FRP v0.71.1 Core"]
        BACKEND_IMG["frp-backend:latest<br/>FastAPI + SQLite"]
        FRONTEND_IMG["frp-frontend:latest<br/>React + Nginx"]
        AGENT_IMG["frp-agent:latest<br/>Unified Client Container"]
    end

    subgraph Server["Server VPS (Docker / Podman Compose)"]
        Web["Web Console<br/>:8080 / :443"]
        Backend["Backend API<br/>127.0.0.1:8000"]
        FRPS["FRPS Engine<br/>:7000 Tunnel + 127.0.0.1:7500 API"]
        Web <--> Backend
        Backend <-->|"API Hot Reload"| FRPS
    end

    subgraph Clients["Client Devices (NAS / Linux / PC / Edge)"]
        DockerClient["frp-agent:latest<br/>In-Process Tunnel Engine + Monitor"]
    end

    FRPS_IMG -.->|"Pull"| FRPS
    BACKEND_IMG -.->|"Pull"| Backend
    FRONTEND_IMG -.->|"Pull"| Web
    AGENT_IMG -.->|"High-speed Pull"| DockerClient

    DockerClient <-.->|"WebSocket Metrics/Logs"| Backend
    DockerClient <-->|"FRP Data Tunnel"| FRPS
```

---

<a id="quick-start-server"></a>

## Server Deployment Guide

> **Note**: No `git clone` or source code download required! The server is deployed completely via container images.

### 1. Create GitHub OAuth App

This platform uses GitHub OAuth for authentication. Create your OAuth App first:

1. Open [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **New OAuth App**:
   - **Application name**: `FRP Manager`
   - **Homepage URL**: `http://<YOUR_SERVER_IP>:8080` (or domain)
   - **Authorization callback URL**: `http://<YOUR_SERVER_IP>:8080/api/auth/github/callback`
3. Save your **Client ID** and generate a **Client Secret**.

---

### 2. One-Line Deployment (Recommended)

Run the automated deployment script on your Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
```

The script will prompt for your `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and optional `INITIAL_ADMIN_GITHUB_USERNAME` for anti-hijack protection.

---

### 3. Or via Standard Docker Compose

If you prefer manual compose management:

```bash
mkdir -p frp-manager && cd frp-manager

# Download standard compose file
curl -fsSL https://raw.githubusercontent.com/GreenhandTan/FRP-ALL-IN-ONE/main/deploy/compose.yml -o compose.yml

# Create environment configuration
cat > .env <<EOF
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')
INITIAL_ADMIN_GITHUB_USERNAME=your_github_username
EOF

# Pull and start services
docker compose up -d
```

Open `http://<YOUR_SERVER_IP>:8080` in your browser.

---

<a id="quick-start-client"></a>

## Client Deployment Guide

Client devices run a unified container image without worrying about CPU architecture or archive extraction.

Go to Web Console → **Devices** → **Add Device**, then copy the generated command:

### Option 1: Docker One-Liner (Recommended for NAS / Linux Servers)

For devices with Docker (Synology, QNAP, Unraid, OpenWrt, Linux):

```bash
docker run -d \
  --name frp-agent \
  --network host \
  --restart always \
  -e FRP_AGENT_TOKEN="<TOKEN_FROM_CONSOLE>" \
  sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest \
  -server "ws://<SERVER_IP>:8080/ws/agent/<CLIENT_ID>" \
  -id "<CLIENT_ID>"
```

### Option 2: Linux Automated Script

Auto-detects and installs Docker/Podman if missing, then starts the agent container:

```bash
curl -fsSL http://<SERVER_IP>:8080/api/frp/agent/install-script/linux?client_id=<CLIENT_ID> | sudo bash
```

### Option 3: Windows (PowerShell)

In administrator PowerShell:

```powershell
irm http://<SERVER_IP>:8080/api/frp/agent/install-script/windows?client_id=<CLIENT_ID> | iex
```

### Option 4: macOS (Terminal)

In Terminal:

```bash
curl -fsSL http://<SERVER_IP>:8080/api/frp/agent/install-script/darwin?client_id=<CLIENT_ID> | bash
```

---

<a id="ports"></a>

## Firewall & Port Rules

Ensure the following ports are allowed in your server's security group:

| Port | Protocol | Usage |
| :--- | :--- | :--- |
| **8080** | TCP | Web Management Console (Default) |
| **80** | TCP | HTTP redirect and Let's Encrypt validation (Required for HTTPS) |
| **443** | TCP | Web Console HTTPS access (Optional) |
| **7000** | TCP | FRP Tunnel Control port |
| **Custom range** | TCP/UDP | Your exposed remote service ports (e.g. 6001, 8081) |

---

<a id="maintainer"></a>

## Maintainer Release Guide

For open-source maintainers, build and publish all 4 container images to the public registry with a single command:

```bash
# Build and push frps, frp-backend, frp-frontend, and frp-agent to TCR
sh deploy/build-and-push.sh [VERSION_TAG, default: latest]
```

---

<a id="troubleshooting"></a>

## Troubleshooting

1. **`initial_admin_mismatch` during login?**
   - You specified `INITIAL_ADMIN_GITHUB_USERNAME`, and the current GitHub account does not match the configured admin.
2. **Tunnel created but remote port unreachable?**
   - Check cloud security group rules to ensure the remote port allows incoming TCP/UDP traffic.
3. **HTTPS Certificate generation failed?**
   - Ensure your domain A record points to the server IP and port **80** is open to the public for HTTP-01 validation.

---

<a id="license"></a>

## License

This project is licensed under [Apache-2.0](LICENSE). The tailored FRP core respects the [original FRP License](https://github.com/fatedier/frp/blob/dev/LICENSE).
