"""The hub and the internal HTTP API, driven the way a strategy would."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from aiohttp.test_utils import TestClient, TestServer

from quantgram.config import ConfigError, StrategyConfig, load, load_strategies
from quantgram.hub import Hub
from quantgram.server import make_app

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
        command = hub.send(momentum, "set_param", {"name": "rsi_len", "value": 10})
        reply = await (await asyncio.wait_for(poll, 2)).json()
        assert reply["commands"] == [
            {"id": command.id, "name": "set_param", "args": {"name": "rsi_len", "value": 10}}
        ]
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
        command = hub.send(hub.strategies["grid"], "flatten")
        reply = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert reply["commands"] == []
        url = f"/v1/commands/{command.id}/result"
        assert (await client.post(url, json={"ok": True}, headers=AUTH)).status == 404
        assert not command.future.done()

    scenario(test)


def test_redelivery_and_expiry() -> None:
    async def test(hub: Hub, client: TestClient, notes: Notes) -> None:
        momentum = hub.strategies["momentum"]
        command = hub.send(momentum, "flatten")
        first = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert [c["id"] for c in first["commands"]] == [command.id]
        second = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert second["commands"] == []  # just delivered
        await asyncio.sleep(0.12)
        third = await (await client.get("/v1/commands?wait=0", headers=AUTH)).json()
        assert [c["id"] for c in third["commands"]] == [command.id]  # no result: sent again

        stale = hub.send(hub.strategies["grid"], "pause")
        await asyncio.sleep(0.22)
        hub.sweep()
        result = stale.future.result()
        assert not result.ok and "作废" in result.message
        assert not command.future.done()  # delivered ones wait longer for a result

    scenario(test, redeliver_after=0.1, undelivered_ttl=0.2, result_ttl=5)


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


def test_config_loading(tmp_path: Path) -> None:
    path = tmp_path / "strategies.yaml"
    path.write_text(
        "strategies:\n"
        "  - {id: momentum, name: 动量策略, token_env: QG_TOKEN_MOMENTUM}\n"
        "  - {id: grid, token: '" + "g" * 16 + "'}\n"
    )
    env = {
        "TG_TOKEN": "123:abc",
        "TG_OWNER_ID": "42",
        "QG_CONFIG": str(path),
        "QG_TOKEN_MOMENTUM": "m" * 16,
        "TG_QUIET_HOURS": "23-07",
    }
    settings = load(env)
    assert [(s.id, s.name) for s in settings.strategies] == [
        ("momentum", "动量策略"),
        ("grid", "grid"),
    ]
    assert settings.quiet_hours == (23, 7) and settings.port == 8080
    assert "m" * 16 not in repr(settings)
    with pytest.raises(ConfigError, match="QG_TOKEN_MOMENTUM"):
        load({**env, "QG_TOKEN_MOMENTUM": ""})
    with pytest.raises(ConfigError, match="TG_OWNER_ID"):
        load({**env, "TG_OWNER_ID": "me"})
    path.write_text("strategies:\n  - {id: Bad!, token: '" + "x" * 16 + "'}\n")
    with pytest.raises(ConfigError, match="lowercase"):
        load_strategies(path, {})
    path.write_text("strategies:\n  - {id: a, token: short}\n")
    with pytest.raises(ConfigError, match="16"):
        load_strategies(path, {})
