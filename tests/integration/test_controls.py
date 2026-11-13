from uuid import uuid4

from .test_control_plane import (
    ADMIN,
    AGENT,
    CAPS,
    NOW,
    Clock,
    client,
    create,
    issue,
    log_in,
    poll,
    report,
    stamp,
    token_headers,
)

RSI = {"label": "RSI period", "type": "integer", "minimum": "1", "maximum": "100"}
RISK = {"label": "Risk", "type": "decimal", "minimum": "0", "maximum": "10"}
CHOICE = {"label": "Mode", "type": "choice", "choices": ["safe", "balanced"]}
TEXT = {"label": "Note", "type": "string"}
EXTRA_CAPS = [
    {"id": "set_rsi", "label": "Set RSI", "parameters": {"period": {**RSI, "required": True}}},
    {"id": "set_risk", "label": "Set risk", "parameters": {"percent": {**RISK, "required": True}}},
    {"id": "set_mode", "label": "Set mode", "parameters": {"mode": {**CHOICE, "required": True}}},
    {"id": "set_note", "label": "Set note", "parameters": {"note": TEXT}},
    {"id": "set_multi", "label": "Tune", "parameters": {"period": RSI, "note": TEXT}},
    {
        "id": "set_flag",
        "label": "Flag",
        "parameters": {"enabled": {"label": "Enabled", "type": "boolean"}},
    },
]
CONTROLS = [
    {"id": "refresh_market", "type": "button", "label": "Refresh", "command": "refresh"},
    {
        "id": "trading_enabled",
        "type": "toggle",
        "label": "Allow entries",
        "command": "set_trading_enabled",
    },
    {"id": "flag", "type": "toggle", "label": "Flag", "command": "set_flag", "default": True},
    {
        "id": "trading_mode",
        "type": "select",
        "label": "Mode",
        "command": "set_mode",
        "group": "parameters",
        "options": [{"label": "Safe", "value": "safe"}, {"label": "Balanced", "value": "balanced"}],
    },
    {
        "id": "rsi_period",
        "type": "number",
        "label": "RSI",
        "command": "set_rsi",
        "min": 5,
        "max": 30,
        "step": 1,
        "integer": True,
        "default": 14,
        "group": "parameters",
    },
    {
        "id": "max_risk",
        "type": "slider",
        "label": "Risk",
        "command": "set_risk",
        "min": 0.5,
        "max": 5,
        "step": 0.5,
        "unit": "%",
    },
    {"id": "note", "type": "text", "label": "Note", "command": "set_note", "max_length": 10},
    {
        "id": "multi",
        "type": "form",
        "label": "Tune",
        "command": "set_multi",
        "fields": {"period": RSI, "note": TEXT},
    },
    {
        "id": "result",
        "type": "readonly",
        "label": "<script>alert(1)</script>",
        "value_type": "text",
    },
    {
        "id": "close_positions",
        "type": "button",
        "label": "Flatten",
        "command": "flatten",
        "risk_level": "low",
    },
]


def connect_controls(http, token, instance="primary"):
    response = http.post(
        AGENT + "/session",
        headers=token_headers(token),
        json={
            "instance_id": instance,
            "executor": True,
            "capabilities": CAPS + EXTRA_CAPS,
        },
    )
    assert response.status_code == 200, response.text
    return {**token_headers(token), "X-Agent-Session": response.json()["session_id"]}


def publish(http, headers, revision=1, controls=CONTROLS):
    return http.put(
        AGENT + "/controls",
        headers=headers,
        json={
            "schema_version": 1,
            "revision": revision,
            "groups": [{"id": "parameters", "label": "Parameters", "order": 2}],
            "controls": controls,
        },
    )


def state(http, headers, values=None, disabled=None, when=NOW, revision=1):
    return http.put(
        AGENT + "/controls/state",
        headers=headers,
        json={
            "revision": revision,
            "observed_at": stamp(when),
            "values": values or {},
            "disabled": disabled or {},
        },
    )


