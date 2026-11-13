import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from fastapi.testclient import TestClient

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


def test_remote_setup_is_disabled(tmp_path):
    app = make_app(tmp_path / "quantbot.sqlite3", docker_local_http=True, telegram_network=False)
    with TestClient(
        app, base_url="https://console.example.test", client=("172.20.0.1", 1234)
    ) as client:
        assert client.get(SETUP).json() == {"required": True, "available": False}
        assert (
            client.post(SETUP, json=ACCOUNT, headers={"Origin": str(client.base_url)}).status_code
            == 403
        )
        assert client.get("http://console.example.test:8888/healthz").status_code == 426
        assert (
            client.get(ORIGIN + "/healthz", headers={"Forwarded": "for=8.8.8.8"}).status_code == 426
        )
        assert client.get(ORIGIN + "/healthz").status_code == 200
    with TestClient(app, base_url=ORIGIN, client=("8.8.8.8", 1234)) as client:
        assert client.get("/healthz").status_code == 426
