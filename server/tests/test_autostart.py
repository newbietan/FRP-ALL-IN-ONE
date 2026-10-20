"""Check startup configuration using shell functions, never the host services."""
import os
import subprocess
from pathlib import Path

import pytest

from routers.frp_server import _generate_unix_script, _generate_windows_script

ROOT = Path(__file__).resolve().parents[2]


def unix_script(platform="linux"):
    return _generate_unix_script("127.0.0.1", 7000, "fixture", "client", "fixture", platform)


def startup_fragment(role):
    if role == "server":
        source = (ROOT / "deploy/deploy.sh").read_text()
        definition = source.split("detect_container_stack() {", 1)[1].split("\nrun_compose() {", 1)[0]
        return "detect_container_stack() {" + definition + "\ndetect_container_stack\n"
    source = unix_script()
    # Exercise only service setup, not installation, image pulls or container creation.
    fragment = source.split("# Docker 当前可用不代表已设开机自启", 1)[1].split("\n", 1)[1].split("ENDPOINT=", 1)[0]
    # Simulate the root installation path even when tests run as a regular user.
    return 'CONTAINER_CLI=docker\n' + fragment.replace('"$EUID"', '"0"')


SHIMS = r'''
command() {
    if [ "$1" = "-v" ]; then
        case "$2" in
            docker) return 0 ;;
            systemctl) [ "$TEST_INIT" = systemd ] ;;
            rc-update|rc-service) [ "$TEST_INIT" = openrc ] ;;
            *) return 1 ;;
        esac
    else
        builtin command "$@"
    fi
}
docker() { printf 'docker %s\n' "$*" >> "$TEST_LOG"; return 0; }
systemctl() { printf 'systemctl %s\n' "$*" >> "$TEST_LOG"; return "$TEST_SERVICE_RESULT"; }
rc-update() { printf 'rc-update %s\n' "$*" >> "$TEST_LOG"; return "$TEST_SERVICE_RESULT"; }
rc-service() { printf 'rc-service %s\n' "$*" >> "$TEST_LOG"; return 0; }
log_warn() { echo "[WARN] $*"; }
log_error() { echo "[ERROR] $*"; }
'''


@pytest.mark.parametrize("role", ["server", "agent"])
@pytest.mark.parametrize("init", ["systemd", "openrc", "none"])
@pytest.mark.parametrize("service_result", [0, 1])
def test_running_docker_still_gets_autostart_configuration(tmp_path, role, init, service_result):
    log = tmp_path / "calls.log"
    run = subprocess.run(
        ["bash", "-c", "set -e\n" + SHIMS + startup_fragment(role)],
        env={**os.environ, "TEST_LOG": str(log), "TEST_INIT": init,
             "TEST_SERVICE_RESULT": str(service_result)},
        capture_output=True, text=True, check=False,
    )
    assert run.returncode == 0, run.stderr
    calls = log.read_text().splitlines()
    assert "docker info" in calls
    if init == "systemd":
        assert "systemctl enable --now docker" in calls
    elif init == "openrc":
        assert "rc-update add docker default" in calls
        assert "rc-service docker start" in calls
    else:
        assert not any(line.startswith(("systemctl", "rc-")) for line in calls)
    assert ("[WARN]" in run.stdout + run.stderr) == (init == "none" or service_result != 0)


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_generated_unix_scripts_keep_restart_policy_and_valid_syntax(platform):
    script = unix_script(platform)
    run = subprocess.run(["bash", "-n"], input=script, capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    assert "--restart always" in script
    if platform == "darwin":
        assert "Docker Desktop 设置中开启登录时启动" in script


def test_windows_script_explains_docker_desktop_startup_requirement():
    script = _generate_windows_script("127.0.0.1", 7000, "fixture", "client", "fixture")
    assert "--restart always" in script
    assert "Docker Desktop 设置中开启登录时启动" in script
    assert "未登录前不保证运行" in script


def test_server_compose_keeps_restart_policy():
    assert "restart: always" in (ROOT / "deploy/compose.yml").read_text()
