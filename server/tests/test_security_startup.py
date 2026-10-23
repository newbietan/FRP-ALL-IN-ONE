"""Exercise the startup policy with a recording Python shim, never a live server."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("tls", [False, True])
def test_backend_binds_loopback_unless_explicitly_configured(tmp_path, tls):
    shim = tmp_path / "python"
    shim.write_text(f"#!{sys.executable}\nimport json,sys;print(json.dumps(sys.argv[1:]))\n")
    shim.chmod(0o700)
    env = {key: value for key, value in os.environ.items() if not key.startswith("FRP_TLS_")}
    env.pop("FRP_LISTEN_HOST", None)
    env.pop("FRP_TRUSTED_PROXY_IPS", None)
    env["PATH"] = str(tmp_path) + os.pathsep + env["PATH"]
    if tls:
        env.update(FRP_LISTEN_HOST="198.51.100.5", FRP_TLS_CERT="/tls/cert with spaces.pem", FRP_TLS_KEY="/tls/key.pem")
    result = subprocess.run(["bash", str(ROOT / "server/run.sh")], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    args = json.loads(result.stdout)
    assert args[:3] == ["-m", "uvicorn", "main:app"]
    assert args[args.index("--host") + 1] == ("198.51.100.5" if tls else "127.0.0.1")
    assert args[args.index("--port") + 1] == "443"
    assert args[args.index("--ws-max-size") + 1] == "1048576"
    assert args[args.index("--forwarded-allow-ips") + 1] == "127.0.0.1,::1"
    if tls:
        assert args[args.index("--ssl-certfile") + 1] == "/tls/cert with spaces.pem"
        assert args[args.index("--ssl-keyfile") + 1] == "/tls/key.pem"
    else:
        assert "--ssl-certfile" not in args


@pytest.mark.parametrize("variable", ["FRP_TLS_CERT", "FRP_TLS_KEY"])
def test_partial_tls_configuration_fails_before_starting_python(tmp_path, variable):
    env = {key: value for key, value in os.environ.items() if not key.startswith("FRP_TLS_")}
    env[variable] = "/tls/only-one-file.pem"
    result = subprocess.run(["bash", str(ROOT / "server/run.sh")], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "must be configured together" in result.stderr


def test_default_compose_does_not_mount_engine_socket():
    compose = (ROOT / "deploy/compose.yml").read_text()
    active_lines = [line.strip() for line in compose.splitlines() if not line.lstrip().startswith("#")]
    assert not any("docker.sock" in line for line in active_lines)
    assert 'CMD ["bash", "/app/run.sh"]' in (ROOT / "server/Dockerfile").read_text()
    assert "--require-hashes -r requirements.lock" in (ROOT / "server/Dockerfile").read_text()


def test_tls_manager_ensure_self_signed_cert_ip_and_dns(tmp_path, monkeypatch):
    from services.tls_manager import TLSManager
    monkeypatch.setenv("FRP_CERTS_DIR", str(tmp_path / "certs"))
    tm = TLSManager()
    cert, key, fp = tm.ensure_self_signed_cert("198.51.100.99")
    assert cert.is_file() and key.is_file()
    assert len(fp) == 64
    out = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-text", "-noout"], text=True)
    assert "IP Address:198.51.100.99" in out
    assert "DNS:localhost" in out
    info = tm.get_self_signed_cert_info()
    assert info and info["fingerprint"] == fp


def test_generated_script_includes_fingerprint_for_self_signed():
    from routers import frp_server
    fp = "aabbcc112233" * 5 + "1234"
    script = frp_server._generate_unix_script("1.1.1.1", 7000, "token", "c1", "tok", "linux", tls_fingerprint=fp)
    assert f"TLS_FINGERPRINT={fp}" in script
    assert '-e FRP_AGENT_TLS_FINGERPRINT="$TLS_FINGERPRINT"' in script
    win_script = frp_server._generate_windows_script("1.1.1.1", 7000, "token", "c1", "tok", tls_fingerprint=fp)
    assert f"$TLS_FINGERPRINT = '{fp}'" in win_script
    assert 'FRP_AGENT_TLS_FINGERPRINT="$TLS_FINGERPRINT"' in win_script
