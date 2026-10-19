"""Docker/Podman transaction runner. Standard library only; shipped in both images.

Never remove the old container until the replacement passes health checks. The
helper is independent of the process being replaced. All durable state lives on
an existing data volume; no credentials or full inspect payloads are persisted.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import http.client
import json
import os
import re
import shutil
import socket
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlencode

REGISTRY = "sgccr.ccs.tencentyun.com/frp-all-in-one"
RUNTIME = "/usr/local/lib/frp/container_upgrade.py"
TERMINAL = {"succeeded", "failed", "rolled_back", "rollback_failed"}
VERSION_RE = re.compile(r"^v?(\d+\.\d+\.\d+)$")


def normalize_version(value: str) -> str:
    match = VERSION_RE.fullmatch(value or "")
    if not match:
        raise ValueError("升级目标必须是正式版本号，例如 v3.2.6")
    return "v" + match.group(1)


def image_for(role: str, version: str) -> str:
    if role not in {"server", "agent"}:
        raise ValueError("未知容器角色")
    return f"{REGISTRY}/frp-{role}:{normalize_version(version)}"


def read_status(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"step": "idle", "is_upgrading": False, "message": ""}


def save_status(path: Path, data: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = {**data, "updated_at": time.time()}
    data["is_upgrading"] = data.get("step") not in TERMINAL | {"idle"}
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    return data


def begin_job(path: Path, version: str, role: str, container: str, *, job_id: str | None = None) -> dict:
    version = normalize_version(version)
    if job_id and not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("无效的升级任务ID")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if read_status(path).get("step") == "rollback_failed":
        raise RuntimeError("上次回滚尚未完成，请先使用 --recover 恢复")
    lock = path.with_suffix(".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise RuntimeError("已有升级事务；请等待完成，异常中断时使用 --recover 恢复，勿重复升级") from exc
    job = {"job_id": job_id or uuid.uuid4().hex, "target_version": version, "role": role,
           "container": container, "step": "queued", "message": "升级任务已排队", "started_at": time.time()}
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(job["job_id"])
        return save_status(path, job)
    except BaseException:
        lock.unlink(missing_ok=True)
        raise


def finish_job(path: Path, job: dict, step: str, message: str, error: str | None = None) -> dict:
    result = save_status(path, {**job, "step": step, "message": message, "error": error})
    path.with_suffix(".lock").unlink(missing_ok=True)
    return result


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, sock: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = sock

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class Engine:
    def __init__(self, sock: str = "/var/run/docker.sock"):
        self.sock = sock

    def request(self, method: str, path: str, body=None, *, allowed=(200, 201, 204), timeout=30):
        connection = UnixConnection(self.sock, timeout)
        try:
            encoded = json.dumps(body).encode() if body is not None else None
            connection.request(method, path, encoded, {"Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read()
            if response.status not in allowed:
                # Do not include inspect bodies, environment variables or engine logs.
                raise RuntimeError(f"容器引擎 {method} {path.split('?')[0]}: HTTP {response.status}")
            return json.loads(raw) if raw else {}
        finally:
            connection.close()

    def inspect(self, container: str) -> dict:
        return self.request("GET", f"/containers/{quote(container, safe='')}/json")

    def image(self, image: str) -> dict:
        return self.request("GET", f"/images/{quote(image, safe='')}/json")

    def pull(self, image: str):
        # Stream Docker NDJSON: HTTP 200 can still contain an error mid-stream.
        connection = UnixConnection(self.sock, 900)
        try:
            connection.request("POST", "/images/create?" + urlencode({"fromImage": image}))
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError(f"镜像拉取失败: HTTP {response.status}")
            while line := response.readline():
                if line.strip():
                    event = json.loads(line)
                    if event.get("error") or event.get("errorDetail"):
                        raise RuntimeError("镜像仓库返回拉取错误，请检查版本、网络和仓库权限")
        finally:
            connection.close()

    def exec(self, container: str, command: list[str]) -> bool:
        result = self.request("POST", f"/containers/{container}/exec", {
            "Cmd": command, "AttachStdout": False, "AttachStderr": False})
        exec_id = result["Id"]
        self.request("POST", f"/exec/{exec_id}/start", {"Detach": False, "Tty": False})
        state = self.request("GET", f"/exec/{exec_id}/json")
        return not state.get("Running") and state.get("ExitCode") == 0


def container_payload(old: dict, old_image: dict, target: dict) -> dict:
    """Preserve runtime overrides, not build-time defaults from the old image."""
    config = copy.deepcopy(old.get("Config") or {})
    defaults = old_image.get("Config") or {}
    target_config = target.get("Config") or {}
    allowed = {"Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr",
               "ExposedPorts", "Tty", "OpenStdin", "StdinOnce", "Cmd", "Healthcheck", "ArgsEscaped",
               "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled", "MacAddress", "OnBuild",
               "Labels", "StopSignal", "StopTimeout", "Shell"}
    payload = {key: value for key, value in config.items() if key in allowed}
    for key in ("Cmd", "Entrypoint", "User", "WorkingDir", "Healthcheck", "StopSignal", "Shell", "OnBuild"):
        if payload.get(key) == defaults.get(key):
            payload.pop(key, None)
    if config.get("Hostname") in {old.get("Id", "")[:12], old.get("Id")}:
        payload.pop("Hostname", None)
    default_env = dict(item.split("=", 1) for item in defaults.get("Env", []) if "=" in item)
    payload["Env"] = [item for item in config.get("Env", []) if "=" in item
                      and item.split("=", 1)[0] not in {"APP_VERSION", "AGENT_VERSION", "VITE_APP_VERSION"}
                      and default_env.get(item.split("=", 1)[0]) != item.split("=", 1)[1]]
    payload["Image"] = target["Id"]  # immutable local image ID, never mutable :latest
    payload["Labels"] = {**(config.get("Labels") or {}), **(target_config.get("Labels") or {}),
                         "com.centurylinklabs.watchtower.enable": "false"}
    host = copy.deepcopy(old.get("HostConfig") or {})
    host.pop("ContainerIDFile", None)
    host.pop("VolumesFrom", None)
    host["AutoRemove"] = False
    mounts = host.setdefault("Mounts", [])
    destinations = {m.get("Target") for m in mounts}
    destinations.update(b.rsplit(":", 2)[-2] if b.count(":") >= 2 else b.rsplit(":", 1)[-1]
                        for b in host.get("Binds") or [])
    destinations.update((host.get("Tmpfs") or {}).keys())
    for mount in old.get("Mounts") or []:
        dst = mount["Destination"]
        if dst in destinations or mount["Type"] == "tmpfs":
            continue
        entry = {"Type": mount["Type"], "Target": dst, "ReadOnly": not mount.get("RW", True)}
        entry["Source"] = mount.get("Name") if mount["Type"] == "volume" else mount.get("Source")
        if not entry["Source"]:
            raise RuntimeError(f"无法保留数据卷: {dst}")
        mounts.append(entry)
    payload["HostConfig"] = host
    networks = old.get("NetworkSettings", {}).get("Networks") or {}
    endpoints = {}
    for name, endpoint in networks.items():
        if name in {"host", "none", "bridge"}:
            continue
        endpoints[name] = {key: endpoint[key] for key in ("IPAMConfig", "Aliases", "Links", "DriverOpts")
                           if endpoint.get(key)}
    if endpoints:
        payload["NetworkingConfig"] = {"EndpointsConfig": endpoints}
    return payload


def data_directory(role: str) -> Path:
    return Path(os.environ.get("FRP_UPGRADE_DATA_DIR", "/app/data" if role == "server" else "/opt/frp"))


def verify_mount(old: dict, directory: Path):
    if not any(str(directory) == m["Destination"] or str(directory).startswith(m["Destination"].rstrip("/") + "/")
               for m in old.get("Mounts", []) if m.get("RW", True)):
        raise RuntimeError(f"{directory} 必须位于可写持久化挂载内，拒绝冒险重建")


def helper_socket_mount(old: dict, sock: str) -> str:
    for mount in old.get("Mounts", []):
        if mount.get("Destination") == sock:
            return f"{mount['Source']}:/var/run/docker.sock"
    # Host CLI launcher may not inherit a socket from the application container.
    return f"{os.environ.get('FRP_UPGRADE_HOST_SOCKET', sock)}:/var/run/docker.sock"


def launch_upgrade(engine: Engine, container: str, version: str, role: str, path: Path, job: dict | None = None) -> dict:
    job = job or begin_job(path, version, role, container)
    helper_id = None
    try:
        old = engine.inspect(container)
        if not old.get("State", {}).get("Running"):
            raise RuntimeError("原容器未运行；请先恢复服务再升级")
        verify_mount(old, data_directory(role))
        if job.get("expected_client_id"):
            args = old.get("Config", {}).get("Cmd") or []
            if "-id" not in args or args[args.index("-id") + 1:args.index("-id") + 2] != [job["expected_client_id"]]:
                raise RuntimeError("宿主机现有容器客户端ID不匹配，拒绝升级其他设备")
        job.update(old_id=old["Id"], container=old["Name"].lstrip("/"))
        save_status(path, {**job, "step": "pulling", "message": "正在拉取并验证固定版本镜像"})
        image = image_for(role, version)
        engine.pull(image)
        target = engine.image(image)
        labels = target.get("Config", {}).get("Labels") or {}
        if (labels.get("io.frp-all-in-one.version") != normalize_version(version)
                or labels.get("io.frp-all-in-one.role") != role
                or labels.get("io.frp-all-in-one.upgrade-protocol") != "1"):
            raise RuntimeError("目标镜像版本、角色或升级协议不匹配，旧容器未改动")
        job.update(image_id=target["Id"], helper_name="frp-upgrade-" + job["container"] + "-" + job["job_id"][:8])
        job = save_status(path, {**job, "step": "preparing", "message": "镜像验证完成，启动独立升级事务"})
        command = ["python3", RUNTIME, "--worker", "--status", str(path), "--socket", "/var/run/docker.sock", "--job-id", job["job_id"]]
        socket_bind = helper_socket_mount(old, engine.sock)
        payload = {"Image": target["Id"], "Entrypoint": command, "Cmd": [], "User": "0",
                   "Env": [f"FRP_UPGRADE_DATA_DIR={data_directory(role)}",
                           f"FRP_UPGRADE_HOST_SOCKET={socket_bind.rsplit(':', 1)[0]}"],
                   "Labels": {"io.frp-all-in-one.upgrade-helper": job["job_id"], "com.centurylinklabs.watchtower.enable": "false"},
                   "HostConfig": {"VolumesFrom": [old["Id"] + ":rw"],
                                  "Binds": [socket_bind], "NetworkMode": "none",
                                  "RestartPolicy": {"Name": "on-failure", "MaximumRetryCount": 3}}}
        created = engine.request("POST", "/containers/create?" + urlencode({"name": job["helper_name"]}), payload)
        helper_id = created["Id"]
        job["helper_id"] = helper_id
        save_status(path, job)
        engine.request("POST", f"/containers/{helper_id}/start")
        return job
    except Exception as exc:
        if helper_id:
            with contextlib.suppress(OSError, RuntimeError):
                engine.request("DELETE", f"/containers/{helper_id}?force=true&v=false")
        finish_job(path, job, "failed", "准备升级失败，原容器保持不变", str(exc))
        raise


def snapshot(directory: Path, job: dict) -> list[str]:
    backup = directory / "upgrade" / "backups" / job["job_id"]
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    names = ["frp_manager.db", "frps.toml", "certs"] if job["role"] == "server" else ["frpc.toml", "frpc.toml.bak"]
    present = []
    job["snapshot_absent"] = [name for name in names if not (directory / name).exists()]
    for name in names:
        source = directory / name
        if source.is_dir():
            shutil.copytree(source, backup / name)
        elif source.exists():
            if name.endswith(".db"):
                with sqlite3.connect(source) as src, sqlite3.connect(backup / name) as dst:
                    src.backup(dst)
                shutil.copymode(source, backup / name)
            else:
                shutil.copy2(source, backup / name)
        else:
            continue
        present.append(name)
    return present


def restore(directory: Path, job: dict):
    for name in job.get("snapshot_absent", []):
        destination = directory / name
        try:
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink(missing_ok=True)
        except OSError as exc:
            raise RuntimeError(f"无法移除升级新增配置: {name}") from exc
    backup = directory / "upgrade" / "backups" / job["job_id"]
    for name in job.get("snapshot", []):
        destination = directory / name
        if (backup / name).is_dir():
            if destination.exists():
                try:
                    shutil.rmtree(destination)
                except OSError as exc:
                    raise RuntimeError(f"无法恢复配置目录: {name}") from exc
            shutil.copytree(backup / name, destination)
        else:
            if name.endswith(".db"):
                for suffix in ("-wal", "-shm"):
                    Path(str(destination) + suffix).unlink(missing_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".rollback")
            shutil.copy2(backup / name, temporary)
            os.replace(temporary, destination)


def health_command(old: dict, role: str, version: str) -> list[str]:
    if role == "agent":
        return ["frp-agent", "-healthcheck", "-expect-version", version.lstrip("v")]
    args = old.get("Config", {}).get("Cmd") or []
    port = "8080"
    if "--port" in args:
        port = str(args[args.index("--port") + 1])
    script = ("import json,urllib.request; "
              f"d=json.load(urllib.request.urlopen('http://127.0.0.1:{int(port)}/api/system/upgrade/health',timeout=3)); "
              f"assert d['ready'] and d['app_version']=={version!r}")
    return ["python3", "-c", script]


def wait_healthy(engine: Engine, container: str, command: list[str], timeout=90):
    deadline = time.monotonic() + timeout
    consecutive = 0
    while time.monotonic() < deadline:
        state = engine.inspect(container).get("State", {})
        if state.get("Running") and not state.get("Restarting"):
            try:
                consecutive = consecutive + 1 if engine.exec(container, command) else 0
                if consecutive >= 3:
                    return
            except (OSError, RuntimeError, ValueError):
                consecutive = 0
        else:
            consecutive = 0
        time.sleep(2)
    raise RuntimeError("新容器未通过连续健康检查（目标版本、管理连接与穿透核心），准备回滚")


def rollback(engine: Engine, path: Path, job: dict, directory: Path):
    old_id = job["old_id"]
    candidate = job.get("candidate_id")
    # Recover even if the worker died between create and journaling the new ID.
    if not candidate:
        with contextlib.suppress(RuntimeError):
            current = engine.inspect(job["container"])
            if current["Id"] != old_id:
                candidate = current["Id"]
    if candidate:
        engine.request("POST", f"/containers/{candidate}/stop?t=15", allowed=(200, 204, 304, 404))
        engine.request("DELETE", f"/containers/{candidate}?force=true&v=false", allowed=(200, 204, 404))
    if job.get("snapshot"):
        engine.request("POST", f"/containers/{old_id}/stop?t=15", allowed=(200, 204, 304))
    restore(directory, job)
    old = engine.inspect(old_id)
    if old["Name"].lstrip("/") != job["container"]:
        engine.request("POST", f"/containers/{old_id}/rename?" + urlencode({"name": job["container"]}))
    attached = old.get("NetworkSettings", {}).get("Networks") or {}
    for name, endpoint in job.get("detached_networks", {}).items():
        if name not in attached:
            engine.request("POST", f"/networks/{quote(name, safe='')}/connect", {"Container": old_id, "EndpointConfig": endpoint})
    engine.request("POST", f"/containers/{old_id}/start", allowed=(200, 204, 304))
    # Old images may predate the new health protocol. Ensure they stay running,
    # without falsely claiming the requested target version has been installed.
    for _ in range(3):
        time.sleep(2)
        if not engine.inspect(old_id).get("State", {}).get("Running"):
            raise RuntimeError("旧容器回滚后仍未运行，需要人工检查")
    return finish_job(path, job, "rolled_back", "升级失败，已恢复旧容器及配置", job.get("error"))


def run_worker(engine: Engine, path: Path, *, recover=False, expected_job_id=None) -> dict:
    job = read_status(path)
    if expected_job_id and job.get("job_id") != expected_job_id:
        return {"step": "idle", "message": "过期辅助进程已退出，未触碰新任务"}
    if recover and job.get("helper_id"):
        helper = engine.inspect(job["helper_id"])
        if helper.get("State", {}).get("Running"):
            raise RuntimeError("升级辅助容器仍在运行，请先检查日志，勿并发恢复")
    if job.get("step") in TERMINAL and not (recover and job.get("step") == "rollback_failed"):
        if recover:
            path.with_suffix(".lock").unlink(missing_ok=True)
        return job
    directory = data_directory(job["role"])
    if recover and not job.get("old_id"):
        return finish_job(path, job, "failed", "准备阶段中断，原容器未进行切换")
    if recover or job.get("step") in {"stopping", "starting", "verifying", "rolling_back"}:
        try:
            return rollback(engine, path, job, directory)
        except Exception as exc:
            return finish_job(path, job, "rollback_failed", "自动恢复失败，请保留旧容器与备份并人工检查", str(exc))
    try:
        old = engine.inspect(job["old_id"])
        target = engine.image(job["image_id"])
        payload = container_payload(old, engine.image(old["Image"]), target)
        if job.get("enable_socket"):
            binds = payload["HostConfig"].setdefault("Binds", [])
            if not any("/var/run/docker.sock" in item for item in binds):
                binds.append(helper_socket_mount(old, engine.sock))
        job.update(backup_name=job["container"] + "-rollback-" + job["job_id"][:8],
                   detached_networks=payload.get("NetworkingConfig", {}).get("EndpointsConfig", {}))
        job = save_status(path, {**job, "step": "stopping", "message": "正在优雅停止旧容器（现有连接会短暂中断）"})
        engine.request("POST", f"/containers/{job['old_id']}/stop?t=20", allowed=(200, 204, 304))
        job["snapshot"] = snapshot(directory, job)
        save_status(path, job)
        engine.request("POST", f"/containers/{job['old_id']}/rename?" + urlencode({"name": job["backup_name"]}))
        for name in payload.get("NetworkingConfig", {}).get("EndpointsConfig", {}):
            engine.request("POST", f"/networks/{quote(name, safe='')}/disconnect", {"Container": job["old_id"], "Force": True})
            save_status(path, job)
        job = save_status(path, {**job, "step": "starting", "message": "配置已备份，正在启动目标版本"})
        result = engine.request("POST", "/containers/create?" + urlencode({"name": job["container"]}), payload)
        job["candidate_id"] = result["Id"]
        save_status(path, job)
        engine.request("POST", f"/containers/{job['candidate_id']}/start")
        job = save_status(path, {**job, "step": "verifying", "message": "正在校验目标版本及核心健康状态"})
        wait_healthy(engine, job["candidate_id"], health_command(old, job["role"], job["target_version"]))
        # Commit first. A cleanup failure must not roll back a healthy new service.
        job = finish_job(path, job, "succeeded", "目标版本已通过健康检查，升级完成")
        # A cleanup error only retains the old stopped container.
        with contextlib.suppress(OSError, RuntimeError):
            engine.request("DELETE", f"/containers/{job['old_id']}?v=false")
        return job
    except Exception as exc:
        job = save_status(path, {**job, "step": "rolling_back", "message": "升级失败，正在恢复旧容器和配置", "error": str(exc)})
        try:
            return rollback(engine, path, job, directory)
        except Exception as rollback_exc:
            return finish_job(path, job, "rollback_failed", "回滚失败，请保留备份容器并人工恢复", f"{exc}; {rollback_exc}")


def main():
    parser = argparse.ArgumentParser(description="可回滚容器升级（非零停机）")
    parser.add_argument("--socket", default="/var/run/docker.sock")
    parser.add_argument("--container")
    parser.add_argument("--version")
    parser.add_argument("--role", choices=["server", "agent"], default="server")
    parser.add_argument("--status")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--job-id")
    parser.add_argument("--client-id")
    parser.add_argument("--enable-socket", action="store_true", help="显式授权新容器访问宿主引擎")
    options = parser.parse_args()
    engine = Engine(options.socket)
    path = Path(options.status) if options.status else data_directory(options.role) / "upgrade" / (options.role + ".json")
    if options.worker or options.recover:
        result = run_worker(engine, path, recover=options.recover, expected_job_id=options.job_id)
    else:
        if not options.container or not options.version:
            parser.error("必须指定 --container 与 --version")
        job = begin_job(path, options.version, options.role, options.container, job_id=options.job_id)
        job["enable_socket"] = options.enable_socket
        job["expected_client_id"] = options.client_id
        result = launch_upgrade(engine, options.container, options.version, options.role, path, job)
        if options.wait:
            deadline = time.monotonic() + 1200
            while time.monotonic() < deadline:
                result = read_status(path)
                if result["step"] in TERMINAL:
                    break
                time.sleep(2)
            else:
                raise RuntimeError("事务等待超时，请查看持久状态与辅助容器日志；不要重复升级")
    print(json.dumps({k: result.get(k) for k in ("job_id", "step", "message", "error")}, ensure_ascii=False))
    if result.get("step") in TERMINAL - {"succeeded"} and not options.worker:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
