import secrets
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Request
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
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.clear()


def test_identifier_alone_cannot_download_client_token(http, db):
    response = http.get("/api/frp/agent/install/linux?client_id=fixture-client")
    assert response.status_code == 403
    assert db.query(models.Client).first().auth_token not in response.text
    assert http.post("/api/agents/fixture-client/upgrade-command").status_code == 401


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
    manager.agent_connections["fixture-client"] = SimpleNamespace(send_json=AsyncMock())
    manager.agent_system_info["fixture-client"] = {"version": "1.0.0", "can_self_upgrade": True, "upgrade_protocol": 1}
    monkeypatch.setattr(agents, "ws_manager", manager)
    import routers.clients as clients
    monkeypatch.setattr(clients, "ws_manager", manager)
    monkeypatch.setattr(models, "APP_VERSION", "2.0.0")
    result = await agents.trigger_batch_agent_upgrade(SimpleNamespace(), db, SimpleNamespace())
    assert result["sent_count"] == 1
    manager.agent_connections["fixture-client"].send_json.assert_awaited_once()
    message = manager.agent_connections["fixture-client"].send_json.call_args.args[0]
    assert message["data"]["image"].endswith(":v2.0.0")
    task = agent_upgrades.get_task(db, "fixture-client")
    assert task and task["status"] == "sent"


@pytest.mark.anyio
async def test_legacy_agent_does_not_receive_fake_upgrade_signal(db, monkeypatch):
    manager = ConnectionManager()
    socket = SimpleNamespace(send_json=AsyncMock())
    manager.agent_connections["fixture-client"] = socket
    manager.agent_system_info["fixture-client"] = {"version": "1.0.0"}
    monkeypatch.setattr(agents, "ws_manager", manager)
    request = Request({"type": "http", "scheme": "https", "server": ("panel.example", 8443), "headers": [], "path": "/", "root_path": ""})
    result = await agents.trigger_agent_upgrade("fixture-client", request, db, SimpleNamespace())
    assert not result["signal_sent"]
    assert "upgrade-script" in result["upgrade_command"]
    socket.send_json.assert_not_awaited()


def test_command_keeps_origin_port_and_bounded_credential(db, http):
    main.app.dependency_overrides[get_current_user] = lambda: SimpleNamespace()
    response = http.post("/api/agents/fixture-client/upgrade-command", headers={"origin": "https://panel.example:10967"})
    assert response.status_code == 200
    command = response.json()["upgrade_command"]
    assert "https://panel.example:10967/" in command
    assert db.query(models.Client).first().auth_token not in command
    assert response.json()["expires_in"] == 600


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_generated_unix_script_syntax_and_no_destructive_commands(platform, tmp_path):
    import subprocess
    script = frp_server._generate_unix_script("example.test", "7000", "fixture-token", "fixture-client", "fixture-secret", platform, target_version="v2.0.0", upgrade_job_id="a"*32)
    result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert "rm -f frp-agent" not in script
    assert script.index('pull "$IMAGE"') < script.index('cat > "$INSTALL_DIR/frpc.toml"')
    assert 'if [ ! -f "$INSTALL_DIR/frpc.toml" ]; then' in script
    assert "--volumes-from frp-agent:rw" in script
    assert "--wait" in script


def test_windows_script_preserves_config_and_checks_health():
    script = frp_server._generate_windows_script("example.test", "7000", "fixture-token", "fixture-client", "fixture-secret", target_version="v2.0.0")
    assert "rm -f" not in script
    assert 'if (!(Test-Path "$INSTALL_DIR\\frpc.toml"))' in script
    assert "--wait" in script and "-healthcheck" in script
    assert "{{.Id}}" in script
