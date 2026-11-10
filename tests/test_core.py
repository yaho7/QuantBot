from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from quantgram.bridge import Bridge
from quantgram.core import Core, Reply, check_type, parse_value
from quantgram.state import State

OWNER = 42


class FakeStrategy:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], str]] = []
        self._params: dict[str, Any] = {"rsi_len": 14, "risk": 0.02, "symbol": "QQQ", "live": False}
        self.flat_result = "平掉 QQQ 10 股"

    def _log(self, name: str, *args: Any) -> None:
        self.calls.append((name, args, threading.current_thread().name))

    def status(self) -> str:
        self._log("status")
        return "净值 10000"

    def positions(self) -> str:
        return "QQQ 10 股"

    def orders(self) -> list[dict[str, Any]]:
        return [{"id": "ord-1", "text": "卖出 QQQ 10 @ 520 止损"}]

    def cancel(self, order_id: str) -> str:
        self._log("cancel", order_id)
        return "已撤"

    def flatten(self) -> str:
        self._log("flatten")
        return self.flat_result

    def params(self) -> dict[str, Any]:
        return dict(self._params)

    def set_param(self, name: str, value: Any) -> str:
        self._log("set_param", name, value)
        self._params[name] = value
        return ""

    def manual_order(self, side: str, symbol: str, qty: float) -> str:
        self._log("manual_order", side, symbol, qty)
        return "订单 abc"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def setup(tmp_path: Path) -> Iterator[tuple[Core, FakeStrategy, list[tuple[str, str]], Clock]]:
    strategy = FakeStrategy()
    bridge = Bridge()
    notes: list[tuple[str, str]] = []
    stopped: list[bool] = []
    clock = Clock()
    core = Core(
        strategy,
        bridge,
        State(tmp_path),
        owner_id=OWNER,
        notify=lambda text, kind: notes.append((text, kind)),
        on_stop=lambda: stopped.append(True) or bridge.request_stop(),
        command_timeout=2,
        clock=clock,
    )

    def serve() -> None:
        while bridge.sleep(0.05):
            pass

    worker = threading.Thread(target=serve, name="trading")
    worker.start()
    yield core, strategy, notes, clock
    bridge.request_stop()
    worker.join(timeout=2)


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def datas(reply: Reply) -> list[str]:
    return [data for row in reply.buttons for _, data in row]


def labels(reply: Reply) -> list[str]:
    return [label for row in reply.buttons for label, _ in row]


def confirm_of(reply: Reply) -> str:
    return next(data for label, data in reply.buttons[0] if label.startswith("✅"))


def test_menu_runs_status_on_trading_thread_and_shows_features(setup) -> None:
    core, strategy, _, _ = setup
    reply = run(core.menu())
    assert reply.text == "净值 10000"
    assert strategy.calls == [("status", (), "trading")]
    assert labels(reply) == ["🔄 刷新", "⏸ 暂停开仓", "📊 持仓", "📋 挂单", "🧹 平仓", "⏹ 停止程序"]
    assert core.allowed(OWNER) and not core.allowed(7) and not core.allowed(None)


def test_pause_is_saved_and_shown(setup, tmp_path: Path) -> None:
    core, _, _, _ = setup
    core.pause(OWNER)
    reply = run(core.menu())
    assert reply.text.startswith("⏸ 已暂停开仓：手动暂停")
    assert "▶️ 恢复开仓" in labels(reply)
    assert State(tmp_path).paused is True
    core.resume(OWNER)
    assert State(tmp_path).paused is False
    actions = [json.loads(x)["action"] for x in (tmp_path / "audit.jsonl").read_text().splitlines()]
    assert actions == ["pause", "resume"]


def test_flatten_needs_two_taps_and_runs_once(setup, tmp_path: Path) -> None:
    core, strategy, _, _ = setup
    offer = next(d for label, d in core.menu_buttons()[-1] if label == "🧹 平仓")
    ask = run(core.tap(offer, OWNER))
    assert ask.text.startswith("确定平掉本程序的仓位？")
    assert strategy.calls == []
    confirm = confirm_of(ask)
    done = run(core.tap(confirm, OWNER))
    assert done.text == "🧹 平仓：平掉 QQQ 10 股"
    assert [c[0] for c in strategy.calls] == ["flatten"]
    again = run(core.tap(confirm, OWNER))
    assert "已失效" in again.text and [c[0] for c in strategy.calls] == ["flatten"]
    record = json.loads((tmp_path / "audit.jsonl").read_text().splitlines()[-1])
    assert record["action"] == "flatten" and record["op"] == confirm[2:] and record["ok"] is True


