import secrets
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, Request, WebSocket
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
import main
import models
from core import get_current_user, get_db
from database import Base
from routers import agents, frp_server
from services import agent_upgrades
from websocket_manager import ConnectionManager


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        fixture_token = secrets.token_urlsafe(24)
        session.add(models.Client(id="fixture-client", name="fixture", auth_token=fixture_token, status="online"))
        session.add(models.AgentInfo(client_id="fixture-client", agent_version="1.0.0", os="linux"))
        session.commit()
        yield session
    engine.dispose()


@pytest.fixture
def http(db):
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(main.app, base_url="https://testserver")
    finally:
        main.app.dependency_overrides.clear()


def test_identifier_alone_cannot_download_client_token(http, db):
    response = http.get("/api/frp/agent/install/linux?client_id=fixture-client")
    assert response.status_code == 403
    assert db.query(models.Client).first().auth_token not in response.text
    assert http.post("/api/agents/fixture-client/upgrade-command").status_code == 401


def test_client_responses_enrich_schema_without_mutating_orm(db, http):
    main.app.dependency_overrides[get_current_user] = lambda: models.Admin()
    client = db.get(models.Client, "fixture-client")
    assert client and not hasattr(client, "agent_info")
    listed = http.get("/api/clients/")
    assert listed.status_code == 200
    assert listed.json()[0]["agent_info"]["os"] == "linux"
    detail = http.get("/api/clients/fixture-client")
    assert detail.status_code == 200 and detail.json()["agent_info"]["os"] == "linux"
    updated = http.patch("/api/clients/fixture-client", json={"remark": "测试备注"})
    assert updated.status_code == 200 and updated.json()["remark"] == "测试备注"
    assert updated.json()["agent_info"]["os"] == "linux"
    assert not hasattr(client, "agent_info")


@pytest.mark.parametrize("enabled", [None, "true", 1, [], {}])
def test_tunnel_enabled_requires_boolean(db, http, enabled):
    main.app.dependency_overrides[get_current_user] = lambda: models.Admin()
    tunnel = models.Tunnel(name="ssh", type=models.TunnelType.TCP, client_id="fixture-client",
                           local_ip="127.0.0.1", local_port=22, remote_port=6001, enabled=True)
    db.add(tunnel)
    db.commit()
    response = http.patch(f"/api/clients/fixture-client/tunnels/{tunnel.id}", json={"enabled": enabled})
    assert response.status_code == 422
    db.refresh(tunnel)
    assert tunnel.enabled is True


@pytest.mark.parametrize("subject", [None, 123, {}, [], "invalid"])
def test_invalid_jwt_subject_is_unauthorized(http, monkeypatch, subject):
    monkeypatch.setattr(auth.jwt, "decode", lambda *args, **kwargs: {"sub": subject})
    response = http.get("/api/system/info", headers={"Authorization": "Bearer fixture"})
    assert response.status_code == 401


def test_grant_is_single_use_client_bound_and_not_an_admin_token(db, http):
    token = agent_upgrades.issue_grant(db, "fixture-client", "v2.0.0")
    assert http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "other", "grant": token}).status_code == 403
    assert http.get("/api/system/info", headers={"Authorization": "Bearer " + token}).status_code == 401
    response = http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "fixture-client", "grant": token})
    assert response.status_code == 200
    assert "frp-agent:v2.0.0" in response.text
    assert "--client-id" in response.text
    assert "no-store" in response.headers["cache-control"]
    assert http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "fixture-client", "grant": token}).status_code == 403


def test_fresh_grant_retries_same_active_task_after_download_or_pull_failure(db, http):
    task = agent_upgrades.begin_task(db, "fixture-client", "v2.0.0")
    for _ in range(2):
        token = agent_upgrades.issue_grant(db, "fixture-client", "v2.0.0")
        response = http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "fixture-client", "grant": token})
        assert response.status_code == 200
        assert f'JOB_ID="{task["job_id"]}"' in response.text
        persisted = agent_upgrades.get_task(db, "fixture-client")
        assert persisted and persisted["job_id"] == task["job_id"]
        assert http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "fixture-client", "grant": token}).status_code == 403


def test_expired_grant_rejected(db, http):
    token = auth.create_access_token({"purpose": "agent-upgrade-script", "sub": "fixture-client", "jti": "a"*32}, expires_delta=timedelta(seconds=-1))
    assert http.get("/api/frp/agent/upgrade-script/linux", params={"client_id": "fixture-client", "grant": token}).status_code == 403


def test_task_requires_matching_job_version_and_ready_new_agent(db):
    task = agent_upgrades.begin_task(db, "fixture-client", "v2.0.0")
    with pytest.raises(HTTPException) as error:
        agent_upgrades.begin_task(db, "fixture-client", "v2.0.0")
    assert error.value.status_code == 409
    assert agent_upgrades.update_task(db, "fixture-client", {**task, "job_id": "other", "status": "acknowledged"}) is None
    success = {**task, "status": "succeeded", "ready": True}
    assert agent_upgrades.update_task(db, "fixture-client", success, agent_version="1.0.0") is None
    assert agent_upgrades.update_task(db, "fixture-client", {**success, "ready": False}, agent_version="2.0.0") is None
    accepted = agent_upgrades.update_task(db, "fixture-client", success, agent_version="2.0.0")
    assert accepted and accepted["status"] == "succeeded"
    # Terminal tasks cannot regress to an earlier acknowledgment.
    later = agent_upgrades.update_task(db, "fixture-client", {**task, "status": "acknowledged"})
    assert later and later["status"] == "succeeded"
    db.expire_all()
    persisted = agent_upgrades.get_task(db, "fixture-client")
    assert persisted and persisted["status"] == "succeeded"