def invoke(http, sid, control, revision=1, request=None, **extra):
    return http.post(
        f"{ADMIN}/strategies/{sid}/controls/{control}/invoke",
        json={
            "revision": revision,
            "request_id": request or uuid4().hex,
            **extra,
        },
    )


def test_all_components_revision_and_state_validation(tmp_path):
    clock = Clock()
    with client(tmp_path / "controls.db", clock) as http:
        log_in(http)
        sid, credential = create(http)
        headers = connect_controls(http, credential)
        assert http.get("/api/schemas/controls").status_code == 200
        registry = publish(http, headers)
        assert registry.status_code == 200, registry.text
        assert publish(http, headers).json() == registry.json()
        assert {c["type"] for c in registry.json()["controls"]} == {
            "button",
            "toggle",
            "select",
            "number",
            "slider",
            "text",
            "form",
            "readonly",
        }
        assert publish(http, headers, controls=CONTROLS[:-1]).status_code == 409
        assert publish(http, headers, 2, [*CONTROLS, CONTROLS[0]]).status_code == 422
        assert publish(http, headers, 2, [{**CONTROLS[0], "html": "<script/>"}]).status_code == 422
        assert (
            publish(http, headers, 2, [{**CONTROLS[0], "command": "not_declared"}]).status_code
            == 422
        )
        assert publish(http, headers, 2, [{**CONTROLS[5], "step": 0}]).status_code == 422
        report(http, headers)
        values = {
            "trading_enabled": True,
            "flag": True,
            "rsi_period": 14,
            "max_risk": 2.0,
            "trading_mode": "safe",
            "multi": {"period": 12},
            "result": "<b>plain text</b>",
        }
        actual = state(http, headers, values)
        assert actual.status_code == 200, actual.text
        assert actual.json()["states"]["max_risk"]["value"] == "2.0"
        assert actual.json()["states"]["rsi_period"]["value"] == 14
        assert state(http, headers, values).status_code == 200
        assert state(http, headers, {"rsi_period": 20}, when=NOW - 1).status_code == 409
        assert state(http, headers, {"rsi_period": 20}).status_code == 409
        for key, value in (
            ("rsi_period", 60),
            ("rsi_period", False),
            ("max_risk", "0.7"),
            ("max_risk", "2e0"),
            ("trading_mode", "unsafe"),
            ("not_found", 1),
            ("note", "12345678901"),
            ("multi", {"period": "oops"}),
        ):
            assert state(http, headers, {key: value}, when=NOW + 1).status_code in {404, 422}
        assert state(http, headers, {"trading_enabled": False}, when=NOW + 1).status_code == 409
        assert state(http, headers, {"rsi_period": 18}, when=NOW + 2).status_code == 200
        assert publish(http, headers, 2, CONTROLS[:-1]).status_code == 200
        assert publish(http, headers).status_code == 409
        assert state(http, headers, {"rsi_period": 19}, when=NOW + 3).status_code == 409
        admin = http.get(f"{ADMIN}/strategies/{sid}/controls").json()
        assert admin["states"]["rsi_period"]["value_stale"] is True
        assert "close_positions" not in admin["states"]
        assert state(http, headers, {"rsi_period": 19}, when=NOW + 3, revision=2).status_code == 200
        clock.value += 65
        admin = http.get(f"{ADMIN}/strategies/{sid}/controls").json()
        assert admin["states"]["rsi_period"]["value"] == 19
        assert admin["states"]["rsi_period"]["value_stale"]
        assert not admin["states"]["rsi_period"]["available"]
        assert invoke(http, sid, "rsi_period", revision=2, value=20).status_code == 409


