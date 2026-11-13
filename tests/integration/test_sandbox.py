import sqlite3
from concurrent.futures import ThreadPoolExecutor

from .test_control_plane import ADMIN, AGENT, NOW, create, stamp, token_headers
from .test_control_plane import server as server
from .test_registry import packet

SANDBOX = "/api/sandbox/agent"


def test_sandbox_protocol_lifecycle_and_isolation(server):
    http, clock, path = server
    sid, formal = create(http)
    url = f"{ADMIN}/strategies/{sid}/sandbox"
    assert http.get(url).json() is None
    assert http.post(url, headers={"Origin": "https://elsewhere.example"}).status_code == 403
    original = http.get(f"{ADMIN}/strategies/{sid}").json()
    with sqlite3.connect(path) as db:
        before = "\n".join(db.iterdump())
    sandbox = http.post(url).json()
    assert sandbox["endpoint"] == "https://testserver" + SANDBOX
    assert sandbox["expires_at"] == stamp(NOW + 3600).replace("+00:00", "Z")
    assert http.post(url).json()["secret"] == sandbox["secret"]
    assert "secret" not in http.get(url).json()

    body = {
        "instance_id": "sandbox-test",
        "executor": True,
        "capabilities": [
            {"id": "pause_entry", "label": "Pause"},
            {"id": "resume_entry", "label": "Resume"},
            {"id": "refresh", "label": "Refresh"},
        ],
    }
    key = {"Authorization": "Bearer " + sandbox["secret"]}
    assert http.post(AGENT + "/session", headers=key, json=body).status_code == 401
    assert (
        http.post(SANDBOX + "/session", headers=token_headers(formal), json=body).status_code == 401
    )
    assert http.post(SANDBOX + "/session", headers=key, json={}).status_code == 422
    session = http.post(SANDBOX + "/session", headers=key, json=body)
    assert session.status_code == 200, session.text
    headers = {**key, "X-Agent-Session": session.json()["session_id"]}
    assert http.put(SANDBOX + "/heartbeat", headers=headers, json={}).status_code == 200
    assert (
        http.post(SANDBOX + "/reports", headers=headers, json={"records": [{}]}).status_code == 422
    )
    equity = packet("equity", account_id="test", currency="USD", value="42")
    assert (
        http.post(SANDBOX + "/reports", headers=headers, json={"records": [equity]}).status_code
        == 200
    )
    control = {"id": "entry", "label": "Entry", "type": "toggle", "command": "set_trading_enabled"}
    refresh = {"id": "refresh_button", "label": "Refresh", "type": "button", "command": "refresh"}
    registry = {"schema_version": 1, "revision": 1, "controls": [control, refresh]}
    assert http.put(SANDBOX + "/controls", headers=headers, json=registry).status_code == 200
    queue = http.get(SANDBOX + "/commands", headers=headers).json()
    assert queue["control"]["desired"]["entry_enabled"] is False
    sync = {
        "revision": queue["control"]["desired"]["revision"],
        "entry_enabled": False,
        "risk_locked": False,
        "disconnect_policy_applied": "continue",
    }
    assert http.put(SANDBOX + "/control/reported", headers=headers, json=sync).status_code == 200
    assert queue["commands"][0]["control_id"] == "refresh_button"
    cid = queue["commands"][0]["id"]
    command = SANDBOX + f"/commands/{cid}"
    permit = http.post(command + "/claim", headers=headers).json()["permit"]
    assert (
        http.post(
            command + "/result", headers=headers, json={"permit": permit, "status": "succeeded"}
        ).status_code
        == 200
    )
    status = http.get(url).json()
    assert status["passed"]
    assert status["controls"][0]["id"] == "entry"
    assert any(item["status"] == 422 for item in status["requests"])

    clock.value += 3400
    action = f"{url}/{sandbox['key']}"
    renewed = http.post(action + "/renew").json()
    assert renewed["expires_at"] == stamp(NOW + 7000).replace("+00:00", "Z")
    assert http.post(url).json()["secret"] == sandbox["secret"]
    assert http.post(action + "/close").json()["status"] == "closed"
    assert http.get(SANDBOX + "/control", headers=headers).status_code == 401
    second = http.post(url).json()
    assert second["secret"] != sandbox["secret"]
    clock.value += 3600
    assert http.get(url).json()["status"] == "expired"
    assert (
        http.post(
            SANDBOX + "/session", headers=token_headers({"token": second["secret"]}), json=body
        ).status_code
        == 401
    )
    assert http.post(f"{url}/{second['key']}/renew").status_code == 409
    with sqlite3.connect(path) as db:
        assert "\n".join(db.iterdump()) == before
    assert http.get(f"{ADMIN}/strategies/{sid}").json() == original


