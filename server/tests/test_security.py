# pyright: reportMissingImports=false
"""Security regressions use fake identities, in-memory SQL and local ASGI only."""
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
import crud
import main
import models
from core import get_db
from core.rate_limit import limiter
from core.security import public_base_url, secure_transport_allowed
from database import Base
from routers import auth as oauth
from routers import frp_server
from services.agent_upgrades import issue_grant


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session
    engine.dispose()


class FakeGitHub:
    calls = 0
    user = {"id": 424242, "login": "audit-owner", "avatar_url": ""}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def post(self, *args, **kwargs):
        FakeGitHub.calls += 1
        return FakeResponse({"access_token": "fake-provider-token"})

    async def get(self, *args, **kwargs):
        return FakeResponse(FakeGitHub.user)


class FakeResponse:
    status_code = 200

    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


@pytest.fixture
def client(db, monkeypatch):
    for key in ("FRP_ALLOW_INSECURE_HTTP", "FRP_ENABLE_REMOTE_UPGRADE", "FRP_PUBLIC_URL",
                "INITIAL_ADMIN_GITHUB_ID", "INITIAL_ADMIN_GITHUB_USERNAME"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(auth, "GITHUB_CLIENT_ID", "fake-client-id")
    monkeypatch.setattr(auth, "GITHUB_CLIENT_SECRET", "fake-client-secret")
    monkeypatch.setattr(oauth.httpx, "AsyncClient", FakeGitHub)
    FakeGitHub.calls = 0
    FakeGitHub.user = {"id": 424242, "login": "audit-owner", "avatar_url": ""}
    oauth._oauth_states.clear()
    limiter.reset()
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(main.app, base_url="https://panel.example")
    finally:
        main.app.dependency_overrides.clear()
        oauth._oauth_states.clear()


def login_state(client):
    response = client.get("/api/auth/github", follow_redirects=False)
    assert response.status_code == 307
    return parse_qs(urlsplit(response.headers["location"]).query)["state"][0], response


def administrator(db):
    return crud.create_admin_from_github(db, 424242, "audit-owner", "", True)


def access_token(admin):
    return auth.create_access_token({"sub": str(admin.github_id), "purpose": "access"})


@pytest.mark.parametrize("path", ["/%2e%2e/secret", "/..%2fsecret", "/%2e%2e%2fsecret",
                                  "/%2e%2e/data/.jwt_secret", "/%2e%2e/data/frp_manager.db"])
def test_unauthenticated_traversal_is_rejected(client, tmp_path, monkeypatch, path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("public SPA")
    (tmp_path / "secret").write_text("fake-private-data")
    (tmp_path / "data").mkdir()
    (tmp_path / "data/.jwt_secret").write_text("fake-private-signing-key")
    (tmp_path / "data/frp_manager.db").write_text("fake-private-database")
    monkeypatch.setattr(main, "_static_dir", static)
    response = client.get(path)
    assert response.status_code == 404
    assert "fake-private" not in response.text


def test_absolute_paths_and_escaping_symlinks_are_rejected(client, tmp_path, monkeypatch):
    static = tmp_path / "static"
    static.mkdir()
    secret = tmp_path / "secret"
    secret.write_text("fake-private-data")
    (static / "index.html").write_text("public SPA")
    (static / "escape.txt").symlink_to(secret)
    monkeypatch.setattr(main, "_static_dir", static)
    assert client.get("/%2f" + str(secret).lstrip("/")).status_code == 404
    assert client.get("/escape.txt").status_code == 404
    (static / "index.html").unlink()
    (static / "index.html").symlink_to(secret)
    assert client.get("/dashboard").status_code == 404


def test_public_assets_and_spa_still_work(client, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("public SPA")
    (tmp_path / "app.js").write_text("public JavaScript")
    (tmp_path / ".hidden").write_text("fake-private-data")
    monkeypatch.setattr(main, "_static_dir", tmp_path)
    assert client.get("/dashboard").text == "public SPA"
    assert client.get("/app.js").text == "public JavaScript"
    assert client.get("/.hidden").status_code == 404
    assert client.get("/api/not-a-route").status_code == 404


@pytest.mark.parametrize("invalid_state", [None, "mismatch", "access", "upgrade"])
def test_callback_rejects_missing_wrong_or_cross_purpose_state(client, db, invalid_state):
    admin = administrator(db)
    login_state(client)
    state = invalid_state
    if state == "access":
        state = access_token(admin)
    elif state == "upgrade":
        state = issue_grant(db, "fake-device", "v2.0.0")
    params = {"code": "fake-code"}
    if state is not None:
        params["state"] = state
    response = client.get("/api/auth/github/callback", params=params, follow_redirects=False)
    assert response.status_code == 400
    assert FakeGitHub.calls == 0


def test_callback_requires_browser_cookie_and_does_not_consume_other_browser_state(client, db):
    administrator(db)
    state, _ = login_state(client)
    cookie = client.cookies.get(oauth._COOKIE)
    client.cookies.clear()
    params = {"code": "fake-code", "state": state}
    assert client.get("/api/auth/github/callback", params=params).status_code == 400
    assert state in oauth._oauth_states
    client.cookies.set(oauth._COOKIE, cookie, path=oauth._COOKIE_PATH)
    response = client.get("/api/auth/github/callback", params=params, follow_redirects=False)
    assert response.status_code == 307
    assert "#access_token=" in response.headers["location"]
    client.cookies.set(oauth._COOKIE, cookie, path=oauth._COOKIE_PATH)
    assert client.get("/api/auth/github/callback", params=params).status_code == 400
    assert FakeGitHub.calls == 1


def test_oauth_cookie_is_secure_and_state_expires(client):
    state, response = login_state(client)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert response.headers["cache-control"] == "no-store"
    oauth._oauth_states[state]["expires"] = 0
    response = client.get("/api/auth/github/callback", params={"code": "fake-code", "state": state})
    assert response.status_code == 400
    assert FakeGitHub.calls == 0


def test_bootstrap_without_preset_owner_fails_closed(client, db):
    state, _ = login_state(client)
    response = client.get("/api/auth/github/callback", params={"code": "fake-code", "state": state})
    assert response.status_code == 503
    assert crud.count_admins(db) == 0


@pytest.mark.parametrize("expected_id,expected_username,allowed", [
    ("424242", "", True), ("", "AUDIT-OWNER", True),
    ("999999", "audit-owner", False), ("", "someone-else", False),
])
def test_bootstrap_is_bound_to_owner_and_id_takes_priority(client, db, monkeypatch, expected_id, expected_username, allowed):
    monkeypatch.setenv("INITIAL_ADMIN_GITHUB_ID", expected_id)
    monkeypatch.setenv("INITIAL_ADMIN_GITHUB_USERNAME", expected_username)
    state, _ = login_state(client)
    response = client.get("/api/auth/github/callback", params={"code": "fake-code", "state": state}, follow_redirects=False)
    assert response.status_code == 307
    assert ("#access_token=" in response.headers["location"]) is allowed
    assert crud.count_admins(db) == int(allowed)


def test_rebind_requires_authenticated_post_and_same_browser(client, db):
    admin = administrator(db)
    token = access_token(admin)
    assert client.get("/api/auth/github/rebind", params={"token": token}).status_code in {404, 405}
    assert client.post("/api/auth/github/rebind").status_code == 401
    response = client.post("/api/auth/github/rebind", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 200
    assert token not in response.text
    state = parse_qs(urlsplit(response.json()["authorization_url"]).query)["state"][0]
    FakeGitHub.user = {"id": 555555, "login": "replacement-owner", "avatar_url": ""}
    response = client.get("/api/auth/github/callback", params={"code": "fake-code", "state": state}, follow_redirects=False)
    assert response.status_code == 307
    assert crud.get_admin_by_github_id(db, 424242) is None
    assert crud.get_admin_by_github_id(db, 555555) is not None
    assert client.get("/api/auth/profile", headers={"Authorization": "Bearer " + token}).status_code == 401


def test_transport_policy_ignores_spoofed_forwarding_headers(client, db, monkeypatch):
    admin = administrator(db)
    headers = {"Authorization": "Bearer " + access_token(admin), "x-forwarded-proto": "https", "x-forwarded-host": "safe.example"}
    assert client.get("/api/auth/profile", headers=headers).status_code == 200
    insecure = TestClient(main.app, base_url="http://panel.example")
    assert insecure.get("/api/auth/profile", headers=headers).status_code == 400
    assert insecure.get("/api/auth/github", headers=headers).status_code == 400
    assert insecure.get("/api/frp/agent/install/linux?key=fake", headers=headers).status_code == 400
    monkeypatch.setenv("FRP_ALLOW_INSECURE_HTTP", "1")
    assert insecure.get("/api/auth/profile", headers=headers).status_code == 200


@pytest.mark.parametrize("host,peer,scheme,allowed", [
    ("localhost", "127.0.0.1", "http", True),
    ("127.0.0.1", "198.51.100.1", "http", False),
    ("panel.example", "127.0.0.1", "http", False),
    ("panel.example", "198.51.100.1", "https", True),
])
def test_only_real_local_development_may_use_plaintext(monkeypatch, host, peer, scheme, allowed):
    monkeypatch.delenv("FRP_ALLOW_INSECURE_HTTP", raising=False)
    request = Request({"type": "http", "scheme": scheme, "server": (host, 80), "client": (peer, 1), "headers": [], "path": "/"})
    assert secure_transport_allowed(request) is allowed


def test_canonical_origin_ignores_raw_forwarded_host_and_origin(client, db, monkeypatch):
    request = Request({"type": "http", "scheme": "https", "server": ("panel.example", 8443), "headers": [
        (b"x-forwarded-host", b"attacker.example"), (b"x-forwarded-proto", b"http"), (b"origin", b"https://attacker.example")], "path": "/"})
    assert public_base_url(request, db) == "https://panel.example:8443"
    monkeypatch.setenv("FRP_PUBLIC_URL", "https://canonical.example:10967")
    assert public_base_url(request, db) == "https://canonical.example:10967"


@pytest.mark.parametrize("base", ["http://panel.example", "https://user@panel.example",
                                  "https://panel.example:0", "https://panel.example:99999",
                                  "https://panel.example/path", "https://panel.example/#fragment"])
def test_invalid_or_plaintext_public_origins_fail_closed(client, monkeypatch, base):
    monkeypatch.setenv("FRP_PUBLIC_URL", base)
    assert client.get("/api/auth/github", follow_redirects=False).status_code == 400
    assert not oauth._oauth_states


def test_login_callback_and_redirect_use_stored_origin(client, db, monkeypatch):
    administrator(db)
    monkeypatch.setenv("FRP_PUBLIC_URL", "https://canonical.example:10967")
    state, response = login_state(client)
    assert "canonical.example" in parse_qs(urlsplit(response.headers["location"]).query)["redirect_uri"][0]
    response = client.get("/api/auth/github/callback", params={"code": "fake-code", "state": state},
                          headers={"host": "attacker.example", "x-forwarded-host": "attacker.example"}, follow_redirects=False)
    assert response.headers["location"].startswith("https://canonical.example:10967/#access_token=")


def test_install_key_cannot_retrieve_existing_device_credentials(client, db):
    device = crud.create_client_with_token(db, "fake-device")
    crud.set_config(db, models.ConfigKeys.SERVER_INSTALL_TOKEN, "fake-install-key")
    response = client.get("/api/frp/agent/install/linux", params={"key": "fake-install-key", "client_id": device.id})
    assert response.status_code == 403
    assert device.auth_token not in response.text
    before = db.query(models.Client).count()
    response = client.get("/api/frp/agent/install/linux", params={"key": "fake-install-key"})
    assert response.status_code == 200
    assert db.query(models.Client).count() == before + 1
    assert "MANAGER_WS_URL=wss://panel.example/" in response.text
    assert "ENABLE_REMOTE_UPGRADE=0" in response.text
    assert response.headers["cache-control"] == "no-store"


def test_remote_upgrade_socket_requires_explicit_opt_in(client, monkeypatch):
    arguments = ("example.test", 7000, "fake-frps-token", "fake-client", "fake-client-token")
    script = frp_server._generate_unix_script(*arguments, "linux")
    assert "ENABLE_REMOTE_UPGRADE=0" in script
    assert 'if [ "$ENABLE_REMOTE_UPGRADE" = "1" ]; then' in script
    windows = frp_server._generate_windows_script(*arguments)
    assert "$ENABLE_REMOTE_UPGRADE = $false" in windows
    assert "@SocketArgs" in windows
    monkeypatch.setenv("FRP_ENABLE_REMOTE_UPGRADE", "1")
    assert "ENABLE_REMOTE_UPGRADE=1" in frp_server._generate_unix_script(*arguments, "linux")
    assert "$ENABLE_REMOTE_UPGRADE = $true" in frp_server._generate_windows_script(*arguments)


def test_websocket_and_http_reject_wrong_purpose_and_nonexpiring_tokens(client, db):
    admin = administrator(db)
    upgrade = auth.create_access_token({"sub": str(admin.github_id), "purpose": "agent-upgrade-script"})
    no_expiry = jwt.encode({"sub": str(admin.github_id)}, auth.get_secret_key(), algorithm=auth.ALGORITHM)
    assert main._get_admin_from_token(db, upgrade) is None
    assert main._get_admin_from_token(db, no_expiry) is None
    unsigned = jwt.encode({"sub": str(admin.github_id)}, key="", algorithm="none")
    for token in (upgrade, no_expiry, unsigned):
        assert client.get("/api/auth/profile", headers={"Authorization": "Bearer " + token}).status_code == 401


def test_install_command_supports_self_signed_tls(client, db):
    admin = administrator(db)
    token = access_token(admin)
    response = client.get("/api/frp/agent/install-command", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 200
    data = response.json()
    assert "commands" in data
    assert data["commands"]["linux"].startswith("curl -kfsSL '")
    assert data["commands"]["linux"].endswith("' | sudo bash")
    assert data["commands"]["darwin"].startswith("curl -kfsSL '")
    assert data["commands"]["darwin"].endswith("' | bash")
    assert "ServerCertificateValidationCallback" in data["commands"]["windows"]
    assert "Invoke-RestMethod" in data["commands"]["windows"]


def test_generate_script_insecure_tls_and_fingerprint():
    arguments = ("120.46.213.43", 7000, "token", "client-1", "secret")
    unix_script = frp_server._generate_unix_script(*arguments, "linux", tls_fingerprint="abc123fp", insecure_tls=True)
    assert 'TLS_FINGERPRINT=abc123fp' in unix_script
    assert 'INSECURE_TLS=1' in unix_script
    assert '-e FRP_AGENT_INSECURE_TLS="$INSECURE_TLS"' in unix_script
    assert '-e FRP_AGENT_TLS_FINGERPRINT="$TLS_FINGERPRINT"' in unix_script

    win_script = frp_server._generate_windows_script(*arguments, tls_fingerprint="abc123fp", insecure_tls=True)
    assert "$TLS_FINGERPRINT = 'abc123fp'" in win_script
    assert "$INSECURE_TLS = '1'" in win_script
    assert '-e FRP_AGENT_INSECURE_TLS="$INSECURE_TLS"' in win_script
    assert '-e FRP_AGENT_TLS_FINGERPRINT="$TLS_FINGERPRINT"' in win_script

