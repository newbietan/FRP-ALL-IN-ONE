import { Device, Tunnel, ServerConfig, GlobalSettings, OS } from './types';
import { APP_VERSION } from './version';

export const initialDevices: Device[] = [
  {
    id: 'dev-l8wPz9K2',
    name: 'Home-Ubuntu-Server',
    os: 'linux',
    ip: '192.168.31.100',
    status: 'online',
    lastSeen: '2026-05-28 13:40:12',
    tunnelsCount: 3,
    cpuUsage: 14,
    memUsage: 35,
    arch: 'amd64',
    uploadRate: '124.5 KB/s',
    downloadRate: '18.2 KB/s',
    totalTraffic: '1.58 GB',
  },
  {
    id: 'dev-w2yXm4R1',
    name: 'Workstation-Win11',
    os: 'windows',
    ip: '10.0.0.45',
    status: 'online',
    lastSeen: '2026-05-28 13:44:01',
    tunnelsCount: 1,
    cpuUsage: 8,
    memUsage: 62,
    arch: 'x86_64',
    uploadRate: '45.2 KB/s',
    downloadRate: '389.1 KB/s',
    totalTraffic: '434.3 MB',
  },
  {
    id: 'dev-m6qTk8N5',
    name: 'Macbook-Pro-M3',
    os: 'macos',
    ip: '192.168.1.5',
    status: 'offline',
    lastSeen: '2026-05-28 09:15:30',
    tunnelsCount: 0,
    cpuUsage: 0,
    memUsage: 0,
    arch: 'arm64',
    uploadRate: '0 B/s',
    downloadRate: '0 B/s',
    totalTraffic: '12.4 GB',
  }
];

export const initialTunnels: Tunnel[] = [
  {
    id: 'tun-ssh',
    deviceId: 'dev-l8wPz9K2',
    name: 'ssh-tunnel',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: 22,
    remotePort: 6022,
    status: 'online',
    trafficIn: '15.4 MB',
    trafficOut: '142.1 MB',
  },
  {
    id: 'tun-web',
    deviceId: 'dev-l8wPz9K2',
    name: 'nextcloud-http',
    type: 'http',
    localIp: '127.0.0.1',
    localPort: 8080,
    remotePort: 80,
    status: 'online',
    trafficIn: '128.9 MB',
    trafficOut: '1.42 GB',
  },
  {
    id: 'tun-db',
    deviceId: 'dev-l8wPz9K2',
    name: 'mysql-remote',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: 3306,
    remotePort: 6306,
    status: 'offline',
    trafficIn: '0 B',
    trafficOut: '0 B',
  },
  {
    id: 'tun-winrdp',
    deviceId: 'dev-w2yXm4R1',
    name: 'rdp-tunnel',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: 3389,
    remotePort: 6338,
    status: 'online',
    trafficIn: '45.2 MB',
    trafficOut: '389.1 MB',
  }
];

export const defaultServerConfig: ServerConfig = {
  ip: '',
  port: 7000,
  token: '',
  mode: 'ip',
  version: APP_VERSION,
};

export const defaultGlobalSettings: GlobalSettings = {
  maxClients: 100,
  enableDashboard: true,
  dashboardPort: 7500,
  logLevel: 'info',
  autoCleanup: true,
};

export function getOSScript(os: OS, ip: string, port: number, token: string, devId: string): string {
  if (os === 'docker') {
    return `# FRP Manager Agent - Docker 一键运行 (腾讯云 TCR 高速拉取)
docker run -d \\
  --name frp-agent \\
  --network host \\
  --restart always \\
  -e FRP_AGENT_TOKEN="${token}" \\
  sgccr.ccs.tencentyun.com/frp-all-in-one/frp-agent:latest \\
  -server "ws://${ip}:8080/ws/agent/${devId}" \\
  -id "${devId}"
`;
  }

  if (os === 'windows') {
    return `# Powershell FRP Client deployment script
# Generated for Windows. Make sure to run in Administrator Powershell.
$SERVER_IP = "${ip}"
$SERVER_PORT = ${port}
$TOKEN = "${token}"
$DEVICE_ID = "${devId}"

Write-Host "Creating FRP-Agent directory..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "C:\\Program Files\\frp-agent"

# Download agent binary
Write-Host "Fetching Windows build..." -ForegroundColor Yellow
Invoke-WebRequest -Uri "https://api.frp-aio.local/downloads/frp-agent-windows.exe" -OutFile "C:\\Program Files\\frp-agent\\frpc.exe"

# Create config file
$config = @"
[common]
server_addr = $SERVER_IP
server_port = $SERVER_PORT
token = $TOKEN
user = $DEVICE_ID
"@

Set-Content -Path "C:\\Program Files\\frp-agent\\frpc.ini" -Value $config

# Register Service
Write-Host "Registering System Service..." -ForegroundColor Green
New-Service -Name "frp-agent" -BinaryPathName "C:\\Program Files\\frp-agent\\frpc.exe -c C:\\Program Files\\frp-agent\\frpc.ini" -DisplayName "FRP Agent Service" -StartupType Automatic

Write-Host "FRP Agent installed and started successfully!" -ForegroundColor Green
Start-Service -Name "frp-agent"
`;
  }

  if (os === 'macos') {
    return `#!/bin/zsh
# macOS FRP Client Deployment Script
# Automatically detects current platform architecture and starts LaunchDaemon service.

set -e

SERVER_URL="https://47.86.83.205:${port}"
TOKEN="${token}"
DEVICE_ID="${devId}"

echo "🤖 Starting macOS installation for device: $DEVICE_ID"

# Check Apple Silicon vs Intel
ARCH=$(uname -m)
echo "Platform Architecture: $ARCH"

sudo mkdir -p /usr/local/bin /usr/local/etc/frp

sudo curl -sSL "https://api.frp-aio.local/scripts/mac-agent-$ARCH" -o /usr/local/bin/frpc
sudo chmod +x /usr/local/bin/frpc

# Render configuration
cat <<EOF | sudo tee /usr/local/etc/frp/frpc.ini
[common]
server_addr = 47.86.83.205
server_port = ${port}
token = $TOKEN
user = $DEVICE_ID
EOF

# Render LaunchDaemon Plist
cat <<EOF | sudo tee /Library/LaunchDaemons/local.frpc.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.frpc</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/frpc</string>
        <string>-c</string>
        <string>/usr/local/etc/frp/frpc.ini</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

sudo launchctl load -w /Library/LaunchDaemons/local.frpc.plist
echo "✅ macOS launchctl service successfully compiled and active."
`;
  }

  // linux
  return `#!/bin/bash
# FRP-ALL-IN-ONE Agent Installation Script
# Generated: 2026-05-28T13:44:54Z

set -e

SERVER_URL="https://api.frp-aio.local"
TOKEN="${token}"
DEVICE_ID="${devId}"

echo "Starting installation for device: $DEVICE_ID..."

sudo curl -sSL "$SERVER_URL/scripts/agent_setup.sh" | sudo bash -s -- \\
    --token "$TOKEN" \\
    --id "$DEVICE_ID" \\
    --server-ip "${ip}" \\
    --server-port "${port}" \\
    --auto-start true

echo "Installation complete. Service is starting."
sudo systemctl status frp-agent
`;
}
