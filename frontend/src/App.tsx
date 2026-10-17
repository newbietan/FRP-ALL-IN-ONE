import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  Cpu, 
  Activity, 
  Database, 
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
  Smartphone, 
  Clock, 
  Menu, 
  ChevronRight, 
  Sliders, 
  Terminal as TerminalIcon,
  X,
  Server,
  Zap,
  Radio,
  ExternalLink,
  PlusCircle,
  Download,
  ArrowUp,
  ArrowDown,
  BookOpen, 
  Box,
  Code,
  Search,
  Filter
} from 'lucide-react';
import { Screen, Device, Tunnel, ServerConfig, GlobalSettings, OS } from './types';
import {
  defaultServerConfig,
  defaultGlobalSettings,
  getOSScript
} from './data';
import { APP_VERSION_DISPLAY } from './version';
import { authApi, clientsApi, tunnelsApi, frpApi, settingsApi, systemApi, isLoggedIn, setToken, clearToken } from './api';
import { dashboardWs } from './ws';

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

  const [newTunnelData, setNewTunnelData] = useState({
    name: 'web-service',
    type: 'tcp' as any,
    localIp: '127.0.0.1',
    localPort: 80,
    remotePort: 8080,
    deviceId: devices[0]?.id || ''
  });

  // ===========================
  // OAuth 回调处理 & 初始化数据加载
  // ===========================
  // 检查系统状态并跳转到对应页面，同时预加载公网 IP
  const checkSystemAndNavigate = async () => {
    // 并行获取系统状态和公网 IP
    const [status, ipResult] = await Promise.allSettled([
      systemApi.getStatus(),
      systemApi.getPublicIp(),
    ]);

    // 处理公网 IP 结果
    if (ipResult.status === 'fulfilled' && ipResult.value.success && ipResult.value.ip) {
      setServerPublicIp(ipResult.value.ip);
      setInputIp(ipResult.value.ip);
    }

    // 处理系统状态结果
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

    return () => {
      dashboardWs.off('full_sync', handleFullSync);
      dashboardWs.off('metrics_update', handleMetricsUpdate);
      dashboardWs.off('client_event', handleClientEvent);
      dashboardWs.off('frps_status', handleFrpsStatus);
      dashboardWs.off('log', handleLog);
    };
  }, []);

  /** 将后端 Client 数据映射为前端 Device 格式 */
  const mapClientToDevice = (client: any): Device => {
    const agent = client.agent_info || {};
    const os: OS = (agent.os === 'darwin' ? 'macos' : agent.os) || 'linux';
    // 优先使用 agent_info.online（实时 WebSocket 状态），其次 is_online，最后 client.status
    const onlineStatus = agent.online ?? client.is_online ?? (client.status === 'online');
    return {
      id: client.id,
      name: agent.hostname || client.name || client.id,
      os,
      ip: agent.ip || '未知',
      status: onlineStatus ? 'online' : 'offline',
      lastSeen: client.last_seen || '-',
      tunnelsCount: client.tunnels?.length || 0,
      cpuUsage: Math.round(agent.cpu_percent || 0),
      memUsage: Math.round(agent.memory_percent || 0),
      arch: agent.arch,
      uploadRate: agent.net_speed_out != null ? `${(agent.net_speed_out / 1024).toFixed(1)} KB/s` : '0 KB/s',
      downloadRate: agent.net_speed_in != null ? `${(agent.net_speed_in / 1024).toFixed(1)} KB/s` : '0 KB/s',
      totalTraffic: formatBytes((agent.net_bytes_in || 0) + (agent.net_bytes_out || 0)),
      agentInfo: agent,
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
      triggerToast(`部署失败: ${err.message}`, 'warning');
    }
  };

  // Complete deploy steps & transition to controller panel
  const handleCompleteInit = () => {
    loadDashboardData();
    dashboardWs.connect();
    changeScreen(Screen.DASHBOARD, 'push');
  };

  // Script selection handler which handles clicks inside template DIVs
  const [installScript, setInstallScript] = useState<string>('');
  const handleSelectOS = async (os: OS) => {
    setSelectedOs(os);
    try {
      const script = await frpApi.getInstallScript(os);
      setInstallScript(script as string);
    } catch {
      setInstallScript(getOSScript(os, serverConfig.ip, serverConfig.port, serverConfig.token, `dev-client-node`));
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
    try {
      const created = await tunnelsApi.create(newTunnelData.deviceId, {
        name: newTunnelData.name,
        type: newTunnelData.type,
        local_ip: newTunnelData.localIp,
        local_port: Number(newTunnelData.localPort),
        remote_port: Number(newTunnelData.remotePort),
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

  // Reset demo simulator configuration
  const _handleUninstallDevice = (id: string, name: string) => {
    setDevices(prev => prev.map(d => d.id === id ? { ...d, status: 'offline', lastSeen: '已断开' } : d));
    setTunnels(prev => prev.map(t => t.deviceId === id ? { ...t, status: 'offline' } : t));
    triggerToast(`FRP 客户端 agent '${name}' 已安全停用并离线.`, 'warning');
  };
  void _handleUninstallDevice;

  const handleDeleteDevice = async (deviceId: string, deviceName: string) => {
    try {
      await clientsApi.delete(deviceId);
    } catch (_err) {
      void _err;
    }
    setDevices(prev => prev.filter(d => d.id !== deviceId));
    setTunnels(prev => prev.filter(t => t.deviceId !== deviceId));
    triggerToast(t(`设备 '${deviceName}' 及其关联隧道端口已被安全卸载从系统中释放.`, `Device '${deviceName}' and all associated tunnels unmounted from the database.`), 'warning');
  };

  const handleEditDeviceName = async (device: Device) => {
    let nextName: string | null = null;
    try {
      nextName = prompt(t('请输入新的设备主机名称:', 'Please enter the new device hostname:'), device.name);
    } catch (_e) {
      void _e;
    }

    if (nextName !== null && nextName.trim()) {
      try {
        await clientsApi.updateName(device.id, nextName.trim());
        setDevices(prev => prev.map(d => d.id === device.id ? { ...d, name: nextName!.trim() } : d));
        triggerToast(t('设备主机名称修改成功!', 'Device hostname updated successfully!'), 'success');
      } catch (err: any) {
        triggerToast(`修改失败: ${err.message}`, 'warning');
      }
    }
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
      // 保存域名
      if (tempDomain) {
        await settingsApi.setDomain(tempDomain);
      }
      // 保存面板端口
      await settingsApi.setPanelPort(tempDashboardPort.trim());
      // 处理 TLS 开关（仅在状态变化或域名变化时触发，避免重复申请证书）
      if (enableAutoHttps && tempDomain) {
        if (!savedTlsEnabled || tempDomain !== savedDomain) {
          await settingsApi.enableTls(tempDomain);
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
      triggerToast(t('全局及系统设置参数已同步写入 frps.ini 系统配置文件!', 'All network options and core bindings successfully written onto frps.ini configuration file!'), 'success');
    } catch (err: any) {
      triggerToast(`保存失败: ${err.message}`, 'warning');
    }
  };

  const handleDiscardSettings = () => {
    setTempDomain(serverConfig.domain || 'frp.mydomain.com');
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
                <div className="flex flex-col items-center mb-10">
                  <h1 className="font-headline font-semibold text-2xl text-primary text-center tracking-tight">FRP-ALL-IN-ONE</h1>
                  <p className="font-mono text-xs text-on-surface-variant mt-2 bg-surface-container-high px-2 py-0.5 rounded font-semibold">{APP_VERSION_DISPLAY}</p>
                </div>
                
                {/* Action Area */}
                <div className="w-full flex flex-col gap-3">
                  <button
                    onClick={() => {
                      if (isLoggedIn()) {
                        checkSystemAndNavigate();
                      } else {
                        authApi.loginWithGitHub();
                      }
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
                  href="https://github.com/GreenhandTan/FRP-ALL-IN-ONE" 
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
                  href="https://github.com/GreenhandTan" 
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
                  <p className="font-body-md text-body-md text-on-surface-variant mt-2">{t('请选择您的部署模式', 'Please select your deployment mode')}</p>
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
                      <h3 className="font-headline-sm text-headline-sm text-on-surface mb-2">{t('IP 直连模式', 'IP Direct Connect Mode')}</h3>
                      <p className="font-body-md text-body-md text-on-surface-variant">{t('通过服务器公网 IP 直接访问管理面板和穿透服务。', 'Direct access to admin panel and proxy channels via server Public IP.')}</p>
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
                      <h3 className="font-headline-sm text-headline-sm text-on-surface mb-2">{t('域名模式', 'Custom Domain Mode')}</h3>
                      <p className="font-body-md text-body-md text-on-surface-variant">{t('通过自定义域名访问，支持自动申请 Let\'s Encrypt HTTPS 证书。', 'Access through your own domain name. Supports automated Let\'s Encrypt SSL/TLS certificates setup.')}</p>
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
                    <div className="w-8 h-8 rounded bg-primary-container flex items-center justify-center text-on-primary-container shrink-0 shadow-sm bg-sky-500/10 text-[#006782]">
                      <Terminal className="w-4 h-4" />
                    </div>
                    <div>
                      <h1 className="font-headline font-black text-[#006782] text-sm tracking-tight leading-none">
                        FRP-ALL-IN-ONE
                      </h1>
                      <p className="font-mono text-[9px] text-[#6d797f] font-semibold tracking-wider mt-1">{APP_VERSION_DISPLAY}</p>
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
                      href="https://github.com/GreenhandTan/FRP-ALL-IN-ONE" 
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen className="w-4 h-4 shrink-0" />
                      <span>{t('项目文档', 'Project Docs')}</span>
                    </a>
                    <a 
                      className="flex items-center gap-3 px-4 py-2 text-on-surface-variant hover:bg-slate-100 rounded-lg text-xs font-semibold transition-all" 
                      href="https://github.com/GreenhandTan" 
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
                        <Terminal className="w-4 h-4 text-[#006782]" />
                        <span className="font-headline font-semibold text-sm tracking-tight text-on-surface">FRP-ALL-IN-ONE</span>
                      </div>
                    )}

                  </div>

                  <div className="flex items-center justify-center gap-4 text-xs font-mono h-full">
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
                                      {device.name}
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
                                            {device.name}
                                            <ChevronRight className={`w-3.5 h-3.5 text-outline group-hover:text-primary transition-all shrink-0 ${isExpanded ? 'rotate-90 text-primary' : ''}`} />
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
                                              title={t('修改设备主机名', 'Edit Device Hostname')}
                                            >
                                              <Sliders className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                              onClick={() => {
                                                if (confirm(t(`确定从管理控制台中移除 ${device.name} 吗？此操作不可逆。`, `Warning: Are you sure you want to permanently detach '${device.name}' from the manager?`))) {
                                                  handleDeleteDevice(device.id, device.name);
                                                }
                                              }}
                                              className="p-1 px-1.5 text-outline hover:text-status-offline rounded hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
                                              title={t('注销卸载设备', 'Uninstall Terminal')}
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
                                                    setNewTunnelData(p => ({ ...p, deviceId: device.id }));
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
                                                                    if (confirm(t(`确定卸载子渠道映射 ${tunnel.name} 吗？`, `Confirm release of sub-tunnel ${tunnel.name}?`))) {
                                                                      handleDeleteTunnel(tunnel.id, tunnel.name);
                                                                    }
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
                          
                          {/* Section 1: Domain & HTTPS */}
                          <section className="bg-white border border-border-subtle rounded-xl overflow-hidden relative shadow-sm">
                            <div className="p-6 border-b border-border-subtle bg-slate-50">
                              <div className="flex items-center gap-3 mb-2">
                                <Globe className="w-5 h-5 text-[#006782] shrink-0" />
                                <h3 className="font-headline font-semibold text-base text-on-surface">
                                  {t('域名与 HTTPS 路由', 'Domain Name & HTTPS Routes')}
                                </h3>
                              </div>
                              <p className="font-body-md text-xs text-on-surface-variant">
                                {t('配置主泛域名并管理 SSL/TLS 证书以实现安全的外部访问。', 'Configure primary wild domain name and manage SSL/TLS certificates for safe external access.')}
                              </p>
                            </div>
                            
                            <div className="p-6 space-y-6">
                              {/* Domain Name */}
                              <div>
                                <label className="block font-label-md text-xs text-on-surface mb-2 font-semibold">
                                  {t('基础域名', 'Base Domain')}
                                </label>
                                <div className="flex rounded shadow-sm">
                                  <span className="inline-flex items-center px-4 rounded-l border border-r-0 border-outline-variant bg-slate-50 text-on-surface-variant font-mono text-sm select-none">
                                    *.
                                  </span>
                                  <input
                                    type="text"
                                    value={tempDomain}
                                    onChange={(e) => setTempDomain(e.target.value)}
                                    className="flex-1 block w-full rounded-none rounded-r text-sm border border-outline-variant focus:ring-1 focus:ring-primary focus:border-primary bg-white py-2 px-3 text-on-surface font-mono"
                                    placeholder="example.com"
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
                                    {t('自动为映射 of 子域名申请和续签 SSL 证书。', 'Automatically request and renew secure SSL certificates for generated proxy maps.')}
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
                              
                              {/* One-click Let's Encrypt */}
                              <div>
                                <label className="block font-label-md text-xs text-on-surface mb-2 font-semibold">
                                  {t('一键申请 Let\'s Encrypt 证书', 'One-click Let\'s Encrypt Certificate')}
                                </label>
                                <button
                                  onClick={async () => {
                                    if (!tempDomain) {
                                      triggerToast(t('请先填写域名', 'Please enter a domain first'), 'warning');
                                      return;
                                    }
                                    try {
                                      triggerToast(t('正在申请证书，请稍候...', 'Requesting certificate, please wait...'), 'info');
                                      const result = await settingsApi.enableTls(tempDomain, 'auto');
                                      if ((result as any).success) {
                                        setEnableAutoHttps(true);
                                        triggerToast(t('证书申请成功，HTTPS 已启用！', 'Certificate issued successfully, HTTPS enabled!'), 'success');
                                      } else {
                                        triggerToast(`申请失败: ${(result as any).message}`, 'warning');
                                      }
                                    } catch (err: any) {
                                      triggerToast(`申请失败: ${err.message}`, 'warning');
                                    }
                                  }}
                                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#006782] hover:bg-[#005a6e] text-white rounded-lg font-sans text-sm font-semibold transition-colors cursor-pointer"
                                >
                                  <Shield className="w-4 h-4 shrink-0" />
                                  {t('一键申请 SSL 证书', 'Issue SSL Certificate')}
                                </button>
                                <p className="text-[11px] text-slate-400 font-sans mt-2">
                                  {t('需先配置域名并确保 DNS 已解析到本服务器', 'Domain must be configured and DNS must resolve to this server')}
                                </p>
                              </div>
                            </div>
                          </section>

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
                            
                            <div className="p-5 space-y-5">
                              <p className="font-body-md text-xs text-on-surface-variant leading-relaxed">
                                {t('系统使用 GitHub OAuth 进行多因素管理员安全接入验证。如需变更，可由主管理员在下方重新签发授权。', 'This console relies on GitHub OAuth for Multi-Factor Admin authentication. Click down here to re-authorize another developer handle.')}
                              </p>
                              
                              <hr className="border-border-subtle" />
                              
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

                              <button
                                type="button"
                                onClick={() => window.open('https://github.com/GreenhandTan/FRP-ALL-IN-ONE', '_blank', 'noopener,noreferrer')}
                                className="w-full mt-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded font-bold text-xs transition-colors flex items-center justify-center gap-2 border border-slate-700 cursor-pointer select-none"
                              >
                                <RefreshCw className="w-3.5 h-3.5 text-slate-300" />
                                {t('手动检查核心更新', 'Check Core Updates')}
                              </button>
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
                      className="min-h-screen bg-slate-600/10 backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-gutters shadow-[0_4px_30px_rgba(0,0,0,0.1)]"
                    >
                      <div className="bg-white w-full max-w-3xl rounded-xl border border-border-subtle flex flex-col p-8 relative shadow-lg mx-margin-mobile">
                        {/* Header controls layout XPath match */}
                        <div className="flex items-start justify-between border-b border-border-subtle pb-4">
                          <div>
                            <h2 className="font-headline-md text-headline-md text-on-surface">{t('添加新设备', 'Add New Device')}</h2>
                            <p className="font-body-md text-body-md text-on-surface-variant mt-1">{t('全平台通过容器极速运行，自动从腾讯云公开镜像仓库秒级拉取', 'Unified container-based deployment pulling from Tencent Cloud Registry.')}</p>
                          </div>
                          
                          <button 
                            aria-label="Close"
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="text-on-surface-variant hover:text-on-surface p-1 rounded hover:bg-slate-50 cursor-pointer"
                          >
                            <X className="w-5 h-5 shrink-0" />
                          </button>
                        </div>

                        {/* OS Interactive card Selection block layout XPath matches */}
                        <div className="py-6 flex flex-col gap-6">
                          <div>
                            <p className="text-xs font-mono text-outline uppercase font-medium mb-3">{t('选择客户端运行环境', 'Choose Client Deployment Environment')}</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

                              {/* Docker Selector */}
                              <div 
                                data-os="docker"
                                onClick={() => handleSelectOS('docker')}
                                className="border border-border-subtle hover:border-[#2496ed] px-4 py-6 rounded-lg cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition-all text-center flex flex-col items-center gap-2.5 relative group"
                              >
                                <div className="p-2.5 bg-[#2496ed]/10 text-[#2496ed] rounded-full">
                                  <Box className="w-5 h-5 shrink-0" />
                                </div>
                                <span className="font-headline text-sm font-semibold text-on-surface">{t('Docker (推荐)', 'Docker (Fast)')}</span>
                                <span className="text-[11px] font-mono text-outline">{t('NAS / 服务器一键命令', 'NAS / Linux One-Liner')}</span>
                              </div>
                              
                              {/* Linux Selector DIV XPath match */}
                              <div 
                                data-os="linux"
                                onClick={() => handleSelectOS('linux')}
                                className="border border-border-subtle hover:border-[#006782] px-4 py-6 rounded-lg cursor-pointer bg-slate-50/50 hover:bg-slate-100/50 transition-all text-center flex flex-col items-center gap-2.5 relative group"
                              >
                                <div className="p-2.5 bg-[#006782]/10 text-[#006782] rounded-full">
                                  <Terminal className="w-5 h-5 shrink-0" />
                                </div>
                                <span className="font-headline text-sm font-semibold text-on-surface">Linux</span>
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
                            className="px-4 py-2 bg-slate-100 text-on-surface-variant hover:bg-slate-200 text-xs font-semibold rounded cursor-pointer font-sans"
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
                      className="min-h-screen bg-black/30 backdrop-blur-md fixed inset-0 z-50 flex items-center justify-center p-gutter shadow-2xl"
                    >
                      <div className="relative bg-white w-full max-w-3xl rounded-xl border border-border-subtle flex flex-col mx-margin-mobile max-h-[921px] shadow-[0_4px_24px_rgba(0,0,0,0.08)]">
                        {/* Header components */}
                        <div className="px-gutter pt-gutter p-6 pb-4 border-b border-border-subtle flex items-start justify-between">
                          <div>
                            <h2 className="font-headline-md text-headline-md text-primary font-bold">{t('客户端脚本部署', 'Client Script Quick Deploy')}</h2>
                            <p className="font-body-md text-body-md text-on-surface-variant mt-2 max-w-xl">
                              {t('请复制下方脚本并在您的客户端机器上以 root 权限执行。脚本会自动检测架构并完成安装。', 'Please copy the shell command below and run it with root privileges inside your workspace terminal. The wizard detects cpu architectures automatically.')}
                            </p>
                          </div>
                          
                          <button 
                            aria-label="关闭"
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded hover:bg-slate-50 cursor-pointer"
                          >
                            <X className="w-5 h-5 shrink-0" />
                          </button>
                        </div>

                        {/* Content Scroll area */}
                        <div className="p-gutter p-6 flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                          
                          {/* Code Editor Container style Code Blocks */}
                          <div className="rounded-lg border border-border-subtle bg-github-dark overflow-hidden flex flex-col">
                            {/* Editor Toolbar Header */}
                            <div className="bg-[#161b22] px-4 py-3 border-b border-[#30363d] flex justify-between items-center">
                              <div className="flex items-center gap-2 text-[#8b949e] font-label-sm text-xs font-mono uppercase font-bold text-slate-400">
                                <TerminalIcon className="w-4 h-4 shrink-0 text-primary-container" />
                                <span>{selectedOs === 'docker' ? 'docker-run.sh' : (selectedOs === 'windows' ? 'install_agent.ps1' : 'install_agent.sh')}</span>
                              </div>
                              <div className="flex items-center gap-2 font-sans font-medium text-xs">
                                <button 
                                  onClick={() => handleCopyText(installScript || getOSScript(selectedOs, serverConfig.ip, serverConfig.port, serverConfig.token, `dev-client-node`))}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-[#21262d] hover:bg-[#30363d] text-primary-container border border-[#30363d] transition-colors cursor-pointer text-slate-300 font-sans"
                                >
                                  <Copy className="w-3.5 h-3.5 shrink-0" />
                                  {t('一键复制', 'Copy Command')}
                                </button>
                                <button
                                  onClick={() => {
                                    const script = installScript || getOSScript(selectedOs, serverConfig.ip, serverConfig.port, serverConfig.token, `dev-client-node`);
                                    const ext = selectedOs === 'windows' ? 'ps1' : 'sh';
                                    const filename = `install_agent.${ext}`;
                                    const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = filename;
                                    a.click();
                                    URL.revokeObjectURL(url);
                                    triggerToast(t(`已下载 ${filename}`, `Downloaded ${filename}`), 'success');
                                  }}
                                  className="hidden sm:flex items-center gap-1 px-3 py-1.5 rounded bg-[#21262d] hover:bg-[#30363d] text-slate-300 border border-[#30363d] transition-colors cursor-pointer text-[#8b949e] font-sans"
                                >
                                  <Download className="w-3.5 h-3.5 shrink-0" />
                                  {t('下载脚本', 'Download Agent')}
                                </button>
                              </div>
                            </div>

                            {/* Scripts code display textarea */}
                            <div className="relative w-full h-[280px]">
                              <textarea
                                readOnly
                                className="absolute inset-0 w-full h-full bg-[#0d1117] text-cyan-400 font-mono text-sm p-4 border-none focus:ring-0 resize-none custom-scrollbar m-0 whitespace-pre text-left focus:outline-none"
                                spellCheck="false"
                                value={installScript || getOSScript(selectedOs, serverConfig.ip, serverConfig.port, serverConfig.token, `dev-client-node`)}
                              />
                            </div>
                          </div>

                          {/* Contextual Guidance */}
                          <div className="p-4 rounded bg-surface-container-low border border-border-subtle flex gap-3 items-start">
                            <Info className="w-5 h-5 text-status-warning shrink-0 mt-0.5" />
                            <div className="font-body-md text-body-md text-on-surface text-left">
                              <strong>{t('安全提示:', 'Security Alert:')}</strong> {t('该脚本包含您的设备注册令牌 (Token)。请勿在公开环境中分享此脚本。', 'This script contains your device registration token. Do not share it publicly.')}
                            </div>
                          </div>
                        </div>

                        {/* Action controllers buttons XPath complete */}
                        <div className="px-gutter p-6 py-4 border-t border-border-subtle bg-surface flex justify-end items-center gap-4 rounded-b-xl">
                          <button 
                            onClick={() => changeScreen(Screen.DEVICE_MANAGEMENT, 'push_back')}
                            className="font-label-md text-label-md text-on-surface-variant hover:text-on-surface px-4 py-2 transition-colors cursor-pointer font-sans text-sm font-medium"
                          >
                            {t('取消', 'Cancel')}
                          </button>
                          <button 
                            onClick={handleCompleteDeployment}
                            className="font-label-md text-label-md bg-primary-container text-on-primary hover:bg-primary px-6 py-2 rounded transition-colors shadow-sm cursor-pointer font-sans text-sm font-semibold"
                          >
                            {t('完成部署', 'Complete Provisioning')}
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
        {addTunnelModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 shadow-xl"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-white w-full max-w-lg rounded-lg border border-border-subtle p-6 flex flex-col gap-4 shadow-lg text-left"
            >
              <div className="flex justify-between items-center border-b border-border-subtle pb-3">
                <h3 className="font-headline font-semibold text-sm uppercase tracking-wider text-on-surface flex items-center gap-2">
                  <PlusCircle className="w-4 h-4 text-primary" />
                  新建穿透映射 (FRP Proxy Client Node)
                </h3>
                <button 
                  onClick={() => setAddTunnelModalOpen(false)}
                  className="text-on-surface-variant hover:text-on-surface cursor-pointer p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateTunnel} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-mono text-outline uppercase font-semibold">绑定目标客户端设备</label>
                  <select 
                    className="w-full border border-border-subtle rounded py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary h-[34px] bg-white text-on-surface font-sans"
                    value={newTunnelData.deviceId}
                    onChange={(e) => setNewTunnelData(p => ({ ...p, deviceId: e.target.value }))}
                  >
                    {devices.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-mono text-outline uppercase font-semibold">服务通道名称 (Proxy Name)</label>
                    <input 
                      type="text"
                      className="w-full border border-border-subtle rounded py-1.5 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                      value={newTunnelData.name}
                      onChange={(e) => setNewTunnelData(p => ({ ...p, name: e.target.value }))}
                      required
                    />
                  </div>
                  
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-mono text-outline uppercase font-semibold">传输层协议</label>
                    <select 
                      className="w-full border border-border-subtle rounded py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary h-[34px] bg-white text-on-surface font-sans"
                      value={newTunnelData.type}
                      onChange={(e) => setNewTunnelData(p => ({ ...p, type: e.target.value as any }))}
                    >
                      <option value="tcp">TCP</option>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                      <option value="udp">UDP</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 font-mono text-xs">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] text-outline uppercase font-semibold">内部局域网 IP</label>
                    <input 
                      type="text"
                      className="w-full border border-border-subtle rounded py-1 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      value={newTunnelData.localIp}
                      onChange={(e) => setNewTunnelData(p => ({ ...p, localIp: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] text-outline uppercase font-semibold">局域网端口</label>
                    <input 
                      type="number"
                      className="w-full border border-border-subtle rounded py-1 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      value={newTunnelData.localPort}
                      onChange={(e) => setNewTunnelData(p => ({ ...p, localPort: Number(e.target.value) }))}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] text-outline uppercase font-semibold">服务端映射端口</label>
                    <input 
                      type="number"
                      className="w-full border border-border-subtle rounded py-1 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      value={newTunnelData.remotePort}
                      onChange={(e) => setNewTunnelData(p => ({ ...p, remotePort: Number(e.target.value) }))}
                      required
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 border-t border-border-subtle pt-4 mt-2">
                  <button 
                    type="button"
                    onClick={() => setAddTunnelModalOpen(false)}
                    className="px-4 py-2 bg-slate-100 text-on-surface-variant hover:bg-slate-200 text-xs font-semibold rounded cursor-pointer font-sans"
                  >
                    取消
                  </button>
                  <button 
                    type="submit"
                    className="bg-primary hover:bg-[#005166] text-white text-xs font-semibold py-2 px-5 rounded cursor-pointer font-sans"
                  >
                    确认创建映射
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
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

    </div>
  );
}
