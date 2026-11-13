"""Verify HTTPS termination and long polling through a local reverse proxy."""

import ipaddress
import os
import sqlite3
import ssl
import subprocess
import sys
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from urllib.request import HTTPSHandler, build_opener
from uuid import uuid4

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from examples.http_agent import Demo, NoRedirect, RequestFailure

from tests.integration.test_http_example import ADMIN, ROOT, eventually, stop, unused_port


def proxy_tls(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "QuantBot test proxy")])
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(minutes=5))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
        .public_bytes(serialization.Encoding.PEM)
    )
    cert_file, key_file = tmp_path / "proxy.pem", tmp_path / "proxy.key"
    cert_file.write_bytes(certificate)
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),  # Test-only ephemeral key.
        )
    )
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_file, key_file)
    return server_context, ssl.create_default_context(cafile=str(cert_file))


def test_tls_proxy_preserves_authorization_and_long_poll(tmp_path):
    port = unused_port()
    origin = f"http://127.0.0.1:{port}"
    password = "proxy-test-only-password"
    started_poll = Event()
    server_tls, client_tls = proxy_tls(tmp_path)

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def forward(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            headers = {
                key: value
                for key, value in self.headers.items()
                if key.lower() not in {"connection", "content-length", "x-forwarded-proto"}
            }
            headers["X-Forwarded-Proto"] = "https"
            if self.path.startswith("/api/agent/commands?"):
                started_poll.set()
            with httpx.Client(base_url=origin, timeout=12, trust_env=False) as backend:
                response = backend.request(self.command, self.path, content=body, headers=headers)
            self.send_response(response.status_code)
            for key, value in response.headers.multi_items():
                if key not in {"server", "date", "connection", "transfer-encoding"}:
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(response.content)

        do_POST = do_PUT = do_GET = forward

    with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy:
        proxy.socket = server_tls.wrap_socket(proxy.socket, server_side=True)
        worker = Thread(target=proxy.serve_forever, daemon=True)
        worker.start()
        public = f"https://127.0.0.1:{proxy.server_port}"
        env = {key: value for key, value in os.environ.items() if not key.startswith("QB_")}
        env.update(QB_ADMIN_PASSWORD=password, QB_PUBLIC_URL=public)
        service = subprocess.Popen(  # noqa: S603
            [
                sys.executable,
                "-m",
                "quantbot",
                "--data-dir",
                str(tmp_path / "server"),
                "serve",
                "--port",
                str(port),
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            with httpx.Client(
                base_url=public, verify=client_tls, timeout=2, trust_env=False
            ) as admin:
                eventually(lambda: admin.get("/healthz").is_success)
                login = admin.post(
                    ADMIN + "/login", json={"username": "admin", "password": password}
                )
                assert login.is_success
                assert "Secure" in login.headers["Set-Cookie"]
                created = admin.post(
                    ADMIN + "/strategies", json={"name": "HTTPS proxy", "mode": "paper"}
                ).json()
                credential = created["credential"]
                with closing(sqlite3.connect(":memory:")) as db:
                    demo = Demo(public + "/api/agent", credential["token"], "proxy-test", db, False)
                    payload = {
                        "instance_id": "proxy-test",
                        "executor": True,
                        "capabilities": [{"id": "refresh", "label": "Refresh simulated cache"}],
                    }
                    with pytest.raises(RequestFailure, match="tls"):
                        demo.http("POST", "/session", payload)
                    demo.opener = build_opener(NoRedirect, HTTPSHandler(context=client_tls))
                    session = demo.http("POST", "/session", payload)
                    assert session["executor"]
                    demo.headers["X-Agent-Session"] = session["session_id"]

                    replies = []
                    poll = Thread(
                        target=lambda: replies.append(demo.http("GET", "/commands?wait=8")),
                        daemon=True,
                    )
                    poll.start()
                    assert started_poll.wait(2)
                    command = admin.post(
                        f"{ADMIN}/strategies/{credential['strategy_id']}/commands",
                        json={"action": "refresh", "request_id": uuid4().hex},
                    )
                    assert command.status_code == 201
                    poll.join(3)
                    assert not poll.is_alive()
                    assert replies[0]["commands"][0]["id"] == command.json()["id"]
        finally:
            stop(service)
            proxy.shutdown()
            worker.join()
