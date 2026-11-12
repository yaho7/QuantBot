"""The hub and the internal HTTP API, driven the way a strategy would."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aiohttp.test_utils import TestClient, TestServer

from quantbot.config import StrategyConfig
from quantbot.hub import Hub
from quantbot.server import make_app

A = StrategyConfig("momentum", "动量策略", "a" * 20)
B = StrategyConfig("grid", "网格策略", "b" * 20)
AUTH = {"Authorization": "Bearer " + "a" * 20}

Notes = list[tuple[str, str, str, Any]]


def scenario(test: Callable[[Hub, TestClient, Notes], Awaitable[None]], **hub_args: Any) -> None:
    async def main() -> None:
        notes: Notes = []
        hub = Hub((A, B), lambda *note: notes.append(note), **hub_args)
        async with TestClient(TestServer(make_app(hub))) as client:
            await test(hub, client, notes)

    asyncio.run(main())


def test_tokens_identify_strategies() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        assert (await client.get("/healthz")).status == 200
        assert (await client.get("/v1/commands?wait=0")).status == 401
        bad = await client.get("/v1/commands?wait=0", headers={"Authorization": "Bearer nope"})
        assert bad.status == 401
        good = await client.get("/v1/commands?wait=0", headers=AUTH)
        assert await good.json() == {"commands": [], "need_hello": True}
        assert hub.online(hub.strategies["momentum"]) and not hub.online(hub.strategies["grid"])

    scenario(test)


def test_hello_status_and_bad_events() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        hello = {"type": "hello", "commands": ["status", "pause", "flatten", "rm -rf"]}
        assert (await client.post("/v1/events", json=hello, headers=AUTH)).status == 200
        momentum = hub.strategies["momentum"]
        assert momentum.commands == ("status", "pause", "flatten") and momentum.said_hello
        status = {"type": "status", "text": "净值 10000", "paused": True}
        await client.post("/v1/events", json=status, headers=AUTH)
        assert momentum.status_text == "净值 10000" and momentum.paused is True
        for body in ({"type": "nope"}, {"type": "hello"}, [1]):
            assert (await client.post("/v1/events", json=body, headers=AUTH)).status == 400
        raw = await client.post("/v1/events", data="not json", headers=AUTH)
        assert raw.status == 400

    scenario(test)


def test_command_round_trip_with_long_poll() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        momentum = hub.strategies["momentum"]
        poll = asyncio.create_task(client.get("/v1/commands?wait=5", headers=AUTH))
        await asyncio.sleep(0.05)
        command = hub.send(momentum, "status", {})
        reply = await (await asyncio.wait_for(poll, 2)).json()
        assert reply["commands"] == [{"id": command.id, "name": "status", "args": {}}]
        url = f"/v1/commands/{command.id}/result"
        done = await client.post(url, json={"ok": True, "message": "改好了"}, headers=AUTH)
        assert done.status == 200
        result = await asyncio.wait_for(command.future, 1)
        assert result.ok and result.message == "改好了"
        again = await client.post(url, json={"ok": True}, headers=AUTH)
        assert again.status == 404

    scenario(test)


def test_other_strategy_cannot_see_or_answer_commands() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        grid = hub.strategies["grid"]
        await hub.poll(grid, 0, claims=True)
        command = hub.send(grid, "flatten")
        reply = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert reply["commands"] == []
        url = f"/v1/commands/{command.id}/result"
        assert (await client.post(url, json={"ok": True}, headers=AUTH)).status == 404
        assert not command.future.done()

    scenario(test)


def test_redelivery_and_expiry() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        momentum = hub.strategies["momentum"]
        command = hub.send(momentum, "status")
        first = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert [c["id"] for c in first["commands"]] == [command.id]
        second = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert second["commands"] == []  # just delivered
        await asyncio.sleep(0.12)
        third = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert [c["id"] for c in third["commands"]] == [command.id]  # no result: sent again

        stale = hub.send(hub.strategies["grid"], "status")
        await asyncio.sleep(0.22)
        hub.sweep()
        result = stale.future.result()
        assert not result.ok and "作废" in result.message
        assert not command.future.done()  # delivered ones wait longer for a result

    scenario(test, redeliver_after=0.1, undelivered_ttl=0.2, result_ttl=5)


def test_protected_command_claim_and_reconciliation_survive_restart(tmp_path: Path) -> None:
    path = tmp_path / "operations.sqlite3"
    now = 100.0

    def clock() -> float:
        return now

    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        strategy = hub.strategies[A.id]
        poll = "/v1/commands?wait=0"
        await client.get(poll, headers=AUTH)
        assert not hub.send(strategy, "manual_order").future.result().ok
        await client.get(poll + "&claims=1", headers=AUTH)
        first = hub.send(strategy, "manual_order", {"qty": 1})
        assert (await (await client.get(poll, headers=AUTH)).json())["commands"] == []
        ready = (await (await client.get(poll + "&claims=1", headers=AUTH)).json())["commands"]
        assert ready == [
            {"id": first.id, "name": "manual_order", "args": {"qty": 1}, "expires_at": 115}
        ]
        assert (await (await client.get(poll + "&claims=1", headers=AUTH)).json())["commands"] == []
        claim_url = f"/v1/commands/{first.id}/claim"
        grant = "a" * 32
        assert (await client.post(claim_url, headers=AUTH, json={"grant": grant})).status == 200
        assert (await client.post(claim_url, headers=AUTH, json={"grant": grant})).status == 409
        restarted = Hub(
            (A,), lambda *note: None, operation_path=path, wall_clock=clock, result_ttl=5
        )
        current = restarted.strategies[A.id]
        await restarted.poll(current, 0, claims=True)
        assert not restarted.claim(current, first.id, "b" * 32)
        nonlocal now
        now += 6
        duplicate = restarted.send(current, "manual_order", {"qty": 2}).future.result()
        assert duplicate.state == "UNKNOWN" and duplicate.operation_id == first.id
        receipt = {"ok": True, "grant": grant, "message": "broker accepted"}
        assert restarted.result(current, first.id, receipt)
        assert restarted.result(current, first.id, receipt)
        assert (
            restarted.send(current, "manual_order", {"qty": 1}).future.result().state == "SUCCEEDED"
        )
        assert restarted.operations.recent(A.id)[0]["result"] == {
            "ok": True,
            "message": "broker accepted",
        }

    scenario(test, operation_path=path, wall_clock=clock)


def test_expired_commands_cannot_be_claimed_and_pause_survives_restart(tmp_path: Path) -> None:
    async def run() -> None:
        now = [100.0]
        path = tmp_path / "operations.sqlite3"
        hub = Hub((A,), lambda *note: None, operation_path=path, wall_clock=lambda: now[0])
        strategy = hub.strategies[A.id]
        pause = hub.send(strategy, "pause")
        await hub.poll(strategy, 0, claims=True)
        resume = hub.send(strategy, "resume")
        assert not resume.future.result().ok
        trade = hub.send(strategy, "flatten")
        await hub.poll(strategy, 0, claims=True)
        now[0] += 16
        assert not hub.claim(strategy, trade.id, "late")
        hub.sweep()
        assert trade.future.result().state == "FAILED"
        restarted = Hub((A,), lambda *note: None, operation_path=path)
        current = restarted.strategies[A.id]
        polled = await restarted.poll(current, 0, claims=True)
        assert polled["commands"] == [{"id": pause.id, "name": "pause", "args": {}}]
        assert restarted.result(current, pause.id, {"ok": True})
        assert restarted.operations.pause_intent(A.id) is None

    asyncio.run(run())


def test_stop_receipt_invalidates_old_poll_until_a_new_client_starts() -> None:
    async def run() -> None:
        now = [100.0]
        hub = Hub((A,), lambda *note: None, clock=lambda: now[0])
        strategy = hub.strategies[A.id]
        hello = {"type": "hello", "instance": "a" * 32, "commands": ["stop"]}
        hub.event(strategy, hello)
        await hub.poll(strategy, 0, claims=True)
        stop = hub.send(strategy, "stop")
        await hub.poll(strategy, 0, claims=True)
        assert hub.claim(strategy, stop.id, "grant")
        poll = asyncio.create_task(hub.poll(strategy, 25, claims=True))
        await asyncio.sleep(0)
        assert strategy.polling == 1
        receipt = {"ok": True, "grant": "grant"}
        assert hub.result(strategy, stop.id, receipt)
        assert (await asyncio.wait_for(poll, 1))["commands"] == []
        now[0] += 49
        hub.event(strategy, {"type": "status", "text": "old status"})
        hub.event(strategy, hello)
        assert strategy.stopped and not hub.online(strategy)
        duplicate = hub.send(strategy, "stop").future.result()
        assert duplicate.ok and duplicate.message == "策略已停止。"
        assert not hub.send(strategy, "flatten").future.result().ok

        hub.event(strategy, {**hello, "instance": "b" * 32})
        await hub.poll(strategy, 0, claims=True)
        assert not strategy.stopped and hub.ready_for_claims(strategy)
        assert hub.result(strategy, stop.id, receipt) and hub.online(strategy)

    asyncio.run(run())


def test_offline_and_back_online_alerts() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        await client.post("/v1/events", json={"type": "hello", "commands": []}, headers=AUTH)
        await asyncio.sleep(0.15)
        hub.sweep()
        hub.sweep()
        assert notes == [("动量策略", "🔴 离线：0 秒没有来取命令", "alert", None)]
        await client.get("/v1/commands?wait=0", headers=AUTH)
        assert notes[-1] == ("动量策略", "🟢 恢复在线", "info", None)

    scenario(test, offline_after=0.1)


def test_notices_connection_expiry_and_summary_image() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        async def post(body: dict[str, Any]) -> int:
            return (await client.post("/v1/events", json=body, headers=AUTH)).status

        notes.clear()
        assert await post({"type": "fill", "message": "AAPL BUY 10 @ 280.50"}) == 200
        assert await post({"type": "error", "message": "boom"}) == 200
        up = {"type": "connection", "name": "Schwab", "ok": True}
        down = {"type": "connection", "name": "Schwab", "ok": False, "detail": "timeout"}
        for body in (up, down, down, up):
            await post(body)
        png = base64.b64encode(b"\x89PNG fake").decode()
        await post({"type": "summary", "message": "今日 +1%", "image": png})
        assert await post({"type": "summary", "message": "x", "image": "%%%"}) == 400
        soon = (datetime.now(timezone.utc) + timedelta(hours=10)).isoformat()
        await post({"type": "expiry", "name": "Schwab", "expires_at": soon})
        assert await post({"type": "expiry", "name": "Schwab", "expires_at": "2026-01-01"}) == 400
        hub.sweep()
        hub.sweep()
        assert notes == [
            ("动量策略", "🧾 AAPL BUY 10 @ 280.50", "trade", None),
            ("动量策略", "❌ boom", "error", None),
            ("动量策略", "🔌 Schwab 断开：timeout", "alert", None),
            ("动量策略", "✅ Schwab 已恢复连接", "info", None),
            ("动量策略", "📅 今日 +1%", "info", b"\x89PNG fake"),
            ("动量策略", "⏰ Schwab 的授权约 9 小时后过期，请尽快续期。", "alert", None),
        ]

    scenario(test)


def test_durable_notice_is_retried_after_server_restart(tmp_path) -> None:
    now = 1_800_000_000.0
    event_id = "a" * 32
    body = {"type": "alert", "message": "risk threshold", "event_id": event_id}
    path = tmp_path / "operations.sqlite3"

    async def fail_delivery(notice):
        assert notice.id == event_id
        return False

    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        first = await client.post("/v1/events", json=body, headers=AUTH)
        assert await first.json() == {"ok": True, "event_id": event_id}
        await asyncio.sleep(0)
        await hub.close_notices()
        restarted = Hub(
            (A,), lambda *note: notes.append(note), operation_path=path, wall_clock=lambda: now + 31
        )
        restarted.sweep()
        assert notes == [(A.name, "⚠️ risk threshold", "alert", None)]
        assert restarted.event(restarted.strategies[A.id], body) == event_id
        restarted.sweep()
        assert len(notes) == 1

    scenario(test, operation_path=path, wall_clock=lambda: now, deliver_notice=fail_delivery)
