"""Exercise host scripts with a recording Docker shim, never the host daemon."""
import json
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def docker_shim(tmp_path):
    log = tmp_path / "docker.jsonl"
    shim = tmp_path / "docker"
    shim.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_TEST_LOG'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
if args[:2] == ['image', 'inspect']:
    print('sha256:fixture-image')
if args[:1] == ['run']:
    sys.exit(int(os.environ.get('DOCKER_TEST_RESULT', '0')))
''')
    shim.chmod(0o700)
    # Keep the socket short enough for macOS AF_UNIX's path limit.
    socket_dir = tempfile.TemporaryDirectory(prefix="frp-sock-", dir="/tmp")
    sock_path = Path(socket_dir.name) / "d.sock"
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(sock_path))
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
           "DOCKER_TEST_LOG": str(log), "DOCKER_HOST": "unix://" + str(sock_path),
           "FRP_UPGRADE_HOST_SOCKET": str(sock_path), "FRP_CONTAINER_CLI": "docker"}
    try:
        yield env, log
    finally:
        sock.close()
        socket_dir.cleanup()


def calls(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


@pytest.mark.parametrize("result", [0, 1])
def test_host_upgrade_pins_version_and_delegates_health_and_rollback(docker_shim, result):
    env, log = docker_shim
    env["DOCKER_TEST_RESULT"] = str(result)
    run = subprocess.run(["bash", str(ROOT / "deploy/upgrade.sh"), "2.0.0"],
                         env=env, capture_output=True, text=True, check=False)
    assert run.returncode == result, run.stderr
    commands = calls(log)
    assert ["pull", "sgccr.ccs.tencentyun.com/frp-all-in-one/frp-server:v2.0.0"] in commands
    launch = next(cmd for cmd in commands if cmd[0] == "run")
    assert launch[launch.index("--volumes-from") + 1] == "frp-server:rw"
    assert launch[launch.index("--version") + 1] == "v2.0.0"
    assert "--wait" in launch and "--enable-socket" in launch
    assert "/usr/local/lib/frp/container_upgrade.py" in launch
    assert all(cmd[0] not in {"compose", "stop", "rename", "rm"} for cmd in commands)
    assert ("[OK]" in run.stdout) == (result == 0)


@pytest.mark.parametrize("version", ["latest", "v1.2", "v2.0.0;touch /tmp/unsafe"])
def test_host_upgrade_rejects_invalid_target_before_pull(docker_shim, version):
    env, log = docker_shim
    run = subprocess.run(["bash", str(ROOT / "deploy/upgrade.sh"), version], env=env, capture_output=True, check=False)
    assert run.returncode == 2
    assert not any(cmd[0] in {"pull", "run", "stop", "rm"} for cmd in calls(log))


def test_host_upgrade_rejects_remote_docker_context(docker_shim):
    env, log = docker_shim
    env["DOCKER_HOST"] = "ssh://remote.example"
    run = subprocess.run(["bash", str(ROOT / "deploy/upgrade.sh"), "v2.0.0"], env=env, capture_output=True, check=False)
    assert run.returncode != 0
    assert not any(cmd[0] in {"pull", "run"} for cmd in calls(log))


def test_build_propagates_same_version_to_both_images_and_frontend(docker_shim):
    env, log = docker_shim
    env.pop("FRP_BUILD_VERSION", None)
    run = subprocess.run(["bash", str(ROOT / "deploy/build-and-push.sh"), "v2.0.0"],
                         env=env, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    builds = [cmd for cmd in calls(log) if cmd[0] == "build"]
    assert "APP_VERSION=2.0.0" in builds[0] and "VITE_APP_VERSION=v2.0.0" in builds[0]
    assert "AGENT_VERSION=2.0.0" in builds[1]
    assert all(any(arg.endswith(":v2.0.0") for arg in cmd) for cmd in builds)
