"""No daemon required: exercise the real transaction with an in-memory engine."""
import copy
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest

from services import container_upgrade as upgrade


class FakeEngine:
    sock = "/var/run/docker.sock"

    def __init__(self, directory):
        self.calls = []
        self.pull_error = False
        self.create_error = False
        self.start_error = False
        self.directory = directory
        self.containers = {"old-id": {
            "Id": "old-id", "Name": "/frp-server", "Image": "old-image",
            "State": {"Running": True},
            "Config": {"Env": ["APP_VERSION=1.0.0", "SECRET_KEY=keep"],
                       "Cmd": ["python", "-m", "uvicorn", "main:app", "--port", "9090"]},
            "HostConfig": {"Binds": [f"{directory}:{directory}:rw"], "NetworkMode": "bridge",
                           "PortBindings": {"9090/tcp": [{"HostPort": "9090"}]}, "Memory": 1234},
            "Mounts": [{"Type": "bind", "Source": str(directory), "Destination": str(directory), "RW": True}],
        }}
        self.images = {
            "old-image": {"Id": "old-image", "Config": {"Env": ["APP_VERSION=1.0.0"]}},
            "new-image": {"Id": "new-image", "Config": {"Labels": {
                "io.frp-all-in-one.version": "v2.0.0", "io.frp-all-in-one.role": "server",
                "io.frp-all-in-one.upgrade-protocol": "1"}}},
        }

    def inspect(self, name):
        for cid, container in self.containers.items():
            if name == cid or name == container["Name"].lstrip("/"):
                return copy.deepcopy(container)
        raise RuntimeError("not found")

    def image(self, name):
        return copy.deepcopy(self.images.get(name, self.images["new-image"]))

    def pull(self, image):
        self.calls.append(("pull", image))
        if self.pull_error:
            raise RuntimeError("pull denied")

    def exec(self, container, command):
        self.calls.append(("exec", container))
        return True

    def request(self, method, uri, body=None, **kwargs):
        self.calls.append((method, uri, copy.deepcopy(body)))
        url = urlsplit(uri)
        parts = url.path.strip("/").split("/")
        if parts == ["containers", "create"]:
            assert body is not None
            name = parse_qs(url.query)["name"][0]
            helper = name.startswith("frp-upgrade-")
            if self.create_error and not helper:
                raise RuntimeError("candidate create failed")
            cid = "helper-id" if helper else "candidate-id"
            self.containers[cid] = {"Id": cid, "Name": "/" + name, "Image": body["Image"], "Config": body,
                                    "State": {"Running": False}, "HostConfig": body["HostConfig"]}
            return {"Id": cid}
        if len(parts) >= 2 and parts[0] == "containers":
            cid = parts[1]
            if method == "DELETE":
                del self.containers[cid]
            elif parts[-1] == "rename":
                self.containers[cid]["Name"] = "/" + parse_qs(url.query)["name"][0]
            elif parts[-1] == "stop":
                self.containers[cid]["State"]["Running"] = False
            elif parts[-1] == "start":
                if self.start_error and cid == "candidate-id":
                    raise RuntimeError("start failed")
                self.containers[cid]["State"]["Running"] = True
            else:
                raise AssertionError((method, uri))
            return {}
        if parts[0] == "networks":
            return {}
        raise AssertionError((method, uri))