@pytest.mark.anyio
async def test_batch_uses_registered_version_and_counts_real_sends(db, monkeypatch):
    manager = ConnectionManager()
    socket = MagicMock(spec=WebSocket)
    socket.__len__.return_value = 1  # WebSocket is a mapping; a default mock is falsey.
    socket.send_json = AsyncMock()
    manager.agent_connections["fixture-client"] = socket
    manager.agent_system_info["fixture-client"] = {"version": "1.0.0", "can_self_upgrade": True, "upgrade_protocol": 1}
    monkeypatch.setattr(agents, "ws_manager", manager)
    from routers import clients
    monkeypatch.setattr(clients, "ws_manager", manager)
    monkeypatch.setattr(models, "APP_VERSION", "2.0.0")
    request = Request({"type": "http", "scheme": "https", "server": ("panel.example", 443), "headers": [], "path": "/", "root_path": ""})
    result = await agents.trigger_batch_agent_upgrade(request, db, models.Admin())
    assert result["sent_count"] == 1
    socket.send_json.assert_awaited_once()
    message = socket.send_json.call_args.args[0]
    assert message["data"]["image"].endswith(":v2.0.0")
    task = agent_upgrades.get_task(db, "fixture-client")
    assert task and task["status"] == "sent"


@pytest.mark.anyio
async def test_legacy_agent_does_not_receive_fake_upgrade_signal(db, monkeypatch):
    manager = ConnectionManager()
    socket = MagicMock(spec=WebSocket)
    socket.__len__.return_value = 1
    socket.send_json = AsyncMock()
    manager.agent_connections["fixture-client"] = socket
    manager.agent_system_info["fixture-client"] = {"version": "1.0.0"}
    monkeypatch.setattr(agents, "ws_manager", manager)
    request = Request({"type": "http", "scheme": "https", "server": ("panel.example", 8443), "headers": [], "path": "/", "root_path": ""})
    result = await agents.trigger_agent_upgrade("fixture-client", request, db, models.Admin())
    assert not result["signal_sent"]
    assert "upgrade-script" in result["upgrade_command"]
    socket.send_json.assert_not_awaited()


def test_command_keeps_origin_port_and_bounded_credential(db, http):
    main.app.dependency_overrides[get_current_user] = lambda: SimpleNamespace()
    response = http.post("/api/agents/fixture-client/upgrade-command", headers={"host": "panel.example:10967", "origin": "https://untrusted.example"})
    assert response.status_code == 200
    command = response.json()["upgrade_command"]
    assert "https://panel.example:10967/" in command
    assert "untrusted.example" not in command
    assert db.query(models.Client).first().auth_token not in command
    assert response.json()["expires_in"] == 600


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_generated_unix_script_syntax_and_no_destructive_commands(platform, tmp_path):
    import subprocess
    script = frp_server._generate_unix_script("example.test", "7000", "fixture-token", "fixture-client", "fixture-secret", platform, target_version="v2.0.0", upgrade_job_id="a"*32)
    result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    assert "rm -f frp-agent" not in script
    assert script.index('pull "$IMAGE"') < script.index('cat > "$INSTALL_DIR/frpc.toml"')
    assert 'if [ ! -f "$INSTALL_DIR/frpc.toml" ]; then' in script
    assert "--volumes-from frp-agent:rw" in script
    assert "--wait" in script
    assert 'case "$ENDPOINT" in' in script
    if platform == "darwin":
        assert 'if [ "darwin" != "darwin" ] && [ ! -S "$SOCKET" ]; then' in script
        assert 'if [ "darwin" = "darwin" ] || [ -S "$SOCKET" ]; then' in script


def test_windows_script_preserves_config_and_checks_health():
    script = frp_server._generate_windows_script("example.test", "7000", "fixture-token", "fixture-client", "fixture-secret", target_version="v2.0.0")
    assert "rm -f" not in script
    assert 'if (!(Test-Path "$INSTALL_DIR\\frpc.toml"))' in script
    assert "--wait" in script and "-healthcheck" in script
    assert "{{.Id}}" in script
    assert script.count("$ErrorActionPreference = 'Continue'") == 2
    assert "if ($Exists)" in script and "if ($Healthy)" in script


def test_windows_script_powershell_parser_when_available():
    import shutil
    import subprocess

    pwsh = shutil.which("pwsh")
    if not pwsh:
        pytest.skip("PowerShell is not installed on this host")
    script = frp_server._generate_windows_script("example.test", "7000", "fixture-token", "fixture-client", "fixture-secret", target_version="v2.0.0")
    parser = ("$tokens=$null; $errors=$null; "
              "[void][System.Management.Automation.Language.Parser]::ParseInput("
              "[Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors); "
              "if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }")
    result = subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-Command", parser],
                            input=script, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
