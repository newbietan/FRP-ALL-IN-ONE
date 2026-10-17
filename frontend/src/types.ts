export enum Screen {
  LOGIN = 'LOGIN',
  INIT_CHOOSE_MODE = 'INIT_CHOOSE_MODE',
  INIT_SERVER_CONFIG = 'INIT_SERVER_CONFIG',
  INIT_DEPLOY_SUCCESS = 'INIT_DEPLOY_SUCCESS',
  DASHBOARD = 'DASHBOARD',
  DEVICE_MANAGEMENT = 'DEVICE_MANAGEMENT',
  SETTINGS = 'SETTINGS',
  ADD_DEVICE = 'ADD_DEVICE',
  CLIENT_SCRIPT = 'CLIENT_SCRIPT',
}

export type OS = 'linux' | 'windows' | 'macos';

export interface Device {
  id: string;
  name: string;
  os: OS;
  ip: string;
  status: 'online' | 'offline';
  lastSeen: string;
  tunnelsCount: number;
  cpuUsage: number;
  memUsage: number;
  arch?: string;
  uploadRate?: string;
  downloadRate?: string;
  totalTraffic?: string;
  agentInfo?: {
    hostname?: string;
    os?: string;
    arch?: string;
    platform?: string;
    platform_version?: string;
    agent_version?: string;
    cpu_percent?: number;
    memory_percent?: number;
    memory_used?: number;
    memory_total?: number;
    disk_percent?: number;
    disk_used?: number;
    disk_total?: number;
    net_speed_in?: number;
    net_speed_out?: number;
    net_bytes_in?: number;
    net_bytes_out?: number;
  };
}

export interface Tunnel {
  id: string;
  deviceId: string;
  name: string;
  type: 'tcp' | 'udp' | 'http' | 'https';
  localIp: string;
  localPort: number;
  remotePort: number;
  status: 'online' | 'offline';
  trafficIn: string;
  trafficOut: string;
  backendId?: number;
  enabled?: boolean;
}

export interface ServerConfig {
  ip: string;
  port: number;
  token: string;
  mode: 'ip' | 'domain';
  domain?: string;
  version: string;
}

export interface GlobalSettings {
  maxClients: number;
  enableDashboard: boolean;
  dashboardPort: number;
  logLevel: 'info' | 'debug' | 'warn' | 'error';
  autoCleanup: boolean;
}
