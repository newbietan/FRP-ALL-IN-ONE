/**
 * HTTP API 请求模块 - 对接后端 FastAPI
 */

const API_BASE = window.location.origin;

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string) {
  localStorage.setItem('token', token);
}

export function clearToken() {
  localStorage.removeItem('token');
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

async function request<T = any>(
  method: string,
  url: string,
  body?: any,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method, headers };

  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = body;
  } else if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  if (opts?.signal) init.signal = opts.signal;

  const res = await fetch(`${API_BASE}${url}`, init);
  if (!res.ok) {
    let detail = '';
    try {
      const d = await res.json();
      detail = d.detail || d.message || '';
    } catch (_err) {
      void _err;
    }
    const err = new Error(detail || `HTTP ${res.status}`);
    (err as any).status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text() as any;
}

// ===========================
// 认证
// ===========================

export const authApi = {
  /** 重定向到 GitHub OAuth */
  loginWithGitHub() {
    window.location.assign('/api/auth/github');
  },

  /** 获取当前用户信息 */
  getProfile() {
    return request<{ github_username: string; avatar_url: string; is_superadmin: boolean }>('GET', '/api/auth/profile');
  },

  /** 换绑 GitHub 账号 */
  rebindGithub() {
    const token = getToken();
    window.location.assign(`/api/auth/github/rebind?token=${encodeURIComponent(token || '')}`);
  },
};

// ===========================
// 客户端/设备管理
// ===========================

export interface ClientData {
  id: string;
  name: string;
  auth_token: string;
  status: 'online' | 'offline';
  last_seen: string;
  created_at: string;
  tunnels: TunnelData[];
  agent_info?: AgentInfoData;
}

export interface AgentInfoData {
  hostname?: string;
  os?: string;
  arch?: string;
  agent_version?: string;
  platform?: string;
  cpu_percent?: number;
  memory_percent?: number;
  memory_used?: number;
  memory_total?: number;
  disk_percent?: number;
  disk_used?: number;
  disk_total?: number;
  net_speed_in?: number;
  net_speed_out?: number;
}

export interface TunnelData {
  id: number;
  name: string;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port?: number;
  custom_domains?: string;
  enabled: boolean;
}

export const clientsApi = {
  /** 获取客户端列表 */
  list() {
    return request<ClientData[]>('GET', '/api/clients/');
  },

  /** 获取单个客户端详情 */
  get(clientId: string) {
    return request<ClientData>('GET', `/api/clients/${clientId}`);
  },

  /** 更新客户端名称 */
  updateName(clientId: string, name: string) {
    return request<ClientData>('PATCH', `/api/clients/${clientId}`, { name });
  },

  /** 删除客户端 */
  delete(clientId: string) {
    return request('DELETE', `/api/clients/${clientId}`);
  },
};

// ===========================
// 隧道管理
// ===========================

export interface TunnelCreate {
  name: string;
  type: string;
  local_ip: string;
  local_port: number;
  remote_port?: number;
  custom_domains?: string;
}

export const tunnelsApi = {
  /** 创建隧道 */
  create(clientId: string, tunnel: TunnelCreate) {
    return request<TunnelData>('POST', `/api/clients/${clientId}/tunnels/`, tunnel);
  },

  /** 更新隧道（启用/禁用） */
  update(clientId: string, tunnelId: number, payload: { enabled: boolean }) {
    return request<TunnelData>('PATCH', `/api/clients/${clientId}/tunnels/${tunnelId}`, payload);
  },

  /** 删除隧道 */
  delete(clientId: string, tunnelId: number) {
    return request('DELETE', `/api/clients/${clientId}/tunnels/${tunnelId}`);
  },
};

// ===========================
// FRP 服务端管理
// ===========================

export interface FrpsStatus {
  success: boolean;
  message?: string;
  server_info?: any;
  total_clients?: number;
  total_proxies?: number;
  clients?: any[];
  proxies?: any[];
  aggregated_traffic_in?: number;
  aggregated_traffic_out?: number;
}

