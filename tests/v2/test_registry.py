from uuid import uuid4

from .test_control_plane import (
    ADMIN,
    AGENT,
    NOW,
    Clock,
    client,
    connect,
    create,
    log_in,
    stamp,
    token_headers,
)


def packet(kind, offset=0, **fields):
    return {"type": kind, "schema_version": 1, "observed_at": stamp(NOW + offset), **fields}


def batch(http, headers, *items):
    return http.post(AGENT + "/reports", headers=headers, json={"records": list(items)})


def discover(http, sid):
    response = http.get(f"{ADMIN}/strategies/{sid}/components")
    assert response.status_code == 200, response.text
    return {item["id"]: item for item in response.json()["components"]}


def test_token_only_monitor_survives_outage_and_server_restart(tmp_path):
    path = tmp_path / "monitor.db"
    clock = Clock()
    with client(path, clock) as http:
        log_in(http)
        sid, credential = create(http, scopes=["session", "telemetry"])
        headers = token_headers(credential)
        url = AGENT + "/monitor/strategy-a"
        for offset in (0, 15, 30, 45, 60):
            clock.value = NOW + offset
            point = packet("metric", offset, name="rsi", unit="index", value="12.2")
            assert (
                http.post(url, headers=headers, json={"records": [point]}).json()["inserted"] == 1
            )
        assert http.get(f"{ADMIN}/strategies/{sid}").json()["status"] == "online"
        assert http.get(AGENT + "/control", headers=headers).status_code == 403
        assert http.post(url, json={"records": [point]}).status_code == 401
        _, restricted = create(http, scopes=["session"])
        assert (
            http.post(url, headers=token_headers(restricted), json={"records": [point]}).status_code
            == 403
        )
        assert (
            http.post(
                AGENT + "/session", headers=headers, json={"instance_id": "monitor:strategy-a"}
            ).status_code
            == 422
        )
    clock.value += 90
    with client(path, clock) as http:
        log_in(http)
        assert http.post(url, headers=headers, json={"records": [point]}).json()["duplicates"] == 1
        assert http.get(f"{ADMIN}/strategies/{sid}").json()["status"] == "online"


def test_registry_schema_discovery_and_stale_data(tmp_path):
    clock = Clock()
    with client(tmp_path / "registry.db", clock) as http:
        log_in(http)
        sid, credential = create(http)
        headers, _ = connect(http, credential)
        types = http.get("/api/v2/data-types").json()
        assert {item["type"] for item in types} == {
            "status",
            "portfolio",
            "position",
            "order",
            "fill",
            "equity",
            "performance",
            "metric",
            "ohlcv",
            "signal",
            "risk",
            "log",
            "connection",
            "alert",
        }
        assert all(http.get(item["schema"]).status_code == 200 for item in types)
        assert discover(http, sid) == {}
        metadata = http.put(
            AGENT + "/metric-definitions",
            headers=headers,
            json={
                "metrics": [{"name": "rsi", "label": "RSI 14", "unit": "index", "kind": "ratio"}],
            },
        )
        assert metadata.json()["registered"] == 1
        assert discover(http, sid) == {}
        invalid = packet("metric", name="rsi", unit="index", value=12.2)
        assert batch(http, headers, invalid).status_code == 422
        assert discover(http, sid) == {}
        data = packet("metric", name="rsi", unit="index", value="12.2")
        assert batch(http, headers, data).json()["inserted"] == 1
        components = discover(http, sid)
        assert set(components) <= {"metrics", "metric_cards", "alerts"}
        assert components["metric_cards"]["state"] == "ready"
        assert components["metrics"]["state"] == "insufficient"
        assert components["metrics"]["sources"][0]["label"] == "RSI 14"
        assert batch(http, headers, {**data, "arbitrary": {"ohlcv": "fake"}}).status_code == 422
        assert discover(http, sid)["metrics"]["state"] == "incompatible"
        assert batch(http, headers, {**data, "schema_version": True}).status_code == 422
        assert batch(http, headers, packet("unknown", fake={"value": "1"})).status_code == 422
        assert batch(http, headers, {**data, "observed_at": stamp(NOW + 5)}).status_code == 200
        assert discover(http, sid)["metrics"]["state"] == "ready"
        clock.value += 500
        assert discover(http, sid)["metrics"]["state"] == "stale"


