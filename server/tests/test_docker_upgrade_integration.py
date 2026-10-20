"""Opt-in, disposable real-Docker tests. Run as root in an isolated CI runner."""
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from services import container_upgrade as upgrade

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.environ.get("FRP_DOCKER_INTEGRATION") != "1",
                                reason="requires an isolated Docker daemon and root")


def docker(*args):
    return subprocess.check_output(["docker", *args], cwd=ROOT, text=True).strip()


@pytest.fixture(scope="module")
def images():
    # Fixed protocol versions intentionally live only on the disposable CI daemon.
    old = "frp-upgrade-ci-old:0.0.1"
    target = upgrade.image_for("server", "v0.0.2")
    for image, version in ((old, "0.0.1"), (target, "0.0.2")):
        docker("build", "-q", "-f", "server/tests/fixtures/upgrade.Dockerfile",
               "--build-arg", "VERSION=" + version, "-t", image, ".")
    return old, target


@pytest.mark.parametrize("fail", [False, True])
def test_real_docker_success_and_rollback(images, tmp_path, monkeypatch, fail):
    assert os.geteuid() == 0, "Run opt-in integration tests as root to read root-owned durable state"
    old_image, _ = images
    suffix = uuid.uuid4().hex[:10]
    name = "frp-ci-" + suffix
    network = "frp-ci-net-" + suffix
    directory = str(tmp_path)
    monkeypatch.setenv("FRP_UPGRADE_DATA_DIR", directory)
    (tmp_path / "frps.toml").write_text("original")
    docker("network", "create", network)
    engine = upgrade.Engine()
    # Only the fixture pull is skipped; EVERY container/network/exec HTTP call
    # and the independent helper use the actual daemon and production runner.
    monkeypatch.setattr(engine, "pull", lambda image: None)
    job = None
    old_id = None
    try:
        old_id = docker("run", "-d", "--name", name, "--network", network,
                        "--restart", "unless-stopped", "-v", f"{directory}:{directory}",
                        "-v", "/var/run/docker.sock:/var/run/docker.sock",
                        "-e", "FRP_UPGRADE_DATA_DIR=" + directory,
                        "-e", "SECRET_KEY=keep-me", "-e", "FRP_TEST_FAIL=" + str(int(fail)), old_image)
        path = tmp_path / "upgrade" / "server.json"
        job = upgrade.launch_upgrade(engine, name, "v0.0.2", "server", path)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            state = upgrade.read_status(path)
            if state.get("step") in upgrade.TERMINAL:
                break
            time.sleep(0.5)
        else:
            pytest.fail("worker did not complete: " + json.dumps(upgrade.read_status(path)))
        assert state["step"] == ("rolled_back" if fail else "succeeded"), json.dumps(state, ensure_ascii=False)
        if fail:
            assert state.get("candidate_id") and "健康检查" in (state.get("error") or ""), json.dumps(state, ensure_ascii=False)
        current = engine.inspect(name)
        assert current["State"]["Running"]
        assert "SECRET_KEY=keep-me" in current["Config"]["Env"]
        assert current["HostConfig"]["RestartPolicy"]["Name"] == "unless-stopped"
        assert network in current["NetworkSettings"]["Networks"]
        assert (tmp_path / "frps.toml").read_text() == ("original" if fail else "migrated")
        assert (current["Id"] == old_id) is fail
        assert not path.with_suffix(".lock").exists()
    finally:
        # Never prune the daemon or touch unrelated resources.
        ids = [name, old_id, (job or {}).get("helper_id"), (job or {}).get("candidate_id")]
        for cid in filter(None, ids):
            subprocess.run(["docker", "rm", "-f", cid], capture_output=True, check=False)
        subprocess.run(["docker", "network", "rm", network], capture_output=True, check=False)
