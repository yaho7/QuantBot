import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from quantbot.__main__ import docker_gateway, trusted_proxies
from quantbot.v2.api import make_app

SETUP = "/api/v2/admin/setup"
ORIGIN = "http://localhost:8888"
ACCOUNT = {"username": "operator", "password": "setup-test-password"}


def test_first_run_creates_administrator_once(tmp_path):
    path = tmp_path / "quantbot.sqlite3"
    app = make_app(path, docker_local_http=True, telegram_network=False)
    with TestClient(app, base_url=ORIGIN, client=("172.20.0.1", 1234)) as client:
        assert client.get(SETUP).json() == {"required": True, "available": True}
        assert client.post(SETUP, json=ACCOUNT).status_code == 403
        assert (
            client.post(SETUP, json=ACCOUNT, headers={"Origin": "http://evil.test"}).status_code
            == 403
        )
        headers = {"Origin": ORIGIN}
        assert (
            client.post(SETUP, json={**ACCOUNT, "password": "short"}, headers=headers).status_code
            == 422
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(
                pool.map(
                    lambda _: client.post(SETUP, json=ACCOUNT, headers=headers).status_code,
                    range(2),
                )
            )
        assert statuses == [201, 409]
        assert client.get("/api/v2/admin/session").json() == {"actor": "web:operator"}
        assert client.get(SETUP).json() == {"required": False, "available": False}
    with closing(sqlite3.connect(path)) as db:
        assert (
            ACCOUNT["password"]
            not in db.execute("SELECT value FROM settings WHERE name='administrator'").fetchone()[0]
        )
    with TestClient(app, base_url=ORIGIN, client=("172.20.0.1", 1234)) as client:
        assert client.get(SETUP).json() == {"required": False, "available": False}
        assert client.post("/api/v2/admin/login", json=ACCOUNT).status_code == 200


def test_remote_plain_http_is_rejected(tmp_path):
    app = make_app(tmp_path / "quantbot.sqlite3", docker_local_http=True, telegram_network=False)
    with TestClient(
        app, base_url="https://console.example.test", client=("172.20.0.1", 1234)
    ) as client:
        assert client.get(SETUP).json() == {"required": True, "available": True}
        assert (
            client.post(
                "http://console.example.test:8888" + SETUP,
                json=ACCOUNT,
                headers={"Origin": "http://console.example.test:8888"},
            ).status_code
            == 426
        )
        assert client.get("http://console.example.test:8888/healthz").status_code == 426
        assert (
            client.get(ORIGIN + "/healthz", headers={"Forwarded": "for=8.8.8.8"}).status_code == 426
        )
        assert client.get(ORIGIN + "/healthz").status_code == 200
    with TestClient(app, base_url=ORIGIN, client=("8.8.8.8", 1234)) as client:
        assert client.get("/healthz").status_code == 426


def test_docker_host_proxy_supports_first_run_setup_over_https(tmp_path, monkeypatch):
    routes = tmp_path / "route"
    routes.write_text("Iface Destination Gateway Flags\neth0 00000000 010012AC 0003\n")
    link = tmp_path / "eth0"
    link.mkdir()
    (link / "ifindex").write_text("2\n")
    (link / "iflink").write_text("3\n")
    gateway = docker_gateway(routes, tmp_path)
    assert gateway == "172.18.0.1"
    monkeypatch.setattr("quantbot.__main__.docker_gateway", lambda: gateway)
    monkeypatch.delenv("QB_TRUST_PROXY", raising=False)
    app = ProxyHeadersMiddleware(
        make_app(tmp_path / "quantbot.sqlite3", docker_local_http=True, telegram_network=False),
        trusted_hosts=trusted_proxies(docker_local_http=True),
    )
    forwarded = {"X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.10"}
    domain = "http://quantbot.example.test"
    with TestClient(app, base_url=ORIGIN, client=(gateway, 1234)) as client:
        assert client.get(SETUP).json() == {"required": True, "available": True}
        assert client.get(domain + SETUP, headers=forwarded).json() == {
            "required": True,
            "available": True,
        }
        assert client.get(domain + SETUP).status_code == 426
        headers = {**forwarded, "Origin": "https://quantbot.example.test"}
        assert client.post(domain + SETUP, json=ACCOUNT, headers=forwarded).status_code == 403
        setup = client.post(domain + SETUP, json=ACCOUNT, headers=headers)
        assert setup.status_code == 201
        assert "Secure" in setup.headers["set-cookie"]
        assert client.get(domain + SETUP, headers=forwarded).json() == {
            "required": False,
            "available": False,
        }
        assert client.post(domain + SETUP, json=ACCOUNT, headers=headers).status_code == 409
    with TestClient(app, base_url=domain, client=("172.18.0.2", 1234)) as client:
        assert client.get(SETUP, headers=forwarded).status_code == 426
    monkeypatch.setenv("QB_TRUST_PROXY", "172.18.0.3")
    assert trusted_proxies(docker_local_http=True) == "172.18.0.3"
