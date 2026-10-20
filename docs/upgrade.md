# Docker 升级说明与故障分析

## 架构与限制

- `frontend/`：React 管理界面；`server/`：FastAPI、SQLite、内嵌 FRPS。
- `agent/`：Go Agent、WebSocket 管理连接、内嵌 FRPC；`core/frp_custom/` 为定制 FRP 内核。
- `server/services/container_upgrade.py` 同时打包进两种镜像，是服务端和客户端共用的独立升级事务执行器。
- **仅支持 Docker**。历史非 Docker 安装需先备份数据并手动迁移；新脚本不跨引擎查找、删除容器，也不会卸载其他引擎。
- 这是保留配置、可失败回滚的容器替换，**不是零停机**。切换期间 FRP 隧道和管理连接会短暂中断，客户端随后重连。

## 已发现与修复的问题

| 问题 | 影响 | 修复 |
| --- | --- | --- |
| 宿主机脚本拉取版本镜像，却按 Compose 中的 `latest` 重建 | 指定版本与实际版本不一致 | 统一走事务执行器，使用不可变镜像 ID |
| 脚本只检查容器 `Up`，失败路径直接重建且无回滚 | 应用未就绪也报告成功；可能丢失运行参数 | 复制原容器配置，检查真实目标版本/就绪状态，失败恢复旧容器和备份 |
| 共用执行器调用无版本的 Docker API | 在要求较高最低 API 版本的 Docker 上可能失败 | 从 `/version` 获取 API 版本，所有资源请求及镜像拉取使用版本化 URL |
| 为兼容其他引擎剥离设备、PID/IPC/用户命名空间等参数，过滤 `/run` 挂载 | VPN/TUN、证书和定制运行配置无法保留 | 保留用户运行参数及 Docker 解析后的实际挂载 |
| 未兼容 `HostConfig.Mounts=null` 和 Windows 盘符绑定 | 准备阶段异常或重复挂载导致创建失败 | 规范化空值，按目标路径去重 |
| 健康检查使用旧容器启动参数 | 新镜像修改默认端口时可能误回滚 | 检查实际新容器参数，兼容 `--port=...` |
| 手动客户端下载命令就创建活动任务，下载/拉取失败后无法重试 | 被“已有升级任务”持续阻塞 | 新凭据复用同版本活动任务 ID；客户端持久锁仍阻止并发切换 |
| 本地构建脚本只设置镜像标签，没有传构建版本 | 标签、镜像协议标签、前端和 Agent 实际版本不一致 | 显式传递三处构建版本，拒绝模糊版本 |
| macOS 用宿主机 `-S` 检查 Docker VM Socket；Windows 把预期的探测失败当终止错误 | 手动升级被误拒绝，或首次健康检查失败就退出 | 区分 Desktop VM 挂载源，Windows 在探测阶段保存退出码并允许重试 |
| 使用镜像 ID 启动后，卸载脚本不能识别仓库归属 | 安装或升级后无法正常移除 | 从镜像 RepoTags/RepoDigests 核实归属，仍拒绝删除无关镜像容器 |
| Watchtower 绕过事务升级 | 与升级锁、验证和回滚冲突 | 新 Compose 默认关闭该容器的外部自动更新，移除自动更新服务模板 |

## 服务端升级