def test_sandbox_auth_capacity_and_body_limits(server, monkeypatch):
    from quantbot.core import sandbox as limits

    http, _, _ = server
    sid, _ = create(http)
    url = f"{ADMIN}/strategies/{sid}/sandbox"
    monkeypatch.setattr(limits, "KEY_RATE", 2)
    monkeypatch.setattr(limits, "GLOBAL_RATE", 4)
    monkeypatch.setattr(limits, "MAX_SESSIONS", 1)
    with ThreadPoolExecutor(4) as executor:
        copies = list(executor.map(lambda _: http.post(url).json(), range(4)))
    assert len({copy["secret"] for copy in copies}) == 1
    other, _ = create(http)
    assert http.post(f"{ADMIN}/strategies/{other}/sandbox").status_code == 429
    headers = token_headers({"token": copies[0]["secret"]})
    oversized = http.post(SANDBOX + "/session", headers=headers, json={"padding": "x" * 65536})
    assert oversized.status_code == 413
    assert http.post(SANDBOX + "/session", headers=headers, json={}).status_code == 422
    assert http.post(SANDBOX + "/session", headers=headers, json={}).status_code == 429
    assert http.get(SANDBOX + "/commands").status_code == 401
    assert http.get(SANDBOX + "/commands").status_code == 429
    http.cookies.clear()
    assert http.post(url).status_code == 401


def test_sandbox_concurrency_and_storage_cap(server, monkeypatch):
    import asyncio
    from threading import Event

    from quantbot.core import sandbox as limits

    http, _, _ = server
    sid, _ = create(http)
    url = f"{ADMIN}/strategies/{sid}/sandbox"
    credentials = http.post(url).json()
    headers = token_headers({"token": credentials["secret"]})
    entered = Event()
    release = Event()
    original = limits.Sandboxes.dispatch

    async def slow(self, app, scope, receive, send, secret, path, request_id):
        if path == "/session":

            async def blocked(*args):
                entered.set()
                while not release.is_set():
                    await asyncio.sleep(0.01)
                await app(*args)

            return await original(self, blocked, scope, receive, send, secret, path, request_id)
        return await original(self, app, scope, receive, send, secret, path, request_id)

    monkeypatch.setattr(limits.Sandboxes, "dispatch", slow)
    monkeypatch.setattr(limits, "MAX_IN_FLIGHT", 2)
    monkeypatch.setattr(limits, "KEY_IN_FLIGHT", 1)
    with ThreadPoolExecutor(2) as executor:
        pending = executor.submit(
            http.post, SANDBOX + "/session", headers=headers, json={"instance_id": "bounded"}
        )
        try:
            assert entered.wait(3)
            assert http.get(SANDBOX + "/commands", headers=headers).status_code == 429
            monkeypatch.setattr(limits, "MAX_IN_FLIGHT", 1)
            assert http.get(SANDBOX + "/commands").status_code == 429
            assert http.get("/healthz").status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 200

    pool = http.app.state.sandboxes

    async def fill():
        runtime = pool.sessions[sid].runtime
        pages = runtime.db.one("PRAGMA page_count")[0]
        runtime.db.execute(f"PRAGMA max_page_count={pages}")
        runtime.db.execute("INSERT INTO settings VALUES ('full', zeroblob(8192))")

    import pytest

    with pytest.raises(sqlite3.OperationalError) as full:
        http.portal.call(pool.call, fill())
    assert full.value.sqlite_errorcode == sqlite3.SQLITE_FULL
    assert http.post(f"{url}/{credentials['key']}/close").json()["status"] == "closed"
