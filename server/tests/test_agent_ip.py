import pytest

from database import Base, SessionLocal, engine
from main import _auto_migrate_db, _handle_agent_message
import models
from routers.clients import _build_client_agent_info


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    _auto_migrate_db(engine)
    db = SessionLocal()
    # 清理测试数据
    db.query(models.AgentInfo).filter(models.AgentInfo.client_id == "test-client-ip").delete()
    db.query(models.Client).filter(models.Client.id == "test-client-ip").delete()
    # 创建测试 Client
    generated_token = "agent_tok_" + "12345"
    test_client = models.Client(
        id="test-client-ip",
        name="test-client-ip",
        auth_token=generated_token,
        status="offline"
    )
    db.add(test_client)
    db.commit()
    db.close()
    yield
    db = SessionLocal()
    db.query(models.AgentInfo).filter(models.AgentInfo.client_id == "test-client-ip").delete()
    db.query(models.Client).filter(models.Client.id == "test-client-ip").delete()
    db.commit()
    db.close()


@pytest.mark.anyio
async def test_agent_registration_saves_and_reports_ip():
    client_id = "test-client-ip"
    register_msg = {
        "type": "register",
        "data": {
            "client_id": client_id,
            "version": "3.2.1",
            "hostname": "test-host",
            "os": "linux",
            "arch": "amd64",
            "platform": "debian",
            "ip": "192.168.1.14",
            "ips": ["192.168.1.14", "172.17.0.1"]
        }
    }

    await _handle_agent_message(client_id, register_msg)

    # 验证数据库中持久化了 IP
    db = SessionLocal()
    try:
        agent = db.query(models.AgentInfo).filter(models.AgentInfo.client_id == client_id).first()
        assert agent is not None
        assert agent.ip == "192.168.1.14"
        assert agent.ips is not None
        assert "192.168.1.14" in agent.ips

        # 验证 _build_client_agent_info 正确组装了 ip 和 ips
        info = _build_client_agent_info(db, client_id)
        assert info["ip"] == "192.168.1.14"
        assert "192.168.1.14" in info["ips"]
    finally:
        db.close()