发布包含修复的新版本镜像后，在宿主机运行：

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/upgrade.sh -o /tmp/frp-upgrade.sh
sudo bash /tmp/frp-upgrade.sh vX.Y.Z
```

也可省略版本号，由 GitHub 最新正式 Release 决定；无法确认版本时立即失败，不再静默降级到硬编码版本。请先将 `vX.Y.Z` 替换为已发布版本。

- 不需要宿主机安装 Python，也不依赖 Compose。
- 脚本使用目标镜像里的执行器，因此旧服务端未内置执行器时也可迁移。
- 自定义容器名：`FRP_UPGRADE_CONTAINER=名称 bash upgrade.sh vX.Y.Z`。
- 使用本地非标准 Socket 时，设置 `FRP_UPGRADE_HOST_SOCKET` 并使 Docker 上下文指向同一个 Socket；不支持通过远程上下文升级。
- 数据目录默认是**容器内** `/app/data`，必须持久化挂载。自定义布局需显式设置 `FRP_UPGRADE_DATA_DIR`，并核实数据库、配置和证书备份覆盖范围。
- 不要用 `deploy.sh` 代替升级脚本：部署脚本仍含历史容器清理逻辑。
- 已部署的外部自动更新器应先停用，避免与手动升级并发。

如果还用 Compose 管理服务，应同步固定目标镜像，避免下次 `compose up` 按旧标签重新创建容器。新模板可在 `.env` 设置：

```dotenv
FRP_IMAGE=sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:vX.Y.Z
```

旧模板请直接修改 `services.server.image`；新模板和该环境变量不会自动覆盖旧的自定义 Compose 文件。

## 客户端升级

1. 先升级服务端，再升级客户端。
2. 支持升级协议且挂载 Docker Socket 的客户端可从面板发起远程升级。
3. 旧 Agent、缺少执行器或未挂载 Socket 的安装，使用面板新生成的客户端专属宿主机命令进行首次迁移。凭据十分钟有效且单次使用；下载失败或未执行时需重新生成。
4. 新命令对已有 `frp-agent` 使用同一事务执行器，不先删除容器、不覆盖旧配置，并核对客户端 ID。
5. 若任务已经进入容器切换阶段而异常中断，不应删除锁后盲目重试，应先恢复原事务。

Docker Desktop 需运行 Linux 容器；host 网络模式还取决于 Desktop 版本及设置。挂载 Docker Socket 等价于授予宿主机管理权限，仅在受信任设备上启用。

## 状态、备份与异常恢复

标准目录：服务端 `/app/data/upgrade/server.json`，客户端 `/opt/frp/upgrade/agent.json`。备份位于对应数据目录的 `upgrade/backups/<job_id>/`。

拉取镜像和校验协议发生在停止旧容器之前；停止后备份 SQLite（使用 SQLite backup API）、核心配置及证书。新容器需通过连续三次检查，才提交成功并尝试清理旧容器。失败则恢复备份与旧容器；回滚失败会明确报告 `rollback_failed`，不会伪报成功。

保留旧容器、辅助容器和备份。先查看 `docker logs frp-upgrade-<容器名>-<任务ID前8位>`。在独立临时容器中使用执行器的 `--recover`，不要在即将被停止的应用容器内部恢复：

```bash
# OLD 是仍保留数据挂载的旧/备用容器名；IMAGE 是该任务的固定版本镜像。
docker run --rm --user 0 --network none --volumes-from "$OLD:rw" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --entrypoint python3 "$IMAGE" /usr/local/lib/frp/container_upgrade.py \
  --role server --recover
```

客户端用 `--role agent`；自定义目录需传入相同的 `FRP_UPGRADE_DATA_DIR`。恢复会拒绝与仍在运行的原辅助容器并发执行。若原辅助容器已被外部删除或持久状态损坏，请先人工检查，不要删除旧容器或备份。恢复到旧版本的状态是 `rolled_back`，命令仍返回非零，表示原升级没有成功。

## 构建与验证

```bash
bash deploy/build-and-push.sh vX.Y.Z
# 若确实要构建 latest，仍须声明真实版本：
FRP_BUILD_VERSION=vX.Y.Z bash deploy/build-and-push.sh latest

PYTHONPATH=server python -m pytest -q server/tests
(cd agent && go test ./...)
```

`.github/workflows/upgrade-quality.yml` 在隔离的 Linux CI 中额外执行真实 Docker 升级/回滚测试，包括独立辅助容器、桥接网络、环境变量及配置恢复。这些测试默认跳过；只在一次性测试 Docker 环境中以 root 显式设置 `FRP_DOCKER_INTEGRATION=1`。本地单元测试通过不代表生产镜像、Windows/macOS Docker Desktop 或真实网络环境已经验证。
