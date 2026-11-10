"""What each command and button does, without any Telegram types.

`bot.py` turns Telegram updates into calls here and turns `Reply` objects back
into messages, so this file can be tested with a plain fake strategy.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Any

from quantgram.bridge import Bridge, Stopped
from quantgram.state import State

Buttons = list[list[tuple[str, str]]]  # rows of (label, callback data)

SYMBOL = re.compile(r"^[A-Za-z0-9.\-/]{1,15}$")
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

# Actions that change orders, positions or the program, and need a second tap.
CONFIRM_TEXT = {
    "flatten": "确定平掉本程序的仓位？",
    "stop": "确定停止程序？挂着的止损单会保留。",
}


@dataclass
class Reply:
    text: str
    buttons: Buttons = field(default_factory=list)


@dataclass
class Ticket:
    action: str
    args: tuple[Any, ...]
    expires: float
    confirm: bool  # True: this tap executes. False: this tap asks for confirmation.
    prompt: str = ""
    used: bool = False


def _fmt_error(exc: BaseException) -> str:
    if isinstance(exc, Stopped):
        return str(exc)
    return f"{type(exc).__name__}: {exc}"


def parse_value(raw: str) -> Any:
    """`10` -> 10, `0.5` -> 0.5, `true` -> True, `"a b"` -> "a b", anything else as text."""
    text = raw.strip()
    if text in {"True", "False"}:
        return text == "True"
    try:
        return json.loads(text)
    except ValueError:
        return text


def check_type(name: str, old: Any, new: Any) -> tuple[bool, Any]:
    """Can `new` replace `old`? Returns (ok, value converted where safe)."""
    if old is None:
        return True, new
    if isinstance(old, bool) or isinstance(new, bool):
        return isinstance(old, bool) and isinstance(new, bool), new
    if isinstance(old, float) and isinstance(new, int):
        return True, float(new)
    if isinstance(old, int) and isinstance(new, float) and new.is_integer():
        return True, int(new)
    return type(old) is type(new), new


class Core:
    def __init__(
        self,
        strategy: Any,
        bridge: Bridge,
        state: State,
        *,
        owner_id: int,
        notify: Callable[[str, str], None],
        on_stop: Callable[[], None],
        command_timeout: float = 15.0,
        confirm_ttl: float = 30.0,
        offer_ttl: float = 600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.strategy = strategy
        self.bridge = bridge
        self.state = state
        self.owner_id = owner_id
        self.notify = notify
        self.on_stop = on_stop
        self.command_timeout = command_timeout
        self.confirm_ttl = confirm_ttl
        self.offer_ttl = offer_ttl
        self.clock = clock
        self._tickets: dict[str, Ticket] = {}

    # ------------------------------------------------------------- helpers

    def has(self, method: str) -> bool:
        return callable(getattr(self.strategy, method, None))

    def allowed(self, user_id: int | None) -> bool:
        return user_id == self.owner_id

    def _ticket(
        self, action: str, args: tuple[Any, ...], *, confirm: bool, prompt: str = ""
    ) -> str:
        now = self.clock()
        self._tickets = {
            key: value
            for key, value in self._tickets.items()
            if value.expires > now and not value.used
        }
        token = secrets.token_urlsafe(8)
        ttl = self.confirm_ttl if confirm else self.offer_ttl
        self._tickets[token] = Ticket(action, args, now + ttl, confirm, prompt)
        return f"t:{token}"

    async def _call(self, method: str, *args: Any, label: str = "") -> tuple[bool, Any]:
        """Run a strategy method on the trading thread. (False, text) when it fails or is slow."""
        future: Future[Any] = self.bridge.submit(getattr(self.strategy, method), *args)
        try:
            return True, await asyncio.wait_for(
                asyncio.shield(asyncio.wrap_future(future)), self.command_timeout
            )
        except asyncio.TimeoutError:
            what = label or method

            def later(done: Future[Any]) -> None:
                if done.cancelled():
                    return
                error = done.exception()
                result = f"失败：{_fmt_error(error)}" if error else str(done.result() or "完成")
                self.notify(f"{what}：{result}", "info")

            future.add_done_callback(later)
            return False, "程序正忙，命令已排队，完成后会通知你。"
        except Exception as exc:  # noqa: BLE001 - the strategy's error is the answer
            return False, f"失败：{_fmt_error(exc)}"

    # ---------------------------------------------------------------- menu

    def menu_buttons(self) -> Buttons:
        rows: Buttons = [[("🔄 刷新", "m")]]
        rows[0].append(("▶️ 恢复开仓", "r") if self.state.paused else ("⏸ 暂停开仓", "p"))
        second = []
        if self.has("positions"):
            second.append(("📊 持仓", "pos"))
        if self.has("orders"):
            second.append(("📋 挂单", "ord"))
        if self.has("chart"):
            second.append(("📈 净值图", "chart"))
        if second:
            rows.append(second)
        third = []
        if self.has("flatten"):
            third.append(("🧹 平仓", self._ticket("flatten", (), confirm=False)))
        third.append(("⏹ 停止程序", self._ticket("stop", (), confirm=False)))
        rows.append(third)
        return rows

    async def menu(self) -> Reply:
        lines = []
        if self.state.paused:
            reason = self.state.pause_reason
            lines.append("⏸ 已暂停开仓" + (f"：{reason}" if reason else ""))
        if self.bridge.stopping:
            lines.append("⏹ 正在停止")
        if self.has("status"):
            ok, text = await self._call("status", label="状态")
            lines.append(str(text) if ok else text)
        else:
            lines.append("运行中")
        return Reply("\n".join(lines), self.menu_buttons())

    # ---------------------------------------------------------- pause switch

    def pause(self, user_id: int, reason: str = "") -> Reply:
        changed = self.state.set_paused(True, reason or "手动暂停")
        self.state.audit("pause", user=user_id, changed=changed)
        return Reply("⏸ 已暂停开仓。已有仓位和止损照常。", self.menu_buttons())

    def resume(self, user_id: int) -> Reply:
        changed = self.state.set_paused(False)
        self.state.audit("resume", user=user_id, changed=changed)
        return Reply("▶️ 已恢复开仓。", self.menu_buttons())

    # --------------------------------------------------------------- lists

    async def positions(self) -> Reply:
        if not self.has("positions"):
            return Reply("这个程序没有提供持仓。")
        ok, text = await self._call("positions", label="持仓")
        return Reply(str(text) if ok else text, [[("⬅️ 菜单", "m")]])

    async def orders(self) -> Reply:
        if not self.has("orders"):
            return Reply("这个程序没有提供挂单。")
        ok, items = await self._call("orders", label="挂单")
        if not ok:
            return Reply(items, [[("⬅️ 菜单", "m")]])
        items = list(items or [])
        if not items:
            return Reply("没有挂单。", [[("⬅️ 菜单", "m")]])
        lines, rows = [], []
        for index, item in enumerate(items, 1):
            lines.append(f"{index}. {item.get('text', item.get('id'))}")
            if self.has("cancel") and item.get("id") is not None:
                prompt = f"确定撤掉第 {index} 个挂单？\n{item.get('text', '')}"
                data = self._ticket("cancel", (item["id"],), confirm=False, prompt=prompt)
                rows.append([(f"❌ 撤单 {index}", data)])
        rows.append([("🔄 刷新", "ord"), ("⬅️ 菜单", "m")])
        return Reply("\n".join(lines), rows)

    async def chart(self) -> bytes | Reply:
        if not self.has("chart"):
            return Reply("这个程序没有提供净值图。")
        ok, image = await self._call("chart", label="净值图")
        if not ok:
            return Reply(image)
        if not isinstance(image, bytes | bytearray) or not image:
            return Reply("净值图是空的。")
        return bytes(image)

    # ------------------------------------------------ requests with a second tap

    def ask(self, action: str, args: tuple[Any, ...] = (), prompt: str = "") -> Reply:
        text = prompt or CONFIRM_TEXT[action]
        confirm = self._ticket(action, args, confirm=True)
        return Reply(f"{text}\n30 秒内有效。", [[("✅ 确定", confirm), ("取消", "m")]])

    def request_flatten(self) -> Reply:
        if not self.has("flatten"):
            return Reply("这个程序没有提供平仓。")
        return self.ask("flatten")

    def request_stop(self) -> Reply:
        return self.ask("stop")

    async def request_set(self, raw: str) -> Reply:
        if not self.has("set_param"):
            return Reply("这个程序不支持改参数。")
        name, _, value_text = raw.strip().partition(" ")
        if not NAME.match(name) or not value_text.strip():
            return Reply("用法：/set 名字 值，例如 /set rsi_len 10")
        value = parse_value(value_text)
        old: Any = None
        if self.has("params"):
            ok, current = await self._call("params", label="参数")
            if not ok:
                return Reply(current)
            current = dict(current or {})
            if name not in current:
                names = "、".join(sorted(current)) or "（没有）"
                return Reply(f"没有参数 {name}。可以改的有：{names}")
            old = current[name]
            ok, value = check_type(name, old, value)
            if not ok:
                return Reply(f"{name} 现在是 {type(old).__name__}，不能改成 {value!r}。")
        change = f"{old!r} → {value!r}" if old is not None else repr(value)
        return self.ask("set", (name, value, old), f"确定把 {name} 改成 {value!r}？（{change}）")

    def request_order(self, side: str, raw: str) -> Reply:
        if not self.has("manual_order"):
            return Reply("这个程序不支持手动下单。")
        parts = raw.split()
        word = "买入" if side == "buy" else "卖出"
        if len(parts) != 2 or not SYMBOL.match(parts[0]):
            return Reply(f"用法：/{side} 代码 数量，例如 /{side} QQQ 10")
        qty = parse_value(parts[1])
        if isinstance(qty, bool) or not isinstance(qty, int | float) or not qty > 0:
            return Reply("数量要是大于 0 的数。")
        symbol = parts[0].upper()
        return self.ask("order", (side, symbol, qty), f"确定{word} {symbol} {qty}？")

    # ------------------------------------------------------------- buttons

    async def tap(self, data: str, user_id: int) -> Reply | bytes:
        simple = {"m": self.menu, "pos": self.positions, "ord": self.orders, "chart": self.chart}
        if data in simple:
            return await simple[data]()
        if data == "p":
            return self.pause(user_id)
        if data == "r":
            return self.resume(user_id)
        if not data.startswith("t:"):
            return Reply("这个按钮已失效。", [[("⬅️ 菜单", "m")]])
        token = data[2:]
        ticket = self._tickets.get(token)
        if ticket is None or ticket.used or ticket.expires <= self.clock():
            return Reply("这个按钮已失效，请重新操作。", [[("⬅️ 菜单", "m")]])
        if not ticket.confirm:  # an offer only opens a confirmation, so it can be reused
            if ticket.action == "flatten":
                return self.request_flatten()
            if ticket.action == "stop":
                return self.request_stop()
            return self.ask(ticket.action, ticket.args, ticket.prompt)
        ticket.used = True
        return await self.execute(ticket, token, user_id)

    async def execute(self, ticket: Ticket, op: str, user_id: int) -> Reply:
        back = [[("⬅️ 菜单", "m")]]
        if ticket.action == "stop":
            self.state.audit("stop", user=user_id, op=op)
            self.on_stop()
            return Reply("⏹ 正在停止程序。交易线程退出后会通知你。")
        if ticket.action == "flatten":
            ok, result = await self._call("flatten", label="平仓")
            text = f"🧹 平仓：{result}" if ok else result
        elif ticket.action == "cancel":
            ok, result = await self._call("cancel", *ticket.args, label="撤单")
            text = f"❌ 撤单：{result or '完成'}" if ok else result
        elif ticket.action == "set":
            name, value, old = ticket.args
            ok, result = await self._call("set_param", name, value, label=f"改参数 {name}")
            change = f"{old!r} → {value!r}" if old is not None else repr(value)
            text = f"✏️ {name}：{change}" + (f"\n{result}" if ok and result else "")
            if not ok:
                text = result
        elif ticket.action == "order":
            ok, result = await self._call("manual_order", *ticket.args, label="手动下单")
            text = f"🧾 下单：{result or '已提交'}" if ok else result
        else:
            return Reply("未知操作。", back)
        self.state.audit(ticket.action, user=user_id, op=op, args=ticket.args, ok=ok, result=text)
        return Reply(text, back)
