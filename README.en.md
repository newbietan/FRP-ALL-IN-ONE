<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>A web-based, fully containerized FRP reverse proxy management platform: configure <b>FRPS server</b>, <b>onboard client devices via containers</b>, manage <b>port mappings</b>, and view <b>real-time streaming traffic & system resource monitoring</b> directly in your browser.</p>
  <p><b>100% Containerized Architecture · High-Speed Tencent Cloud Registry CDN · Embedded Tailored FRP v0.71.1 Core</b></p>
  <p>
    <a href="https://github.com/newbietan/FRP-ALL-IN-ONE/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/newbietan/FRP-ALL-IN-ONE?style=flat&logo=github"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/newbietan/FRP-ALL-IN-ONE?style=flat"></a>
    <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white">
    <img alt="FRP Core" src="https://img.shields.io/badge/FRP_Core-v0.71.1-00ADD8?style=flat">
    <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white">
    <img alt="React" src="https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black">
  </p>
  <p>
    <a href="#highlights">Highlights</a> ·
    <a href="#demo">Demo</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#quick-start-server">Server Deployment</a> ·
    <a href="#ports">Ports</a> ·
    <a href="#license">License</a>
  </p>
  <p>
    <a href="README.md">简体中文</a> |
    <a href="README.en.md">English</a> |
    <a href="README.zh-TW.md">繁體中文</a>
  </p>
</div>

> **Security update:** the backend now binds to loopback by default. Public administration requires HTTPS/WSS and a preset initial administrator. Docker Socket mounts are opt-in. The older HTTP deployment examples below are not production defaults; read [secure deployment and migration](docs/security.md) first.

<a id="demo"></a>

## Demo

<p align="center">
  <img src="demo1.png" alt="Dashboard Preview" width="850" />
</p>

<details>
  <summary><b>Click to expand full feature gallery screenshots</b></summary>
  <br />
  <table>
    <tr>
      <td align="center" width="50%"><img src="demo2.png" alt="Device & Tunnel Management" /><br /><sub><b>Device & Tunnel Status Management</b></sub></td>
      <td align="center" width="50%"><img src="demo3.png" alt="Container Onboarding Wizard" /><br /><sub><b>Container Onboarding Wizard</b></sub></td>
    </tr>
    <tr>
      <td align="center" width="50%"><img src="demo4.png" alt="Settings & HTTPS" /><br /><sub><b>HTTPS & System Settings</b></sub></td>
      <td align="center" width="50%"><img src="demo5.png" alt="Mobile View & Logs" /><br /><sub><b>Mobile Adaptation & Logs</b></sub></td>
    </tr>
  </table>
</details>

---

<a id="highlights"></a>

## Highlights

- **100% Container-Driven (Zero Source Compilation)**: Both server and client deploy via ready-to-run container images. No need to install Node.js, Go, or Python build tools on host machines.
- **Tencent Cloud Registry (TCR) Fast Distribution**: Distributed via public Tencent Cloud registry with high-speed CDN, eliminating DockerHub throttling and GitHub connection timeouts.
- **Hardware-Independent Single Client Image**: Clients run a unified `frp-agent:latest` container regardless of CPU architectures (x86/ARM compatible), embedding a tailored FRP v0.71.1 in-process engine.
- **Production-Grade Security**:
  - Initial login superadmin whitelist protection (prevents public hijack)
  - Pre-generated cryptographically secure tokens on port 7000
  - Reverse-proxy aware rate limiting and localhost isolation
  - Automatic Let's Encrypt TLS certificate issue and renewal
- **Real-Time Streaming Monitoring**: WebSocket stream for client CPU, memory, real-time traffic in/out rates, and aggregated bandwidth statistics.

---

<a id="architecture"></a>

## Architecture

```mermaid
flowchart TB
    subgraph TCR["Public Tencent Cloud Registry (TCR)"]
        SERVER_IMG["frp-server:latest<br/>All-In-One Server (Web+API+FRPS)"]
        AGENT_IMG["frp-agent:latest<br/>Unified Client Container"]
    end

    subgraph Server["Server VPS (Single Container Deployment)"]
        SingleServer["frp-server Single Container<br/>Web Console & Management API :443<br/>Embedded FRPS Core :7000"]
    end

    subgraph Clients["Client Devices (NAS / Linux / PC / Edge)"]
        DockerClient["frp-agent:latest<br/>In-Process Tunnel Engine + Monitor"]
    end

    SERVER_IMG -.->|"Pull"| SingleServer
    AGENT_IMG -.->|"High-speed Pull"| DockerClient

    DockerClient <-.->|"WebSocket Metrics/Logs (:443)"| SingleServer
    DockerClient <-->|"FRP Data Tunnel (:7000)"| SingleServer
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
   - **Homepage URL**: `https://<YOUR_SERVER_IP_OR_DOMAIN>` (e.g. `https://1.2.3.4` if using direct IP mode)
   - **Authorization callback URL**: `https://<YOUR_SERVER_IP_OR_DOMAIN>/api/auth/github/callback`
3. Save your **Client ID** and generate a **Client Secret**.

---

### 2. One-Line Deployment (Recommended)

Run the automated deployment script on your Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
```

The script will prompt for your `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and optional `INITIAL_ADMIN_GITHUB_USERNAME` for anti-hijack protection.

---

### 3. Or via Standard Docker Compose

If you prefer manual compose management:

```bash
mkdir -p frp-manager && cd frp-manager

# Download standard compose file
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/compose.yml -o compose.yml

# Create environment configuration
cat > .env <<EOF
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
# Direct IP mode: https://<YOUR_PUBLIC_IP>; Domain mode: https://<YOUR_DOMAIN>
FRP_PUBLIC_URL=https://<YOUR_SERVER_IP_OR_DOMAIN>
FRP_AUTO_SELF_SIGNED_TLS=1
FRP_LISTEN_HOST=0.0.0.0
SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')
INITIAL_ADMIN_GITHUB_ID=your_github_numeric_id
EOF
chmod 600 .env

# Pull and start services
docker compose up -d
```

The Web Console defaults to port 443 with native TLS. Open `https://<YOUR_SERVER_IP>` in your browser (if using self-signed IP certificate, accept the browser warning on first visit via Advanced -> Proceed). See [Security Guide](docs/security.md).

> **Client Device Onboarding**: Once the server is running, log into the Web Console, go to **Devices** → click **Add Device**, and copy the auto-generated one-click container command or setup script to your edge device.

---

## Upgrades and rollback

Docker only. Upgrades pin the target version, preserve configuration, verify readiness, and roll back on failure. Connections briefly disconnect during replacement; this is not zero-downtime. Legacy installations require an initial host-side migration. See the [upgrade guide and failure analysis](docs/upgrade.md) (Chinese).

<a id="ports"></a>

## Firewall & Port Rules

Ensure the following ports are allowed in your server's security group:

| Port | Protocol | Usage |
| :--- | :--- | :--- |
| **443** | TCP | Web Management Console HTTPS (Default port, direct IP `https://<IP>` supported) |
| **7000** | TCP | FRP Tunnel Control port |
| **40000-60000** | TCP/UDP | Remote exposed port range (Recommended) |

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