@pytest.fixture
def environment(tmp_path, monkeypatch):
    monkeypatch.setenv("FRP_UPGRADE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(upgrade.time, "sleep", lambda _: None)
    return FakeEngine(tmp_path), tmp_path / "upgrade" / "server.json"


def test_payload_preserves_mounts_ports_and_runtime_not_old_build_defaults(environment):
    engine, _ = environment
    old = engine.inspect("old-id")
    old["Mounts"].append({"Type": "volume", "Name": "cert-volume", "Source": "/daemon/volumes/_data",
                          "Destination": "/certs", "RW": False})
    old["Config"]["User"] = "1001:1001"
    payload = upgrade.container_payload(old, engine.image("old-image"), engine.image("new-image"))
    assert payload["Image"] == "new-image"
    assert payload["Env"] == ["SECRET_KEY=keep"]
    assert payload["HostConfig"]["PortBindings"] == old["HostConfig"]["PortBindings"]
    assert payload["HostConfig"]["Memory"] == 1234
    assert payload["User"] == "1001:1001"
    assert payload["Cmd"] == old["Config"]["Cmd"]
    assert payload["HostConfig"]["Mounts"] == [{"Type": "volume", "Target": "/certs", "ReadOnly": True, "Source": "cert-volume"}]
    assert payload["Labels"]["com.centurylinklabs.watchtower.enable"] == "false"


def test_durable_lock_rejects_duplicate_until_terminal(environment):
    engine, path = environment
    job = upgrade.launch_upgrade(engine, "frp-server", "v2.0.0", "server", path)
    with pytest.raises(RuntimeError, match="已有升级事务"):
        upgrade.begin_job(path, "v2.0.0", "server", "frp-server")
    assert engine.inspect("old-id")["State"]["Running"]
    upgrade.finish_job(path, job, "failed", "fixture")
    assert upgrade.begin_job(path, "v2.0.0", "server", "frp-server")["job_id"] != job["job_id"]


def test_pull_failure_never_stops_original(environment):
    engine, path = environment
    engine.pull_error = True
    with pytest.raises(RuntimeError, match="pull denied"):
        upgrade.launch_upgrade(engine, "frp-server", "v2.0.0", "server", path)
    assert engine.inspect("old-id")["State"]["Running"]
    assert upgrade.read_status(path)["step"] == "failed"
    assert not path.with_suffix(".lock").exists()


def test_target_label_mismatch_leaves_original(environment):
    engine, path = environment
    engine.images["new-image"]["Config"]["Labels"]["io.frp-all-in-one.version"] = "v1.0.0"
    with pytest.raises(RuntimeError, match="不匹配"):
        upgrade.launch_upgrade(engine, "frp-server", "v2.0.0", "server", path)
    assert engine.inspect("old-id")["State"]["Running"]


def test_success_removes_old_only_after_health_checks(environment):
    engine, path = environment
    upgrade.launch_upgrade(engine, "frp-server", "v2.0.0", "server", path)
    result = upgrade.run_worker(engine, path)
    assert result["step"] == "succeeded"
    assert engine.inspect("frp-server")["Image"] == "new-image"
    assert "old-id" not in engine.containers
    health = [i for i, call in enumerate(engine.calls) if call[0] == "exec"]
    remove = next(i for i, call in enumerate(engine.calls) if call[:2] == ("DELETE", "/containers/old-id?v=false"))
    assert len(health) == 3 and max(health) < remove
    assert not path.with_suffix(".lock").exists()
    assert "SECRET_KEY" not in path.read_text()


@pytest.mark.parametrize("failure", ["create", "start", "health"])
def test_failure_restores_old_container_database_and_config(environment, monkeypatch, failure):
    engine, path = environment
    directory = engine.directory
    (directory / "frps.toml").write_text("old-config")
    with sqlite3.connect(directory / "frp_manager.db") as db:
        db.execute("CREATE TABLE test(value TEXT)")
        db.execute("INSERT INTO test VALUES ('old')")
    upgrade.launch_upgrade(engine, "frp-server", "v2.0.0", "server", path)
    engine.create_error = failure == "create"
    engine.start_error = failure == "start"
    if failure == "health":
        def failed_health(*args):
            (directory / "frps.toml").write_text("new-invalid-config")
            with sqlite3.connect(directory / "frp_manager.db") as db:
                db.execute("UPDATE test SET value='changed'")
            raise RuntimeError("not ready")
        monkeypatch.setattr(upgrade, "wait_healthy", failed_health)
    result = upgrade.run_worker(engine, path)
    assert result["step"] == "rolled_back"
    assert engine.inspect("frp-server")["Id"] == "old-id"
    assert engine.inspect("old-id")["State"]["Running"]
    assert "candidate-id" not in engine.containers
    assert (directory / "frps.toml").read_text() == "old-config"
    with sqlite3.connect(directory / "frp_manager.db") as db:
        assert db.execute("SELECT value FROM test").fetchone()[0] == "old"


def test_http_200_pull_error_stream_is_failure(monkeypatch):
    class Response:
        status = 200
        def readline(self):
            return b'{"errorDetail":{"message":"denied"},"error":"denied"}\n'
    class Connection:
        def __init__(self, *args): pass
        def request(self, *args): pass
        def getresponse(self): return Response()
        def close(self): pass
    monkeypatch.setattr(upgrade, "UnixConnection", Connection)
    engine = upgrade.Engine()
    engine._api_version = "1.47"  # negotiation is tested separately
    with pytest.raises(RuntimeError, match="拉取错误"):
        engine.pull(upgrade.image_for("server", "v2.0.0"))


@pytest.mark.parametrize("version", ["latest", "v1.0.0;touch /tmp/unsafe", "v1.2", "v1.2.3-beta"])
def test_version_allowlist(version):
    with pytest.raises(ValueError):
        upgrade.normalize_version(version)


def test_engine_negotiates_and_reuses_version_for_requests_and_pull(monkeypatch):
    import json
    paths = []

    class Response:
        status = 200

        def __init__(self, path):
            self.path = path

        def read(self):
            return json.dumps({"ApiVersion": "1.47"} if self.path == "/version" else {"Id": "fixture"}).encode()

        def readline(self):
            return b""

    class Connection:
        def __init__(self, *args): pass
        def request(self, method, path, *args):
            self.path = path
            paths.append(path)
        def getresponse(self): return Response(self.path)
        def close(self): pass

    monkeypatch.setattr(upgrade, "UnixConnection", Connection)
    engine = upgrade.Engine()
    engine.inspect("frp-server")
    engine.image("repo/test:v2.0.0")
    engine.pull("repo/test:v2.0.0")
    assert paths == ["/version", "/v1.47/containers/frp-server/json",
                     "/v1.47/images/repo%2Ftest%3Av2.0.0/json",
                     "/v1.47/images/create?fromImage=repo%2Ftest%3Av2.0.0"]


def test_payload_handles_null_mounts_preserves_devices_namespaces_and_run_mount(environment):
    engine, _ = environment
    old = engine.inspect("old-id")
    old["HostConfig"].update(Mounts=None, PidMode="host", IpcMode="host", UsernsMode="host",
                             Devices=[{"PathOnHost": "/dev/net/tun", "PathInContainer": "/dev/net/tun", "CgroupPermissions": "rwm"}])
    old["Mounts"].append({"Type": "bind", "Source": "/host/run/cert", "Destination": "/run/cert", "RW": False})
    payload = upgrade.container_payload(old, engine.image("old-image"), engine.image("new-image"))
    for key in ("PidMode", "IpcMode", "UsernsMode", "Devices"):
        assert payload["HostConfig"][key] == old["HostConfig"][key]
    assert payload["HostConfig"]["Mounts"] == [{"Type": "bind", "Source": "/host/run/cert", "Target": "/run/cert", "ReadOnly": True}]


def test_payload_does_not_duplicate_windows_bind_destination(environment):
    engine, _ = environment
    old = engine.inspect("old-id")
    old["HostConfig"]["Binds"] = ["C:\\frp:/opt/frp"]
    old["Mounts"] = [{"Type": "bind", "Source": "/host_mnt/c/frp", "Destination": "/opt/frp", "RW": True}]
    payload = upgrade.container_payload(old, engine.image("old-image"), engine.image("new-image"))
    assert payload["HostConfig"]["Mounts"] == []


def test_payload_replaces_old_image_defaults_with_target_defaults(environment):
    engine, _ = environment
    old = engine.inspect("old-id")
    old_image = engine.image("old-image")
    old_image["Config"].update(Cmd=old["Config"]["Cmd"], Entrypoint=["old-entrypoint"])
    old["Config"]["Entrypoint"] = ["old-entrypoint"]
    payload = upgrade.container_payload(old, old_image, engine.image("new-image"))
    assert "Cmd" not in payload and "Entrypoint" not in payload
    assert not any(item.startswith("APP_VERSION=") for item in payload["Env"])


@pytest.mark.parametrize("exit_code", [0, 17])
def test_exec_waits_for_detached_command_to_finish(monkeypatch, exit_code):
    engine = upgrade.Engine()
    calls = []
    states = iter([{"Running": True, "ExitCode": None}, {"Running": False, "ExitCode": exit_code}])

    def request(method, path, body=None):
        calls.append((method, path, body))
        if path.endswith("/exec"):
            return {"Id": "health-exec"}
        if path.endswith("/start"):
            return {}
        return next(states)

    monkeypatch.setattr(engine, "request", request)
    monkeypatch.setattr(upgrade.time, "sleep", lambda _: None)
    assert engine.exec("candidate", ["python3", "-c", "pass"]) is (exit_code == 0)
    assert ("POST", "/exec/health-exec/start", {"Detach": True, "Tty": False}) in calls
    assert sum(path.endswith("/json") for _, path, _ in calls) == 2


def test_exec_has_a_bounded_wait_for_stuck_command(monkeypatch):
    import itertools
    from types import SimpleNamespace

    ticks = itertools.count(0, 6)
    monkeypatch.setattr(upgrade, "time", SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None))
    engine = upgrade.Engine()
    monkeypatch.setattr(engine, "request", lambda *args, **kwargs: {"Id": "exec", "Running": True})
    with pytest.raises(RuntimeError, match="执行超时"):
        engine.exec("candidate", ["fixture"])


def test_health_timeout_preserves_last_engine_error(environment, monkeypatch):
    import itertools
    from types import SimpleNamespace

    engine, _ = environment
    ticks = itertools.count(0, 2)
    monkeypatch.setattr(upgrade, "time", SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None))

    def failed_exec(*args):
        raise RuntimeError("HTTP 400: fixture failure")

    monkeypatch.setattr(engine, "exec", failed_exec)
    with pytest.raises(RuntimeError, match="HTTP 400: fixture failure"):
        upgrade.wait_healthy(engine, "old-id", ["fixture"], timeout=3)