def test_strict_batches_comparison_dashboard_and_persistence(tmp_path):
    clock = Clock()
    path = tmp_path / "history.db"
    with client(path, clock) as http:
        log_in(http)
        sid, cred = create(http)
        other, cred_other = create(http)
        headers, _ = connect(http, cred)
        second, _ = connect(http, cred_other)
        records = [
            packet(
                "portfolio",
                accounts=[{"account_id": "a", "currency": "USD", "equity": "1.00000000001"}],
            ),
            packet(
                "equity", 1, account_id="a", currency="USD", value="3.00000000001", drawdown="0.25"
            ),
            packet("position", strategy_positions=[], broker_positions=[]),
            packet("order", open_orders=[], completed_orders=[]),
            packet("status", runtime={"uptime_seconds": 12}),
            packet("performance", performance={"daily_return": "1.5"}),
            packet("connection", broker_connected=True),
            packet("log", id="log-1", severity="info", message="Initialized"),
            packet("alert", id="alert-1", code="test", severity="warning", message="Test"),
        ]
        assert batch(http, headers, *records).json()["inserted"] == len(records)
        assert batch(http, headers, *records).json()["duplicates"] == len(records)
        assert (
            batch(
                http,
                headers,
                packet("status", 2, runtime={}),
                packet("metric", name="rsi", value=9),
            ).status_code
            == 422
        )
        found = discover(http, sid)
        assert found["equity"]["state"] == "ready"
        assert found["position_mix"]["state"] == "insufficient"
        assert found["status_history"]["state"] == "insufficient"
        assert found["drawdown"]["state"] == "insufficient"
        assert found["returns"]["state"] == "insufficient"
        assert (
            batch(
                http, second, packet("equity", account_id="b", currency="USD", value="9")
            ).status_code
            == 200
        )
        sources = [
            {
                "strategy_id": key,
                "instance_id": "primary",
                "name": "account.equity",
                "account_id": account,
                "unit": "USD",
            }
            for key, account in ((sid, "a"), (other, "b"))
        ]
        query = {
            "sources": sources,
            "start": stamp(NOW - 5),
            "end": stamp(NOW + 5),
            "bucket_seconds": 60,
            "aggregation": "mean",
        }
        data = http.post(ADMIN + "/history/metrics", json=query).json()
        assert data[0]["points"][0]["value"] == "2.00000000001"
        assert data[1]["points"][0]["value"] == "9"
        url = f"{ADMIN}/strategies/{sid}/dashboard"
        widget = {
            "id": uuid4().hex,
            "component": "equity",
            "title": "净值对比",
            "chart": "line",
            "width": 2,
            "sources": sources,
        }
        assert http.put(url, json={"revision": 0, "widgets": [widget]}).status_code == 200
        assert http.put(url, json={"revision": 0, "widgets": []}).status_code == 409
        assert (
            http.put(url, json={"revision": 1, "widgets": [{**widget, "chart": "pie"}]}).status_code
            == 422
        )
        assert (
            http.put(
                url,
                json={
                    "revision": 1,
                    "widgets": [{**widget, "component": "candles", "chart": "candlestick"}],
                },
            ).status_code
            == 422
        )

    with client(path, clock) as http:
        log_in(http)
        assert http.get(url).json()["widgets"][0]["title"] == "净值对比"
        assert http.post(ADMIN + "/history/metrics", json=query).json() == data
        assert (
            http.get(f"{ADMIN}/strategies/{sid}").json()["snapshot"]["accounts"][0]["account_id"]
            == "a"
        )


def test_ohlcv_fill_and_markers(tmp_path):
    with client(tmp_path / "market.db", Clock()) as http:
        log_in(http)
        sid, cred = create(http)
        headers, _ = connect(http, cred)
        candle = packet(
            "ohlcv",
            symbol="SPY",
            interval_seconds=60,
            open="100",
            high="105",
            low="99",
            close="104",
            volume="120",
        )
        assert batch(http, headers, {**candle, "high": "102"}).status_code == 422
        fill = {
            "fill_id": "fill-1",
            "order_id": "o-1",
            "account_id": "a",
            "symbol": "SPY",
            "currency": "USD",
            "side": "buy",
            "quantity": "0.125",
            "price": "103.22",
            "occurred_at": stamp(NOW + 1),
        }
        order = {
            "order_id": "o-1",
            "account_id": "a",
            "symbol": "SPY",
            "currency": "USD",
            "side": "buy",
            "quantity": "0.125",
            "status": "filled",
            "updated_at": stamp(NOW + 1),
        }
        items = [
            candle,
            packet("fill", 1, id="fill-1", fill=fill),
            packet("signal", 1, id="signal-1", symbol="SPY", name="rsi", direction="buy"),
            packet("risk", 1, id="risk-1", code="limit", message="Risk limit", symbol="SPY"),
            packet("order", 1, open_orders=[], completed_orders=[order]),
        ]
        res = batch(http, headers, *items)
        assert res.status_code == 200, res.text
        assert discover(http, sid)["candles"]["state"] == "ready"
        result = http.get(
            f"{ADMIN}/strategies/{sid}/market",
            params={
                "instance": "primary",
                "symbol": "SPY",
                "interval_seconds": 60,
                "start": stamp(NOW - 60),
                "end": stamp(NOW + 60),
            },
        ).json()
        assert result["candles"][0]["close"] == "104"
        assert {item["kind"] for item in result["markers"]} == {"fill", "signal", "risk", "order"}
        assert (
            next(item for item in result["markers"] if item["kind"] == "fill")["price"] == "103.22"
        )