def test_confirmation_expires_after_30_seconds(setup) -> None:
    core, strategy, _, clock = setup
    confirm = confirm_of(core.request_flatten())
    clock.now += 31
    assert "已失效" in run(core.tap(confirm, OWNER)).text
    assert strategy.calls == []


def test_stop_calls_on_stop_after_confirmation(setup) -> None:
    core, _, _, _ = setup
    reply = run(core.tap(confirm_of(core.request_stop()), OWNER))
    assert reply.text.startswith("⏹ 正在停止")
    assert core.bridge.stopping


def test_orders_list_offers_cancel_with_confirmation(setup) -> None:
    core, strategy, _, _ = setup
    listing = run(core.orders())
    assert listing.text == "1. 卖出 QQQ 10 @ 520 止损"
    ask = run(core.tap(datas(listing)[0], OWNER))
    assert ask.text.startswith("确定撤掉第 1 个挂单？")
    done = run(core.tap(confirm_of(ask), OWNER))
    assert done.text == "❌ 撤单：已撤"
    assert strategy.calls[-1][:2] == ("cancel", ("ord-1",))


def test_set_param_checks_name_and_type(setup) -> None:
    core, strategy, _, _ = setup
    assert "可以改的有" in run(core.request_set("nope 1")).text
    assert "不能改成" in run(core.request_set("rsi_len abc")).text
    assert "不能改成" in run(core.request_set("live 1")).text
    assert "用法" in run(core.request_set("rsi_len")).text
    ask = run(core.request_set("rsi_len 10"))
    assert "14 → 10" in ask.text
    done = run(core.tap(confirm_of(ask), OWNER))
    assert done.text == "✏️ rsi_len：14 → 10"
    assert strategy._params["rsi_len"] == 10
    ask = run(core.request_set("risk 1"))  # int accepted for a float, stored as float
    run(core.tap(confirm_of(ask), OWNER))
    assert strategy._params["risk"] == 1.0 and isinstance(strategy._params["risk"], float)


def test_manual_order_validates_then_confirms(setup) -> None:
    core, strategy, _, _ = setup
    assert "用法" in core.request_order("buy", "QQQ").text
    assert "大于 0" in core.request_order("buy", "QQQ -5").text
    assert "用法" in core.request_order("buy", "QQ;Q 5").text
    ask = core.request_order("buy", "qqq 10")
    assert ask.text.startswith("确定买入 QQQ 10？")
    assert run(core.tap(confirm_of(ask), OWNER)).text == "🧾 下单：订单 abc"
    assert strategy.calls[-1][:2] == ("manual_order", ("buy", "QQQ", 10))


def test_strategy_error_is_reported_not_raised(setup) -> None:
    core, strategy, _, _ = setup

    def broken() -> str:
        raise RuntimeError("cannot tell which shares are ours")

    strategy.flatten = broken
    done = run(core.tap(confirm_of(core.request_flatten()), OWNER))
    assert done.text == "失败：RuntimeError: cannot tell which shares are ours"


def test_busy_trading_thread_answers_later(tmp_path: Path) -> None:
    bridge = Bridge()  # nobody is serving the queue yet
    notes: list[tuple[str, str]] = []
    core = Core(
        FakeStrategy(),
        bridge,
        State(tmp_path),
        owner_id=OWNER,
        notify=lambda text, kind: notes.append((text, kind)),
        on_stop=bridge.request_stop,
        command_timeout=0.05,
    )
    reply = run(core.positions())
    assert reply.text.startswith("程序正忙")
    bridge.process()
    assert notes == [("持仓：QQQ 10 股", "info")]


def test_missing_features_are_hidden(tmp_path: Path) -> None:
    class Bare:
        def status(self) -> str:
            return "ok"

    core = Core(
        Bare(),
        Bridge(),
        State(tmp_path),
        owner_id=OWNER,
        notify=lambda *a: None,
        on_stop=lambda: None,
    )
    assert labels(Reply("", core.menu_buttons())) == ["🔄 刷新", "⏸ 暂停开仓", "⏹ 停止程序"]
    assert "没有提供平仓" in core.request_flatten().text
    assert "不支持手动下单" in core.request_order("buy", "QQQ 1").text


@pytest.mark.parametrize(
    ("raw", "value"),
    [("10", 10), ("0.5", 0.5), ("true", True), ("False", False), ('"a b"', "a b"), ("SPY", "SPY")],
)
def test_parse_value(raw: str, value: Any) -> None:
    assert parse_value(raw) == value and type(parse_value(raw)) is type(value)


def test_check_type() -> None:
    assert check_type("x", 1, 2.0) == (True, 2)
    assert check_type("x", 1, 2.5)[0] is False
    assert check_type("x", True, 1)[0] is False
    assert check_type("x", "a", 1)[0] is False
    assert check_type("x", None, [1]) == (True, [1])
