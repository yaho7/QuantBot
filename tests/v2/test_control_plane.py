import sqlite3
import threading
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from quantbot.v2.api import make_app
from quantbot.v2.auth import password_hash
from quantbot.v2.db import encode

NOW = 1_800_000_000
ALL = ["session", "telemetry", "control", "commands"]
CAPS = [
    {"id": "pause_entry", "label": "Pause entries"},
    {"id": "resume_entry", "label": "Resume entries"},
    {"id": "refresh", "label": "Refresh"},
    {"id": "flatten", "label": "Flatten"},
    {"id": "set_parameters", "label": "Set parameters"},
    {
        "id": "custom_refresh",
        "label": "Custom",
        "parameters": {"offset": {"label": "Offset", "type": "decimal", "minimum": "0"}},
    },
]
ADMIN = "/api/v2/admin"
AGENT = "/api/v2/agent"


def stamp(seconds=NOW):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


class Clock:
    value = NOW

    def __call__(self):
        return self.value


def bootstrap(runtime):
    runtime.db.execute(
        "INSERT OR IGNORE INTO settings VALUES ('administrator', ?)",
        (encode({"username": "admin", "password_hash": password_hash("test-password-only")}),),
    )


def client(path, clock, configure=None):
    return TestClient(
        make_app(
            path, clock=clock, bootstrap=bootstrap, configure=configure, telegram_network=False
        ),
        base_url="https://testserver",
    )


def log_in(http):
    response = http.post(
        ADMIN + "/login", json={"username": "admin", "password": "test-password-only"}
    )
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]


@pytest.fixture
def server(tmp_path):
    clock = Clock()
    path = tmp_path / "control.db"
    with client(path, clock) as http:
        log_in(http)
        yield http, clock, path


def create(http, *, scopes=ALL, mode="paper", expires=None):
    response = http.post(
        ADMIN + "/strategies",
        json={
            "name": "策略 A",
            "mode": mode,
            "token": {"scopes": scopes, "expires_at": expires},
        },
    )
    assert response.status_code == 201, response.text
    data = response.json()
    return data["strategy"]["id"], data["credential"]


def token_headers(credential):
    return {"Authorization": f"Bearer {credential['token']}"}


def connect(http, credential, name="primary", *, executor=True):
    response = http.post(
        AGENT + "/session",
        headers=token_headers(credential),
        json={
            "instance_id": name,
            "executor": executor,
            "capabilities": CAPS if executor else [],
        },
    )
    assert response.status_code == 200, response.text
    return {
        **token_headers(credential),
        "X-Agent-Session": response.json()["session_id"],
    }, response.json()