def test_component_commands_require_confirmation_and_reported_values(tmp_path):
    with client(tmp_path / "operations.db", Clock()) as http:
        log_in(http)
        sid, credential = create(http)
        headers = connect_controls(http, credential)
        assert publish(http, headers).status_code == 200
        report(http, headers, risk_locked=True)
        assert state(http, headers, {"rsi_period": 14}).status_code == 200
        assert issue(http, sid, "set_rsi", period=20).status_code == 409
        assert invoke(http, sid, "rsi_period", value=31).status_code == 422
        assert invoke(http, sid, "rsi_period", value=20, revision=2).status_code == 409
        request_id = uuid4().hex
        command = invoke(http, sid, "rsi_period", value=20, request=request_id).json()
        assert command["control_id"] == "rsi_period" and command["control_revision"] == 1
        assert (
            command["arguments"] == {"period": 20} and command["state"] == "confirmation_required"
        )
        cid = command["id"]
        assert invoke(http, sid, "rsi_period", value=20, request=request_id).json()["id"] == cid
        assert invoke(http, sid, "rsi_period", value=21, request=request_id).status_code == 409
        assert http.post(f"{ADMIN}/commands/{cid}/confirm").json()["state"] == "pending"
        assert poll(http, headers)[0]["id"] == cid
        permit = http.post(f"{AGENT}/commands/{cid}/claim", headers=headers).json()["permit"]
        assert http.post(f"{AGENT}/commands/{cid}/claim", headers=headers).status_code == 409
        assert (
            http.post(
                f"{AGENT}/commands/{cid}/result",
                headers=headers,
                json={
                    "permit": permit,
                    "status": "failed",
                    "error": "simulated rejection",
                },
            ).json()["state"]
            == "failed"
        )
        assert (
            http.get(f"{ADMIN}/strategies/{sid}/controls").json()["states"]["rsi_period"]["value"]
            == 14
        )
        assert state(http, headers, {"rsi_period": 20}, when=NOW + 1).status_code == 200
        cancelled = invoke(http, sid, "close_positions").json()
        assert cancelled["state"] == "confirmation_required"
        assert (
            http.post(f"{ADMIN}/commands/{cancelled['id']}/cancel").json()["state"] == "cancelled"
        )
        assert http.post(f"{ADMIN}/commands/{cancelled['id']}/confirm").status_code == 409
        requested = invoke(http, sid, "trading_enabled", value=False).json()
        assert requested["action"] == "pause_entry" and requested["state"] == "pending"
        assert http.get(f"{ADMIN}/strategies/{sid}/controls").json()["states"]["trading_enabled"][
            "value"
        ]
        report(http, headers, requested["revision"], entry_enabled=False, risk_locked=True)
        view = http.get(f"{ADMIN}/strategies/{sid}/controls").json()
        assert view["states"]["trading_enabled"]["value"] is False


def test_revisions_disable_queued_commands_and_fence_other_instances(tmp_path):
    clock = Clock()
    path = tmp_path / "safe.db"
    with client(path, clock) as http:
        log_in(http)
        sid, credential = create(http)
        headers = connect_controls(http, credential)
        duplicate = connect_controls(http, credential, instance="other")
        assert publish(http, duplicate).status_code == 403
        assert publish(http, headers).status_code == 200
        queued = invoke(http, sid, "refresh_market").json()
        assert queued["state"] == "pending"
        poll(http, headers)
        assert (
            state(
                http,
                headers,
                disabled={
                    "refresh_market": {"disabled": True, "reason": "Maintenance"},
                },
            ).status_code
            == 200
        )
        assert (
            http.post(f"{AGENT}/commands/{queued['id']}/claim", headers=headers).status_code == 409
        )
        assert http.get(f"{ADMIN}/commands/{queued['id']}").json()["state"] == "expired"
        assert invoke(http, sid, "refresh_market").status_code == 409
        order = invoke(http, sid, "close_positions").json()
        assert publish(http, headers, revision=2).status_code == 200
        assert http.post(f"{ADMIN}/commands/{order['id']}/confirm").status_code == 409
        assert http.get(f"{ADMIN}/commands/{order['id']}").json()["state"] == "expired"

    with client(path, clock) as http:
        log_in(http)
        assert http.get(f"{ADMIN}/strategies/{sid}/controls").json()["revision"] == 2
        assert publish(http, headers, revision=3).status_code == 409
