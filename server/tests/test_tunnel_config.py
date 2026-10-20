"""Panel-generated proxy identities must not depend on editable display names."""
import re
import secrets

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import crud
import models
from database import Base
from routers.clients import _render_frpc_toml


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        crud.set_config(session, models.ConfigKeys.SERVER_PUBLIC_IP, "127.0.0.1")
        crud.set_config(session, models.ConfigKeys.FRPS_PORT, "7000")
        crud.set_config(session, models.ConfigKeys.FRPS_AUTH_TOKEN, "fixture")
        yield session
    engine.dispose()


def add_client(db, client_id):
    client = models.Client(id=client_id, name="ubuntu", auth_token=secrets.token_urlsafe(24), status="online")
    db.add(client)
    db.commit()
    return client


def add_tunnel(db, client, remote_port):
    tunnel = models.Tunnel(
        client_id=client.id, name="SSH", type=models.TunnelType.TCP,
        local_ip="127.0.0.1", local_port=22, remote_port=remote_port, enabled=True,
    )
    db.add(tunnel)
    db.commit()
    db.refresh(client)
    return tunnel


def proxy_names(db, client):
    config = _render_frpc_toml(db, client)
    assert config
    return re.findall(r'^name = "([^"]+)"$', config, flags=re.MULTILINE)


def test_same_hostname_and_tunnel_name_are_unique_across_devices(db):
    first = add_client(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    second = add_client(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    first_tunnel = add_tunnel(db, first, 6001)
    second_tunnel = add_tunnel(db, second, 6002)
    first_names = proxy_names(db, first)
    second_names = proxy_names(db, second)
    assert first_names == [f"client-{first.id}.tunnel-{first_tunnel.id}"]
    assert second_names == [f"client-{second.id}.tunnel-{second_tunnel.id}"]
    assert set(first_names).isdisjoint(second_names), "two Ubuntu SSH devices share a global FRPS proxy name"
    assert first.name == second.name == "ubuntu"
    assert first_tunnel.name == second_tunnel.name == "SSH"


def test_same_display_name_is_unique_within_one_device(db):
    client = add_client(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    add_tunnel(db, client, 6001)
    add_tunnel(db, client, 6002)
    names = proxy_names(db, client)
    assert len(names) == len(set(names)) == 2


def test_proxy_identity_survives_display_rename_and_disable_reenable(db):
    client = add_client(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    tunnel = add_tunnel(db, client, 6001)
    original = proxy_names(db, client)
    client.name = 'renamed.host"\n[[proxies]]'
    tunnel.name = 'renamed.SSH"\n[[proxies]]'
    db.commit()
    assert proxy_names(db, client) == original
    tunnel.enabled = False
    db.commit()
    assert proxy_names(db, client) == []
    tunnel.enabled = True
    db.commit()
    assert proxy_names(db, client) == original
