import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Terminal, 
  LayoutGrid, 
  Laptop, 
  Settings, 
  ArrowRight, 
  Check, 
  Copy, 
  Eye, 
  EyeOff, 
  Info, 
  Key, 
  Globe, 
  Plus, 
  Save, 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  Play, 
  Square, 
  RefreshCw, 
  LogOut, 
  Trash2, 
  Shield, 
  Lock, 
  Network, 
  HardDrive, 
  Clock, 
  Menu, 
  ChevronRight, 
  Sliders, 
  Terminal as TerminalIcon,
  X,
  Radio,
  ExternalLink,
  PlusCircle,
  Download,
  ArrowUp,
  ArrowDown,
  BookOpen, 
  Code,
  Search,
  Filter,
  Sparkles,
  ArrowUpCircle
} from 'lucide-react';
import { Screen, Device, Tunnel, ServerConfig, GlobalSettings, OS } from './types';
import {
  defaultServerConfig,
  defaultGlobalSettings,
  getClientUninstallCommand
} from './data';
import { APP_VERSION_DISPLAY } from './version';
import { authApi, clientsApi, tunnelsApi, frpApi, settingsApi, systemApi, agentsApi, isLoggedIn, setToken, clearToken } from './api';
import type { AgentUpgradeStatus } from './api';
import { serverUpgradeCompleted, upgradeBusy, upgradeFailed, upgradeTimestamp } from './upgrade';
import { dashboardWs } from './ws';
import { MarkdownView } from './components/MarkdownView';
import { ConfirmModal, ConfirmDialogOptions } from './components/ConfirmModal';

