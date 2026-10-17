"""
WebSocket 连接管理器
用于管理 Dashboard 客户端和 Agent 的 WebSocket 连接
"""
from __future__ import annotations

import asyncio
from collections import deque
import contextlib
from datetime import datetime, timezone
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """管理所有 WebSocket 连接"""

    def __init__(self):
        # Dashboard 前端连接（多个浏览器标签）
        self.dashboard_connections: set[WebSocket] = set()

        # Agent 连接（client_id -> WebSocket）
        self.agent_connections: dict[str, WebSocket] = {}

        # Agent 系统信息（client_id -> system_info）
        self.agent_system_info: dict[str, dict[str, Any]] = {}

        # 日志订阅者（client_id -> 订阅该客户端日志的 WebSocket 集合）
        self.log_subscribers: dict[str, set[WebSocket]] = {}

        # Agent 日志缓存（client_id -> deque）
        self.agent_log_buffer: dict[str, deque[dict[str, Any]]] = {}

        # 冲突事件记录（最近 20 条）：记录同一 client_id 被多台设备抢占的情况
        self.conflict_events: list[dict[str, Any]] = []

        # 各 Agent 最后一次写入 DB 的时间戳，用于节流（每 30 秒写一次）
        self._metrics_last_write: dict[str, float] = {}

    # ========================
    # Dashboard 连接管理
    # ========================

    async def connect_dashboard(self, websocket: WebSocket):
        """接受 Dashboard 前端连接"""
        self.dashboard_connections.add(websocket)
        logger.info(f"Dashboard 已连接，当前连接数: {len(self.dashboard_connections)}")

    def disconnect_dashboard(self, websocket: WebSocket):
        """断开 Dashboard 前端连接"""
        self.dashboard_connections.discard(websocket)
        logger.info(f"Dashboard 已断开，当前连接数: {len(self.dashboard_connections)}")

    async def broadcast_status(self, status: dict[str, Any]):
        """向所有 Dashboard 广播状态更新"""
        if not self.dashboard_connections:
            return

        message = {"type": "status", "data": status}
        disconnected = []

        for ws in self.dashboard_connections:
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.warning(f"发送状态失败: {e}")
                disconnected.append(ws)

        # 清理断开的连接
        for ws in disconnected:
            self.disconnect_dashboard(ws)

    async def broadcast_dashboard(self, message: dict[str, Any]):
        """向所有 Dashboard 广播任意 JSON 消息"""
        if not self.dashboard_connections:
            return

        disconnected = []
        for ws in self.dashboard_connections:
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.warning(f"发送 Dashboard 消息失败: {e}")
                disconnected.append(ws)

        for ws in disconnected:
            self.disconnect_dashboard(ws)

    # ========================
    # Agent 连接管理
    # ========================

    async def connect_agent(self, websocket: WebSocket, client_id: str):
        """接受 Agent 连接"""
        # 如果已有同 ID 的连接，说明同一份脚本被安装到了多台设备上
        # 这会导致两台设备竞争同一个 client_id，只有最新连接的设备可见
        if client_id in self.agent_connections:
            logger.warning(
                f"[冲突] Agent {client_id} 已存在活跃连接，检测到重复 client_id！"
                " 原因：同一份安装脚本被部署到了多台设备。"
                " 请为每台设备单独生成安装脚本（管理后台 → 部署设备）。"
                " 正在关闭旧连接并接受新连接..."
            )
            # 记录冲突事件（最多保留 20 条）
            event = {
                "client_id": client_id,
                "time": datetime.now(timezone.utc).isoformat(),
                "message": f"检测到重复 client_id [{client_id[:8]}...]：同一脚本被安装到多台设备，请从控制台为每台设备单独生成脚本"
            }
            self.conflict_events.append(event)
            if len(self.conflict_events) > 20:
                self.conflict_events.pop(0)

            with contextlib.suppress(Exception):
                await self.agent_connections[client_id].close(1008, "Duplicate client_id: per-device script required")

        self.agent_connections[client_id] = websocket
        # 重连时清除旧的离线标记，确保 system_info 缓存中的 online 标记一致
        if client_id in self.agent_system_info:
            self.agent_system_info[client_id]["online"] = True
        logger.info(f"Agent {client_id} 已连接，当前 Agent 数: {len(self.agent_connections)}")
        # 广播客户端上线事件给所有 Dashboard
        await self.broadcast_client_event(client_id, True)

    def get_recent_conflicts(self) -> list[dict[str, Any]]:
        """获取最近的 client_id 冲突事件列表"""
        return list(self.conflict_events)

    async def disconnect_agent(self, client_id: str, websocket: WebSocket | None = None) -> bool:
        """断开 Agent 连接；旧会话不得清理同 ID 的新连接。"""
        current = self.agent_connections.get(client_id)
        if current is None:
            return False
        if websocket is not None and current is not websocket:
            logger.info(f"忽略 Agent {client_id} 旧会话的断开事件")
            return False

        del self.agent_connections[client_id]
        logger.info(f"Agent {client_id} 已断开，当前 Agent 数: {len(self.agent_connections)}")
        # 保留系统信息一段时间，标记为离线
        if client_id in self.agent_system_info:
            self.agent_system_info[client_id]["online"] = False
        # 广播客户端下线事件给所有 Dashboard
        await self.broadcast_client_event(client_id, False)
        return True

    def update_agent_system_info(self, client_id: str, system_info: dict[str, Any]):
        """更新 Agent 系统信息"""
        self.agent_system_info[client_id] = {
            **system_info,
            "online": True,
            "last_update": asyncio.get_event_loop().time() if asyncio.get_event_loop().is_running() else 0
        }

    def get_all_agents_info(self) -> list[dict[str, Any]]:
        """获取所有 Agent 信息"""
        result = []
        for client_id, info in self.agent_system_info.items():
            result.append({
                "client_id": client_id,
                "online": client_id in self.agent_connections,
                **info
            })
        return result

    def is_agent_online(self, client_id: str) -> bool:
        """检查 Agent 是否在线"""
        return client_id in self.agent_connections

    async def send_to_agent(self, client_id: str, message: dict[str, Any]) -> bool:
        """向指定 Agent 发送消息"""
        ws = self.agent_connections.get(client_id)
        if ws:
            try:
                await ws.send_json(message)
                return True
            except Exception as e:
                logger.warning(f"发送消息到 Agent {client_id} 失败: {e}")
                await self.disconnect_agent(client_id, ws)
        return False

    async def push_config_to_agent(self, client_id: str, config: str) -> bool:
        """推送配置更新到 Agent"""
        return await self.send_to_agent(client_id, {
            "type": "config_update",
            "data": config
        })

    # ========================
    # 日志订阅管理
    # ========================

    async def subscribe_logs(self, websocket: WebSocket, client_id: str):
        """订阅某客户端的日志"""
        if client_id not in self.log_subscribers:
            self.log_subscribers[client_id] = set()
        self.log_subscribers[client_id].add(websocket)
        logger.info(f"日志订阅: {client_id}，当前订阅者: {len(self.log_subscribers[client_id])}")

        # 发送历史日志（如果有）
        if client_id in self.agent_log_buffer:
            history = list(self.agent_log_buffer[client_id])
            if history:
                try:
                    for log_entry in history:
                        await websocket.send_json(log_entry)
                except Exception as e:
                    logger.warning(f"发送历史日志失败: {e}")

    def unsubscribe_logs(self, websocket: WebSocket, client_id: str):
        """取消日志订阅"""
        if client_id in self.log_subscribers:
            self.log_subscribers[client_id].discard(websocket)
            if not self.log_subscribers[client_id]:
                del self.log_subscribers[client_id]

    async def broadcast_log(self, client_id: str, log_line: str):
        """广播日志到所有订阅者，并缓存最近日志"""
        message = {"type": "log", "data": log_line, "client_id": client_id}

        # 1. 缓存日志
        if client_id not in self.agent_log_buffer:
            self.agent_log_buffer[client_id] = deque(maxlen=2000)
        self.agent_log_buffer[client_id].append(message)

        # 2. 广播给订阅者
        subscribers = self.log_subscribers.get(client_id, set())
        if not subscribers:
            return

        disconnected = []

        for ws in subscribers:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)

        # 清理断开的连接
        for ws in disconnected:
            self.unsubscribe_logs(ws, client_id)

    # ========================
    # 统计信息
    # ========================

    def get_stats(self) -> dict[str, Any]:
        """获取连接统计"""
        return {
            "dashboard_connections": len(self.dashboard_connections),
            "agent_connections": len(self.agent_connections),
            "online_agents": list(self.agent_connections.keys()),
            "log_subscribers": {k: len(v) for k, v in self.log_subscribers.items()}
        }

    async def broadcast_ping(self):
        """向所有连接的 Agent 发送 Ping"""
        if not self.agent_connections:
            return

        disconnected = []
        for client_id, ws in self.agent_connections.items():
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                disconnected.append((client_id, ws))

        for client_id, ws in disconnected:
            await self.disconnect_agent(client_id, ws)

    # ========================
    # 事件驱动广播（新增）
    # ========================

    async def broadcast_metrics_patch(self, client_id: str, data: dict[str, Any]):
        """向所有 Dashboard 广播单个 Agent 的实时指标（增量推送，不含静态信息）"""
        if not self.dashboard_connections:
            return
        message = {
            "type": "metrics_update",
            "client_id": client_id,
            "data": {
                "cpu_percent":     data.get("cpu_percent"),
                "memory_percent":  data.get("memory_percent"),
                "memory_used":     data.get("memory_used"),
                "memory_total":    data.get("memory_total"),
                "disk_percent":    data.get("disk_percent"),
                "disk_used":       data.get("disk_used"),
                "disk_total":      data.get("disk_total"),
                "net_bytes_in":    data.get("net_bytes_in"),
                "net_bytes_out":   data.get("net_bytes_out"),
                "net_speed_in":    data.get("net_speed_in"),
                "net_speed_out":   data.get("net_speed_out"),
            }
        }
        disconnected = []
        for ws in self.dashboard_connections:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect_dashboard(ws)

    async def broadcast_client_event(self, client_id: str, is_online: bool):
        """向所有 Dashboard 广播客户端上线/离线事件"""
        if not self.dashboard_connections:
            return
        message = {
            "type": "client_event",
            "client_id": client_id,
            "is_online": is_online,
        }
        disconnected = []
        for ws in self.dashboard_connections:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect_dashboard(ws)

    async def broadcast_frps_status(self, frps_data: dict[str, Any]):
        """向所有 Dashboard 广播 FRPS 状态变化"""
        if not self.dashboard_connections:
            return
        message = {"type": "frps_status", "data": frps_data}
        disconnected = []
        for ws in self.dashboard_connections:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect_dashboard(ws)


# 全局连接管理器实例
manager = ConnectionManager()
