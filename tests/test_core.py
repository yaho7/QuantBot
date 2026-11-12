"""Menus, buttons and confirmations against the real hub, with strategies faked in-process."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from quantbot.audit import Audit
from quantbot.config import StrategyConfig
from quantbot.core import Core, Reply, ago, check_type, parse_value
from quantbot.hub import Hub, Strategy

OWNER = 42
ALL = ["status", "pause", "resume", "positions", "orders", "cancel", "flatten",
       "params", "set_param", "manual_order", "chart", "stop"]  # fmt: skip


class Fake:
    """Answers commands the way a client would, and records what it ran."""

    def __init__(self, hub: Hub, sid: str, commands: list[str] = ALL) -> None:
        self.hub, self.strategy = hub, hub.strategies[sid]
        self.ran: list[tuple[str, dict[str, Any]]] = []
        self.params: dict[str, Any] = {"rsi_len": 14, "risk": 0.02, "live": False}
        self.paused = False
        self.fail: str | None = None
        self.silent = False
        hub.event(self.strategy, {"type": "hello", "commands": commands})

    def answer(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.fail:
            return {"ok": False, "message": self.fail}
        if name == "status":
            return {
                "ok": True,
                "data": {"text": f"净值 10000\n{self.strategy.id}", "paused": self.paused},
            }
        if name in {"pause", "resume"}:
            self.paused = name == "pause"
            return {"ok": True}
        if name == "positions":
            return {"ok": True, "message": "QQQ 10 股"}
        if name == "orders":
            return {"ok": True, "data": [{"id": "ord-1", "text": "卖出 QQQ 10 @ 520 止损"}]}
        if name == "params":
            return {"ok": True, "data": dict(self.params)}
        if name == "set_param":
            self.params[args["name"]] = args["value"]
            return {"ok": True}
        if name == "chart":
            return {"ok": True, "data": base64.b64encode(b"PNG").decode()}
        return {"ok": True, "message": f"{name} 完成"}

    async def serve(self) -> None:
        while True:
            reply = await self.hub.poll(self.strategy, 0.2, claims=True)
            for command in reply["commands"]:
                if self.silent:
                    continue
                self.ran.append((command["name"], command["args"]))
                grant = {}
                if "expires_at" in command:
                    assert self.hub.claim(self.strategy, command["id"], "grant")
                    grant["grant"] = "grant"
                result = self.answer(command["name"], command["args"])
                self.hub.result(self.strategy, command["id"], {**result, **grant})


Notes = list[tuple[str, str, str]]
Test = Callable[[Core, dict[str, Fake], Notes, Path], Awaitable[None]]


def scenario(
    test: Test, tmp_path: Path, ids: tuple[str, ...] = ("momentum", "grid"), **core_args: Any
) -> None:
    async def main() -> None:
        notes: Notes = []
        configs = tuple(
            StrategyConfig(i, {"momentum": "动量", "grid": "网格"}.get(i, i), i * 20) for i in ids
        )
        hub = Hub(configs, lambda name, text, kind, image: None)
        core = Core(
            hub,
            Audit(tmp_path),
            owner_id=OWNER,
            notify=lambda *note: notes.append(note),
            command_timeout=1,
            **core_args,
        )
        fakes = {i: Fake(hub, i) for i in ids}
        tasks = [asyncio.create_task(f.serve()) for f in fakes.values()]
        await asyncio.sleep(0.01)
        try:
            await test(core, fakes, notes, tmp_path)
        finally:
            for task in tasks:
                task.cancel()

    asyncio.run(main())


def labels(reply: Reply) -> list[str]:
    return [label for row in reply.buttons for label, _ in row]


def button(reply: Reply, label: str) -> str:
    return next(data for row in reply.buttons for text, data in row if text == label)


def audit(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (path / "audit.jsonl").read_text().splitlines()]


def test_home_lists_strategies_and_opens_one(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        home = await core.home()
        assert labels(home) == ["🟢 动量", "🟢 网格", "🔄 刷新", "⏸ 全部暂停开仓"]
        page = await core.tap(button(home, "🟢 动量"), OWNER)
        assert page.text.startswith("🟢 动量 · 0 秒前") and "净值 10000\nmomentum" in page.text
        assert labels(page) == [
            "🔄 刷新",
            "⏸ 暂停开仓",
            "📊 持仓",
            "📋 挂单",
            "📈 净值图",
            "🧹 平仓",
            "⏹ 停止",
            "⬅️ 全部策略",
        ]
        assert core.current == "momentum"
        assert core.allowed(OWNER) and not core.allowed(7)

    scenario(test, tmp_path)


def test_single_strategy_opens_directly(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        page = await core.home()
        assert page.text.startswith("🟢 动量") and "⬅️ 全部策略" not in labels(page)

    scenario(test, tmp_path, ids=("momentum",))


def test_pause_resume_and_pause_all(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        page = await core.tap("p:momentum", OWNER)
        assert fakes["momentum"].paused and "⏸ 已暂停开仓" in page.text
        assert "▶️ 恢复开仓" in labels(page) and "⏸ 暂停开仓" not in labels(page)
        resume = await core.tap("r:momentum", OWNER)
        assert fakes["momentum"].paused
        await core.tap(button(resume, "✅ 确定"), OWNER)
        assert not fakes["momentum"].paused
        result = await core.tap("pa", OWNER)
        assert result.text == "⏸ 动量：已暂停\n⏸ 网格：已暂停"
        assert all(f.paused for f in fakes.values())
        assert [r["action"] for r in audit(path)] == ["pause", "resume", "pause_all"]

    scenario(test, tmp_path)


def test_flatten_needs_two_taps_runs_once_and_expires(tmp_path: Path) -> None:
    class Clock:
        now = 1000.0

        def __call__(self) -> float:
            return self.now

    clock = Clock()

    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        page = await core.open("momentum")
        ask = await core.tap(button(page, "🧹 平仓"), OWNER)
        assert ask.text.startswith("确定平掉 动量 的仓位？")
        assert [n for n, _ in fakes["momentum"].ran] == ["status"]
        confirm = button(ask, "✅ 确定")
        done = await core.tap(confirm, OWNER)
        assert done.text == "动量 平仓：flatten 完成"
        again = await core.tap(confirm, OWNER)
        assert "已失效" in again.text
        assert [n for n, _ in fakes["momentum"].ran].count("flatten") == 1
        record = audit(path)[-1]
        assert record["action"] == "flatten" and record["op"] == confirm[2:] and record["ok"]

        late = button(core.request("flatten", core.hub.strategies["grid"]), "✅ 确定")
        clock.now += 31
        assert "已失效" in (await core.tap(late, OWNER)).text
        assert "flatten" not in [n for n, _ in fakes["grid"].ran]

    scenario(test, tmp_path, clock=clock)


def test_orders_cancel_and_positions_and_chart(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        listing = await core.tap("ord:grid", OWNER)
        assert listing.text == "📋 网格\n1. 卖出 QQQ 10 @ 520 止损"
        ask = await core.tap(button(listing, "❌ 撤单 1"), OWNER)
        assert ask.text.startswith("确定撤掉 网格 的第 1 个挂单？")
        await core.tap(button(ask, "✅ 确定"), OWNER)
        assert fakes["grid"].ran[-1] == ("cancel", {"order_id": "ord-1"})
        assert (await core.tap("pos:grid", OWNER)).text == "📊 网格\nQQQ 10 股"
        assert (await core.tap("ch:grid", OWNER)).image == b"PNG"

    scenario(test, tmp_path)


def test_set_param_checks_name_and_type(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        s = core.hub.strategies["momentum"]
        assert "可以改的有" in (await core.request_set(s, "nope 1")).text
        assert "不能改成" in (await core.request_set(s, "rsi_len abc")).text
        assert "不能改成" in (await core.request_set(s, "live 1")).text
        assert "用法" in (await core.request_set(s, "rsi_len")).text
        ask = await core.request_set(s, "rsi_len 10")
        assert "14 → 10" in ask.text
        done = await core.tap(button(ask, "✅ 确定"), OWNER)
        assert done.text == "✏️ 动量 rsi_len：14 → 10"
        assert fakes["momentum"].params["rsi_len"] == 10
        ask = await core.request_set(s, "risk 1")
        await core.tap(button(ask, "✅ 确定"), OWNER)
        assert fakes["momentum"].params["risk"] == 1.0
        assert isinstance(fakes["momentum"].params["risk"], float)

    scenario(test, tmp_path)


def test_manual_order_validates_then_confirms(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        s = core.hub.strategies["momentum"]
        assert "用法" in core.request_order(s, "buy", "QQQ").text
        assert "大于 0" in core.request_order(s, "buy", "QQQ -5").text
        for qty in ("NaN", "Infinity", "1e100"):
            assert "有限数" in core.request_order(s, "buy", f"QQQ {qty}").text
        assert "用法" in core.request_order(s, "buy", "QQ;Q 5").text
        ask = core.request_order(s, "buy", "qqq 10")
        assert ask.text.startswith("确定让 动量 买入 QQQ 10？")
        await core.tap(button(ask, "✅ 确定"), OWNER)
        assert fakes["momentum"].ran[-1] == (
            "manual_order",
            {"side": "buy", "symbol": "QQQ", "qty": 10},
        )

    scenario(test, tmp_path)


def test_failures_slow_answers_and_unsupported(tmp_path: Path) -> None:
    async def test(core: Core, fakes: dict[str, Fake], notes: Notes, path: Path) -> None:
        fakes["momentum"].fail = "分不清哪些仓位属于本策略"
        ask = core.request("flatten", core.hub.strategies["momentum"])
        done = await core.tap(button(ask, "✅ 确定"), OWNER)
        assert done.text == "动量 平仓：失败：分不清哪些仓位属于本策略"

        fakes["grid"].silent = True
        reply = await core.tap("pos:grid", OWNER)
        assert "还没回报结果" in reply.text
        grid = core.hub.strategies["grid"]
        command = next(iter(grid.pending.values()))
        core.hub.result(grid, command.id, {"ok": True, "message": "QQQ 10 股"})
        await asyncio.sleep(0)
        assert notes == [("网格", "持仓：QQQ 10 股", "info")]

        grid.commands = ("status",)
        assert "不支持持仓" in (await core.tap("pos:grid", OWNER)).text
        assert labels(await core.open("grid")) == ["🔄 刷新", "⬅️ 全部策略"]

    scenario(test, tmp_path)


def test_offline_strategy_only_queues_pause(tmp_path: Path) -> None:
    async def main() -> None:
        hub = Hub(
            (StrategyConfig("a", "A", "a" * 20), StrategyConfig("b", "B", "b" * 20)),
            lambda *n: None,
        )
        core = Core(
            hub, Audit(tmp_path), owner_id=OWNER, notify=lambda *n: None, command_timeout=0.05
        )
        assert isinstance(core.target(), Reply)  # two strategies, none chosen
        assert isinstance(core.target("zzz"), Reply)
        page = await core.open("b")
        assert page.text.startswith("🔴 B · 还没有状态") and "还没有连上过" in page.text
        assert isinstance(core.target(), Strategy) and core.target().id == "b"
        reply = await core.tap("pos:b", OWNER)
        assert "离线，命令未发送" in reply.text
        strategy = hub.strategies["b"]
        for command in ("manual_order", "cancel", "flatten", "resume", "stop"):
            ok, _ = await core.call(strategy, command)
            assert not ok and not strategy.pending
        assert "暂停意图已保存" in (await core.tap("p:b", OWNER)).text
        assert len(strategy.pending) == 1

    asyncio.run(main())


@pytest.mark.parametrize(
    ("raw", "value"),
    [("10", 10), ("0.5", 0.5), ("true", True), ("False", False), ('"a b"', "a b"), ("SPY", "SPY")],
)
def test_parse_value(raw: str, value: Any) -> None:
    assert parse_value(raw) == value and type(parse_value(raw)) is type(value)


def test_check_type_and_ago() -> None:
    assert check_type(1, 2.0) == (True, 2)
    assert check_type(1, 2.5)[0] is False
    assert check_type(True, 1)[0] is False
    assert check_type("a", 1)[0] is False
    assert check_type(None, [1]) == (True, [1])
    assert [ago(None), ago(5), ago(125), ago(7300)] == [
        "还没有状态",
        "5 秒前",
        "2 分钟前",
        "2 小时前",
    ]
