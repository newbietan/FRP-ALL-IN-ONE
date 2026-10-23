"""Tiny readiness server for real-Docker transaction tests."""
import contextlib
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

version = os.environ["APP_VERSION"]
if version == "0.0.2":
    (Path(os.environ["FRP_UPGRADE_DATA_DIR"]) / "frps.toml").write_text("migrated")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        ready = not (version == "0.0.2" and os.environ.get("FRP_TEST_FAIL") == "1")
        payload = json.dumps({"ready": ready, "app_version": "v" + version}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)


# The fixture is reachable only through Docker exec, never via the host network.
if __name__ == "__main__":
    port = 443
    with contextlib.suppress(ValueError):
        port = int(os.environ.get("PORT", "443"))
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