def test_fill_aggregation_counts_verified_fill_records(tmp_path):
    with client(tmp_path / "fill-count.db", Clock()) as http:
        log_in(http)
        sid, cred = create(http)
        headers, _ = connect(http, cred)
        items = [
            packet(
                "fill",
                offset,
                id=f"fill-{offset}",
                fill={
                    "fill_id": f"fill-{offset}",
                    "order_id": "order",
                    "account_id": "a",
                    "currency": "USD",
                    "symbol": "SPY",
                    "side": "buy",
                    "quantity": "1",
                    "price": "100",
                    "occurred_at": stamp(NOW + offset),
                },
            )
            for offset in (1, 2, 200)
        ]
        assert batch(http, headers, *items).status_code == 200
        params = {"start": stamp(), "end": stamp(NOW + 250), "bucket_seconds": 60}
        result = http.get(f"{ADMIN}/strategies/{sid}/components/fill_count", params=params)
        assert result.status_code == 200, result.text
        assert [(row["side"], row["value"]) for row in result.json()] == [
            ("buy", "2"),
            ("buy", "1"),
        ]


def test_multi_account_fill_replay_does_not_duplicate_trade_counts(tmp_path):
    with client(tmp_path / "trade-replay.db", Clock()) as http:
        log_in(http)
        sid, cred = create(http)
        headers, _ = connect(http, cred)
        fill = {
            "fill_id": "same-broker-fill-id",
            "order_id": "order",
            "account_id": "alpha",
            "currency": "USD",
            "symbol": "SPY",
            "side": "buy",
            "quantity": "1",
            "price": "100",
            "occurred_at": stamp(),
        }
        result = batch(http, headers, packet("fill", id="initial-fill", fill=fill))
        assert result.status_code == 200, result.text
        snap = {
            "type": "snapshot",
            "schema_version": 1,
            "observed_at": stamp(NOW + 1),
            "fills": [fill, {**fill, "account_id": "beta"}],
        }
        result = http.put(AGENT + "/snapshot", headers=headers, json=snap)
        assert result.status_code == 200, result.text
        events = http.get(
            ADMIN + "/events", params={"strategy_id": sid, "category": "trade"}
        ).json()
        assert len(events) == 2
        assert {row["fill"]["account_id"] for row in events} == {"alpha", "beta"}
        detail = http.get(f"{ADMIN}/strategies/{sid}").json()
        assert len(detail["snapshot"]["fills"]) == 2
        conflicting = packet("fill", id="conflict", fill={**fill, "quantity": "2"})
        assert batch(http, headers, conflicting).status_code == 409


def test_backfilled_runtime_does_not_override_current_health(tmp_path):
    clock = Clock()
    with client(tmp_path / "runtime.db", clock) as http:
        log_in(http)
        sid, cred = create(http)
        headers, _ = connect(http, cred)
        clock.value += 20
        healthy = {"health": "healthy", "broker_connected": True}
        assert http.put(AGENT + "/heartbeat", headers=headers, json=healthy).status_code == 200
        assert (
            batch(http, headers, packet("connection", 10, broker_connected=False)).status_code
            == 200
        )
        detail = http.get(f"{ADMIN}/strategies/{sid}").json()
        assert detail["status"] == "online"
        assert detail["instances"][0]["runtime"]["broker_connected"] is True
        assert (
            batch(http, headers, packet("status", 21, runtime={"health": "degraded"})).status_code
            == 200
        )
        detail = http.get(f"{ADMIN}/strategies/{sid}").json()
        assert detail["status"] == "abnormal"
        assert detail["instances"][0]["runtime"]["broker_connected"] is True