// Navigation transitions simulation mapping
const animationVariants = {
  push: {
    initial: { x: '100%', opacity: 0 },
    animate: { x: 0, opacity: 1, transition: { type: 'spring', damping: 25, stiffness: 200 } },
    exit: { x: '-100%', opacity: 0, transition: { ease: 'easeInOut', duration: 0.25 } }
  },
  push_back: {
    initial: { x: '-100%', opacity: 0 },
    animate: { x: 0, opacity: 1, transition: { type: 'spring', damping: 25, stiffness: 200 } },
    exit: { x: '100%', opacity: 0, transition: { ease: 'easeInOut', duration: 0.25 } }
  },
  slide_up: {
    initial: { y: '100%', opacity: 0 },
    animate: { y: 0, opacity: 1, transition: { type: 'spring', damping: 20, stiffness: 150 } },
    exit: { y: '100%', opacity: 0, transition: { ease: 'easeInOut', duration: 0.25 } }
  },
  none: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.1 } },
    exit: { opacity: 0, transition: { duration: 0.1 } }
  }
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export default function App() {
  // Language translation state
  const [lang, setLang] = useState<'zh' | 'en'>('zh');

  // Translation helper function for instant multi-language support anywhere
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;

  // Navigation states
  const [currentScreen, setCurrentScreen] = useState<Screen>(Screen.LOGIN);
  const [_lastScreen, setLastScreen] = useState<Screen | null>(null);
  const [transitionDirection, setTransitionDirection] = useState<'push' | 'push_back' | 'slide_up' | 'none'>('none');

  // Business state — 初始为空，由 loadDashboardData 从后端 API 加载
  const [devices, setDevices] = useState<Device[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [serverConfig, setServerConfig] = useState<ServerConfig>({ ...defaultServerConfig, ip: '', port: 7000, token: '' });
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(defaultGlobalSettings);
  const [frpsInfo, setFrpsInfo] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<{ github_username: string; avatar_url: string; is_superadmin: boolean } | null>(null);
  const [systemInfo, setSystemInfo] = useState<any>(null);

  // Script / OS selection wizard
  const [selectedOs, setSelectedOs] = useState<OS>('linux');

  // Form values (controlled temporarily during steps or inputs)
  const [inputIp, setInputIp] = useState<string>('');
  const [inputPort, setInputPort] = useState<number>(7000);
  const [inputDomain, setInputDomain] = useState<string>('');
  const [serverPublicIp, setServerPublicIp] = useState<string>('');
  const [tokenVisible, setTokenVisible] = useState<boolean>(false);
  
  // Settings view states matching design mockup from HTML
  const [tempDomain, setTempDomain] = useState<string>('');
  const [enableAutoHttps, setEnableAutoHttps] = useState<boolean>(false);
  const [tempDashboardPort, setTempDashboardPort] = useState<string>('');
  const [_dnsChecked, setDnsChecked] = useState<boolean>(true);
  const [dnsCheckLoading, setDnsCheckLoading] = useState<boolean>(false);
  // 追踪服务端已保存的 TLS 状态，避免保存设置时重复申请证书
  const [savedTlsEnabled, setSavedTlsEnabled] = useState<boolean>(false);
  const [savedDomain, setSavedDomain] = useState<string>('');
  
  // 日志流 — 由 WebSocket 实时推送填充
  const [logs, setLogs] = useState<string[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // 指标节流：缓冲 WebSocket 推送的指标，每 3 次更新刷新 1 次页面
  const metricsBufferRef = useRef<Map<string, any>>(new Map());
  const metricsCountRef = useRef(0);

  // Toast notifications helper
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'warning' } | null>(null);

  // Interface controls
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [addTunnelModalOpen, setAddTunnelModalOpen] = useState<boolean>(false);
  
  // Realtime Live Logs Modal States
  const [logModalOpen, setLogModalOpen] = useState<boolean>(false);
  const [logModalDevice, setLogModalDevice] = useState<Device | null>(null);
  const [liveLogs, setLiveLogs] = useState<{ id: string; msg: string; }[]>([]);
  const terminalScrollRef = useRef<HTMLDivElement>(null);
  
  // Device management search/filtering states matching mockup requirements
  const [deviceSearchQuery, setDeviceSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [osFilter, setOsFilter] = useState({ linux: true, windows: true, macos: true });
  const [archFilter, setArchFilter] = useState({ x86_64: true, arm64: true });
  const [statusFilter, setStatusFilter] = useState({ online: true, offline: true });
  const [expandedDeviceIds, setExpandedDeviceIds] = useState<Record<string, boolean>>({
    'dev-l8wPz9K2': true // expand first Ubuntu by default
  });

  // 版本检测与升级弹窗状态
  interface UpdateInfo {
    current_version: string;
    latest_version: string;
    has_update: boolean;
    release_name?: string;
    release_notes?: string;
    published_at?: string;
    html_url?: string;
    checked_at: number;
    error?: string | null;
  }
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState<boolean>(false);
  const [checkUpdateLoading, setCheckUpdateLoading] = useState<boolean>(false);
  const [upgradeTargetDevice, setUpgradeTargetDevice] = useState<Device | null>(null);
  const [upgradingDevice, setUpgradingDevice] = useState<boolean>(false);
  const [batchUpgrading, setBatchUpgrading] = useState<boolean>(false);
  const [isUpgradingServer, setIsUpgradingServer] = useState(false);
  const [serverUpgradeProgress, setServerUpgradeProgress] = useState('');
  const [serverUpgradeError, setServerUpgradeError] = useState('');
  const [upgradeCapability, setUpgradeCapability] = useState<{ can_self_upgrade: boolean; reason: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogOptions | null>(null);
  const [agentUpgradeStatuses, setAgentUpgradeStatuses] = useState<Record<string, AgentUpgradeStatus>>({});
  const [serverUpgradeJob, setServerUpgradeJob] = useState<string | null>(null);
  const [agentUpgradeCommands, setAgentUpgradeCommands] = useState<Record<string, { command: string; expiresAt: number }>>({});
  const [generatingUpgradeCommand, setGeneratingUpgradeCommand] = useState(false);

  const showConfirm = (opts: ConfirmDialogOptions) => {
    setConfirmDialog(opts);
  };
  
  const totals = useMemo(() => {
    let totalUploadMB = 0;
    let totalDownloadMB = 0;
    devices.forEach((d) => {
      const trafficStr = d.totalTraffic || '0 MB';
      let num = parseFloat(trafficStr) || 0;
      let mb = num;
      if (trafficStr.toUpperCase().includes('GB')) {
        mb = num * 1024;
      } else if (trafficStr.toUpperCase().includes('KB')) {
        mb = num / 1024;
      } else if (trafficStr.toUpperCase().includes('B') && !trafficStr.toUpperCase().includes('M') && !trafficStr.toUpperCase().includes('K') && !trafficStr.toUpperCase().includes('G')) {
        mb = num / (1024 * 1024);
      }
      totalUploadMB += mb * 0.375;
      totalDownloadMB += mb * 0.625;
    });
    const totalMB = totalUploadMB + totalDownloadMB;
    
    const formatVal = (mb: number) => {
      if (mb >= 1024 * 1024) {
        return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
      } else if (mb >= 1024) {
        return `${(mb / 1024).toFixed(1)} GB`;
      }
      return `${mb.toFixed(1)} MB`;
    };
    
    return {
      total: formatVal(totalMB),
      upload: formatVal(totalUploadMB),
      download: formatVal(totalDownloadMB)
    };
  }, [devices]);

  const outdatedDevices = useMemo(() => {
    return devices.filter(d => d.hasUpdate);
  }, [devices]);

  const filteredDevices = useMemo(() => {
    return devices.filter(device => {
      // 1. Search Query
      const q = deviceSearchQuery.trim().toLowerCase();
      if (q) {
        const nameMatch = device.name.toLowerCase().includes(q);
        const idMatch = device.id.toLowerCase().includes(q);
        const ipMatch = device.ip.toLowerCase().includes(q);
        const osMatch = device.os.toLowerCase().includes(q);
        const archMatch = (device.arch || '').toLowerCase().includes(q);
        if (!nameMatch && !idMatch && !ipMatch && !osMatch && !archMatch) {
          return false;
        }
      }
      
      // 2. OS filter
      if (!osFilter[device.os as keyof typeof osFilter]) {
        return false;
      }
      
      // 3. Arch filter
      const isX86 = device.arch === 'amd64' || device.arch === 'x86_64';
      const archKey = isX86 ? 'x86_64' : 'arm64';
      if (!archFilter[archKey as keyof typeof archFilter]) {
        return false;
      }
      
      // 4. Status filter
      if (!statusFilter[device.status as keyof typeof statusFilter]) {
        return false;
      }
      
      return true;
    });
  }, [devices, deviceSearchQuery, osFilter, archFilter, statusFilter]);

  // 搜索/过滤变化时重置页码
  useEffect(() => { setCurrentPage(1); }, [deviceSearchQuery, osFilter, archFilter, statusFilter]);

  // 分页计算
  const totalPages = Math.max(1, Math.ceil(filteredDevices.length / ITEMS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pagedDevices = filteredDevices.slice(
    (safeCurrentPage - 1) * ITEMS_PER_PAGE,
    safeCurrentPage * ITEMS_PER_PAGE
  );

  const [newTunnelData, setNewTunnelData] = useState<{
    name: string;
    type: 'tcp' | 'udp' | 'http' | 'https';
    localIp: string;
    localPort: number | string;
    remotePort: number | string;
    deviceId: string;
  }>({
    name: 'web-service',
    type: 'tcp',
    localIp: '127.0.0.1',
    localPort: '',
    remotePort: '',
    deviceId: devices[0]?.id || ''
  });

  // ===========================
  // OAuth 回调处理 & 初始化数据加载
  // ===========================
  // 检查系统状态并跳转到对应页面，同时预加载公网 IP
  const checkSystemAndNavigate = async () => {
    // 1. 如果已有 Token，先验证 Token 是否合法有效（防止历史残留无效 Token）
    if (isLoggedIn()) {
      try {
        const profile = await authApi.getProfile();
        setUserProfile(profile);
      } catch (_err) {
        void _err;
        // Token 无效或已过期（系统重新部署或密钥变更导致历史 Token 失效）
        clearToken();
        setUserProfile(null);
        changeScreen(Screen.LOGIN, 'none');
        triggerToast(t('登录凭据已失效或系统已重新部署，请重新登录', 'Session expired or system was redeployed. Please login again.'), 'warning');
        return;
      }
    } else {
      changeScreen(Screen.LOGIN, 'none');
      return;
    }

    // 2. Token 有效，并行获取系统状态和公网 IP
    const [status, ipResult] = await Promise.allSettled([
      systemApi.getStatus(),
      systemApi.getPublicIp(),
    ]);

    // 处理公网 IP 结果
    if (ipResult.status === 'fulfilled' && ipResult.value.success && ipResult.value.ip) {
      setServerPublicIp(ipResult.value.ip);
      setInputIp(ipResult.value.ip);
    }

    // 3. 处理系统状态结果
    const deployed = status.status === 'fulfilled' && status.value.frps_deployed;
    if (!deployed) {
      changeScreen(Screen.INIT_CHOOSE_MODE, 'push');
    } else {
      changeScreen(Screen.DASHBOARD, 'push');
      loadDashboardData();
      dashboardWs.connect();
    }
  };

  // 页面初始化：处理 OAuth 回调、错误提示或已登录状态
  useEffect(() => {
    // 处理登录错误重定向提示
    const searchParams = new URLSearchParams(window.location.search);
    const authError = searchParams.get('error');
    if (authError) {
      if (authError === 'initial_admin_mismatch') {
        triggerToast(t('登录被拒绝：当前系统已指定特定的管理员 GitHub 账号！', 'Login rejected: Specific admin GitHub account required!'), 'warning');
      } else if (authError === 'not_authorized') {
        triggerToast(t('未授权访问：系统已配置管理员，该账号无访问权限', 'Unauthorized: Admin already configured, account not permitted'), 'warning');
      } else {
        triggerToast(t(`登录失败: ${authError}`, `Login failed: ${authError}`), 'warning');
      }
      window.history.replaceState({}, '', window.location.pathname);
    }

    const hash = window.location.hash;
    if (hash && hash.includes('access_token=')) {
      const token = hash.split('access_token=')[1]?.split('&')[0];
      if (token) {
        setToken(token);
        window.history.replaceState({}, '', window.location.pathname);
        triggerToast(t('登录成功！', 'Login successful!'), 'success');
        checkSystemAndNavigate();
        return;
      }
    }
    if (isLoggedIn()) {
      checkSystemAndNavigate();
    }
  }, []);

  // WebSocket 事件监听
  useEffect(() => {
    const handleFullSync = (data: any) => {
      const clientList = data.registered_clients || data.clients;
      if (clientList) {
        setDevices(prev => {
          // 以 prev 中的实时指标为基准，合并 full_sync 的静态数据
          const prevMap = new Map<string, Device>(
            prev.map((d): [string, Device] => [d.id, d])
          );
          return clientList.map((c: any) => {
            const fresh = mapClientToDevice(c);
            const old = prevMap.get(fresh.id);
            if (!old) return fresh;
            // 保留 WebSocket metrics_update 推送的实时数据，full_sync 仅更新静态字段
            return {
              ...fresh,
              cpuUsage: old.cpuUsage ?? fresh.cpuUsage,
              memUsage: old.memUsage ?? fresh.memUsage,
              uploadRate: old.uploadRate ?? fresh.uploadRate,
              downloadRate: old.downloadRate ?? fresh.downloadRate,
              totalTraffic: old.totalTraffic ?? fresh.totalTraffic,
              agentInfo: old.agentInfo ? { ...fresh.agentInfo, ...old.agentInfo } : fresh.agentInfo,
            };
          });
        });
      }
      // 从 full_sync 中的 frps_status 更新服务端配置
      if (data.frps_status?.server_info) {
        setFrpsInfo(data.frps_status);
        setServerConfig(prev => ({
          ...prev,
          port: data.frps_status.server_info?.bindPort || prev.port,
          version: data.frps_status.server_info?.version ? `v${data.frps_status.server_info.version}-Stable` : prev.version,
        }));
      }
      // 使用数据库中存储的公网 IP（而非 FRPS 的 bindAddr）
      if (data.server_public_ip) {
        setServerConfig(prev => ({ ...prev, ip: data.server_public_ip }));
      }
    };

    const handleMetricsUpdate = (data: any) => {
      if (!data.client_id) return;
      // 缓冲最新数据
      metricsBufferRef.current.set(data.client_id, data);
      metricsCountRef.current += 1;

      // 每次收到消息都立即更新实时速率（秒级刷新）
      const speedOut = data.net_speed_out;
      const speedIn = data.net_speed_in;
      if (speedOut != null || speedIn != null) {
        setDevices(prev => prev.map(d => {
          if (d.id !== data.client_id) return d;
          return {
            ...d,
            uploadRate: speedOut != null ? `${(speedOut / 1024).toFixed(1)} KB/s` : d.uploadRate,
            downloadRate: speedIn != null ? `${(speedIn / 1024).toFixed(1)} KB/s` : d.downloadRate,
          };
        }));
      }

      // 每 3 次更新刷新一次完整指标（CPU/内存/磁盘等）
      if (metricsCountRef.current >= 3) {
        metricsCountRef.current = 0;
        const buffer = metricsBufferRef.current;
        metricsBufferRef.current = new Map();
        setDevices(prev => prev.map(d => {
          const m = buffer.get(d.id);
          if (!m) return d;
          const bytesIn = m.net_bytes_in ?? d.agentInfo?.net_bytes_in ?? 0;
          const bytesOut = m.net_bytes_out ?? d.agentInfo?.net_bytes_out ?? 0;
          return {
            ...d,
            cpuUsage: m.cpu_percent != null ? Math.round(m.cpu_percent) : d.cpuUsage,
            memUsage: m.memory_percent != null ? Math.round(m.memory_percent) : d.memUsage,
            totalTraffic: formatBytes(bytesIn + bytesOut),
            agentInfo: { ...d.agentInfo, ...m },
          };
        }));
      }
    };

    const handleClientEvent = (data: any) => {
      if (data.client_id) {
        setDevices(prev => prev.map(d => {
          if (d.id === data.client_id) {
            return { ...d, status: data.is_online ? 'online' : 'offline', lastSeen: new Date().toISOString().replace('T', ' ').slice(0, 19) };
          }
          return d;
        }));
      }
    };

    const handleFrpsStatus = (data: any) => {
      if (data && data.success && data.server_info) {
        setServerConfig(prev => ({
          ...prev,
          ip: data.server_info?.bindAddr || prev.ip,
          port: data.server_info?.bindPort || prev.port,
        }));
      }
    };

    const handleLog = (data: any) => {
      const logMsg = typeof data === 'string' ? data : data?.data || data?.message || '';
      if (logMsg) {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
        setLogs(prev => [...prev.slice(-50), `[${timestamp}] ${logMsg}`]);
      }
    };

    dashboardWs.on('full_sync', handleFullSync);
    dashboardWs.on('metrics_update', handleMetricsUpdate);
    dashboardWs.on('client_event', handleClientEvent);
    dashboardWs.on('frps_status', handleFrpsStatus);
    dashboardWs.on('log', handleLog);

    const handleAgentUpgradeStatus = (data: any) => {
      if (data?.client_id && data?.data) {
        setAgentUpgradeStatuses(prev => ({
          ...prev,
          [data.client_id]: data.data,
        }));
      }
    };
    dashboardWs.on('agent_upgrade_status', handleAgentUpgradeStatus);

    return () => {
      dashboardWs.off('full_sync', handleFullSync);
      dashboardWs.off('metrics_update', handleMetricsUpdate);
      dashboardWs.off('client_event', handleClientEvent);
      dashboardWs.off('frps_status', handleFrpsStatus);
      dashboardWs.off('log', handleLog);
      dashboardWs.off('agent_upgrade_status', handleAgentUpgradeStatus);
    };
  }, []);

  /** 将后端 Client 数据映射为前端 Device 格式 */
  const mapClientToDevice = (client: any): Device => {
    const agent = client.agent_info || {};
    const os: OS = (agent.os === 'darwin' ? 'macos' : agent.os) || 'linux';
    // 优先使用 agent_info.online（实时 WebSocket 状态），其次 is_online，最后 client.status
    const onlineStatus = agent.online ?? client.is_online ?? (client.status === 'online');
    const detectedIp = agent.ip || client.ip || '';
    const rawIps = agent.ips || client.ips || [];
    const ipsList: string[] = Array.isArray(rawIps) ? rawIps : (typeof rawIps === 'string' && rawIps ? [rawIps] : []);
    const hasUpdate = agent.has_update ?? client.has_update ?? false;
    const latestVersion = agent.latest_version || client.latest_version || '';
    return {
      id: client.id,
      name: agent.hostname || client.name || client.id,
      remark: client.remark || null,
      os,
      ip: detectedIp || '未知',
      ips: ipsList,
      hasUpdate,
      latestVersion,
      status: onlineStatus ? 'online' : 'offline',
      lastSeen: client.last_seen || '-',
      tunnelsCount: client.tunnels?.length || 0,
      cpuUsage: Math.round(agent.cpu_percent || 0),
      memUsage: Math.round(agent.memory_percent || 0),
      arch: agent.arch,
      uploadRate: agent.net_speed_out != null ? `${(agent.net_speed_out / 1024).toFixed(1)} KB/s` : '0 KB/s',
      downloadRate: agent.net_speed_in != null ? `${(agent.net_speed_in / 1024).toFixed(1)} KB/s` : '0 KB/s',
      totalTraffic: formatBytes((agent.net_bytes_in || 0) + (agent.net_bytes_out || 0)),
      agentInfo: {
        ...agent,
        ip: detectedIp,
        ips: ipsList,
        has_update: hasUpdate,
        latest_version: latestVersion,
      },
    };
  };

  /** 从后端加载 Dashboard 数据 */
  const loadDashboardData = async () => {
    try {
      const clients = await clientsApi.list();
      const mapped = clients.map(c => mapClientToDevice(c));
      setDevices(mapped);

      // 展开的隧道
      const allTunnels: Tunnel[] = [];
      clients.forEach(c => {
        (c.tunnels || []).forEach(t => {
          allTunnels.push({
            id: `${c.id}-${t.id}`,
            deviceId: c.id,
            name: t.name,
            type: t.type as any,
            localIp: t.local_ip,
            localPort: t.local_port,
            remotePort: t.remote_port || 0,
            status: (t.enabled !== false && c.status === 'online') ? 'online' : 'offline',
            trafficIn: '0 B',
            trafficOut: '0 B',
            backendId: t.id,
            enabled: t.enabled,
          });
        });
      });
      setTunnels(allTunnels);

      // 加载 FRPS 状态
      try {
        const frps = await frpApi.getServerStatus();
        if (frps.success) {
          setFrpsInfo(frps);
          if (frps.server_info) {
            setServerConfig(prev => ({
              ...prev,
              port: frps.server_info?.bindPort || prev.port,
              version: frps.server_info?.version ? `v${frps.server_info.version}-Stable` : prev.version,
            }));
          }
        }
      } catch (_err) {
        void _err;
      }

      // 加载域名设置（同时获取数据库中存储的公网 IP）
      try {
        const domainCfg = await settingsApi.getDomain();
        const patch: any = {};
        if (domainCfg.domain) {
          patch.domain = domainCfg.domain;
          setTempDomain(domainCfg.domain);
          setEnableAutoHttps(domainCfg.tls_enabled);
          setSavedTlsEnabled(domainCfg.tls_enabled);
          setSavedDomain(domainCfg.domain);
        }
        if (domainCfg.public_ip) {
          patch.ip = domainCfg.public_ip;
        }
        if (Object.keys(patch).length > 0) {
          setServerConfig(prev => ({ ...prev, ...patch }));
        }
      } catch (_err) {
        void _err;
      }

      // 加载面板公网访问端口（NAT 映射场景）
      try {
        const portCfg = await settingsApi.getPanelPort();
        setTempDashboardPort(portCfg.port || '');
        setGlobalSettings(prev => ({
          ...prev,
          dashboardPort: portCfg.port ? Number(portCfg.port) : 0,
        }));
      } catch (_err) {
        void _err;
      }

      // 加载用户信息
      try {
        const profile = await authApi.getProfile();
        setUserProfile(profile);
      } catch (_err) {
        void _err;
      }

      // 加载系统运行信息
      try {
        const info = await systemApi.getInfo();
        setSystemInfo(info);
      } catch (_err) {
        void _err;
      }

      // 静默检查版本更新
      try {
        checkSystemUpdate(false);
      } catch (_err) {
        void _err;
      }
    } catch (err: any) {
      if (err.status === 401 || err.status === 403) {
        clearToken();
        triggerToast(t('登录已过期，请重新登录', 'Session expired, please login again'), 'warning');
      }
    }
  };

  // 自动滚动控制台日志到末尾
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Handle toast notifications helper
  const triggerToast = (message: string, type: 'success' | 'info' | 'warning' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 3000);
  };

  // 检查版本更新
  const checkSystemUpdate = async (force = false) => {
    try {
      setCheckUpdateLoading(true);
      const res = await systemApi.checkUpdate(force);
      setUpdateInfo(res);
      if (force) {
        if (res.has_update) {
          triggerToast(t(`发现新版本 ${res.latest_version}！`, `New version ${res.latest_version} available!`), 'info');
        } else {
          triggerToast(t('当前系统已是最新版本', 'Already running latest version'), 'success');
        }
      }
    } catch (err: any) {
      if (force) {
        triggerToast(t(`检查更新失败: ${err.message}`, `Check update failed: ${err.message}`), 'warning');
      }
    } finally {
      setCheckUpdateLoading(false);
    }
  };

  // Resume persisted jobs when reopening the dialog; browser state is not truth.
  useEffect(() => {
    if (!updateModalOpen) return;
    let cancelled = false;
    systemApi.getUpgradeStatus(AbortSignal.timeout(8000)).then(res => {
      if (cancelled) return;
      setUpgradeCapability({ can_self_upgrade: res.can_self_upgrade, reason: res.reason });
      if (res.is_upgrading && res.job_id) {
        setIsUpgradingServer(true);
        setServerUpgradeJob(res.job_id);
      } else if (upgradeFailed(res.step)) {
        setServerUpgradeError(res.error || res.message);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [updateModalOpen]);

  useEffect(() => {
    if (!serverUpgradeJob) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 20 * 60 * 1000;
    const poll = async () => {
      try {
        const state = await systemApi.getUpgradeStatus(AbortSignal.timeout(8000));
        if (cancelled) return;
        if (state.job_id === serverUpgradeJob) {
          setServerUpgradeProgress(state.message);
          if (upgradeFailed(state.step)) {
            setServerUpgradeError(state.error ? `${state.message}: ${state.error}` : state.message);
            setIsUpgradingServer(false);
            setServerUpgradeJob(null);
            return;
          }
          if (state.step === 'succeeded') {
            const health = await systemApi.getUpgradeHealth(AbortSignal.timeout(8000));
            if (cancelled) return;
            if (serverUpgradeCompleted(state, health, serverUpgradeJob)) {
              window.location.reload();
              return;
            }
          }
        }
      } catch {
        // Expected short outage during switch; never infer success from a restart.
      }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setServerUpgradeError('升级结果尚未确认，请检查持久任务和辅助容器日志，勿重复升级。');
        return;
      }
      timer = setTimeout(poll, 3000); // no overlapping requests
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [serverUpgradeJob]);

  // Poll durable client state as a reconnect-safe fallback to live WS messages.
  useEffect(() => {
    const id = upgradeTargetDevice?.id;
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await agentsApi.getUpgradeStatus(id, AbortSignal.timeout(8000));
        if (!cancelled && result.status) {
          setAgentUpgradeStatuses(prev => ({ ...prev, [id]: result.status! }));
        }
      } catch { /* retain last confirmed state during reconnect */ }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [upgradeTargetDevice?.id]);

  const handleTriggerServerUpgrade = () => {
    if (isUpgradingServer) return;
    showConfirm({
      title: t('升级服务端（支持回滚）', 'Upgrade Server (Rollback Supported)'),
      message: t(
        '将拉取并校验指定版本，备份数据库及配置后切换容器。切换时现有连接会短暂中断并重连；目标版本未通过健康检查时自动恢复旧容器和配置。请勿重复操作。',
        'The pinned version is verified before switching. Connections briefly disconnect and reconnect. Failed health checks restore the old container and configuration. Do not submit twice.'
      ),
      confirmText: t('立即升级', 'Upgrade Now'), confirmType: 'primary',
      onConfirm: async () => {
        setIsUpgradingServer(true);
        setServerUpgradeError('');
        try {
          const result = await systemApi.upgrade(updateInfo?.latest_version);
          if (!result.success || !result.job_id) throw new Error(result.message);
          setServerUpgradeJob(result.job_id);
          setServerUpgradeProgress(result.message);
        } catch (err: any) {
          // A transport failure can happen after the task was accepted. Re-read it.
          try {
            const state = await systemApi.getUpgradeStatus(AbortSignal.timeout(8000));
            if (state.is_upgrading && state.job_id) {
              setServerUpgradeJob(state.job_id);
              return;
            }
          } catch { /* show uncertainty rather than claim failure/success */ }
          setIsUpgradingServer(false);
          setServerUpgradeError(`${err.message}；请先确认任务状态再重试。`);
        }
      },
    });
  };

  const handleUpgradeSingleAgent = async (device: Device) => {
    try {
      setUpgradingDevice(true);
      const result = await agentsApi.upgrade(device.id);
      // Read the real task; a successful socket write is not an acknowledgment.
      const state = await agentsApi.getUpgradeStatus(device.id);
      if (state.status) setAgentUpgradeStatuses(prev => ({ ...prev, [device.id]: state.status! }));
      if (result.upgrade_command) {
        setAgentUpgradeCommands(prev => ({ ...prev, [device.id]: { command: result.upgrade_command!, expiresAt: Date.now() + 600000 } }));
      }
      triggerToast(result.message, result.signal_sent ? 'info' : 'warning');
    } catch (err: any) {
      triggerToast(t(`升级请求未完成: ${err.message}`, `Upgrade request incomplete: ${err.message}`), 'warning');
    } finally {
      setUpgradingDevice(false);
    }
  };

  const handleGenerateUpgradeCommand = async (clientId: string) => {
    setGeneratingUpgradeCommand(true);
    try {
      const result = await agentsApi.getUpgradeCommand(clientId);
      setAgentUpgradeCommands(prev => ({ ...prev, [clientId]: {
        command: result.upgrade_command, expiresAt: Date.now() + result.expires_in * 1000,
      } }));
    } catch (err: any) {
      triggerToast(err.message, 'warning');
    } finally {
      setGeneratingUpgradeCommand(false);
    }
  };

  // 批量触发所有在线旧版本 Agent 升级
  const handleBatchUpgradeAgents = async () => {
    try {
      setBatchUpgrading(true);
      const res = await agentsApi.batchUpgrade();
      triggerToast(t(`已向 ${res.upgraded_count} 台在线旧版本设备发送升级信号！`, `Sent upgrade signals to ${res.upgraded_count} devices!`), 'success');
    } catch (err: any) {
      triggerToast(t(`批量升级失败: ${err.message}`, `Batch upgrade failed: ${err.message}`), 'warning');
    } finally {
      setBatchUpgrading(false);
    }
  };

  // Change screen helper with direction mapping matching navigation specification
  const changeScreen = (screen: Screen, transition: 'push' | 'push_back' | 'slide_up' | 'none') => {
    setLastScreen(currentScreen);
    setTransitionDirection(transition);
    setCurrentScreen(screen);
    setMobileMenuOpen(false);
  };

  // Setup mode choosing handler
  const handleSelectMode = (mode: 'ip' | 'domain') => {
    setServerConfig(prev => ({ ...prev, mode }));
  };

  // Begin deployment initiation
  const handleStartDeployment = async () => {
    try {
      const result = await frpApi.deployServer(inputPort, '', inputIp);
      if (result.success) {
        setServerConfig(prev => ({
          ...prev,
          ip: inputIp,
          port: inputPort,
          token: (result as any).info?.auth_token || prev.token,
          domain: prev.mode === 'domain' ? inputDomain : undefined
        }));
        changeScreen(Screen.INIT_DEPLOY_SUCCESS, 'push');
        triggerToast('FRP服务端节点参数部署成功, 初始化完成.', 'success');
      } else {
        triggerToast(`部署失败: ${(result as any).message}`, 'warning');
      }
    } catch (err: any) {
      if (err.status === 401 || err.status === 403) {
        clearToken();
        setUserProfile(null);
        changeScreen(Screen.LOGIN, 'push_back');
        triggerToast(t('登录凭据已失效或系统已重置，请重新登录', 'Session expired or system was redeployed. Please login again.'), 'warning');
        return;
      }
      triggerToast(`部署失败: ${err.message}`, 'warning');
    }
  };

  // Complete deploy steps & transition to controller panel
  const handleCompleteInit = () => {
    loadDashboardData();
    dashboardWs.connect();
    changeScreen(Screen.DASHBOARD, 'push');
  };

  // 客户端安装一键命令状态（惰性生成，不预先创建幽灵设备）
  const [installCommands, setInstallCommands] = useState<{ linux: string; darwin: string; windows: string } | null>(null);
  const [installCommandsLoading, setInstallCommandsLoading] = useState(false);

  const fetchInstallCommands = async () => {
    setInstallCommandsLoading(true);
    try {
      const res = await frpApi.getInstallCommand();
      setInstallCommands(res.commands);
      return res.commands;
    } catch (err: any) {
      triggerToast(t(`获取安装命令失败：${err.message}，请重试`, `Failed to load install commands: ${err.message}. Please retry.`), 'warning');
      return null;
    } finally {
      setInstallCommandsLoading(false);
    }
  };

  const handleSelectOS = async (os: OS) => {
    setSelectedOs(os);
    if (!installCommands) {
      fetchInstallCommands();
    }
    changeScreen(Screen.CLIENT_SCRIPT, 'none');
  };

  // 完成部署脚本引导，返回设备列表
  // 真实设备会在 Agent 通过 WebSocket 连接后自动注册
  const handleCompleteDeployment = () => {
    loadDashboardData();
    changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back');
    triggerToast(t('请在目标设备上执行安装脚本，Agent 启动后将自动注册到系统', 'Run the install script on your target device. The agent will register automatically via WebSocket.'), 'info');
  };

  // Copy to clipboard helper
  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      triggerToast(t('已成功复制至剪贴板!', 'Copied to clipboard!'), 'success');
    } catch {
      // 降级方案：使用 textarea 选中复制
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      triggerToast(t('已成功复制至剪贴板!', 'Copied to clipboard!'), 'success');
    }
  };

  // Start or Stop a tunnel connection
  const toggleTunnelStatus = async (tunnelId: string) => {
    const tunnel = tunnels.find(t => t.id === tunnelId);
    if (!tunnel) return;
    const isOnline = tunnel.status === 'online';
    try {
      if (tunnel.backendId && tunnel.deviceId) {
        await tunnelsApi.update(tunnel.deviceId, tunnel.backendId, { enabled: isOnline ? false : true });
      }
      setTunnels(prev => prev.map(t => {
        if (t.id === tunnelId) {
          return { ...t, status: isOnline ? 'offline' as const : 'online' as const, enabled: !isOnline };
        }
        return t;
      }));
      triggerToast(`穿透隧道 '${tunnel.name}' 已${isOnline ? '停止' : '重新启动'}.`, isOnline ? 'warning' : 'success');
    } catch (err: any) {
      triggerToast(`操作失败: ${err.message}`, 'warning');
    }
  };

  // Add custom tunnel via form modal
  const handleCreateTunnel = async (e: React.FormEvent) => {
    e.preventDefault();
    const lPort = Number(newTunnelData.localPort);
    const rPort = Number(newTunnelData.remotePort);
    if (!lPort || lPort < 1 || lPort > 65535) {
      triggerToast(t('请输入有效的局域网端口 (1-65535)', 'Please enter a valid local port (1-65535)'), 'warning');
      return;
    }
    if (!rPort || rPort < 1 || rPort > 65535) {
      triggerToast(t('请输入有效的服务端映射端口 (1-65535)', 'Please enter a valid remote port (1-65535)'), 'warning');
      return;
    }
    try {
      const created = await tunnelsApi.create(newTunnelData.deviceId, {
        name: newTunnelData.name,
        type: newTunnelData.type,
        local_ip: newTunnelData.localIp,
        local_port: lPort,
        remote_port: rPort,
      });
      const newTun: Tunnel = {
        id: `${newTunnelData.deviceId}-${created.id}`,
        deviceId: newTunnelData.deviceId,
        name: created.name,
        type: created.type as any,
        localIp: created.local_ip,
        localPort: created.local_port,
        remotePort: created.remote_port || 0,
        status: 'online',
        trafficIn: '0 B',
        trafficOut: '0 B',
        backendId: created.id,
        enabled: true,
      };
      setTunnels(prev => [newTun, ...prev]);
      setDevices(prev => prev.map(d => {
        if (d.id === newTunnelData.deviceId) {
          return { ...d, tunnelsCount: d.tunnelsCount + 1 };
        }
        return d;
      }));
      setAddTunnelModalOpen(false);
      triggerToast(`穿透服务 '${newTun.name}' 建立绑定成功!`, 'success');
    } catch (err: any) {
      triggerToast(`创建隧道失败: ${err.message}`, 'warning');
    }
  };

  // Delete a specific tunnel
  const handleDeleteTunnel = async (id: string, name: string) => {
    const tunnel = tunnels.find(t => t.id === id);
    if (tunnel?.backendId && tunnel.deviceId) {
      try {
        await tunnelsApi.delete(tunnel.deviceId, tunnel.backendId);
      } catch (_err) {
        void _err;
      }
    }
    setTunnels(prev => prev.filter(t => t.id !== id));
    triggerToast(`穿透隧道 '${name}' 已成功释放.`, 'warning');
  };

  const handleDeleteDevice = async (deviceId: string, deviceName: string) => {
    try {
      await clientsApi.delete(deviceId);
    } catch (err: any) {
      triggerToast(t(`注销失败：${err.message}`, `Failed to unregister: ${err.message}`), 'warning');
      return;
    }
    setDevices(prev => prev.filter(d => d.id !== deviceId));
    setTunnels(prev => prev.filter(t => t.deviceId !== deviceId));
    triggerToast(t(`已注销设备 '${deviceName}' 及关联隧道；远端容器请使用卸载命令移除。`, `Device '${deviceName}' and its tunnels were unregistered. Remove the remote container using the uninstall command.`), 'warning');
  };

  /** 获取设备格式化名称：如 "ubuntu（这是备注名）" 或 "ubuntu" */
  const formatDeviceDisplayName = (device: { name: string; remark?: string | null }) => {
    if (device.remark && device.remark.trim()) {
      return `${device.name}（${device.remark.trim()}）`;
    }
    return device.name;
  };

  const handleEditDeviceName = (device: Device) => {
    showConfirm({
      title: t('修改设备备注', 'Edit Device Remark'),
      message: t(
        `为设备 '${device.name}' 设置备注名称，设置后将在面板展示为 “${device.name}（备注名）”。`,
        `Set a custom remark for '${device.name}'. It will be displayed as "${device.name} (Remark)".`
      ),
      confirmText: t('保存备注', 'Save Remark'),
      cancelText: t('取消', 'Cancel'),
      showInput: true,
      inputDefaultValue: device.remark || '',
      inputPlaceholder: t('请输入设备备注名（留空则清除备注）', 'Enter device remark or leave blank to clear'),
      inputLabel: t('设备备注名 (Remark)', 'Device Remark'),
      onConfirmInput: async (nextRemark: string) => {
        const trimmed = nextRemark.trim();
        try {
          await clientsApi.updateRemark(device.id, trimmed ? trimmed : null);
          setDevices(prev => prev.map((d: Device) => d.id === device.id ? { ...d, remark: trimmed ? trimmed : null } : d));
          triggerToast(
            trimmed
              ? t(`设备备注已更新为: ${trimmed}`, `Remark updated to: ${trimmed}`)
              : t('已清除设备备注', 'Device remark cleared'),
            'success'
          );
        } catch (err: any) {
          triggerToast(`修改备注失败: ${err.message}`, 'warning');
        }
      }
    });
  };

  const toggleDeviceExpanded = (deviceId: string) => {
    setExpandedDeviceIds(prev => ({
      ...prev,
      [deviceId]: !prev[deviceId]
    }));
  };

  const handleResetFilters = () => {
    setOsFilter({ linux: true, windows: true, macos: true });
    setArchFilter({ x86_64: true, arm64: true });
    setStatusFilter({ online: true, offline: true });
    setDeviceSearchQuery('');
    setFilterMenuOpen(false);
    triggerToast(t('过滤器与过滤参数均已重置', 'All OS, architecture, and status filters reset'), 'info');
  };

  // 日志弹窗：打开时连接 WebSocket 日志流，关闭时断开
  useEffect(() => {
    if (logModalOpen && logModalDevice) {
      setLiveLogs([]);
      // 通过 WebSocket 订阅该设备的日志（后端 ws/logs/{client_id}）
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = localStorage.getItem('token');
      const logWsUrl = `${protocol}//${window.location.host}/ws/logs/${logModalDevice.id}?token=${token}`;
      const logSocket = new WebSocket(logWsUrl);

      logSocket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const rawMsg = typeof msg === 'string' ? msg : msg.data || msg.message || JSON.stringify(msg);
          // 去除 ANSI 转义序列
          const cleanMsg = rawMsg.replace(/\x1b\[[0-9;]*m/g, '');
          setLiveLogs(prev => [...prev, {
            id: String(Date.now() + Math.random()),
            msg: cleanMsg,
          }]);
        } catch (_err) {
          void _err;
        }
      };

      return () => { logSocket.close(); };
    }
  }, [logModalOpen, logModalDevice]);

  // Scroll to bottom of terminal scroll area on log updates
  useEffect(() => {
    if (terminalScrollRef.current) {
      terminalScrollRef.current.scrollTop = terminalScrollRef.current.scrollHeight;
    }
  }, [liveLogs]);

  // Helper actions for Logs Modal
  const handleClearLogs = () => {
    setLiveLogs([]);
    triggerToast(t('本地日志缓存已成功清空', 'Realtime logs trace cleared locally.'), 'success');
  };

  const handleDownloadLogs = () => {
    if (!logModalDevice) return;
    const logText = liveLogs.map(log => log.msg).join('\n');
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${logModalDevice.name}_realtime_${new Date().toISOString().slice(0, 10)}.log`;
    link.click();
    URL.revokeObjectURL(url);
    triggerToast(t('实时文件日志已成功构建并下载', 'Realtime journal logs exported successfully.'), 'success');
  };

  // React to Settings Update matching HTML mockup design
  const handleSaveSettings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      if (enableAutoHttps && !tempDomain.trim()) {
        throw new Error(t('启用 HTTPS 前请填写面板域名并完成适用的备案要求', 'Enter a panel hostname and meet applicable filing requirements before enabling HTTPS'));
      }
      // 保存域名
      if (tempDomain) {
        await settingsApi.setDomain(tempDomain);
      }
      // 保存面板端口
      await settingsApi.setPanelPort(tempDashboardPort.trim());
      // 处理 TLS 开关（仅在状态变化或域名变化时触发，避免重复申请证书）
      if (enableAutoHttps && tempDomain) {
        if (!savedTlsEnabled || tempDomain !== savedDomain) {
          const result = await settingsApi.enableTls(tempDomain);
          if (!(result as { success?: boolean }).success) {
            throw new Error((result as { message?: string }).message || 'HTTPS 配置失败');
          }
          setSavedTlsEnabled(true);
          setSavedDomain(tempDomain);
        }
      } else if (!enableAutoHttps && savedTlsEnabled) {
        await settingsApi.disableTls();
        setSavedTlsEnabled(false);
      }
      setServerConfig(prev => ({
        ...prev,
        domain: tempDomain,
      }));
      setGlobalSettings(prev => ({
        ...prev,
        dashboardPort: tempDashboardPort ? Number(tempDashboardPort) : 0,
      }));
      triggerToast(t('设置已保存；启用域名或 HTTPS 后请同步修改 GitHub OAuth 回调地址。', 'Settings saved. Update your GitHub OAuth callback URL after changing the domain or HTTPS.'), 'success');
    } catch (err: any) {
      triggerToast(`保存失败: ${err.message}`, 'warning');
    }
  };

  const handleDiscardSettings = () => {
    setTempDomain(serverConfig.domain || '');
    setTempDashboardPort(globalSettings.dashboardPort ? String(globalSettings.dashboardPort) : '');
    triggerToast(t('放弃未保存修改并返回控制面板概览', 'Discarded unsaved change logs, redirected back to Overview'), 'info');
    changeScreen(Screen.DASHBOARD, 'none');
  };

  const handleRunDnsCheck = async () => {
    setDnsCheckLoading(true);
    triggerToast(t('正在检查底层 DNS 递归解析...', 'Querying recursive DNS resolution records over internet...'), 'info');
    try {
      const result = await settingsApi.checkDns(tempDomain);
      setDnsCheckLoading(false);
      if ((result as any).success) {
        setDnsChecked(true);
        triggerToast(t('DNS 深度解析检测通过', 'DNS check matches: domain successfully resolved to host IP address!'), 'success');
      } else {
        setDnsChecked(false);
        triggerToast(`DNS 检查失败: ${(result as any).message}`, 'warning');
      }
    } catch (err: any) {
      setDnsCheckLoading(false);
      setDnsChecked(false);
      triggerToast(`DNS 检查失败: ${err.message}`, 'warning');
    }
  };

  return (
    <div className="min-h-screen bg-background font-body-md text-on-surface antialiased overflow-x-hidden relative flex flex-col justify-between">
      
      {/* Toast Notification HUD */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center px-4 py-3 rounded-lg border border-border-subtle shadow-lg"
            style={{
              backgroundColor: toast.type === 'success' ? '#ECFDF5' : toast.type === 'warning' ? '#FEF3C7' : '#F0F9FF',
              borderColor: toast.type === 'success' ? '#10B981' : toast.type === 'warning' ? '#F59E0B' : '#00ADD8',
              color: toast.type === 'success' ? '#065F46' : toast.type === 'warning' ? '#92400E' : '#0369A1'
            }}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 mr-2 shrink-0 text-status-online" />
            ) : toast.type === 'warning' ? (
              <AlertTriangle className="w-5 h-5 mr-2 shrink-0 text-status-warning" />
            ) : (
              <Info className="w-5 h-5 mr-2 shrink-0 text-primary-container" />
            )}
            <span className="font-sans font-medium text-sm">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main interactive screen wrapper */}
      <div className="flex-grow flex flex-col">
        <AnimatePresence mode="wait">
          {/* SCREEN 1: 登录 - FRP-ALL-IN-ONE */}
          {currentScreen === Screen.LOGIN && (
            <motion.div
              key="screen-login"
              variants={animationVariants[transitionDirection]}
              initial="initial"
              animate="animate"
              exit="exit"
              className="min-h-screen w-full flex flex-col justify-center items-center relative overflow-hidden bg-background text-on-background"
            >
              {/* Subtle Grid Background for Technical Aesthetic */}
              <div 
                className="absolute inset-0 opacity-40 z-0 pointer-events-none"
                style={{ 
                  backgroundImage: 'linear-gradient(to right, #E2E8F0 1px, transparent 1px), linear-gradient(to bottom, #E2E8F0 1px, transparent 1px)', 
                  backgroundSize: '40px 40px' 
                }}
              />
              
              {/* Main Login Card */}
              <main className="w-full max-w-md bg-[#ffffff] border border-border-subtle z-10 flex flex-col items-center p-12 shadow-sm rounded">
                {/* Logo / Branding */}
                <div className="flex flex-col items-center mb-8">
                  <img src="/favicon.svg" alt="FRP-ALL-IN-ONE Logo" className="w-16 h-16 mb-3 drop-shadow-sm rounded-2xl" />
                  <h1 className="font-headline font-semibold text-2xl text-primary text-center tracking-tight">FRP-ALL-IN-ONE</h1>
                  <p className="font-mono text-xs text-on-surface-variant mt-1.5 bg-surface-container-high px-2 py-0.5 rounded font-semibold">{APP_VERSION_DISPLAY}</p>
                </div>
                
                {/* Action Area */}
                <div className="w-full flex flex-col gap-3">
                  <button
                    onClick={() => {
                      authApi.loginWithGitHub();
                    }}
                    className="w-full bg-github-dark text-white flex items-center justify-center gap-3 py-3 px-4 hover:opacity-90 transition-opacity font-medium text-sm rounded cursor-pointer"
                  >
                    {/* GitHub SVG Icon for precision */}
                    <svg aria-hidden="true" className="w-5 h-5 fill-current shrink-0" viewBox="0 0 16 16">
                      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
                    </svg>
                    <span className="font-sans font-medium text-sm">
                      {lang === 'zh' ? '使用 GitHub 登录' : 'Sign in with GitHub'}
                    </span>
                  </button>
                  <p className="font-sans text-xs text-on-surface-variant text-center mt-4 opacity-70">
                    {lang === 'zh' ? '通过 GitHub OAuth 安全访问' : 'Secure access via GitHub OAuth'}
                  </p>
                </div>
              </main>

              {/* Minimalist Footer */}
              <footer className="absolute bottom-8 w-full flex justify-center gap-6 z-10">
                <a 
                  className="flex items-center gap-1.5 text-on-surface-variant hover:text-primary transition-colors text-xs font-semibold" 
                  href="https://github.com/newbietan/FRP-ALL-IN-ONE"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {lang === 'zh' ? '项目文档' : 'Project Docs'}
                  </span>
                </a>
                <a 
                  className="flex items-center gap-1.5 text-on-surface-variant hover:text-primary transition-colors text-xs font-semibold" 
                  href="https://github.com/newbietan"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Code className="w-3.5 h-3.5 shrink-0" />
                  <span>GitHub</span>
                </a>
              </footer>
              
              <div className="absolute top-8 right-8 z-20">
                <button
                  onClick={() => {
                    const nextLang = lang === 'zh' ? 'en' : 'zh';
                    setLang(nextLang);
                    triggerToast(
                      nextLang === 'zh' ? '已切换至简体中文' : 'Switched to English',
                      'success'
                    );
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white/80 backdrop-blur-sm border border-border-subtle hover:bg-slate-50 transition-colors group text-on-surface-variant rounded text-xs font-medium cursor-pointer"
                >
                  <Globe className="w-4 h-4 group-hover:text-primary shrink-0" />
                  <span className="group-hover:text-primary">
                    {lang === 'zh' ? 'English' : '简体中文'}
                  </span>
                </button>
              </div>
            </motion.div>
          )}

          {/* SCREEN 2: 初始化 - 选择模式 */}
          {currentScreen === Screen.INIT_CHOOSE_MODE && (
            <motion.div
              key="screen-init-choose-mode"
              variants={animationVariants[transitionDirection]}
              initial="initial"
              animate="animate"
              exit="exit"
              className="min-h-screen flex items-center justify-center p-gutter bg-background antialiased"
            >
              <main className="w-full max-w-3xl bg-surface-container-lowest border border-border-subtle rounded-xl flex flex-col shadow-sm">
                {/* Header */}
                <div className="px-8 py-6 border-b border-border-subtle flex flex-col items-center text-center">
                  <h1 className="font-headline-lg text-headline-lg text-on-surface">{t('初始化向导', 'Initialization Wizard')}</h1>
                  <p className="font-body-md text-body-md text-on-surface-variant mt-2">{t('面向中国大陆境内设备，推荐使用境内 Linux 服务器', 'For devices in mainland China; use a mainland Linux server')} </p>
                </div>
                {/* Content */}
                <div className="p-8 flex-grow">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Option 1: IP Direct (Selected) */}
                    <div 
                      onClick={() => handleSelectMode('ip')}
                      className={`relative flex flex-col p-6 border-2 rounded-lg cursor-pointer transition-all group ${serverConfig.mode === 'ip' ? 'border-primary bg-surface' : 'border-border-subtle bg-surface hover:bg-surface-container-low'}`}
                    >
                      <div className="flex items-center justify-between mb-6">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${serverConfig.mode === 'ip' ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-variant text-on-surface-variant group-hover:bg-surface-dim'}`}>
                          <Network className="w-6 h-6 shrink-0" />
                        </div>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${serverConfig.mode === 'ip' ? 'border-primary' : 'border-outline-variant group-hover:border-outline'}`}>
                          {serverConfig.mode === 'ip' && <div className="w-2.5 h-2.5 rounded-full bg-primary"></div>}
                        </div>
                      </div>
                      <h3 className="font-headline-sm text-headline-sm text-on-surface mb-2">{t('IP 直连（基础配置）', 'IP access (basic setup)')}</h3>
                      <p className="font-body-md text-body-md text-on-surface-variant">{t('使用公网 IP 配置 TCP/UDP 穿透。HTTP 面板仅适合受限访问或初始配置，不应作为长期公网明文入口。', 'Configure TCP/UDP tunnels using the public IP. Restrict HTTP panel access; do not use plaintext HTTP for long-term public administration.')}</p>
                    </div>

                    {/* Option 2: Domain Mode */}
                    <div 
                      onClick={() => handleSelectMode('domain')}
                      className={`relative flex flex-col p-6 border-2 rounded-lg cursor-pointer transition-all group ${serverConfig.mode === 'domain' ? 'border-primary bg-surface animate-none' : 'border-border-subtle bg-surface hover:bg-surface-container-low'}`}
                    >
                      <div className="flex items-center justify-between mb-6">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${serverConfig.mode === 'domain' ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-variant text-on-surface-variant group-hover:bg-surface-dim'}`}>
                          <Globe className="w-6 h-6 shrink-0" />
                        </div>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${serverConfig.mode === 'domain' ? 'border-primary' : 'border-outline-variant group-hover:border-outline'}`}>
                          {serverConfig.mode === 'domain' && <div className="w-2.5 h-2.5 rounded-full bg-primary"></div>}
                        </div>
                      </div>
                      <h3 className="font-headline-sm text-headline-sm text-on-surface mb-2">{t('域名与 HTTPS（可选）', 'Domain and HTTPS (optional)')}</h3>
                      <p className="font-body-md text-body-md text-on-surface-variant">{t('境内网站应先按接入商要求完成备案，再配置域名与 HTTPS。证书不能替代备案，IP 或非标准端口也不能作为规避依据。', 'Meet your mainland hosting provider’s filing requirements before domain/HTTPS setup. A certificate, IP address or alternate port is not a filing exemption.')}</p>
                    </div>
                  </div>

                  {serverConfig.mode === 'domain' && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 flex flex-col gap-1.5"
                    >
                      <label className="font-label-md text-label-md text-on-surface">{t('主解析域名', 'Primary Domain Name')}</label>
                      <div className="relative flex items-center">
                        <Globe className="absolute left-3 w-4 h-4 text-outline" />
                        <input
                          type="text"
                          className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg py-2 pl-10 pr-3 font-code-block text-on-surface font-mono"
                          value={inputDomain}
                          onChange={(e) => setInputDomain(e.target.value)}
                          placeholder="e.g. frp.my-domain.com"
                        />
                      </div>
                      <span className="text-xs text-outline font-sans">{t(`确保您的 A/CNAME 记录已成功指向公网服务器 IP ${serverPublicIp || '...'}`, `Verify that your DNS A or CNAME entry successfully resolves to Server IP ${serverPublicIp || '...'}`)}</span>
                    </motion.div>
                  )}
                </div>
                {/* Footer */}
                <div className="px-8 py-5 border-t border-border-subtle bg-surface-container-low flex justify-end rounded-b-xl">
                  <button 
                    onClick={() => changeScreen(Screen.INIT_SERVER_CONFIG, 'push')}
                    className="bg-primary-container text-on-primary h-[36px] px-6 rounded font-label-md text-label-md hover:bg-primary transition-colors flex items-center justify-center gap-2 cursor-pointer font-sans"
                  >
                    {t('下一步', 'Next Step')}
                  </button>
                </div>
              </main>
            </motion.div>
          )}

          {/* SCREEN 3: 初始化 - 服务端配置 (更新版) */}
          {currentScreen === Screen.INIT_SERVER_CONFIG && (
            <motion.div
              key="screen-init-server-config"
              variants={animationVariants[transitionDirection]}
              initial="initial"
              animate="animate"
              exit="exit"
              className="min-h-screen flex items-center justify-center p-gutter bg-background antialiased"
            >
              <main className="w-full max-w-[480px] bg-surface-container-lowest rounded-xl border border-border-subtle p-8 flex flex-col gap-6 relative shadow-[0_4px_24px_rgba(0,0,0,0.02)]">
                {/* Header & Progress */}
                <header className="flex flex-col gap-4 text-center">
                  <div className="flex justify-center mb-2">
                    <Sliders className="w-12 h-12 text-primary" />
                  </div>
                  <h1 className="font-headline-lg text-headline-lg text-on-surface">{t('服务端配置', 'FRPS Server Configuration')}</h1>
                  <p className="font-body-md text-body-md text-on-surface-variant">Step 2 of 3: Initialization Wizard</p>
                  {/* Progress Bar */}
                  <div className="w-full bg-surface-container h-2 rounded-full mt-2 overflow-hidden flex">
                    <div className="h-full bg-primary transition-all duration-500 ease-in-out w-2/3"></div>
                  </div>
                </header>

                {/* Form Content */}
                <section className="flex flex-col gap-5 mt-4">
                  {/* Contextual Help */}
                  <div className="bg-surface-container-low p-4 rounded-lg border border-border-subtle flex items-start gap-3">
                    <Info className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <p className="font-body-md text-body-md text-on-surface-variant text-left">
                      {t('这些配置将用于设定 FRP 服务端 (FRPS)。客户端后续连接时，需要填入此处的 IP 和端口。', 'These parameters define your server settings. Client machines will bind using this public IP and port.')}
                    </p>
                  </div>

                  <div className="flex flex-col gap-4">
                    {/* Input Group 1: Server IP */}
                    <div className="flex flex-col gap-1.5 relative">
                      <label className="font-label-md text-label-md text-on-surface flex justify-between items-center" htmlFor="server-ip">
                        {t('当前服务器 IP', 'Public IP Address')}
                        <span className="font-label-sm text-label-sm text-on-surface-variant bg-surface-container px-2 py-1 rounded">{t('自动获取的公网 IP', 'Auto detected Public IP')}</span>
                      </label>
                      <div className="relative flex items-center">
                        <Globe className="absolute left-3 w-4 h-4 text-outline" />
                        <input 
                          className="w-full bg-surface-container-low border border-border-subtle rounded-lg py-2.5 pl-10 pr-3 font-code-block text-code-block text-on-surface-variant focus:outline-none" 
                          id="server-ip" 
                          readOnly 
                          type="text" 
                          value={inputIp}
                        />
                      </div>
                    </div>

                    {/* Input Group 2: Listen Port */}
                    <div className="flex flex-col gap-1.5 relative">
                      <label className="font-label-md text-label-md text-on-surface flex justify-between items-center" htmlFor="listen-port">
                        {t('监听端口', 'Listen Port')}
                        <span className="font-label-sm text-label-sm text-on-surface-variant">{t('FRPS 监听端口', 'FRPS default listen port')}</span>
                      </label>
                      <div className="relative flex items-center">
                        <TerminalIcon className="absolute left-3 w-4 h-4 text-outline" />
                        <input 
                          className="w-full bg-surface-container-lowest border border-border-subtle rounded-lg py-2.5 pl-10 pr-3 font-code-block text-code-block text-on-surface focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-shadow placeholder:text-outline-variant font-mono" 
                          id="listen-port" 
                          placeholder="7000" 
                          type="number" 
                          value={inputPort}
                          onChange={(e) => setInputPort(Math.max(1, Math.min(65535, Number(e.target.value))))}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                {/* Actions */}
                <footer className="flex gap-3 mt-6">
                  <button 
                    onClick={() => changeScreen(Screen.INIT_CHOOSE_MODE, 'push_back')}
                    className="flex-1 py-3 px-4 bg-surface-container-highest hover:bg-surface-dim text-on-surface font-sans text-sm font-medium rounded-lg transition-colors border border-transparent cursor-pointer"
                  >
                    {t('上一步', 'Previous Step')}
                  </button>
                  <button 
                    onClick={handleStartDeployment}
                    className="flex-[2] py-3 px-4 bg-primary-container hover:bg-[#009bc2] text-on-primary font-sans text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                  >
                    {t('开始部署', 'Deploy Daemon')}
                    <ArrowRight className="w-4 h-4 shrink-0" />
                  </button>
                </footer>
              </main>
            </motion.div>
          )}

          {/* SCREEN 4: 初始化 - 部署成功 */}
          {currentScreen === Screen.INIT_DEPLOY_SUCCESS && (
            <motion.div
              key="screen-init-deploy-success"
              variants={animationVariants[transitionDirection]}
              initial="initial"
              animate="animate"
              exit="exit"
              className="min-h-screen flex items-center justify-center p-gutter bg-background antialiased"
            >
              <main className="w-full max-w-[640px] bg-surface-container-lowest border border-border-subtle rounded-xl p-8 md:p-12 text-center flex flex-col items-center shadow-lg">
                {/* Success Icon */}
                <div className="w-24 h-24 bg-status-online/10 rounded-full flex items-center justify-center mb-6">
                  <CheckCircle2 className="w-14 h-14 text-status-online shrink-0" />
                </div>
                {/* Headlines */}
                <h1 className="font-headline-lg text-headline-lg text-on-surface mb-4">{t('部署成功', 'Deployed Successfully')}</h1>
                <p className="font-body-lg text-body-lg text-on-surface-variant mb-10">{t('您的 FRP 节点已成功初始化并正在运行。', 'Your FRPS bridge node is successfully initialized and running.')}</p>
                {/* Parameters Grid */}
                <div className="w-full bg-surface-container-low border border-border-subtle rounded-lg p-6 mb-8 grid grid-cols-1 md:grid-cols-3 gap-6 text-left">
                  <div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border-subtle pb-4 md:pb-0 md:pr-4 last:border-0 last:pb-0 last:pr-0">
                    <span className="font-label-sm text-label-sm text-on-surface-variant uppercase mb-2">{t('系统版本', 'Core Release')}</span>
                    <span className="font-label-md text-label-md text-on-surface font-mono">{serverConfig.version}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border-subtle pb-4 md:pb-0 md:pr-4 last:border-0 last:pb-0 last:pr-0">
                    <span className="font-label-sm text-label-sm text-on-surface-variant uppercase mb-2">{t('监听端口', 'Listen Port')}</span>
                    <span className="font-label-md text-label-md text-on-surface font-mono">{serverConfig.port}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center last:border-0 last:pb-0 last:pr-0 border-transparent">
                    <span className="font-label-sm text-label-sm text-on-surface-variant uppercase mb-2">{t('公网 IP', 'Public Edge IP')}</span>
                    <span className="font-label-md text-label-md text-on-surface font-mono">{serverConfig.ip}</span>
                  </div>
                </div>
                {/* Token Input */}
                <div className="w-full text-left mb-10">
                  <label className="font-label-sm text-label-sm text-on-surface-variant uppercase flex items-center mb-2">
                    {t('认证 Token', 'Access Token')}
                    <AlertTriangle className="w-4 h-4 text-status-warning ml-2 shrink-0 cursor-help" title={t('请妥善保管此凭证', 'Please store this credential safely')} />
                  </label>
                  <div className="relative w-full">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Key className="w-4 h-4 text-outline" />
                    </div>
                    <input 
                      className="block w-full pl-10 pr-20 py-3 bg-surface-container-lowest border border-border-subtle rounded text-on-surface font-code-block text-code-block font-mono focus:outline-none" 
                      id="token-input" 
                      readOnly 
                      type={tokenVisible ? "text" : "password"} 
                      value={serverConfig.token}
                    />
                    <div className="absolute inset-y-0 right-0 pr-2 flex items-center space-x-1">
                      <button 
                        className="p-1.5 text-outline hover:text-on-surface transition-colors rounded hover:bg-surface-container-high cursor-pointer" 
                        id="toggle-token" 
                        title={tokenVisible ? t('隐藏', 'Hide') : t('查看', 'View')} 
                        type="button"
                        onClick={() => setTokenVisible(!tokenVisible)}
                      >
                        {tokenVisible ? <EyeOff className="w-4 h-4 shrink-0" /> : <Eye className="w-4 h-4 shrink-0 text-outline" />}
                      </button>
                      <button 
                        className="p-1.5 text-outline hover:text-on-surface transition-colors rounded hover:bg-surface-container-high cursor-pointer"
                        id="copy-token" 
                        title="复制" 
                        type="button"
                        onClick={() => handleCopyText(serverConfig.token)}
                      >
                        <Copy className="w-4 h-4 shrink-0" />
                      </button>
                    </div>
                  </div>
                </div>
                {/* Action Button */}
                <button 
                  onClick={handleCompleteInit}
                  className="w-full md:w-auto px-8 py-3 bg-primary-container text-on-primary hover:bg-surface-tint hover:shadow-sm transition-all rounded font-label-md text-label-md font-mono flex items-center justify-center space-x-2 cursor-pointer font-sans"
                >
                  <span>{t('完成配置，进入控制面板', 'Confirm & Enter Dashboard')}</span>
                  <ArrowRight className="w-4 h-4 shrink-0" />
                </button>
              </main>
            </motion.div>
          )}

          {/* SHARED ROOT WRAPPER FOR PANEL GRAPHICS (Dashboard, Devices, Settings) */}
          {[Screen.DASHBOARD, Screen.DEVICE_MANAGEMENT, Screen.SETTINGS, Screen.ADD_DEVICE, Screen.CLIENT_SCRIPT].includes(currentScreen) && (
            <motion.div
              key="panel-frame"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="min-h-screen bg-[#f8fafc] flex flex-col"
            >
              {/* NAVIGATION SIDEBAR DRAWER (Responsive & Desktop Fixed) */}
              <aside className={`fixed inset-y-0 left-0 z-40 transform ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 lg:fixed lg:h-screen lg:top-0 w-60 border-r border-[#E2E8F0] bg-[#f8fafc] p-5 flex flex-col select-none transition-transform duration-200 ease-in-out shrink-0 justify-between`}>
                <div className="flex flex-col">
                  {/* Brand Block Reference to Mock HTML layout */}
                  <div className="mb-8 px-2 flex items-center gap-3">
                    <img src="/favicon.svg" alt="FRP-ALL-IN-ONE Logo" className="w-8 h-8 rounded-lg shadow-sm shrink-0" />
                    <div>
                      <h1 className="font-headline font-black text-[#006782] text-sm tracking-tight leading-none">
                        FRP-ALL-IN-ONE
                      </h1>
                      <div className="flex items-center gap-1.5 mt-1">
                        <p className="font-mono text-[9px] text-[#6d797f] font-semibold tracking-wider">{APP_VERSION_DISPLAY}</p>
                        {updateInfo?.has_update && (
                          <button
                            onClick={() => setUpdateModalOpen(true)}
                            className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-500/20 text-amber-700 border border-amber-300 hover:bg-amber-500/30 transition-all cursor-pointer animate-pulse"
                            title={t('点击查看新版本详情与升级指引', 'Click to view update details')}
                          >
                            NEW {updateInfo.latest_version}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Section Title indicator */}
                  <div className="px-2 mb-3">
                    <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-outline">
                      {t('系统核心模块', 'SYSTEM CHANNELS')}
                    </p>
                  </div>

                  <nav className="flex flex-col gap-1">
                    {/* Active/Inactive state aligned perfectly with design specs */}
                    <a 
                      href="#dashboard"
                      onClick={(e) => {
                        e.preventDefault();
                        setMobileMenuOpen(false);
                        changeScreen(Screen.DASHBOARD, 'none');
                      }}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-semibold select-none transition-all duration-200 ${
                        currentScreen === Screen.DASHBOARD 
                          ? 'bg-[#006782]/10 text-[#006782] font-bold translate-x-1' 
                          : 'text-on-surface-variant hover:bg-slate-100 hover:text-on-surface'
                      }`}
                    >
                      <LayoutGrid className="w-4 h-4 shrink-0" />
                      <span>{t('概览', 'Overview')}</span>
                    </a>

                    <a 
                      href="#devices"
                      onClick={(e) => {
                        e.preventDefault();
                        setMobileMenuOpen(false);
                        changeScreen(Screen.DEVICE_MANAGEMENT, 'none');
                      }}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-semibold select-none transition-all duration-200 ${
                        [Screen.DEVICE_MANAGEMENT, Screen.ADD_DEVICE, Screen.CLIENT_SCRIPT].includes(currentScreen) 
                          ? 'bg-[#006782]/10 text-[#006782] font-bold translate-x-1' 
                          : 'text-on-surface-variant hover:bg-slate-100 hover:text-on-surface'
                      }`}
                    >
                      <Laptop className="w-4 h-4 shrink-0" />
                      <span>{t('设备管理', 'Devices')}</span>
                    </a>

                    <a 
                      href="#settings"
                      onClick={(e) => {
                        e.preventDefault();
                        setMobileMenuOpen(false);
                        changeScreen(Screen.SETTINGS, 'none');
                      }}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-semibold select-none transition-all duration-200 ${
                        currentScreen === Screen.SETTINGS 
                          ? 'bg-[#006782]/10 text-[#006782] font-bold translate-x-1' 
                          : 'text-on-surface-variant hover:bg-slate-100 hover:text-on-surface'
                      }`}
                    >
                      <Settings className="w-4 h-4 shrink-0" />
                      <span>{t('系统设置', 'Settings')}</span>
                    </a>
                  </nav>
                </div>

                {/* Footer Section reference to Sidebar mockup and stats metadata */}
                <div className="flex flex-col gap-4">
                  {/* Bottom nav grouped elements with border alignment */}
                  <div className="border-t border-border-subtle pt-4 flex flex-col gap-1">
                    <a 
                      className="flex items-center gap-3 px-4 py-2 text-on-surface-variant hover:bg-slate-100 rounded-lg text-xs font-semibold transition-all" 
                      href="https://github.com/newbietan/FRP-ALL-IN-ONE"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen className="w-4 h-4 shrink-0" />
                      <span>{t('项目文档', 'Project Docs')}</span>
                    </a>
                    <a 
                      className="flex items-center gap-3 px-4 py-2 text-on-surface-variant hover:bg-slate-100 rounded-lg text-xs font-semibold transition-all" 
                      href="https://github.com/newbietan"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Code className="w-4 h-4 shrink-0" />
                      <span>GitHub</span>
                    </a>
                  </div>
                </div>
              </aside>

              {/* Mobile Drawer backdrop blur overlay overlay */}
              {mobileMenuOpen && (
                <div 
                  onClick={() => setMobileMenuOpen(false)}
                  className="fixed inset-0 z-30 bg-black/25 backdrop-blur-sm lg:hidden"
                ></div>
              )}

              {/* MAIN CONTENT WORKSPACE AREA WITH lg:pl-60 TO COMPLEMENT THE FIXED SIDEBAR */}
              <div className="flex flex-col flex-grow lg:pl-60 min-h-screen">
                {/* TOP HEADER STATUSBAR */}
                <header className="sticky top-0 z-30 bg-white border-b border-border-subtle h-16 flex items-center justify-between px-6 shadow-[0_1px_4px_rgba(0,0,0,0.01)]">
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                      className="p-2 rounded hover:bg-surface-container lg:hidden shrink-0 cursor-pointer"
                    >
                      <Menu className="w-5 h-5" />
                    </button>
                    {!mobileMenuOpen && (
                      <div className="flex items-center gap-2 lg:hidden">
                        <img src="/favicon.svg" alt="FRP-ALL-IN-ONE Logo" className="w-5 h-5 rounded shrink-0" />
                        <span className="font-headline font-semibold text-sm tracking-tight text-on-surface">FRP-ALL-IN-ONE</span>
                      </div>
                    )}

                  </div>

                  <div className="flex items-center justify-center gap-4 text-xs font-mono h-full">
                    {updateInfo?.has_update && (
                      <button
                        onClick={() => setUpdateModalOpen(true)}
                        className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-300 hover:bg-amber-100 transition-colors cursor-pointer shadow-sm animate-pulse"
                        title={t('发现新版本，点击查看升级指引', 'New version available, click to view')}
                      >
                        <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                        <span>{t(`发现新版 ${updateInfo.latest_version}`, `New Version ${updateInfo.latest_version}`)}</span>
                      </button>
                    )}
                    <div className="hidden lg:flex items-center justify-center gap-1.5 text-on-surface-variant">
                      <Globe className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="leading-none">{t('IP 地址', 'IP Address')}: {serverConfig.ip}</span>
                    </div>
                    <div className="hidden lg:flex items-center justify-center gap-1.5 text-on-surface-variant">
                      <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="leading-none">{t('端口', 'PORT')}: {serverConfig.port}</span>
                    </div>
                    <div className="self-center h-4 w-[1px] bg-border-subtle hidden lg:block"></div>
                    
                    {/* Account HUD / Exit trigger & Global Language Switcher */}
                    <div className="flex items-center justify-center gap-3">
                      {/* Language Switch Button */}
                      <button 
                        onClick={() => {
                          const nextLang = lang === 'zh' ? 'en' : 'zh';
                          setLang(nextLang);
                          triggerToast(
                            nextLang === 'zh' ? '已切换至简体中文' : 'Switched to English',
                            'success'
                          );
                        }}
                        className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-white border border-border-subtle hover:bg-slate-50 transition-colors text-on-surface-variant rounded text-xs font-semibold cursor-pointer shrink-0 shadow-sm"
                        title={lang === 'zh' ? 'Switch to English' : '切换至简体中文'}
                      >
                        <Globe className="w-3.5 h-3.5 text-primary shrink-0 animate-spin-slow" />
                        <span className="leading-none">{lang === 'zh' ? 'English' : '简体中文'}</span>
                      </button>

                      <div className="self-center h-4 w-[1px] bg-border-subtle hidden sm:block"></div>

                      <span className="text-on-surface-variant hidden md:block leading-none self-center">
                        {lang === 'zh' ? '超级管理员' : 'Administrator'}
                      </span>
                      <button
                        onClick={() => {
                          clearToken();
                          dashboardWs.disconnect();
                          setDevices([]);
                          setTunnels([]);
                          changeScreen(Screen.LOGIN, 'push_back');
                        }}
                        className="p-2 text-on-surface-variant hover:text-error hover:bg-red-50 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                        title={t('退出登录', 'Sign Out')}
                      >
                        <LogOut className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </header>

                {/* SUB SCREENS MAIN COMPARTMENT CONTAINER */}
                <main className="flex-grow p-6 overflow-y-auto max-w-full">

                  {/* VIEW A: 仪表盘 - FRP-ALL-IN-ONE */}
                  {currentScreen === Screen.DASHBOARD && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col gap-6"
                    >
                      {/* Top Header (Contextual to page) */}
                      <header className="flex justify-between items-end pb-4 border-b border-border-subtle">
                        <div>
                          <h2 className="font-headline font-bold text-2xl text-on-surface tracking-tight">{t('概览', 'Overview')}</h2>
                          <div className="flex items-center gap-2 mt-1">
                            <div className="w-2 h-2 rounded-full bg-status-online animate-pulse"></div>
                            <span className="font-sans text-xs text-on-surface-variant uppercase tracking-wider font-semibold">{t('系统运行正常', 'System is running normally')}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => {
                              loadDashboardData();
                            }}
                            className="w-8 h-8 rounded border border-border-subtle flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low transition-colors cursor-pointer"
                            title={t('刷新组件', 'Refresh Components')}
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        </div>
                      </header>

                      {/* Stats Row */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
                        {/* Stat 1: Total Clients */}
                        <div className="bg-white border border-border-subtle rounded p-5 flex flex-col justify-between shadow-sm">
                          <div className="flex justify-between items-start mb-4">
                            <span className="font-sans text-sm text-on-surface-variant text-left">{t('连接总数', 'Total Connections')}</span>
                            <Laptop className="w-5 h-5 text-outline shrink-0" />
                          </div>
                          <div className="text-left">
                            <span className="font-mono text-2xl font-bold text-on-surface">{devices.length}</span>
                            <span className="font-sans text-sm text-on-surface-variant ml-1">{t('总计', 'Total')}</span>
                          </div>
                        </div>

                        {/* Stat 2: Online Clients */}
                        <div className="bg-white border border-border-subtle rounded p-5 flex flex-col justify-between relative overflow-hidden shadow-sm">
                          <div className="absolute top-0 left-0 w-full h-1 bg-status-online"></div>
                          <div className="flex justify-between items-start mb-4">
                            <span className="font-sans text-sm text-on-surface-variant text-left">{t('在线设备', 'Online Devices')}</span>
                            <div className="w-2 h-2 rounded-full bg-status-online mt-1 animate-pulse shrink-0"></div>
                          </div>
                          <div className="text-left">
                            <span className="font-mono text-2xl font-bold text-on-surface">
                              {devices.filter(d => d.status === 'online').length}
                            </span>
                            <span className="font-sans text-sm text-on-surface-variant ml-1">{t('在线', 'Online')}</span>
                          </div>
                        </div>

                        {/* Stat 3: Total Traffic */}
                        <div className="bg-white border border-border-subtle rounded p-5 flex flex-col justify-between border-t-2 border-t-primary-container shadow-sm">
                          <div className="flex justify-between items-start mb-4">
                            <span className="font-sans text-sm text-on-surface-variant text-left">{t('累计总流量', 'Cumulative Traffic')}</span>
                            <Network className="w-5 h-5 text-primary-container shrink-0" />
                          </div>
                          <div className="flex justify-between items-end">
                            <span className="font-mono text-2xl font-bold text-on-surface line-clamp-1">{totals.total}</span>
                            <div className="flex flex-col text-right font-mono text-[11px] gap-0.5">
                              <span className="text-status-warning flex items-center justify-end gap-1 font-semibold">
                                <ArrowUp className="w-3 h-3 text-status-warning shrink-0" /> {totals.upload} {t('上传', 'Up')}
                              </span>
                              <span className="text-status-online flex items-center justify-end gap-1 font-semibold">
                                <ArrowDown className="w-3 h-3 text-status-online shrink-0" /> {totals.download} {t('下载', 'Down')}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Data Table Section */}
                      <div className="mt-8 flex flex-col gap-4">
                        <div className="flex justify-between items-center">
                          <h3 className="font-headline font-semibold text-lg text-on-surface">{t('设备列表', 'Device List')}</h3>
                        </div>
                        <div className="bg-white border border-border-subtle rounded overflow-hidden shadow-sm">
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="border-b border-border-subtle bg-surface-container-low font-sans text-xs text-on-surface-variant uppercase tracking-wider font-semibold">
                                <th className="py-3 px-4 font-medium">{t('状态', 'Status')}</th>
                                <th className="py-3 px-4 font-medium">{t('主机名', 'Hostname')}</th>
                                <th className="py-3 px-4 font-medium hidden md:table-cell">{t('操作系统 / 架构', 'OS / Architecture')}</th>
                                <th className="py-3 px-4 font-medium text-right">{t('实时速率 (上传/下载)', 'Rate (Up/Down)')}</th>
                                <th className="py-3 px-4 font-medium text-right">{t('累计流量', 'Cumulative Traffic')}</th>
                              </tr>
                            </thead>
                            <tbody className="font-sans text-sm">
                              {devices.map((device) => {
                                const isOnline = device.status === 'online';
                                return (
                                  <tr key={device.id} className="border-b border-border-subtle hover:bg-slate-50/50 transition-colors">
                                    <td className="py-3 px-4">
                                      {isOnline ? (
                                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-container text-status-online font-mono text-xs font-semibold">
                                          <span className="w-1.5 h-1.5 rounded-full bg-status-online"></span>
                                          {t('在线', 'Online')}
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-error-container text-on-error-container font-mono text-xs font-semibold">
                                          <span className="w-1.5 h-1.5 rounded-full bg-status-offline"></span>
                                          {t('离线', 'Offline')}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-3 px-4 font-mono text-xs font-bold text-on-surface">
                                      {formatDeviceDisplayName(device)}
                                    </td>
                                    <td className="py-3 px-4 text-on-surface-variant font-mono text-[11px] hidden md:table-cell">
                                      <span className="capitalize">{device.os}</span>/{device.arch || 'amd64'}
                                    </td>
                                    <td className="py-3 px-4 text-right font-mono text-xs">
                                      {isOnline ? (
                                        <>
                                          <span className="text-status-warning font-semibold">{device.uploadRate || '0.0 KB/s'}</span>{' '}
                                          <span className="text-on-surface-variant">/</span>{' '}
                                          <span className="text-status-online font-semibold">{device.downloadRate || '0.0 KB/s'}</span>
                                        </>
                                      ) : (
                                        <span className="text-outline">0 B/s / 0 B/s</span>
                                      )}
                                    </td>
                                    <td className="py-3 px-4 text-right">
                                      <div className="flex justify-end font-mono text-xs font-bold text-on-surface">
                                        {device.totalTraffic || '0 B'}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* VIEW B: 设备管理 - FRP-ALL-IN-ONE */}
                  {currentScreen === Screen.DEVICE_MANAGEMENT && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col gap-6"
                    >
                      {/* Page Header */}
                      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <h2 className="font-headline-lg text-headline-lg text-on-surface">
                            {t('设备管理', 'Device Management')}
                          </h2>
                          <p className="font-body-md text-body-md text-on-surface-variant mt-1">
                            {t('管理连接的节点、监控状态并配置隧道。', 'Manage connected nodes, monitor live status, and configure tunnels.')}
                          </p>
                        </div>
                        <div className="flex gap-3">
                          <div className="relative" id="filter-dropdown-container">
                            <button 
                              onClick={() => setFilterMenuOpen(!filterMenuOpen)}
                              className="bg-white border border-[#E2E8F0] text-on-surface hover:bg-slate-50 font-label-md text-label-md py-2.5 px-4 rounded flex items-center gap-2 shadow-sm transition-all cursor-pointer font-sans"
                            >
                              <Filter className="w-4 h-4 text-[#006a60]" />
                              {t('过滤', 'Filter')}
                            </button>
                            
                            {filterMenuOpen && (
                              <div className="absolute right-0 mt-2 w-64 bg-white border border-outline-variant rounded-lg shadow-xl z-50 overflow-hidden text-left">
                                <div className="p-3 border-b border-[#E2E8F0]">
                                  <p className="font-label-sm text-[11px] text-on-surface-variant uppercase tracking-wider mb-2 font-mono">
                                    {t('操作系统', 'OS Platforms')}
                                  </p>
                                  <div className="space-y-2">
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={osFilter.linux}
                                        onChange={(e) => setOsFilter(p => ({ ...p, linux: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">Linux</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={osFilter.windows}
                                        onChange={(e) => setOsFilter(p => ({ ...p, windows: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">Windows</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={osFilter.macos}
                                        onChange={(e) => setOsFilter(p => ({ ...p, macos: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">macOS</span>
                                    </label>
                                  </div>
                                </div>
                                <div className="p-3 border-b border-[#E2E8F0]">
                                  <p className="font-label-sm text-[11px] text-on-surface-variant uppercase tracking-wider mb-2 font-mono">
                                    {t('架构', 'Processor Arch')}
                                  </p>
                                  <div className="space-y-2">
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={archFilter.x86_64}
                                        onChange={(e) => setArchFilter(p => ({ ...p, x86_64: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">x86_64 / amd64</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={archFilter.arm64}
                                        onChange={(e) => setArchFilter(p => ({ ...p, arm64: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">arm64 / Apple IoT</span>
                                    </label>
                                  </div>
                                </div>
                                <div className="p-3">
                                  <p className="font-label-sm text-[11px] text-on-surface-variant uppercase tracking-wider mb-2 font-mono">
                                    {t('在线状态', 'Online Status')}
                                  </p>
                                  <div className="space-y-2">
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={statusFilter.online}
                                        onChange={(e) => setStatusFilter(p => ({ ...p, online: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">{t('在线', 'Online')}</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer group select-none">
                                      <input 
                                        type="checkbox"
                                        checked={statusFilter.offline}
                                        onChange={(e) => setStatusFilter(p => ({ ...p, offline: e.target.checked }))}
                                        className="rounded border-[#bcc8cf] text-primary focus:ring-primary-container w-4 h-4 cursor-pointer"
                                      />
                                      <span className="text-body-md text-on-surface">{t('离线', 'Offline')}</span>
                                    </label>
                                  </div>
                                </div>
                                <div className="p-2 bg-[#f2f4f6] flex justify-end gap-2">
                                  <button 
                                    onClick={handleResetFilters}
                                    className="px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer font-sans"
                                  >
                                    {t('重置', 'Reset')}
                                  </button>
                                  <button 
                                    onClick={() => setFilterMenuOpen(false)}
                                    className="px-3 py-1.5 bg-[#006782] hover:bg-[#008ba6] text-white rounded text-xs font-semibold cursor-pointer font-sans shadow-sm"
                                  >
                                    {t('应用', 'Apply')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                          
                          <button
                            onClick={() => changeScreen(Screen.ADD_DEVICE, 'slide_up')}
                            className="bg-primary-container hover:bg-primary font-label-md text-label-md py-2 px-4 rounded text-white flex items-center gap-2 shadow-sm cursor-pointer font-sans transition-all"
                          >
                            <Plus className="w-4 h-4" />
                            {t('添加新设备', 'Add New Device')}
                          </button>
                        </div>
                      </header>

                      {/* Stats Overview Bento Grid */}
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-body-md text-body-md text-on-surface-variant font-medium select-none">{t('活跃设备', 'Active Devices')}</span>
                            <HardDrive className="text-status-online w-5 h-5 shrink-0" />
                          </div>
                          <div className="font-headline-md text-headline-md text-on-surface font-black text-left">
                            {devices.filter(d => d.status === 'online').length}
                          </div>
                        </div>
                        
                        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-body-md text-body-md text-on-surface-variant font-medium select-none">{t('离线设备', 'Offline Devices')}</span>
                            <AlertTriangle className="text-status-offline w-5 h-5 shrink-0" />
                          </div>
                          <div className="font-headline-md text-headline-md text-on-surface font-black text-left">
                            {devices.filter(d => d.status === 'offline').length}
                          </div>
                        </div>
                        
                        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-body-md text-body-md text-on-surface-variant font-medium select-none">{t('隧道总数', 'Total Tunnels')}</span>
                            <Radio className="text-[#006782] w-5 h-5 shrink-0 animate-pulse-slow" />
                          </div>
                          <div className="font-headline-md text-headline-md text-on-surface font-black text-left">
                            {tunnels.length}
                          </div>
                        </div>
                        
                        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-body-md text-body-md text-on-surface-variant font-medium select-none">{t('活跃连接', 'Active Connections')}</span>
                            <Activity className="text-[#00add5] w-5 h-5 shrink-0" />
                          </div>
                          <div className="font-headline-md text-headline-md text-on-surface font-black text-left">
                            {tunnels.filter(t => t.status === 'online').length}/{tunnels.length}
                          </div>
                        </div>
                      </div>

                      {/* Main Device Table Container */}
                      <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden flex flex-col shadow-sm">
                        {/* Search / Action Bar */}
                        <div className="p-4 border-b border-[#E2E8F0] bg-slate-50/50 flex flex-col sm:flex-row justify-between gap-4">
                          <div className="relative w-full sm:max-w-md">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-outline w-4 h-4 shrink-0" />
                            <input
                              value={deviceSearchQuery}
                              onChange={(e) => setDeviceSearchQuery(e.target.value)}
                              className="w-full bg-white border border-[#E2E8F0] rounded pl-10 pr-10 py-2 font-body-md text-body-md focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container transition-all text-on-surface font-sans"
                              placeholder={t('搜索主机名、IP 或操作系统...', 'Search hostname, IP platform, OS architecture...')}
                              type="text"
                            />
                            {deviceSearchQuery && (
                              <button 
                                onClick={() => setDeviceSearchQuery('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface p-0.5 rounded cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setDeviceSearchQuery('');
                                loadDashboardData();
                                triggerToast(t('客户端心跳映射数据已刷新', 'FRP client registry synchronized!'), 'success');
                              }}
                              className="p-2 border border-[#E2E8F0] rounded bg-white hover:bg-slate-50 transition-colors cursor-pointer"
                              title={t('刷新列表', 'Sync Devices')}
                            >
                              <RefreshCw className="w-4 h-4 text-on-surface-variant" />
                            </button>
                          </div>
                        </div>

                        {/* Table Wrapper */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="bg-slate-50 border-b border-[#E2E8F0] select-none">
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider w-16 text-center">
                                  {t('状态', 'Status')}
                                </th>
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider">
                                  {t('主机名 / 标识', 'Hostname / Agent ID')}
                                </th>
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider hidden md:table-cell">
                                  {t('操作系统 / 架构', 'Operating System / Arch')}
                                </th>
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider hidden lg:table-cell">
                                  {t('资源监控', 'Resources')}
                                </th>
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider hidden sm:table-cell">
                                  {t('最后心跳时间', 'Last Seen Alive')}
                                </th>
                                <th className="py-3 px-4 font-label-md text-[11px] text-on-surface-variant font-semibold uppercase tracking-wider text-right w-36">
                                  {t('管理控制', 'Control Actions')}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="font-body-md text-body-md">
                              {filteredDevices.length === 0 ? (
                                <tr>
                                  <td colSpan={6} className="py-12 text-center text-on-surface-variant">
                                    <div className="flex flex-col items-center justify-center gap-2">
                                      <Info className="w-8 h-8 text-outline animate-bounce-slow" />
                                      <p className="text-sm font-medium">{t('未找到符合过滤条件的客户端连接设备。', 'No client nodes match your exact filter configuration.')}</p>
                                      <button 
                                        onClick={handleResetFilters}
                                        className="text-xs bg-slate-100 hover:bg-slate-200 text-on-surface font-semibold px-3 py-1.5 rounded mt-1.5 transition-all cursor-pointer font-sans"
                                      >
                                        {t('清除所有过滤条件', 'Clear Filter Configurations')}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ) : (
                                pagedDevices.map((device) => {
                                  const isDeviceOnline = device.status === 'online';
                                  const isExpanded = !!expandedDeviceIds[device.id];
                                  const deviceTunnels = tunnels.filter(t => t.deviceId === device.id);

                                  return (
                                    <React.Fragment key={device.id}>
                                      {/* Main Row */}
                                      <tr 
                                        onClick={() => toggleDeviceExpanded(device.id)}
                                        className={`border-b border-[#E2E8F0] hover:bg-slate-50/70 transition-colors group cursor-pointer select-none ${isExpanded ? 'bg-slate-50/40' : ''}`}
                                      >
                                        <td className="py-4 px-4 text-center">
                                          <div className="flex justify-center items-center">
                                            <div 
                                              className={`w-2.5 h-2.5 rounded-full ${isDeviceOnline ? 'bg-status-online status-pulse' : 'bg-status-offline'}`}
                                              style={{ boxShadow: isDeviceOnline ? '0 0 6px #10B981' : 'none' }}
                                              title={isDeviceOnline ? t('在线', 'Online') : t('离线', 'Offline')}
                                            ></div>
                                          </div>
                                        </td>
                                        
                                        <td className="py-4 px-4">
                                          <div className="font-mono text-xs font-semibold text-[#1e293b] flex items-center gap-2">
                                            <span>{formatDeviceDisplayName(device)}</span>
                                            {device.hasUpdate && (
                                              <span
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setUpgradeTargetDevice(device);
                                                }}
                                                className="text-[9px] bg-amber-50 text-amber-700 border border-amber-300 px-1.5 py-0.5 rounded font-mono font-semibold flex items-center gap-1 cursor-pointer hover:bg-amber-100 transition-colors"
                                                title={t('客户端版本可升级，点击查看升级方式', 'Client update available, click to view')}
                                              >
                                                <Sparkles className="w-2.5 h-2.5 text-amber-600 shrink-0" />
                                                {t('可升级', 'Update')}
                                              </span>
                                            )}
                                            <ChevronRight className={`w-3.5 h-3.5 text-outline group-hover:text-primary transition-all shrink-0 ${isExpanded ? 'rotate-90 text-primary' : ''}`} />
                                          </div>
                                          <div className="font-mono text-[10px] text-outline mt-0.5 flex items-center gap-2">
                                            <span>IP: {device.ip}</span>
                                            <span>·</span>
                                            <span>Agent: {device.agentInfo?.agent_version ? `v${device.agentInfo.agent_version}` : 'v3.0.0'}</span>
                                          </div>
                                          <div className="font-mono text-[10px] text-outline mt-0.5 md:hidden">
                                            CPU {device.cpuUsage}% · MEM {device.memUsage}% · DISK {Math.round(device.agentInfo?.disk_percent || 0)}%
                                          </div>
                                        </td>
                                        
                                        <td className="py-4 px-4 hidden md:table-cell text-on-surface-variant font-mono text-xs capitalize">
                                          {device.os} {device.arch ? `(${device.arch})` : '(x86_64)'}
                                        </td>
                                        
                                        <td className="py-4 px-4 hidden lg:table-cell">
                                          <div className="flex flex-col gap-1.5 min-w-[140px]">
                                            <div className="flex items-center gap-2">
                                              <span className="text-[10px] text-outline w-7 shrink-0">CPU</span>
                                              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                <div className={`h-full rounded-full transition-all ${device.cpuUsage > 80 ? 'bg-red-500' : device.cpuUsage > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(device.cpuUsage, 100)}%` }} />
                                              </div>
                                              <span className="text-[10px] text-outline w-7 text-right shrink-0">{device.cpuUsage}%</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                              <span className="text-[10px] text-outline w-7 shrink-0">MEM</span>
                                              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                <div className={`h-full rounded-full transition-all ${device.memUsage > 80 ? 'bg-red-500' : device.memUsage > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(device.memUsage, 100)}%` }} />
                                              </div>
                                              <span className="text-[10px] text-outline w-7 text-right shrink-0">{device.memUsage}%</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                              <span className="text-[10px] text-outline w-7 shrink-0">DISK</span>
                                              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                                <div className={`h-full rounded-full transition-all ${(device.agentInfo?.disk_percent || 0) > 80 ? 'bg-red-500' : (device.agentInfo?.disk_percent || 0) > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(device.agentInfo?.disk_percent || 0, 100)}%` }} />
                                              </div>
                                              <span className="text-[10px] text-outline w-7 text-right shrink-0">{Math.round(device.agentInfo?.disk_percent || 0)}%</span>
                                            </div>
                                          </div>
                                        </td>
                                        
                                        <td className="py-4 px-4 hidden sm:table-cell text-on-surface-variant font-mono text-xs whitespace-nowrap">
                                          {isDeviceOnline ? t('刚刚', 'Just Now') : device.lastSeen}
                                        </td>
                                        
                                        <td className="py-4 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                                          <div className="flex justify-end gap-1.5">
                                            {device.hasUpdate && (
                                              <button
                                                onClick={() => setUpgradeTargetDevice(device)}
                                                className="p-1 px-1.5 text-amber-600 hover:text-amber-700 rounded hover:bg-amber-50 transition-colors cursor-pointer"
                                                title={t('升级此客户端 Agent', 'Upgrade Client Agent')}
                                              >
                                                <ArrowUpCircle className="w-3.5 h-3.5" />
                                              </button>
                                            )}
                                            <button
                                              onClick={() => {
                                                setLogModalDevice(device);
                                                setLogModalOpen(true);
                                                triggerToast(t(`已成功开启设备 '${device.name}' 的实时日志流监视器`, `Successfully connected log stream monitor for '${device.name}'`), 'success');
                                              }}
                                              className="p-1 px-1.5 text-outline hover:text-primary rounded hover:bg-slate-100 transition-colors cursor-pointer"
                                              title={t('查阅底层日志', 'Fetch Terminal Journals')}
                                            >
                                              <Terminal className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                              onClick={() => handleEditDeviceName(device)}
                                              className="p-1 px-1.5 text-outline hover:text-primary rounded hover:bg-slate-100 transition-colors cursor-pointer"
                                              title={t('修改设备备注', 'Edit Device Remark')}
                                            >
                                              <Sliders className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                              onClick={() => {
                                                showConfirm({
                                                  title: t('注销设备确认', 'Unregister Device'),
                                                  message: t(
                                                    `确定注销设备 '${device.name}' 及其所有隧道吗？\n\n此操作将从管理面板中移除记录，但不会卸载远端容器；如需彻底清理，请在客户端机器另行执行卸载命令。`,
                                                    `Unregister '${device.name}' and all its tunnels?\n\nThis removes the record from the panel but does not uninstall the remote container.`
                                                  ),
                                                  confirmText: t('确认注销', 'Confirm Unregister'),
                                                  confirmType: 'danger',
                                                  onConfirm: () => {
                                                    handleDeleteDevice(device.id, device.name);
                                                  }
                                                });
                                              }}
                                              className="p-1 px-1.5 text-outline hover:text-status-offline rounded hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
                                              title={t('注销设备（不卸载远端容器）', 'Unregister device (keeps remote container)')}
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </td>
                                      </tr>

                                      {/* Sub Accordion Tunnel mapping area */}
                                      {isExpanded && (
                                        <tr className="bg-slate-50/35 border-b border-[#E2E8F0]">
                                          <td className="p-0 border-l-4 border-l-primary" colSpan={6}>
                                            <div className="p-5">
                                              <div className="flex justify-between items-center mb-4 select-none">
                                                <h4 className="font-headline font-semibold text-xs uppercase tracking-wider text-on-surface flex items-center gap-1.5">
                                                  <Radio className="w-4 h-4 text-[#006782]" />
                                                  {t('活跃穿透隧道映射列表 (Mapped FRP Ports)', 'Forwarded Port Sub-Tunnels')}
                                                  <span className="bg-slate-100 px-2 py-0.5 rounded-full text-[#006a60] text-[10px] font-bold">
                                                    {deviceTunnels.length}
                                                  </span>
                                                </h4>
                                                <button
                                                  onClick={() => {
                                                    const targetIp = (device.ip && device.ip !== '未知') ? device.ip : '127.0.0.1';
                                                    setNewTunnelData(p => ({
                                                      ...p,
                                                      deviceId: device.id,
                                                      localIp: targetIp,
                                                      localPort: '',
                                                      remotePort: '',
                                                    }));
                                                    setAddTunnelModalOpen(true);
                                                  }}
                                                  className="bg-white hover:bg-slate-50 border border-[#E2E8F0] hover:border-slate-300 text-primary font-semibold text-[11px] py-1.5 px-3 rounded flex items-center gap-1 transition-colors cursor-pointer font-sans shadow-sm"
                                                >
                                                  <Plus className="w-3.5 h-3.5" />
                                                  {t('绑定新增子隧道', 'Mount Sub-Tunnel')}
                                                </button>
                                              </div>

                                              {deviceTunnels.length === 0 ? (
                                                <div className="bg-white border border-[#E2E8F0] rounded p-6 text-center text-xs font-mono text-outline">
                                                  {t('暂无关联端口隧道，点击上方按钮 “绑定新增子隧道” 可快速新增穿透映射。', 'No sub-tunnels configured. Mount a map channel above to tunnel local servers.')}
                                                </div>
                                              ) : (
                                                <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-sm">
                                                  <table className="w-full text-left text-sm border-collapse">
                                                    <thead className="bg-slate-50 border-b border-[#E2E8F0] select-none">
                                                      <tr>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono">
                                                          {t('服务通道', 'Sub-Tunnel Name')}
                                                        </th>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono">
                                                          {t('映射类型', 'Channel Type')}
                                                        </th>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono">
                                                          {t('本地端口', 'Local Port')}
                                                        </th>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono">
                                                          {t('远程地址', 'Remote Address')}
                                                        </th>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono text-right w-48 whitespace-nowrap">
                                                          {t('流量 (进/出)', 'Traffic (In/Out)')}
                                                        </th>
                                                        <th className="py-2 px-3 font-label-md text-[10px] text-outline font-semibold uppercase font-mono text-center w-24">
                                                          {t('控制', 'Actions')}
                                                        </th>
                                                      </tr>
                                                    </thead>
                                                    <tbody className="font-mono text-xs text-on-surface-variant">
                                                      {deviceTunnels.map((tunnel) => {
                                                        const isTunnelOnline = tunnel.status === 'online';

                                                        return (
                                                          <tr 
                                                            key={tunnel.id} 
                                                            className="border-b border-[#E2E8F0] hover:bg-slate-50/50 last:border-0 transition-all font-mono"
                                                          >
                                                            <td className="py-2 px-3 hover:text-primary transition-colors text-on-surface font-semibold text-xs">
                                                              {tunnel.name}
                                                            </td>
                                                            <td className="py-2 px-3">
                                                              <span className={`px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase border ${
                                                                tunnel.type === 'http' || tunnel.type === 'https'
                                                                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                                                                  : 'bg-purple-50 text-purple-700 border-purple-200'
                                                              }`}>
                                                                {tunnel.type}
                                                              </span>
                                                            </td>
                                                            <td className="py-2 px-3 text-xs text-on-surface-variant">
                                                              {tunnel.localPort}
                                                            </td>
                                                            <td className="py-2 px-3 text-xs font-semibold text-[#006782]">
                                                              {serverConfig.mode === 'domain' && serverConfig.domain
                                                                ? `${serverConfig.domain}:${tunnel.remotePort}`
                                                                : `${serverConfig.ip}:${tunnel.remotePort}`}
                                                            </td>
                                                            <td className="py-2 px-3 text-right whitespace-nowrap">
                                                              <div className="flex items-center justify-end gap-2 text-xs whitespace-nowrap">
                                                                <span className="flex items-center text-[#10B981] font-bold whitespace-nowrap" title={t('下行传输量', 'Incoming Bandwidth')}>
                                                                  <ArrowDown className="w-3 h-3 mr-0.5 shrink-0" />
                                                                  {tunnel.trafficIn}
                                                                </span>
                                                                <span className="flex items-center text-primary-container font-bold whitespace-nowrap" title={t('上行接收量', 'Outgoing Bandwidth')}>
                                                                  <ArrowUp className="w-3 h-3 mr-0.5 shrink-0" />
                                                                  {tunnel.trafficOut}
                                                                </span>
                                                              </div>
                                                            </td>
                                                            <td className="py-2 px-3">
                                                              <div className="flex items-center justify-center gap-1.5" onClick={(ex) => ex.stopPropagation()}>
                                                                <button
                                                                  onClick={() => toggleTunnelStatus(tunnel.id)}
                                                                  className={`p-1 rounded hover:bg-slate-100 transition-colors cursor-pointer ${isTunnelOnline ? 'text-status-online hover:bg-green-50' : 'text-slate-400 hover:bg-slate-100'}`}
                                                                  title={isTunnelOnline ? t('停用此隧道', 'Deactivate Mapping') : t('启用此隧道', 'Activate Tunnel')}
                                                                >
                                                                  {isTunnelOnline ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
                                                                </button>
                                                                <button
                                                                  onClick={() => {
                                                                    showConfirm({
                                                                      title: t('删除隧道确认', 'Delete Tunnel'),
                                                                      message: t(
                                                                        `确定删除穿透映射隧道 '${tunnel.name}' 吗？\n\n删除后该端口映射将立即在客户端与服务端注销关闭。`,
                                                                        `Are you sure you want to delete tunnel '${tunnel.name}'?\n\nThe port mapping will be closed immediately.`
                                                                      ),
                                                                      confirmText: t('确认删除', 'Confirm Delete'),
                                                                      confirmType: 'danger',
                                                                      onConfirm: () => {
                                                                        handleDeleteTunnel(tunnel.id, tunnel.name);
                                                                      }
                                                                    });
                                                                  }}
                                                                  className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                                                                  title={t('释放此子映射端口', 'Delete mapping')}
                                                                >
                                                                  <Trash2 className="w-3 h-3" />
                                                                </button>
                                                              </div>
                                                            </td>
                                                          </tr>
                                                        );
                                                      })}
                                                    </tbody>
                                                  </table>
                                                </div>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      )}
                                    </React.Fragment>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Footer */}
                        {filteredDevices.length > 0 && (
                        <div className="p-4 border-t border-[#E2E8F0] bg-white flex flex-col sm:flex-row justify-between items-center gap-3 text-xs font-semibold select-none">
                          <span className="text-on-surface-variant font-sans">
                            {t(
                              `显示第 ${(safeCurrentPage - 1) * ITEMS_PER_PAGE + 1} 至 ${Math.min(safeCurrentPage * ITEMS_PER_PAGE, filteredDevices.length)} 项，共 ${filteredDevices.length} 个设备`,
                              `Displaying ${(safeCurrentPage - 1) * ITEMS_PER_PAGE + 1} to ${Math.min(safeCurrentPage * ITEMS_PER_PAGE, filteredDevices.length)} of ${filteredDevices.length} registered terminal nodes`
                            )}
                          </span>
                          <div className="flex gap-1">
                            <button
                              disabled={safeCurrentPage <= 1}
                              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                              className="px-3 py-1.5 border border-[#E2E8F0] rounded text-on-surface hover:bg-slate-50 transition-colors cursor-pointer font-sans disabled:opacity-40 disabled:cursor-not-allowed bg-white"
                            >
                              {t('上一页', 'Prev')}
                            </button>
                            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                              <button
                                key={page}
                                onClick={() => setCurrentPage(page)}
                                className={`px-3.5 py-1.5 border rounded font-sans transition-colors cursor-pointer ${
                                  page === safeCurrentPage
                                    ? 'border-[#006782] bg-[#006782] text-white font-bold'
                                    : 'border-[#E2E8F0] text-on-surface hover:bg-slate-50 bg-white'
                                }`}
                              >
                                {page}
                              </button>
                            ))}
                            <button
                              disabled={safeCurrentPage >= totalPages}
                              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                              className="px-3 py-1.5 border border-[#E2E8F0] rounded text-on-surface hover:bg-slate-50 transition-colors cursor-pointer font-sans disabled:opacity-40 disabled:cursor-not-allowed bg-white"
                            >
                              {t('下一页', 'Next')}
                            </button>
                          </div>
                        </div>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* VIEW C: 系统设置 - FRP-ALL-IN-ONE */}
                  {currentScreen === Screen.SETTINGS && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col gap-6 text-left"
                    >
                      {/* Header */}
                      <header className="pb-6 border-b border-border-subtle bg-white -mx-6 -mt-6 px-6 py-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
                        <div>
                          <h2 className="font-headline-lg text-headline-lg text-on-surface mb-1">
                            {t('系统设置', 'System Settings')}
                          </h2>
                          <p className="font-body-md text-body-md text-on-surface-variant">
                            {t('配置 FRP 核心、网络路由和安全参数。', 'Configure FRP core, network routing, and security parameters.')}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={handleDiscardSettings}
                            className="px-4 py-2 border border-outline-variant text-on-surface-variant hover:bg-slate-50 hover:text-on-surface rounded font-label-md text-label-md transition-colors bg-white cursor-pointer shadow-sm"
                          >
                            {t('放弃修改', 'Discard Changes')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveSettings()}
                            className="px-4 py-2 bg-[#006782] hover:bg-[#005066] text-white rounded font-label-md text-label-md transition-colors shadow-sm flex items-center gap-2 cursor-pointer font-bold"
                          >
                            <Save className="w-4 h-4" />
                            {t('保存配置', 'Save Config')}
                          </button>
                        </div>
                      </header>

                      {/* Settings Content Grid */}
                      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 lg:gap-8 items-start">
                        {/* Left Column (Domain & NAT) */}
                        <div className="xl:col-span-2 space-y-6 lg:space-y-8">
                          
                          {/* 可选高级设置，不进入基础 TCP/UDP 部署流程 */}
                          <details className="bg-white border border-border-subtle rounded-xl overflow-hidden relative shadow-sm">
                            <summary className="p-6 border-b border-border-subtle bg-slate-50 cursor-pointer">
                              <div className="flex items-center gap-3 mb-2">
                                <Globe className="w-5 h-5 text-[#006782] shrink-0" />
                                <h3 className="font-headline font-semibold text-base text-on-surface">
                                  {t('域名与 HTTPS（可选高级设置）', 'Domain and HTTPS (optional advanced settings)')}
                                </h3>
                              </div>
                              <p className="font-body-md text-xs text-on-surface-variant">
                                {t('仅用于管理面板域名与证书，不会自动为所有穿透服务申请证书。', 'Panel domain and certificate only; this does not issue certificates for every tunneled service.')}
                              </p>
                            </summary>
                            
                            <div className="p-6 space-y-6">
                              <p className="text-xs leading-relaxed p-3 rounded bg-amber-50 text-amber-900">
                                {t('大陆服务器提供网站服务时，请先按接入商和主管部门要求办理 ICP 备案等手续。要求不因 HTTP/HTTPS、IP 访问或更换端口而当然豁免；证书不能替代备案。未准备好时保留基础配置，并通过防火墙限制面板来源。', 'For websites hosted in mainland China, meet applicable ICP filing and hosting requirements. HTTP/HTTPS, IP access or alternate ports are not automatic exemptions. Certificates do not replace filing. Restrict panel access while preparing.')}
                                {' '}<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="underline">{t('工信部备案系统', 'MIIT filing portal')}</a>
                              </p>
                              {/* Domain Name */}
                              <div>
                                <label className="block font-label-md text-xs text-on-surface mb-2 font-semibold">
                                  {t('管理面板完整域名', 'Full panel hostname')}
                                </label>
                                <div className="flex rounded shadow-sm">
                                  <input
                                    type="text"
                                    value={tempDomain}
                                    onChange={(e) => setTempDomain(e.target.value)}
                                    className="flex-1 block w-full rounded text-sm border border-outline-variant focus:ring-1 focus:ring-primary focus:border-primary bg-white py-2 px-3 text-on-surface font-mono"
                                    placeholder="frp.example.com"
                                  />
                                </div>
                                <p className="mt-2 text-xs text-on-surface-variant font-sans flex items-center gap-1.5 opacity-80 select-none">
                                  <Info className="w-3.5 h-3.5 text-status-warning shrink-0" />
                                  <span>{t('请确保您的 DNS 提供商具有指向此服务器 IP 的 A 记录。', 'Please make sure your DNS provider has an A record pointing to this server IP.')}</span>
                                </p>
                              </div>
                              
                              <hr className="border-border-subtle" />
                              
                              {/* Auto HTTPS Toggle */}
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <label className="block font-label-md text-xs text-on-surface mb-1 font-semibold">
                                    {t('启用自动 HTTPS (Let\'s Encrypt)', 'Enable Automated HTTPS (Let\'s Encrypt)')}
                                  </label>
                                  <p className="font-body-md text-xs text-on-surface-variant leading-relaxed">
                                    {t('保存设置时为上方管理面板域名申请证书；需完成适用的备案要求、DNS 解析，并允许 80 端口验证。签发服务的网络可达性由部署环境决定。', 'Saving requests a panel certificate. Meet applicable filing requirements, configure DNS and allow port 80 validation. Certificate service reachability depends on your network.')}
                                  </p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 select-none">
                                  <input
                                    type="checkbox"
                                    checked={enableAutoHttps}
                                    onChange={(e) => setEnableAutoHttps(e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#00add8] transition-colors"></div>
                                </label>
                              </div>
                              
                              {/* DNS Check Status */}
                              <div className="bg-slate-50 p-4 rounded border border-border-subtle flex items-center justify-between gap-4">
                                <div className="flex items-center gap-3">
                                  <div className={`w-2.5 h-2.5 rounded-full ${dnsCheckLoading ? 'bg-amber-400 animate-spin border border-transparent' : 'bg-status-online animate-pulse'}`}></div>
                                  <div>
                                    <p className="font-semibold text-xs text-on-surface">{t('DNS 解析检查', 'DNS Resolution Check')}</p>
                                    <p className="font-mono text-[11px] text-on-surface-variant mt-0.5">
                                      {tempDomain} {t('解析为', 'resolves to')} {serverConfig.ip}
                                    </p>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={handleRunDnsCheck}
                                  disabled={dnsCheckLoading}
                                  className="text-[#006782] hover:text-[#00add8] disabled:opacity-50 font-semibold text-xs uppercase tracking-wider transition-colors cursor-pointer select-none"
                                >
                                  {dnsCheckLoading ? t('正在查询...', 'Resolving...') : t('重新检查', 'Recheck')}
                                </button>
                              </div>
                              
                            </div>
                          </details>

                          {/* Section 2: NAT Configuration */}
                          <section className="bg-white border border-border-subtle rounded-xl overflow-hidden relative shadow-sm">
                            <div className="p-6 border-b border-border-subtle bg-slate-50">
                              <div className="flex items-center gap-3 mb-2">
                                <Network className="w-5 h-5 text-secondary shrink-0" />
                                <h3 className="font-headline font-semibold text-base text-on-surface">
                                  {t('NAT 配置', 'NAT Configuration')}
                                </h3>
                              </div>
                              <p className="font-body-md text-xs text-on-surface-variant">
                                {t('如果在严格的 NAT 或防火墙后面运行，请管理外部端口映射。', 'Manage external port mapping schemes while running behind a strict NAT router.')}
                              </p>
                            </div>
                            
                            <div className="p-6 space-y-6">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div>
                                  <label className="block font-label-md text-xs text-on-surface mb-2 font-semibold">
                                    {t('管理面板公网端口', 'Dashboard Public Port')}
                                  </label>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={tempDashboardPort}
                                    onChange={(e) => setTempDashboardPort(e.target.value.replace(/[^0-9]/g, ''))}
                                    className="block w-full rounded border border-slate-300 focus:ring-1 focus:ring-secondary focus:border-secondary bg-white text-on-surface font-mono py-2 px-3 text-sm"
                                    placeholder={t('留空表示使用默认端口（8080 或启用 HTTPS 后为 443）', 'Leave empty for default port (8080, or 443 with HTTPS)')}
                                  />
                                  <p className="mt-2 text-xs text-on-surface-variant opacity-85">
                                    {t('NAT 场景下公网映射到本管理面板的外部端口（如 10967 → 内网 8080）。留空表示直连，无需映射。', 'External port mapped to this management panel in NAT scenarios (e.g. 10967 → internal 8080). Leave empty for direct connection.')}
                                  </p>
                                </div>
                                
                                <div>
                                  <label className="block font-label-md text-xs text-on-surface mb-2 font-semibold flex items-center justify-between">
                                    <span>{t('FRP 绑定端口 (TCP)', 'FRP Binding Port (TCP)')}</span>
                                    <Lock className="w-3.5 h-3.5 text-slate-400" />
                                  </label>
                                  <input
                                    type="number"
                                    disabled={true}
                                    value={serverConfig.port}
                                    className="block w-full rounded border border-slate-200 bg-slate-100 text-slate-500 font-mono py-2 px-3 text-sm cursor-not-allowed select-none"
                                    placeholder="7000"
                                  />
                                  <p className="mt-2 text-xs text-slate-400 flex items-center gap-1 select-none">
                                    <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                                    <span>{t('主大网桥绑定端点在正常生命周期中无法被更改。', 'The primary daemon listener port cannot be changed while active.')}</span>
                                  </p>
                                </div>
                              </div>
                            </div>
                          </section>
                        </div>

                        {/* Right Column (Security & SysInfo) */}
                        <div className="space-y-6 lg:space-y-8">
                          
                          {/* Section 3: Account Security */}
                          <section className="bg-white border border-border-subtle rounded-xl overflow-hidden shadow-sm">
                            <div className="p-5 border-b border-border-subtle bg-slate-50">
                              <div className="flex items-center gap-3">
                                <Shield className="w-5 h-5 text-[#9134a7] shrink-0" />
                                <h3 className="font-headline font-semibold text-sm text-on-surface">
                                  {t('账户安全', 'Account Security')}
                                </h3>
                              </div>
                            </div>
                            
                            <div className="p-5">
                              <div className="bg-slate-50 p-4 border border-border-subtle rounded-lg">
                                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2 select-none">
                                  {t('当前关联的 GITHUB 账号', 'CURRENT ASSOCIATED GITHUB ID')}
                                </label>
                                <div className="flex items-center gap-3">
                                  {userProfile?.avatar_url ? (
                                    <img src={userProfile.avatar_url} alt="avatar" className="w-10 h-10 rounded-full shrink-0" />
                                  ) : (
                                    <div className="w-10 h-10 rounded-full bg-[#24292F] flex items-center justify-center text-white shrink-0 select-none">
                                      <span className="font-bold text-sm">Git</span>
                                    </div>
                                  )}
                                  <div>
                                    <p className="font-bold text-sm text-on-surface leading-none">{userProfile?.github_username || '...'}</p>
                                    <p className="text-xs text-status-online flex items-center gap-1 mt-1 font-semibold select-none">
                                      <Check className="w-3.5 h-3.5" />
                                      {t('已授权全部控制链', 'Verified access token')}
                                    </p>
                                  </div>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => authApi.rebindGithub()}
                                className="w-full mt-2 px-4 py-2.5 bg-[#24292F] hover:bg-black text-white rounded font-semibold text-xs transition-colors flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                              >
                                <Code className="w-4 h-4 text-white" />
                                {t('关联其他 GitHub 账号', 'Associate Different GitHub Profile')}
                              </button>
                            </div>
                          </section>

                          {/* Section 4: System Info */}
                          <section className="bg-[#24292F] text-white border border-[#24292F] rounded-xl overflow-hidden shadow-sm">
                            <div className="p-5 border-b border-white/10">
                              <div className="flex items-center gap-3">
                                <Terminal className="w-5 h-5 text-cyan-400 shrink-0" />
                                <h3 className="font-headline font-semibold text-sm text-white">
                                  {t('系统核心与版本信息', 'System Info & Daemon Details')}
                                </h3>
                              </div>
                            </div>
                            
                            <div className="p-5 space-y-4 font-mono text-xs text-slate-300 text-left">
                              <div className="flex justify-between items-center pb-3 border-b border-white/10 select-none">
                                <span className="text-slate-400">{t('版本', 'Version')}</span>
                                <span className="text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded text-[11px] font-bold">
                                  {APP_VERSION_DISPLAY}
                                </span>
                              </div>

                              <div className="flex justify-between items-center pb-3 border-b border-white/10">
                                <span className="text-slate-400">{t('数据库路径', 'Database File')}</span>
                                <span
                                  className="text-slate-200 select-all cursor-pointer font-semibold truncate max-w-[200px]"
                                  title={systemInfo?.database_path || ''}
                                  onClick={() => systemInfo?.database_path && handleCopyText(systemInfo.database_path)}
                                >
                                  {systemInfo?.database_path ? (systemInfo.database_path.length > 25 ? '...' + systemInfo.database_path.slice(-22) : systemInfo.database_path) : '...'}
                                </span>
                              </div>

                              <div className="flex justify-between items-center pb-3 border-b border-white/10 select-none">
                                <span className="text-slate-400">{t('数据库大小', 'Database Size')}</span>
                                <span className="text-slate-200 font-semibold">{systemInfo?.database_size || '-'}</span>
                              </div>

                              <div className="flex justify-between items-center pb-3 border-b border-white/10 select-none">
                                <span className="text-slate-400">{t('累计运行时间', 'Node Uptime')}</span>
                                <span className="text-slate-200 font-semibold">{systemInfo?.uptime_display || '-'}</span>
                              </div>

                              <div className="flex justify-between items-center pb-3 border-b border-white/10 select-none">
                                <span className="text-slate-400">{t('启动时间', 'Start Time')}</span>
                                <span className="text-slate-200 font-semibold">{systemInfo?.start_time || '-'}</span>
                              </div>

                              <div className="flex gap-2 mt-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setUpdateModalOpen(true);
                                    checkSystemUpdate(true);
                                  }}
                                  className="flex-1 px-4 py-2 bg-primary hover:bg-[#005166] text-white rounded font-bold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer select-none shadow-sm"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${checkUpdateLoading ? 'animate-spin' : ''}`} />
                                  {t('在线检查新版本', 'Check for Updates')}
                                </button>
                                <a
                                  href="https://github.com/newbietan/FRP-ALL-IN-ONE/releases"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded font-bold text-xs transition-colors flex items-center justify-center gap-2 border border-slate-700 cursor-pointer select-none"
                                >
                                  <ExternalLink className="w-3.5 h-3.5 text-slate-300" />
                                  {t('GitHub 发布页', 'GitHub Releases')}
                                </a>
                              </div>
                            </div>
                          </section>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* VIEW D1: 添加新设备 - FRP-ALL-IN-ONE (Modal display overlay frame) */}
                  {currentScreen === Screen.ADD_DEVICE && (
                    <motion.div
                      variants={animationVariants.slide_up}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
                    >
                      <div className="bg-white w-full max-w-2xl rounded-2xl border border-slate-200/80 flex flex-col p-6 shadow-2xl relative max-h-[85vh] overflow-y-auto text-left">
                        {/* Header controls layout */}
                        <div className="flex items-start justify-between border-b border-border-subtle pb-4">
                          <div>
                            <h2 className="font-headline-md text-headline-md text-on-surface">{t('添加新设备', 'Add New Device')}</h2>
                            <p className="font-body-md text-body-md text-on-surface-variant mt-1">{t('优先面向境内 Linux/NAS 设备；统一使用容器镜像。Windows/macOS 需自行确认虚拟机网络与镜像兼容性。', 'Linux/NAS devices in mainland China are the primary target. Windows/macOS require compatible images and VM networking.')}</p>
                          </div>
                          
                          <button 
                            aria-label="Close"
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                          >
                            <X className="w-5 h-5 shrink-0" />
                          </button>
                        </div>

                        {/* OS Interactive card Selection block layout XPath matches */}
                        <div className="py-6 flex flex-col gap-6">
                          <div>
                            <p className="text-xs font-mono text-outline uppercase font-medium mb-3">{t('选择客户端运行环境', 'Choose Client Deployment Environment')}</p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              {/* Linux Selector DIV XPath match */}
                              <div 
                                data-os="linux"
                                onClick={() => handleSelectOS('linux')}
                                className="border border-border-subtle hover:border-[#006782] px-4 py-6 rounded-lg cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition-all text-center flex flex-col items-center gap-2.5 relative group"
                              >
                                <div className="p-2.5 bg-[#006782]/10 text-[#006782] rounded-full">
                                  <Terminal className="w-5 h-5 shrink-0" />
                                </div>
                                <span className="font-headline text-sm font-semibold text-on-surface">{t('Linux / NAS（推荐）', 'Linux / NAS (recommended)')}</span>
                                <span className="text-[11px] font-mono text-outline">{t('自动安装/就绪容器', 'Auto-install Docker')}</span>
                              </div>

                              {/* Windows Selector DIV XPath match */}
                              <div 
                                data-os="windows"
                                onClick={() => handleSelectOS('windows')}
                                className="border border-border-subtle hover:border-[#00add8] px-4 py-6 rounded-lg cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition-all text-center flex flex-col items-center gap-2.5 relative group"
                              >
                                <div className="p-2.5 bg-[#00add8]/10 text-[#00add8] rounded-full">
                                  <LayoutGrid className="w-6 h-6 shrink-0" />
                                </div>
                                <span className="font-headline text-sm font-semibold text-on-surface">Windows</span>
                                <span className="text-[11px] font-mono text-outline">{t('PowerShell 容器部署', 'PowerShell Guide')}</span>
                              </div>

                              {/* MacOS Selector DIV XPath match */}
                              <div 
                                data-os="macos"
                                onClick={() => handleSelectOS('macos')}
                                className="border border-border-subtle hover:border-[#da79ef] px-4 py-6 rounded-lg cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition-all text-center flex flex-col items-center gap-2.5 relative group"
                              >
                                <div className="p-2.5 bg-[#da79ef]/10 text-[#da79ef] rounded-full">
                                  <Laptop className="w-6 h-6 shrink-0" />
                                </div>
                                <span className="font-headline text-sm font-semibold text-on-surface">macOS</span>
                                <span className="text-[11px] font-mono text-outline">{t('终端容器部署', 'Terminal Guide')}</span>
                              </div>

                            </div>
                          </div>

                          {/* Footer details metadata */}
                          <div className="flex flex-col gap-3">
                            <span className="text-xs font-mono text-outline uppercase font-medium">{t('服务端连接配置', 'Server Connection Profile')}</span>
                            <div className="bg-slate-50 border border-slate-100 p-4 rounded-lg grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs font-mono text-on-surface">
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('服务器地址', 'Server IP')}</span>
                                <span className="font-bold">{serverConfig.ip || '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('FRPS 端口', 'FRPS Port')}</span>
                                <span className="font-bold">{serverConfig.port}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('FRP 版本', 'FRP Version')}</span>
                                <span className="font-bold">{systemInfo?.frps_version || frpsInfo?.server_info?.version ? `v${systemInfo?.frps_version || frpsInfo?.server_info?.version}` : '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('在线客户端', 'Online Clients')}</span>
                                <span className="font-bold">{systemInfo?.online_clients ?? frpsInfo?.total_clients ?? '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('总隧道数', 'Total Tunnels')}</span>
                                <span className="font-bold">{systemInfo?.total_tunnels ?? frpsInfo?.total_proxies ?? '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('累计运行', 'Uptime')}</span>
                                <span className="font-bold">{systemInfo?.uptime_display || '-'}</span>
                              </div>
                            </div>
                            <span className="text-xs font-mono text-outline uppercase font-medium">{t('数据存储', 'Data Storage')}</span>
                            <div className="bg-slate-50 border border-slate-100 p-4 rounded-lg grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono text-on-surface">
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('数据库路径', 'Database Path')}</span>
                                <span className="font-bold break-all">{systemInfo?.database_path || '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('数据库大小', 'Database Size')}</span>
                                <span className="font-bold">{systemInfo?.database_size || '-'}</span>
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[10px] text-outline uppercase">{t('启动时间', 'Start Time')}</span>
                                <span className="font-bold">{systemInfo?.start_time || '-'}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Action buttons Bottom */}
                        <div className="flex justify-end gap-3 border-t border-border-subtle pt-4">
                          <button 
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 text-xs font-semibold rounded-lg cursor-pointer transition-colors font-sans"
                          >
                            {t('取消', 'Cancel')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* VIEW D2: 客户端脚本展示 - FRP-ALL-IN-ONE (Backdrop blur script demonstrator) */}
                  {currentScreen === Screen.CLIENT_SCRIPT && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
                    >
                      <div className="relative bg-white w-full max-w-2xl rounded-2xl border border-slate-200/80 flex flex-col shadow-2xl text-left max-h-[85vh] overflow-y-auto">
                        {/* Header components */}
                        <div className="px-6 pt-6 pb-4 border-b border-border-subtle flex items-start justify-between">
                          <div>
                            <h2 className="font-headline-md text-headline-md text-primary font-bold">
                              {t('一键拉取并部署客户端', 'Client One-Click Deploy')}
                            </h2>
                            <p className="font-body-md text-body-md text-on-surface-variant mt-1.5 text-xs text-slate-600 max-w-xl">
                              {t(
                                '在目标设备终端中执行对应系统的安装命令，客户端将自动从服务端拉取脚本并启动容器。启动后自动注册上线，零多余配置。',
                                'Run the one-line command on your target device to pull the installer from the server and start the agent container automatically.'
                              )}
                            </p>
                          </div>
                          
                          <button 
                            aria-label="关闭"
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                          >
                            <X className="w-5 h-5 shrink-0" />
                          </button>
                        </div>

                        {/* Content Scroll area */}
                        <div className="p-6 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                          
                          {/* OS Tabs */}
                          <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
                            <button
                              onClick={() => setSelectedOs('linux')}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
                                selectedOs === 'linux' ? 'bg-[#006782] text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              <Terminal className="w-3.5 h-3.5" />
                              <span>Linux / NAS ({t('推荐', 'Recommended')})</span>
                            </button>
                            <button
                              onClick={() => setSelectedOs('windows')}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
                                selectedOs === 'windows' ? 'bg-[#00add8] text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              <LayoutGrid className="w-3.5 h-3.5" />
                              <span>Windows (PowerShell)</span>
                            </button>
                            <button
                              onClick={() => setSelectedOs('macos')}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors flex items-center gap-1.5 ${
                                selectedOs === 'macos' ? 'bg-[#da79ef] text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              <Laptop className="w-3.5 h-3.5" />
                              <span>macOS</span>
                            </button>
                          </div>

                          {/* Command Box */}
                          {(() => {
                            const cmd = installCommands
                              ? (selectedOs === 'windows' ? installCommands.windows : selectedOs === 'macos' ? installCommands.darwin : installCommands.linux)
                              : '';

                            return (
                              <div className="flex flex-col gap-2 p-4 bg-slate-900 rounded-lg text-white border border-slate-800 shadow-inner">
                                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                                  <div className="flex items-center gap-2">
                                    <TerminalIcon className="w-4 h-4 text-emerald-400" />
                                    <span>
                                      {selectedOs === 'windows'
                                        ? t('PowerShell (管理员) 一键执行命令', 'PowerShell Execution Command')
                                        : t('Bash / Shell 一键拉取并执行命令', 'Bash Execution Command')}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-slate-500">{t('秒级自动就绪', 'Ready in seconds')}</span>
                                </div>

                                {installCommandsLoading ? (
                                  <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-400">
                                    <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                                    <span>{t('正在生成一键安装命令...', 'Generating installation command...')}</span>
                                  </div>
                                ) : (
                                  <>
                                    <pre className="text-xs font-mono p-3 bg-black/40 rounded border border-slate-800 text-cyan-300 select-all overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                                      {cmd || t('正在获取命令...', 'Loading command...')}
                                    </pre>
                                    <div className="flex justify-end pt-1">
                                      <button
                                        onClick={() => handleCopyText(cmd)}
                                        disabled={!cmd}
                                        className="px-4 py-2 bg-primary hover:bg-[#005166] text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow transition-colors"
                                      >
                                        <Copy className="w-3.5 h-3.5" />
                                        <span>{t('一键复制安装命令', 'Copy Install Command')}</span>
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })()}

                          {/* Notice */}
                          <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-900">
                            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="leading-relaxed">
                              <span className="font-bold">{t('按需注册说明: ', 'On-Demand Registration: ')}</span>
                              {t(
                                '此命令内嵌专用安装密钥 (key)。仅当客户端实际在终端执行此命令时，服务端才会分配设备 ID 并注册上线。如直接取消或未执行，不会在服务端创建任何幽灵设备。',
                                'This command carries a secure install key. A client ID is only allocated when the command is actually executed on the device. Cancelling leaves no phantom records.'
                              )}
                            </div>
                          </div>

                          {/* Uninstall Accordion */}
                          <details className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 text-xs">
                            <summary className="cursor-pointer font-semibold text-slate-700 flex items-center justify-between">
                              <span>{t('如需卸载客户端（点击展开查看命令）', 'Client Uninstall Command (Click to expand)')}</span>
                            </summary>
                            <div className="mt-3 flex flex-col gap-2">
                              <p className="text-[11px] text-slate-500">
                                {t('在客户端设备终端运行此命令即可安全清理容器。', 'Run this command on the client terminal to remove the agent container.')}
                              </p>
                              <pre className="text-[11px] whitespace-pre-wrap break-all bg-white p-2.5 rounded border border-slate-200 font-mono text-slate-800">
                                {getClientUninstallCommand(selectedOs)}
                              </pre>
                              <div>
                                <button
                                  onClick={() => handleCopyText(getClientUninstallCommand(selectedOs))}
                                  className="text-xs text-primary hover:underline cursor-pointer flex items-center gap-1 font-semibold"
                                >
                                  <Copy className="w-3 h-3" />
                                  <span>{t('复制卸载命令', 'Copy Uninstall Command')}</span>
                                </button>
                              </div>
                            </div>
                          </details>

                        </div>

                        {/* Action controllers buttons */}
                        <div className="px-6 py-4 border-t border-border-subtle bg-slate-50/50 flex justify-end items-center gap-3 rounded-b-2xl">
                          <button 
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer transition-colors"
                          >
                            {t('取消', 'Cancel')}
                          </button>
                          <button 
                            onClick={handleCompleteDeployment}
                            className="px-5 py-2 bg-primary hover:bg-[#005166] text-white rounded-lg text-xs font-semibold cursor-pointer shadow-sm transition-colors"
                          >
                            {t('我已在客户端执行 (完成)', 'I Have Run the Command (Done)')}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                </main>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>



      {/* FORM MODAL HUD GRID FOR ADDING BANDWIDTH TUNNEL CHANNELS */}
      <AnimatePresence>
        {addTunnelModalOpen && (() => {
          const modalSelectedDevice = devices.find(d => d.id === newTunnelData.deviceId) || devices[0];
          const modalDetectedHostIp = (modalSelectedDevice?.ip && modalSelectedDevice.ip !== '未知') ? modalSelectedDevice.ip : '';
          const modalCandidateIps = modalSelectedDevice?.ips || (modalDetectedHostIp ? [modalDetectedHostIp] : []);

          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ scale: 0.95, y: 15 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 15 }}
                className="bg-white w-full max-w-lg rounded-2xl border border-slate-200/80 p-6 flex flex-col gap-4 shadow-2xl text-left max-h-[85vh] overflow-y-auto"
              >
                <div className="flex justify-between items-center border-b border-border-subtle pb-3">
                  <h3 className="font-headline font-semibold text-sm uppercase tracking-wider text-on-surface flex items-center gap-2">
                    <PlusCircle className="w-4 h-4 text-primary" />
                    {t('新建穿透映射 (FRP Proxy Client Node)', 'New FRP Proxy Tunnel')}
                  </h3>
                  <button 
                    onClick={() => setAddTunnelModalOpen(false)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleCreateTunnel} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-mono text-outline uppercase font-semibold">{t('绑定目标客户端设备', 'Target Client Device')}</label>
                    <select 
                      className="w-full border border-slate-300 rounded-xl py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] h-[36px] bg-white text-slate-800 font-sans shadow-sm"
                      value={newTunnelData.deviceId}
                      onChange={(e) => {
                        const nextDevId = e.target.value;
                        const targetDev = devices.find(d => d.id === nextDevId);
                        const targetIp = (targetDev?.ip && targetDev.ip !== '未知') ? targetDev.ip : '127.0.0.1';
                        setNewTunnelData(p => ({
                          ...p,
                          deviceId: nextDevId,
                          localIp: (p.localIp === '127.0.0.1' || !p.localIp || devices.some(d => d.ip === p.localIp)) ? targetIp : p.localIp,
                        }));
                      }}
                    >
                      {devices.map(d => (
                        <option key={d.id} value={d.id}>{d.name} {d.ip && d.ip !== '未知' ? `(${d.ip})` : ''}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-mono text-outline uppercase font-semibold">{t('服务通道名称 (Proxy Name)', 'Proxy Name')}</label>
                      <input 
                        type="text"
                        className="w-full border border-slate-300 rounded-xl py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] font-mono bg-white shadow-sm text-slate-800"
                        value={newTunnelData.name}
                        onChange={(e) => setNewTunnelData(p => ({ ...p, name: e.target.value }))}
                        required
                      />
                    </div>
                    
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-mono text-outline uppercase font-semibold">{t('传输层协议', 'Protocol')}</label>
                      <select 
                        className="w-full border border-slate-300 rounded-xl py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] h-[36px] bg-white text-slate-800 font-sans shadow-sm"
                        value={newTunnelData.type}
                        onChange={(e) => setNewTunnelData(p => ({ ...p, type: e.target.value as any }))}
                      >
                        <option value="tcp">TCP</option>
                        <option value="udp">UDP</option>
                        <optgroup label={t('域名网站（需合规及额外配置）', 'Websites (filing and extra setup may apply)')}>
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                        </optgroup>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 font-mono text-xs">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] text-outline uppercase font-semibold">{t('内部局域网 IP', 'Local IP')}</label>
                        {modalDetectedHostIp && newTunnelData.localIp !== modalDetectedHostIp && (
                          <button
                            type="button"
                            onClick={() => setNewTunnelData(p => ({ ...p, localIp: modalDetectedHostIp }))}
                            className="text-[10px] text-primary hover:underline font-sans cursor-pointer font-medium"
                          >
                            {t('填入宿主机 IP', 'Fill Host IP')}
                          </button>
                        )}
                      </div>
                      <input 
                        type="text"
                        className="w-full border border-slate-300 rounded-xl py-2 px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] font-mono bg-white shadow-sm text-slate-800"
                        value={newTunnelData.localIp}
                        onChange={(e) => setNewTunnelData(p => ({ ...p, localIp: e.target.value }))}
                        placeholder={modalDetectedHostIp || "127.0.0.1"}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] text-outline uppercase font-semibold">{t('局域网端口', 'Local Port')}</label>
                      <input 
                        type="number"
                        className="w-full border border-slate-300 rounded-xl py-2 px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] font-mono bg-white shadow-sm text-slate-800"
                        value={newTunnelData.localPort}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewTunnelData(p => ({ ...p, localPort: val === '' ? '' : Math.max(1, Math.min(65535, Number(val))) }));
                        }}
                        placeholder={t('例如: 22', 'e.g. 22')}
                        min="1"
                        max="65535"
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] text-outline uppercase font-semibold">{t('服务端映射端口', 'Remote Port')}</label>
                      <input 
                        type="number"
                        className="w-full border border-slate-300 rounded-xl py-2 px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#006782]/20 focus:border-[#006782] font-mono bg-white shadow-sm text-slate-800"
                        value={newTunnelData.remotePort}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewTunnelData(p => ({ ...p, remotePort: val === '' ? '' : Math.max(1, Math.min(65535, Number(val))) }));
                        }}
                        placeholder={t('例如: 6000', 'e.g. 6000')}
                        min="1"
                        max="65535"
                        required
                      />
                    </div>
                  </div>

                  {/* 候选 IP 快捷选择徽章 */}
                  {modalDetectedHostIp && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-sans -mt-1">
                      <span className="text-slate-500 text-[10px]">{t('嗅探到宿主机候选 IP:', 'Detected Host Candidate IPs:')}</span>
                      <button
                        type="button"
                        onClick={() => setNewTunnelData(p => ({ ...p, localIp: modalDetectedHostIp }))}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                          newTunnelData.localIp === modalDetectedHostIp
                            ? 'bg-primary/10 text-primary border-primary/40 font-semibold'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                        }`}
                        title={t('推荐：客户端宿主机实际局域网 IP', 'Recommended: Client host LAN IP')}
                      >
                        ★ {modalDetectedHostIp} {t('(宿主机)', '(Host)')}
                      </button>
                      {modalCandidateIps.filter(ip => ip !== modalDetectedHostIp && ip !== '127.0.0.1').map(ip => (
                        <button
                          key={ip}
                          type="button"
                          onClick={() => setNewTunnelData(p => ({ ...p, localIp: ip }))}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                            newTunnelData.localIp === ip
                              ? 'bg-primary/10 text-primary border-primary/40 font-semibold'
                              : 'bg-slate-50 hover:bg-slate-100 text-slate-600 border-slate-200'
                          }`}
                        >
                          {ip}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 容器网络隔离 127.0.0.1 踩坑提示卡片 */}
                  {(newTunnelData.localIp === '127.0.0.1' || newTunnelData.localIp === 'localhost') && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 flex flex-col gap-2 font-sans">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-semibold text-amber-900 leading-tight">
                            {t('容器网络提示：127.0.0.1 指向容器自身内部', 'Container Notice: 127.0.0.1 points inside container')}
                          </p>
                          <p className="text-[11px] text-amber-700 mt-1 leading-relaxed">
                            {t(
                              'frp-agent 运行在 Docker 容器中，容器内部通常没有 SSH 等服务。若需转发宿主机服务（如宿主机 SSH、Web 等），请填入宿主机的实际局域网 IP。',
                              'frp-agent runs inside a container without SSH. To tunnel host services (like host SSH/Web), use the host LAN IP.'
                            )}
                          </p>
                        </div>
                      </div>
                      {modalDetectedHostIp && (
                        <div className="flex items-center gap-2 pl-6">
                          <button
                            type="button"
                            onClick={() => setNewTunnelData(p => ({ ...p, localIp: modalDetectedHostIp }))}
                            className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-medium px-3 py-1 rounded cursor-pointer transition-colors shadow-sm"
                          >
                            {t(`一键填入宿主机 IP (${modalDetectedHostIp})`, `Fill Host IP (${modalDetectedHostIp})`)}
                          </button>
                          <span className="text-[10px] text-amber-600 font-semibold">{t('强烈推荐', 'Highly Recommended')}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end gap-3 border-t border-border-subtle pt-4 mt-2">
                    <button 
                      type="button"
                      onClick={() => setAddTunnelModalOpen(false)}
                      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg cursor-pointer transition-colors font-sans"
                    >
                      {t('取消', 'Cancel')}
                    </button>
                    <button 
                      type="submit"
                      className="bg-primary hover:bg-[#005166] text-white text-xs font-semibold py-2 px-5 rounded-lg cursor-pointer font-sans shadow-sm transition-colors"
                    >
                      {t('确认创建映射', 'Confirm Mapping')}
                    </button>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* REALTIME LOG WINDOW MODAL DISPLAYER FRAME */}
      <AnimatePresence>
        {logModalOpen && logModalDevice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[6px] flex items-center justify-center p-4 sm:p-6"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white border border-[#E2E8F0] rounded-xl shadow-lg w-full max-w-5xl h-[80vh] flex flex-col overflow-hidden text-left"
            >
              {/* Modal Header */}
              <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between bg-slate-50">
                <div className="flex items-center gap-4">
                  <h2 className="font-headline font-semibold text-base text-on-surface">{t('实时日志', 'Realtime Logs')}</h2>
                  <div className="flex items-center gap-2 px-3 py-1 bg-white rounded-full border border-[#E2E8F0] select-none">
                    <span className={`w-2 h-2 rounded-full ${logModalDevice.status === 'online' ? 'bg-status-online animate-pulse' : 'bg-status-offline'}`}></span>
                    <span className="font-mono text-xs text-on-surface-variant font-medium">{logModalDevice.name}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 mr-2">
                    <button
                      onClick={handleClearLogs}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-[#E2E8F0] rounded bg-white hover:bg-slate-50 hover:border-slate-300 transition-all font-semibold text-on-surface-variant cursor-pointer shadow-sm"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('清除', 'Clear')}</span>
                    </button>
                    <button
                      onClick={handleDownloadLogs}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-[#E2E8F0] rounded bg-white hover:bg-slate-50 hover:border-slate-300 transition-all font-semibold text-on-surface-variant cursor-pointer shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{t('下载', 'Download')}</span>
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      setLogModalOpen(false);
                      setLogModalDevice(null);
                    }}
                    className="text-on-surface-variant hover:text-on-surface transition-colors p-1.5 rounded hover:bg-slate-100 flex items-center justify-center cursor-pointer border border-transparent hover:border-[#E2E8F0]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Terminal Body */}
              <div 
                ref={terminalScrollRef}
                className="flex-1 bg-[#24292F] p-4 overflow-y-auto terminal-scroll font-mono text-[13px] leading-relaxed text-slate-100 select-text"
              >
                <div className="flex flex-col gap-1.5">
                  {liveLogs.length === 0 ? (
                    <div className="text-slate-400 py-12 text-center text-xs font-mono select-none">
                      {t('--- 暂无实时日志流数据输出，等待代理程序启动 ---', '--- No realtime logs trace output, waiting for proxy starting signal ---')}
                    </div>
                  ) : (
                    liveLogs.map((log) => (
                        <div key={log.id} className="text-slate-100 hover:bg-white/5 px-2 py-0.5 rounded transition-all font-mono break-all whitespace-pre-wrap">
                          {log.msg}
                        </div>
                      ))
                  )}
                  {logModalDevice.status === 'online' && (
                    <div className="flex gap-3 text-slate-500 hover:bg-white/5 px-2 py-0.5 rounded transition-all opacity-50 select-none">
                      <span className="animate-pulse">_</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Terminal Footer / Status */}
              <div className="bg-[#1a1e23] border-t border-white/10 px-6 py-2.5 flex justify-between items-center text-xs font-mono text-slate-300 select-none">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${logModalDevice.status === 'online' ? 'bg-status-online animate-pulse' : 'bg-status-offline'}`}></span>
                    {logModalDevice.status === 'online' ? t('Connected', 'Connected') : t('Disconnected', 'Disconnected')}
                  </span>
                  <span>{t(`共 ${liveLogs.length} 条日志记录`, `Total logs: ${liveLogs.length}`)}</span>
                </div>
                <span>{t('最后更新: 刚刚', 'Last updated: just now')}</span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* SYSTEM UPDATE MODAL */}
      <AnimatePresence>
        {updateModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white w-full max-w-2xl rounded-2xl border border-slate-200/80 p-6 flex flex-col gap-4 shadow-2xl text-left max-h-[85vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center border-b border-border-subtle pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  <h3 className="font-headline font-bold text-base text-on-surface">
                    {t('系统版本与自动升级中心', 'Version & Auto-Update Center')}
                  </h3>
                </div>
                <button 
                  onClick={() => setUpdateModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Status card */}
              <div className={`p-4 rounded-lg border flex items-center justify-between ${
                updateInfo?.has_update 
                  ? 'bg-amber-50/70 border-amber-300 text-amber-900' 
                  : 'bg-emerald-50/70 border-emerald-300 text-emerald-900'
              }`}>
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${updateInfo?.has_update ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                  <div>
                    <p className="font-semibold text-sm">
                      {updateInfo?.has_update
                        ? t(`发现新版本 ${updateInfo.latest_version}（当前: ${APP_VERSION_DISPLAY}）`, `New version ${updateInfo.latest_version} available (Current: ${APP_VERSION_DISPLAY})`)
                        : t(`当前已是最新版本 (${APP_VERSION_DISPLAY})`, `System is up to date (${APP_VERSION_DISPLAY})`)}
                    </p>
                    <p className="text-xs opacity-75 mt-0.5">
                      {t('上一次检测时间: ', 'Last checked: ')}
                      {updateInfo?.checked_at ? new Date(updateInfo.checked_at * 1000).toLocaleString() : t('刚刚', 'Just now')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => checkSystemUpdate(true)}
                  disabled={checkUpdateLoading}
                  className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 rounded text-xs font-semibold cursor-pointer flex items-center gap-1.5 shadow-sm text-slate-700"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${checkUpdateLoading ? 'animate-spin' : ''}`} />
                  <span>{t('重新检测', 'Re-check')}</span>
                </button>
              </div>

              {/* Release Notes */}
              {updateInfo?.release_notes && (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-mono">
                    {t('更新日志 (Release Notes)', 'Release Notes')}
                  </h4>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs text-slate-700 max-h-56 overflow-y-auto leading-relaxed">
                    <MarkdownView content={updateInfo.release_notes} />
                  </div>
                </div>
              )}

              {/* Server Upgrade Guide */}
              <div className="flex flex-col gap-2.5 bg-slate-50 border border-slate-200 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 font-mono">
                    {t('① 服务端一键平滑升级', 'Server One-Click Smooth Upgrade')}
                  </span>
                  <span className="text-[10px] text-emerald-600 font-semibold">{t('数据、Token与密钥 100% 完整保留', 'Data, Tokens & Keys 100% Preserved')}</span>
                </div>

                {/* 环境不支持直接自升级时的清晰指引 */}
                {upgradeCapability && !upgradeCapability.can_self_upgrade && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-900 font-sans leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">{t('环境提示: ', 'Environment Notice: ')}</span>
                      {upgradeCapability.reason}
                    </div>
                  </div>
                )}

                {/* 升级执行报错信息展示 */}
                {serverUpgradeError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-900 font-sans leading-relaxed">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold">{t('升级失败: ', 'Upgrade Failed: ')}</span>
                      {serverUpgradeError}
                    </div>
                  </div>
                )}
                
                {isUpgradingServer ? (
                  <div className="p-4 bg-sky-50 border border-sky-200 rounded-lg flex flex-col items-center justify-center gap-3 text-center">
                    <div className="flex items-center gap-2 text-sky-800 font-semibold text-xs">
                      <RefreshCw className="w-4 h-4 animate-spin text-[#006782]" />
                      <span>{serverUpgradeProgress || t('正在执行平滑升级...', 'Executing smooth upgrade...')}</span>
                    </div>
                    <p className="text-[11px] text-sky-600">
                      {t('服务正在平滑重启并无缝切换，重启就绪后页面将自动刷新，请勿关闭浏览器。', 'The server is restarting smoothly. The page will auto-refresh once ready.')}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {t('在 Web 面板直接拉取腾讯云最新镜像并平滑重建容器。SQLite 数据库、Token、SSL 证书及客户端连接全自动保留，无需登录服务器终端。', 'Pulls latest image and smoothly recreates container. SQLite database, tokens, SSL certs and client connections are 100% preserved.')}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleTriggerServerUpgrade}
                        disabled={isUpgradingServer || upgradeCapability?.can_self_upgrade === false}
                        className={`flex-1 py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-2 shadow transition-all ${
                          upgradeCapability?.can_self_upgrade === false
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                            : 'bg-primary hover:bg-[#005166] text-white cursor-pointer'
                        }`}
                      >
                        <ArrowUpCircle className="w-4 h-4" />
                        <span>{t('立即一键平滑升级服务端 (推荐)', 'Upgrade Server Now (Recommended)')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* CLI Fallback */}
                <details className="mt-1 text-xs">
                  <summary className="text-[11px] text-slate-500 hover:text-slate-700 cursor-pointer">
                    {t('如未挂载 Socket，可查看终端平滑升级命令（备用）', 'View CLI upgrade command (Alternative)')}
                  </summary>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 bg-slate-900 text-slate-100 p-2 rounded text-[11px] font-mono select-all overflow-x-auto">
                      curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh | bash
                    </code>
                    <button
                      onClick={() => handleCopyText('curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh | bash')}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{t('复制', 'Copy')}</span>
                    </button>
                  </div>
                </details>
              </div>

              {/* Outdated Clients Summary */}
              <div className="flex flex-col gap-2 bg-sky-50/60 border border-sky-200 rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-bold text-sky-900 font-mono">
                      {t('② 客户端设备升级情况', 'Client Devices Update Status')}
                    </span>
                    <p className="text-[11px] text-sky-700 mt-0.5">
                      {t(`共连接 ${devices.length} 台设备，其中 ${outdatedDevices.length} 台可升级`, `${devices.length} devices total, ${outdatedDevices.length} can be upgraded`)}
                    </p>
                  </div>
                    {outdatedDevices.length > 0 && (
                    <button
                      onClick={handleBatchUpgradeAgents}
                      disabled={batchUpgrading}
                      className="px-3 py-1.5 bg-[#006782] hover:bg-[#005166] text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{batchUpgrading ? t('正在下发...', 'Sending...') : t('批量下发升级信号', 'Broadcast Upgrade')}</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-border-subtle pt-3">
                <button
                  onClick={() => setUpdateModalOpen(false)}
                  className="px-5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg cursor-pointer transition-colors"
                >
                  {t('关闭', 'Close')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* INDIVIDUAL CLIENT DEVICE UPGRADE MODAL */}
      <AnimatePresence>
        {upgradeTargetDevice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white w-full max-w-lg rounded-2xl border border-slate-200/80 p-6 flex flex-col gap-4 shadow-2xl text-left"
            >
              <div className="flex justify-between items-center border-b border-border-subtle pb-3">
                <div className="flex items-center gap-2">
                  <ArrowUpCircle className="w-5 h-5 text-primary" />
                  <h3 className="font-headline font-bold text-sm text-on-surface">
                    {t(`升级客户端设备: ${upgradeTargetDevice.name}`, `Upgrade Client: ${upgradeTargetDevice.name}`)}
                  </h3>
                </div>
                <button 
                  onClick={() => setUpgradeTargetDevice(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 grid grid-cols-2 gap-2 text-xs font-mono">
                <div>
                  <span className="text-slate-400">{t('当前版本: ', 'Current: ')}</span>
                  <span className="font-semibold text-slate-800">
                    {upgradeTargetDevice.agentInfo?.agent_version ? `v${upgradeTargetDevice.agentInfo.agent_version}` : 'v3.0.0'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t('目标版本: ', 'Target: ')}</span>
                  <span className="font-semibold text-emerald-600">
                    {upgradeTargetDevice.latestVersion || APP_VERSION_DISPLAY}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">{t('宿主机 IP: ', 'Host IP: ')}</span>
                  <span className="font-semibold text-slate-800">{upgradeTargetDevice.ip}</span>
                </div>
                <div>
                  <span className="text-slate-400">{t('运行环境: ', 'Platform: ')}</span>
                  <span className="font-semibold text-slate-800 capitalize">{upgradeTargetDevice.os}</span>
                </div>
              </div>

              {/* Method 1: Remote Signal */}
              <div className="flex flex-col gap-2 p-3 bg-sky-50/70 border border-sky-200 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-sky-900 font-mono">
                    {t('方式一：在线下发升级信号', 'Method 1: Remote Signal')}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${upgradeTargetDevice.status === 'online' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                    {upgradeTargetDevice.status === 'online' ? t('在线', 'Online') : t('离线', 'Offline')}
                  </span>
                </div>
                <p className="text-[11px] text-sky-700">
                  {t('通过 WebSocket 向正在运行的 Agent 容器发送更新请求', 'Send update signal over WebSocket to the running agent')}
                </p>

                {/* 客户端实时回传反馈卡片 */}
                {agentUpgradeStatuses[upgradeTargetDevice.id] && (
                  <div className="p-2.5 bg-white border border-sky-300 rounded-lg flex flex-col gap-1 text-xs shadow-sm">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-sky-900 flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${upgradeBusy(agentUpgradeStatuses[upgradeTargetDevice.id].status) ? 'bg-amber-500 animate-pulse' : upgradeFailed(agentUpgradeStatuses[upgradeTargetDevice.id].status) ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                        <span>{t('客户端反馈: ', 'Agent Feedback: ')}</span>
                        <span className="text-emerald-700 font-mono font-bold">
                          {agentUpgradeStatuses[upgradeTargetDevice.id].status}
                        </span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {upgradeTimestamp(agentUpgradeStatuses[upgradeTargetDevice.id].updated_at)}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-700 bg-slate-50 p-1.5 rounded font-mono">
                      {agentUpgradeStatuses[upgradeTargetDevice.id].message || t('客户端已接收升级指令', 'Agent received upgrade command')}
                    </p>
                    {agentUpgradeStatuses[upgradeTargetDevice.id].error && (
                      <p className="text-[10px] text-rose-600 bg-rose-50 p-1.5 rounded font-mono">
                        {agentUpgradeStatuses[upgradeTargetDevice.id].error}
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={() => handleUpgradeSingleAgent(upgradeTargetDevice)}
                  disabled={upgradingDevice || upgradeTargetDevice.status !== 'online' || upgradeBusy(agentUpgradeStatuses[upgradeTargetDevice.id]?.status)}
                  className={`w-full py-2 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                    upgradeTargetDevice.status === 'online' && !upgradeBusy(agentUpgradeStatuses[upgradeTargetDevice.id]?.status)
                      ? 'bg-primary hover:bg-[#005166] text-white'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{upgradingDevice || upgradeBusy(agentUpgradeStatuses[upgradeTargetDevice.id]?.status) ? t('执行中...', 'In Progress...') : t('发送远程升级信号', 'Send Upgrade Signal')}</span>
                </button>

                <div className="text-[10px] text-slate-500 bg-white/70 p-2 rounded border border-slate-200/80 leading-normal">
                  {t(
                    '说明：若客户端已挂载 Docker Socket 且支持升级执行器，容器将在接收信号后自动拉取镜像并完成事务升级与回滚保障；若为首次升级旧版本客户端，建议使用下方的【方式二】一键升级命令。',
                    'Notice: If the agent container has Docker Socket mounted and supports the upgrade runner, it upgrades automatically with rollback safety. For legacy agents, please use Method 2 below.'
                  )}
                </div>
              </div>

              {/* Method 2: Host One-Click Command */}
              <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <span className="text-xs font-bold text-slate-800 font-mono">
                  {t('方式二：在客户端设备执行一键升级命令', 'Method 2: Run Command on Host')}
                </span>
                <p className="text-[11px] text-slate-500">
                  {t('生成单次有效且受限的安全升级命令（10分钟有效），自动校验镜像并平滑重建容器，完整保留已有隧道配置', 'Generates a single-use bounded upgrade command (10m validity), pulling verified images and preserving tunnels')}
                </p>
                {(() => {
                  const cmdEntry = agentUpgradeCommands[upgradeTargetDevice.id];
                  const hasValidCmd = cmdEntry && cmdEntry.expiresAt > Date.now();

                  if (hasValidCmd) {
                    return (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <code className="flex-1 bg-slate-900 text-slate-100 p-2 rounded text-[11px] font-mono select-all overflow-x-auto">
                            {cmdEntry.command}
                          </code>
                          <button
                            onClick={() => handleCopyText(cmdEntry.command)}
                            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            <span>{t('复制', 'Copy')}</span>
                          </button>
                        </div>
                        <div className="flex justify-between items-center text-[10px] text-slate-500">
                          <span>{t('有效时间至: ', 'Expires at: ')}{new Date(cmdEntry.expiresAt).toLocaleTimeString()}</span>
                          <button
                            onClick={() => handleGenerateUpgradeCommand(upgradeTargetDevice.id)}
                            disabled={generatingUpgradeCommand}
                            className="text-primary hover:underline cursor-pointer"
                          >
                            {generatingUpgradeCommand ? t('生成中...', 'Generating...') : t('重新生成', 'Regenerate')}
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <button
                      onClick={() => handleGenerateUpgradeCommand(upgradeTargetDevice.id)}
                      disabled={generatingUpgradeCommand}
                      className="w-full py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      <span>{generatingUpgradeCommand ? t('正在生成升级命令...', 'Generating Upgrade Command...') : t('生成安全升级命令 (10分钟有效)', 'Generate Secure Upgrade Command (Valid 10m)')}</span>
                    </button>
                  );
                })()}
              </div>

              <div className="flex justify-end gap-3 border-t border-border-subtle pt-3">
                <button
                  onClick={() => setUpgradeTargetDevice(null)}
                  className="px-5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg cursor-pointer transition-colors"
                >
                  {t('关闭', 'Close')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* GLOBAL UNIFIED CONFIRMATION MODAL */}
      <ConfirmModal dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />

    </div>
  );
}
