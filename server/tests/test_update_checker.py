from __future__ import annotations

import importlib
from unittest.mock import MagicMock

from database import Base, SessionLocal, engine
from main import _auto_migrate_db
import models
import pytest


def test_semantic_version_comparison():
    assert models.is_newer_version("v3.0.2", "v3.0.1") is True
    assert models.is_newer_version("v3.1.0", "v3.0.9") is True
    assert models.is_newer_version("v4.0.0", "v3.99.99") is True
    assert models.is_newer_version("v3.0.1", "v3.0.1") is False
    assert models.is_newer_version("v3.0.0", "v3.0.1") is False
    assert models.is_newer_version("3.0.2", "3.0.1") is True


@pytest.mark.anyio
async def test_check_github_update_structure():
    checker = importlib.import_module("services.update_checker")
    res = await checker.check_github_update(force=False)
    assert "current_version" in res
    assert "latest_version" in res
    assert "has_update" in res
    assert "release_notes" in res
    assert "html_url" in res
    assert res["current_version"] == f"v{models.APP_VERSION}"


@pytest.mark.anyio
async def test_agent_upgrade_endpoint():
    Base.metadata.create_all(bind=engine)
    _auto_migrate_db(engine)

    client_id = "test-upgrade-client"
    db = SessionLocal()
    try:
        db.query(models.AgentInfo).filter(models.AgentInfo.client_id == client_id).delete()
        db.query(models.Client).filter(models.Client.id == client_id).delete()
        dummy_val = "tok_" + client_id
        c = models.Client(
            id=client_id,
            name="test-client-for-upgrade",
            auth_token=dummy_val,
            status="offline"
        )
        db.add(c)
        db.commit()

        agents_module = importlib.import_module("routers.agents")
        req = MagicMock()
        admin = models.Admin(id=1, github_id=1, github_username="admin", is_superadmin=True)

        res = await agents_module.trigger_agent_upgrade(client_id, req, db, admin)
        assert res["success"] is True
        assert res["client_id"] == client_id
        assert "upgrade_command" in res
        assert client_id in res["upgrade_command"]
    finally:
        db.query(models.AgentInfo).filter(models.AgentInfo.client_id == client_id).delete()
        db.query(models.Client).filter(models.Client.id == client_id).delete()
        db.commit()
        db.close()