def report(http, headers, rev=0, **fields):
    response = http.put(
        AGENT + "/control/reported",
        headers=headers,
        json={
            "revision": rev,
            "disconnect_policy_applied": "continue",
            "entry_enabled": True,
            "risk_locked": False,
            **fields,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def issue(http, sid, action, request=None, **arguments):
    return http.post(
        f"{ADMIN}/strategies/{sid}/commands",
        json={
            "action": action,
            "arguments": arguments,
            "request_id": request or uuid4().hex,
        },
    )


def poll(http, headers):
    return http.get(AGENT + "/commands", headers=headers).json()["commands"]


def test_credentials_and_scope(server):
    http, clock, path = server
    sid, credential = create(http, scopes=["session", "telemetry"], expires=stamp(NOW + 5))
    other_sid, _ = create(http)
    token = credential["token"]
    tokens = http.get(f"{ADMIN}/strategies/{sid}/tokens").json()
    assert len(tokens) == 1 and "token" not in tokens[0] and "digest" not in tokens[0]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT digest FROM strategy_tokens").fetchone()[0] != token
    assert http.post(AGENT + "/session", json={"instance_id": "x"}).status_code == 401
    assert (
        http.post(
            AGENT + "/session",
            headers={"Authorization": "Bearer invalid"},
            json={"instance_id": "x"},
        ).status_code
        == 401
    )
    independent = TestClient(http.app, base_url="https://testserver")
    assert (
        independent.get(ADMIN + "/strategies", headers=token_headers(credential)).status_code == 401
    )
    headers, _ = connect(http, credential, executor=False)
    assert http.get(AGENT + "/control", headers=headers).status_code == 403
    assert (
        http.delete(f"{ADMIN}/strategies/{other_sid}/tokens/{credential['id']}").status_code == 404
    )
    clock.value += 6
    assert http.put(AGENT + "/heartbeat", headers=headers, json={}).status_code == 401
    rotated = http.post(f"{ADMIN}/strategies/{sid}/tokens/{credential['id']}/rotate", json={})
    assert rotated.status_code == 201
    new_headers, _ = connect(http, rotated.json(), executor=False)
    assert http.delete(f"{ADMIN}/strategies/{sid}/tokens/{rotated.json()['id']}").status_code == 204
    assert http.put(AGENT + "/heartbeat", headers=new_headers, json={}).status_code == 401


def test_telemetry_exactness_validation_and_dedup(server):
    http, clock, _ = server
    sid, credential = create(http)
    headers, _ = connect(http, credential)
    assert (
        http.put(AGENT + "/heartbeat", headers=headers, json={"health": "degraded"}).status_code
        == 200
    )
    assert http.get(f"{ADMIN}/strategies/{sid}").json()["status"] == "abnormal"
    snap = {
        "type": "snapshot",
        "schema_version": 1,
        "observed_at": stamp(),
        "accounts": [{"account_id": "main", "currency": "USD", "equity": "100.000000001"}],
        "metrics": [{"name": "rsi", "value": "55.5"}],
        "strategy_positions": [
            {
                "position_id": "p",
                "account_id": "main",
                "currency": "USD",
                "symbol": "SPY",
                "quantity": "0.00000001",
            }
        ],
    }
    assert http.put(AGENT + "/snapshot", headers=headers, json=snap).status_code == 200
    wrong_version = {**snap, "schema_version": 2}
    invalid = http.put(AGENT + "/snapshot", headers=headers, json=wrong_version)
    assert invalid.status_code == 422 and "input" not in invalid.text
    assert (
        http.put(
            AGENT + "/snapshot", headers=headers, json={**snap, "observed_at": stamp()[:19]}
        ).status_code
        == 422
    )
    assert (
        http.put(
            AGENT + "/snapshot",
            headers=headers,
            json={**snap, "metrics": [{"name": "rsi", "value": 3.4}]},
        ).status_code
        == 422
    )
    detail = http.get(f"{ADMIN}/strategies/{sid}").json()["snapshot"]
    assert detail["broker_positions"] == []
    assert detail["strategy_positions"][0]["quantity"] == "0.00000001"
    clock.value += 10
    points = {
        "metrics": [
            {
                "type": "metric",
                "schema_version": 1,
                "observed_at": stamp(clock.value),
                "name": "rsi",
                "value": "60",
            },
        ]
    }
    assert http.post(AGENT + "/metrics", headers=headers, json=points).json()["inserted"] == 1
    assert http.post(AGENT + "/metrics", headers=headers, json=points).json()["inserted"] == 0
    history = http.get(f"{ADMIN}/strategies/{sid}/metrics", params={"start": stamp()}).json()
    assert {p["value"] for p in history} == {"55.5", "60", "100.000000001"}
    event = {
        "id": "risk-1",
        "type": "event",
        "schema_version": 1,
        "occurred_at": stamp(),
        "category": "risk",
        "severity": "warning",
        "message": "Risk limit triggered",
    }
    assert http.post(AGENT + "/events", headers=headers, json={"events": [event]}).json()[
        "accepted"
    ] == ["risk-1"]
    assert http.post(AGENT + "/events", headers=headers, json={"events": [event]}).json()[
        "duplicates"
    ] == ["risk-1"]
    event["message"] = "Conflicting event ID"
    assert (
        http.post(AGENT + "/events", headers=headers, json={"events": [event]}).status_code == 409
    )
    alerts = http.get(ADMIN + "/alerts").json()
    assert sum(item["category"] == "risk" for item in alerts) == 1


def test_long_poll_wakes_and_only_one_claim_succeeds(server):
    http, _, _ = server
    sid, credential = create(http)
    headers, _ = connect(http, credential)
    start = threading.Event()
    received = []

    def wait():
        start.set()
        response = http.get(AGENT + "/commands", params={"wait": 25}, headers=headers)
        received.append(response.json()["commands"][0])

    thread = threading.Thread(target=wait, daemon=True)
    thread.start()
    assert start.wait(1)
    command = issue(http, sid, "refresh", request="same-request").json()
    thread.join(2)
    assert not thread.is_alive()
    assert received[0]["id"] == command["id"] and received[0]["state"] == "accepted"
    assert issue(http, sid, "refresh", request="same-request").json()["id"] == command["id"]
    assert issue(http, sid, "set_parameters", request="same-request").status_code == 409
    claim = f"{AGENT}/commands/{command['id']}/claim"
    responses = []
    barrier = threading.Barrier(2)

    def claim_once():
        barrier.wait()
        responses.append(http.post(claim, headers=headers))

    racers = [threading.Thread(target=claim_once, daemon=True) for _ in range(2)]
    for racer in racers:
        racer.start()
    for racer in racers:
        racer.join(2)
    assert sorted(item.status_code for item in responses) == [200, 409]
    permit = next(item.json()["permit"] for item in responses if item.status_code == 200)
    result = f"{AGENT}/commands/{command['id']}/result"
    body = {"permit": permit, "status": "succeeded", "result": {"refreshed": True}}
    assert http.post(result, headers=headers, json=body).json()["state"] == "succeeded"
    assert http.post(result, headers=headers, json=body).status_code == 200
    body["status"] = "failed"
    assert http.post(result, headers=headers, json=body).status_code == 409
    assert http.get(f"{ADMIN}/commands/{command['id']}").json()["state"] == "succeeded"
    trail = http.get(ADMIN + "/audit", params={"command_id": command["id"]}).json()
    assert [(row["action"], row["actor"]) for row in trail[:2]] == [
        ("command.succeeded", "agent:primary"),
        ("command.executing", "agent:primary"),
    ]


def test_protected_confirmation_expiry_and_strategy_isolation(server):
    http, clock, _ = server
    sid, credential = create(http)
    headers, _ = connect(http, credential)
    spectator, info = connect(http, credential, "secondary")
    assert info["executor"] is False
    _, other_credential = create(http)
    other, _ = connect(http, other_credential, "other")
    command = issue(http, sid, "flatten").json()
    cid = command["id"]
    assert command["state"] == "confirmation_required" and poll(http, headers) == []
    confirm = f"{ADMIN}/commands/{cid}/confirm"
    assert http.post(confirm).json()["state"] == "pending"
    assert http.post(confirm).status_code == 409
    assert issue(http, sid, "flatten").status_code == 409
    assert poll(http, headers)[0]["id"] == cid
    claim = f"{AGENT}/commands/{cid}/claim"
    assert http.post(claim, headers=spectator).status_code == 403
    assert http.post(claim, headers=other).status_code == 404
    assert http.post(claim, headers=headers).status_code == 409  # unsynchronized shadow
    assert report(http, headers)["in_sync"] is True
    clock.value += 61
    headers, _ = connect(http, credential)
    assert http.post(claim, headers=headers).status_code == 409
    assert http.get(f"{ADMIN}/commands/{cid}").json()["state"] == "expired"

    live, live_credential = create(http, mode="live")
    connect(http, live_credential)
    assert issue(http, live, "flatten").status_code == 403
    assert issue(http, live, "custom_refresh").status_code == 403
    assert issue(http, live, "pause_entry").status_code == 201


def test_restart_disconnect_recovery_and_unknown_result(tmp_path):
    path = tmp_path / "control.db"
    clock = Clock()
    with client(path, clock) as http:
        log_in(http)
        sid, credential = create(http)
        headers, _ = connect(http, credential)
        shadow = issue(http, sid, "pause_entry").json()
        assert shadow["state"] == "pending"
        state = report(http, headers, shadow["revision"], entry_enabled=False)
        assert state["in_sync"] is True
        assert http.get(f"{ADMIN}/commands/{shadow['id']}").json()["state"] == "succeeded"
        assert (
            http.post(
                AGENT + "/metrics",
                headers=headers,
                json={
                    "metrics": [
                        {
                            "type": "metric",
                            "schema_version": 1,
                            "name": "rsi",
                            "value": "30",
                            "observed_at": stamp(),
                        }
                    ]
                },
            ).status_code
            == 200
        )
        command = issue(http, sid, "flatten").json()
        cid = command["id"]
        http.post(f"{ADMIN}/commands/{cid}/confirm")
        poll(http, headers)
        claim = f"{AGENT}/commands/{cid}/claim"
        permit = http.post(claim, headers=headers).json()["permit"]
        pending = issue(http, sid, "refresh").json()
    clock.value += 65
    with client(path, clock) as http:
        log_in(http)
        assert http.get(f"{ADMIN}/commands/{cid}").json()["state"] == "unknown"
        assert http.get(f"{ADMIN}/commands/{pending['id']}").json()["state"] == "expired"
        assert http.get(f"{ADMIN}/strategies/{sid}/metrics").json()[0]["value"] == "30"
        assert http.put(AGENT + "/heartbeat", headers=headers, json={}).status_code == 409
        new_headers, info = connect(http, credential)
        assert info["control"]["desired"]["entry_enabled"] is False
        assert info["control"]["in_sync"] is False
        assert poll(http, new_headers) == []
        assert http.post(claim, headers=new_headers).status_code == 409
        assert issue(http, sid, "flatten").status_code == 409
        assert report(http, new_headers, shadow["revision"], entry_enabled=False)["in_sync"]
        assert (
            http.post(
                f"{AGENT}/commands/{cid}/result",
                headers=new_headers,
                json={"permit": permit, "status": "succeeded"},
            ).json()["state"]
            == "succeeded"
        )
        assert issue(http, sid, "flatten").status_code == 409  # recent successful duplicate


def test_security_transport_and_limits(server):
    http, _, _ = server
    assert (
        http.post(ADMIN + "/strategies", json={}, headers={"Origin": "https://other"}).status_code
        == 403
    )
    assert http.post(AGENT + "/events", content="a" * (1024 * 1024 + 1)).status_code == 413
    assert (
        http.post(
            ADMIN + "/login",
            content='{"password":NaN}',
            headers={"content-type": "application/json"},
        ).status_code
        == 400
    )
    assert http.get("http://testserver/healthz").status_code == 426
    assert (
        http.get("/openapi.json").json()["components"]["securitySchemes"]["StrategyToken"]["scheme"]
        == "bearer"
    )


def test_resume_preserves_local_risk_lock(server):
    http, _, _ = server
    sid, credential = create(http)
    headers, _ = connect(http, credential)
    pause = issue(http, sid, "pause_entry").json()
    assert report(http, headers, pause["revision"], entry_enabled=False, risk_locked=True)[
        "in_sync"
    ]
    resume = issue(http, sid, "resume_entry").json()
    assert http.get(f"{ADMIN}/commands/{resume['id']}").json()["state"] == "pending"
    state = report(http, headers, resume["revision"], entry_enabled=True, risk_locked=True)
    assert state["in_sync"] and state["reported"]["risk_locked"]
    assert state["effective_entry_enabled"] is False
    assert http.get(f"{ADMIN}/commands/{resume['id']}").json()["state"] == "succeeded"
    assert issue(http, sid, "stop").status_code == 422
    assert (
        http.post(
            AGENT + "/session",
            headers=token_headers(credential),
            json={
                "instance_id": "primary",
                "executor": True,
                "capabilities": [
                    {"id": "stop", "label": "Stop process"},
                ],
            },
        ).status_code
        == 422
    )


def test_database_is_locked_by_one_service(tmp_path):
    path = tmp_path / "exclusive.db"
    with client(path, Clock()):
        with (
            pytest.raises(RuntimeError, match="already using this database"),
            client(path, Clock()),
        ):
            pytest.fail("A second polling runtime acquired the active database")