export const frpApi = {
  /** 获取 FRPS 状态 */
  getServerStatus() {
    return request<FrpsStatus>('GET', '/api/frp/server-status');
  },

  /** 部署 FRPS */
  deployServer(port: number, authToken: string, serverIp: string) {
    const params = new URLSearchParams();
    params.set('port', String(port));
    if (authToken) params.set('auth_token', authToken);
    if (serverIp) params.set('server_ip', serverIp);
    return request('POST', `/api/frp/deploy-server?${params.toString()}`);
  },

  /** 重启 FRPS */
  restartFrps() {
    return request('POST', '/api/frp/restart-frps');
  },

  /** 获取安装脚本 */
  getInstallScript(platform: string, clientId?: string) {
    const params = clientId ? `?client_id=${clientId}` : '';
    return request<string>('GET', `/api/frp/agent/install-script/${platform}${params}`);
  },
};

// ===========================
// 系统设置
// ===========================

export interface DomainConfig {
  domain: string;
  tls_enabled: boolean;
  tls_mode: string;
  public_ip: string;
  cert_info?: any;
}

export const settingsApi = {
  /** 获取域名配置 */
  getDomain() {
    return request<DomainConfig>('GET', '/api/settings/domain');
  },

  /** 设置域名 */
  setDomain(domain: string) {
    return request('POST', '/api/settings/domain', { domain });
  },

  /** 检查 DNS 解析 */
  checkDns(domain: string) {
    return request('POST', `/api/settings/check-dns?domain=${encodeURIComponent(domain)}`);
  },

  /** 启用 TLS */
  enableTls(domain: string, mode: string = 'auto') {
    return request('POST', '/api/settings/enable-tls', { domain, mode });
  },

  /** 禁用 TLS */
  disableTls() {
    return request('POST', '/api/settings/disable-tls');
  },

  /** 获取 TLS 状态 */
  getTlsStatus() {
    return request('GET', '/api/settings/tls-status');
  },

  /** 获取面板端口配置 */
  getPanelPort() {
    return request<{ port: string }>('GET', '/api/settings/panel-port');
  },

  /** 设置面板端口 */
  setPanelPort(port: string) {
    return request('POST', '/api/settings/panel-port', { port });
  },
};

// ===========================
// 系统状态（无需认证）
// ===========================

export const systemApi = {
  /** 检查 FRPS 是否已部署 */
  getStatus() {
    return request<{ frps_deployed: boolean }>('GET', '/api/system/status');
  },

  /** 获取公网 IP（无需认证） */
  getPublicIp() {
    return request<{ success: boolean; ip?: string }>('GET', '/api/system/public-ip/open');
  },

  /** 获取系统运行信息 */
  getInfo() {
    return request<{
      uptime_seconds: number;
      uptime_display: string;
      start_time: string;
      database_path: string;
      database_size: string;
      database_size_bytes: number;
      total_clients: number;
      online_clients: number;
      total_tunnels: number;
      frps_version: string;
    }>('GET', '/api/system/info');
  },

  /** 检查版本更新 */
  checkUpdate(force = false) {
    return request<{
      current_version: string;
      latest_version: string;
      has_update: boolean;
      release_name?: string;
      release_notes?: string;
      published_at?: string;
      html_url?: string;
      checked_at: number;
      error?: string | null;
    }>('GET', `/api/system/check-update${force ? '?force=true' : ''}`);
  },
};

// ===========================
// Agent 客户端远程管理与升级
// ===========================

export const agentsApi = {
  /** 触发指定 Agent 远程升级 */
  upgrade(clientId: string) {
    return request<{
      success: boolean;
      is_online: boolean;
      signal_sent: boolean;
      client_id: string;
      target_version: string;
      upgrade_command: string;
      message: string;
    }>('POST', `/api/agents/${clientId}/upgrade`);
  },

  /** 批量触发所有在线过期 Agent 升级 */
  batchUpgrade() {
    return request<{
      success: boolean;
      upgraded_count: number;
      details: Array<{ client_id: string; name: string; signal_sent: boolean }>;
    }>('POST', '/api/agents/batch-upgrade');
  },
};
