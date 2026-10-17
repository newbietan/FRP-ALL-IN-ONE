import { ServerConfig, GlobalSettings, OS } from './types';
import { APP_VERSION } from './version';

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

export function getClientUninstallCommand(os: OS): string {
  const base = 'https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy';
  if (os === 'windows') {
    return `& ([scriptblock]::Create((Invoke-RestMethod '${base}/uninstall-client.ps1')))`;
  }
  return `curl -fsSL ${base}/uninstall.sh | ${os === 'macos' ? '' : 'sudo '}bash -s -- client`;
}
