"""What each Telegram command and button does, without any Telegram types.

`bot.py` turns updates into calls here and `Reply` objects back into messages,
so this file is tested with the real hub and no Telegram at all.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from quantbot.audit import Audit
from quantbot.hub import Hub, Result, Strategy

Buttons = list[list[tuple[str, str]]]  # rows of (label, callback data)

SYMBOL = re.compile(r"^[A-Za-z0-9.\-/]{1,15}$")
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
CONFIRM_TEXT = {
    "flatten": "确定平掉 {name} 的仓位？只会平它能确认归属的仓位。",
    "stop": "确定让 {name} 停止？挂着的止损单会保留。",
}
LABELS = {
    "status": "状态", "pause": "暂停开仓", "resume": "恢复开仓", "positions": "持仓",
    "orders": "挂单", "cancel": "撤单", "flatten": "平仓", "params": "参数",
    "set_param": "改参数", "manual_order": "下单", "chart": "净值图", "stop": "停止",
}  # fmt: skip


@dataclass
class Reply:
    text: str
    buttons: Buttons = field(default_factory=list)
    image: bytes | None = None


@dataclass
class Ticket:
    action: str
    sid: str
    args: dict[str, Any]
    expires: float
    confirm: bool  # True: this tap runs it. False: this tap asks for confirmation.
    prompt: str = ""
    used: bool = False


def parse_value(raw: str) -> Any:
    """`10` -> 10, `0.5` -> 0.5, `true` -> True, `"a b"` -> "a b", anything else as text."""
    text = raw.strip()
    if text in {"True", "False"}:
        return text == "True"
    try:
        return json.loads(text)
    except ValueError:
        return text


def check_type(old: Any, new: Any) -> tuple[bool, Any]:
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


def ago(seconds: float | None) -> str:
    if seconds is None:
        return "还没有状态"
    if seconds < 60:
        return f"{int(seconds)} 秒前"
    if seconds < 3600:
        return f"{int(seconds // 60)} 分钟前"
    return f"{int(seconds // 3600)} 小时前"


class Core:
    def __init__(
        self,
        hub: Hub,
        audit: Audit,
        *,
        owner_id: int,
        notify: Callable[[str, str, str], None],
        command_timeout: float = 15.0,
        confirm_ttl: float = 30.0,
        offer_ttl: float = 600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.hub = hub
        self.audit = audit
        self.owner_id = owner_id
        self.notify = notify  # (strategy name, text, kind)
        self.command_timeout = command_timeout
        self.confirm_ttl = confirm_ttl
        self.offer_ttl = offer_ttl
        self.clock = clock
        self.current: str | None = None
        self._tickets: dict[str, Ticket] = {}

    # ------------------------------------------------------------ helpers

    def allowed(self, user_id: int | None) -> bool:
        return user_id == self.owner_id

    def _ticket(
        self, action: str, sid: str, args: dict[str, Any], *, confirm: bool, prompt: str = ""
    ) -> str:
        now = self.clock()
        self._tickets = {k: v for k, v in self._tickets.items() if v.expires > now and not v.used}
        token = secrets.token_urlsafe(8)
        ttl = self.confirm_ttl if confirm else self.offer_ttl
        self._tickets[token] = Ticket(action, sid, args, now + ttl, confirm, prompt)
        return f"t:{token}"

    def target(self, sid: str | None = None) -> Strategy | Reply:
        """The strategy a command is about: the given id, the current one, or the only one."""
        strategies = self.hub.strategies
        if sid is not None:
            found = strategies.get(sid)
            return found if found else Reply(f"没有策略 {sid}。", self.picker())
        if self.current in strategies:
            return strategies[self.current]
        if len(strategies) == 1:
            return next(iter(strategies.values()))
        return Reply("先选一个策略：", self.picker())

    def picker(self) -> Buttons:
        return [[(f"{self._dot(s)} {s.name}", f"o:{s.id}")] for s in self.hub.strategies.values()]

    def _dot(self, strategy: Strategy) -> str:
        return "🟢" if self.hub.online(strategy) else "🔴"

    async def call(
        self, strategy: Strategy, name: str, args: dict[str, Any] | None = None
    ) -> tuple[bool, Result | str]:
        """Send a command and wait for the result. (False, text) when it fails, is slow or
        the strategy does not support it."""
        label = LABELS[name]
        if strategy.said_hello and not strategy.supports(name):
            return False, f"{strategy.name} 不支持{label}。"
        online = self.hub.online(strategy)
        command = self.hub.send(strategy, name, args)
        try:
            result = await asyncio.wait_for(asyncio.shield(command.future), self.command_timeout)
        except asyncio.TimeoutError:

            def later(done: asyncio.Future[Result]) -> None:
                if not done.cancelled():
                    outcome = done.result()
                    text = outcome.message or ("完成" if outcome.ok else "失败")
                    kind = "info" if outcome.ok else "alert"
                    self.notify(strategy.name, f"{label}：{text}", kind)

            command.future.add_done_callback(later)
            if not online:
                return False, f"{strategy.name} 离线，命令已排队。2 分钟内它上线才会执行。"
            return False, "命令已发出，还没回报结果。结果到了会推送给你。"
        if not result.ok:
            return False, f"失败：{result.message or '没有说明原因'}"
        return True, result

    # --------------------------------------------------------------- pages

    async def home(self) -> Reply:
        strategies = list(self.hub.strategies.values())
        if not strategies:
            return Reply("还没有策略。在服务器上运行：\nquantbot add <id> --name <名字>")
        if len(strategies) == 1:
            return await self.open(strategies[0].id)
        lines = []
        for s in strategies:
            first = (s.status_text or "").splitlines()[0] if s.status_text else ""
            pause = " ⏸" if s.paused else ""
            lines.append(f"{self._dot(s)} {s.name}{pause} · {ago(self.hub.age(s))}")
            if first:
                lines.append(f"    {first}")
        rows = self.picker()
        rows.append([("🔄 刷新", "h"), ("⏸ 全部暂停开仓", "pa")])
        return Reply("\n".join(lines), rows)

    def page_buttons(self, s: Strategy) -> Buttons:
        rows: Buttons = []
        first = [("🔄 刷新", f"o:{s.id}")]
        can_pause = not s.said_hello or s.supports("pause")
        can_resume = not s.said_hello or s.supports("resume")
        if can_pause and s.paused is not True:
            first.append(("⏸ 暂停开仓", f"p:{s.id}"))
        if can_resume and s.paused is not False:
            first.append(("▶️ 恢复开仓", f"r:{s.id}"))
        rows.append(first)
        second = [
            (label, f"{code}:{s.id}")
            for name, label, code in (
                ("positions", "📊 持仓", "pos"),
                ("orders", "📋 挂单", "ord"),
                ("chart", "📈 净值图", "ch"),
            )
            if s.supports(name)
        ]
        if second:
            rows.append(second)
        third = [
            (label, self._ticket(name, s.id, {}, confirm=False))
            for name, label in (("flatten", "🧹 平仓"), ("stop", "⏹ 停止"))
            if s.supports(name)
        ]
        if third:
            rows.append(third)
        if len(self.hub.strategies) > 1:
            rows.append([("⬅️ 全部策略", "h")])
        return rows

    def page_text(self, s: Strategy, note: str = "") -> str:
        lines = [f"{self._dot(s)} {s.name} · {ago(self.hub.age(s))}"]
        if s.paused:
            lines.append("⏸ 已暂停开仓")
        if note:
            lines.append(note)
        if s.status_text:
            lines.append("")
            lines.append(s.status_text)
        elif not s.said_hello:
            lines.append("还没有连上过 QuantBot。")
        return "\n".join(lines)

    async def open(self, sid: str) -> Reply:
        s = self.target(sid)
        if isinstance(s, Reply):
            return s
        self.current = s.id
        note = ""
        if s.supports("status") and self.hub.online(s):
            ok, outcome = await self.call(s, "status")  # the result refreshes the snapshot
            if not ok:
                note = str(outcome)
        elif not self.hub.online(s):
            note = "离线：下面是最后一次的状态。"
        return Reply(self.page_text(s, note), self.page_buttons(s))

    # -------------------------------------------------------- simple commands

    async def switch(self, s: Strategy, name: str, user_id: int) -> Reply:
        ok, outcome = await self.call(s, name)
        if ok and isinstance(outcome, Result):
            s.paused = name == "pause"
        message = outcome.message if isinstance(outcome, Result) else outcome
        self.audit.write(name, strategy=s.id, user=user_id, ok=ok, result=message)
        default = "⏸ 已暂停开仓。已有仓位和止损照常。" if name == "pause" else "▶️ 已恢复开仓。"
        note = (message or default) if ok else message
        return Reply(self.page_text(s, note), self.page_buttons(s))

    async def pause_all(self, user_id: int) -> Reply:
        targets = [
            s
            for s in self.hub.strategies.values()
            if self.hub.online(s) and (not s.said_hello or s.supports("pause"))
        ]
        if not targets:
            return Reply("没有在线、能暂停的策略。", [[("⬅️ 全部策略", "h")]])
        outcomes = await asyncio.gather(*(self.call(s, "pause") for s in targets))
        lines = []
        for s, (ok, outcome) in zip(targets, outcomes, strict=True):
            if ok:
                s.paused = True
            lines.append(f"{'⏸' if ok else '⚠️'} {s.name}：{'已暂停' if ok else outcome}")
        self.audit.write("pause_all", user=user_id, strategies=[s.id for s in targets])
        return Reply("\n".join(lines), [[("⬅️ 全部策略", "h")]])

    async def positions(self, s: Strategy) -> Reply:
        ok, outcome = await self.call(s, "positions")
        text = (outcome.message or "没有持仓。") if isinstance(outcome, Result) else outcome
        return Reply(f"📊 {s.name}\n{text}", [[("⬅️ 返回", f"o:{s.id}")]])

    async def orders(self, s: Strategy) -> Reply:
        back = [("🔄 刷新", f"ord:{s.id}"), ("⬅️ 返回", f"o:{s.id}")]
        ok, outcome = await self.call(s, "orders")
        if not isinstance(outcome, Result):
            return Reply(outcome, [back])
        items = outcome.data if isinstance(outcome.data, list) else []
        if not items:
            return Reply(f"📋 {s.name}\n{outcome.message or '没有挂单。'}", [back])
        lines, rows = [f"📋 {s.name}"], []
        for index, item in enumerate(items[:20], 1):
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or item.get("id"))
            lines.append(f"{index}. {text}")
            if s.supports("cancel") and item.get("id") is not None:
                prompt = f"确定撤掉 {s.name} 的第 {index} 个挂单？\n{text}"
                data = self._ticket(
                    "cancel", s.id, {"order_id": str(item["id"])}, confirm=False, prompt=prompt
                )
                rows.append([(f"❌ 撤单 {index}", data)])
        rows.append(back)
        return Reply("\n".join(lines), rows)

    async def chart(self, s: Strategy) -> Reply:
        back = [[("⬅️ 返回", f"o:{s.id}")]]
        ok, outcome = await self.call(s, "chart")
        if not isinstance(outcome, Result):
            return Reply(outcome, back)
        try:
            image = base64.b64decode(str(outcome.data or ""), validate=True)
        except (binascii.Error, ValueError):
            image = b""
        if not image:
            return Reply("净值图是空的。", back)
        return Reply(outcome.message or f"📈 {s.name}", back, image)

    # ------------------------------------------- requests that need a second tap

    def ask(self, action: str, s: Strategy, args: dict[str, Any], prompt: str = "") -> Reply:
        text = prompt or CONFIRM_TEXT[action].format(name=s.name)
        confirm = self._ticket(action, s.id, args, confirm=True)
        return Reply(f"{text}\n30 秒内有效。", [[("✅ 确定", confirm), ("取消", f"o:{s.id}")]])

    def request(self, action: str, s: Strategy) -> Reply:
        if s.said_hello and not s.supports(action):
            return Reply(f"{s.name} 不支持{LABELS[action]}。")
        return self.ask(action, s, {})

    async def request_set(self, s: Strategy, raw: str) -> Reply:
        if s.said_hello and not s.supports("set_param"):
            return Reply(f"{s.name} 不支持改参数。")
        name, _, value_text = raw.strip().partition(" ")
        if not NAME.match(name) or not value_text.strip():
            return Reply("用法：/set 名字 值，例如 /set rsi_len 10")
        value = parse_value(value_text)
        old: Any = None
        if s.supports("params"):
            ok, outcome = await self.call(s, "params")
            if not isinstance(outcome, Result):
                return Reply(outcome)
            current = outcome.data if isinstance(outcome.data, dict) else {}
            if name not in current:
                names = "、".join(sorted(current)) or "（没有）"
                return Reply(f"{s.name} 没有参数 {name}。可以改的有：{names}")
            old = current[name]
            ok, value = check_type(old, value)
            if not ok:
                return Reply(f"{name} 现在是 {type(old).__name__}，不能改成 {value!r}。")
        change = f"{old!r} → {value!r}" if old is not None else repr(value)
        args = {"name": name, "value": value, "old": old}
        return self.ask(
            "set_param", s, args, f"确定把 {s.name} 的 {name} 改成 {value!r}？（{change}）"
        )

    def request_order(self, s: Strategy, side: str, raw: str) -> Reply:
        if s.said_hello and not s.supports("manual_order"):
            return Reply(f"{s.name} 不支持手动下单。")
        parts = raw.split()
        word = "买入" if side == "buy" else "卖出"
        if len(parts) != 2 or not SYMBOL.match(parts[0]):
            return Reply(f"用法：/{side} 代码 数量，例如 /{side} QQQ 10")
        qty = parse_value(parts[1])
        if isinstance(qty, bool) or not isinstance(qty, int | float) or not qty > 0:
            return Reply("数量要是大于 0 的数。")
        symbol = parts[0].upper()
        args = {"side": side, "symbol": symbol, "qty": qty}
        return self.ask("manual_order", s, args, f"确定让 {s.name} {word} {symbol} {qty}？")

    # ------------------------------------------------------------- buttons

    async def tap(self, data: str, user_id: int) -> Reply:
        if data == "h":
            return await self.home()
        if data == "pa":
            return await self.pause_all(user_id)
        code, _, rest = data.partition(":")
        if code == "t":
            return await self._tap_ticket(rest, user_id)
        s = self.target(rest)
        if isinstance(s, Reply):
            return s
        self.current = s.id
        if code == "o":
            return await self.open(s.id)
        if code in {"p", "r"}:
            return await self.switch(s, "pause" if code == "p" else "resume", user_id)
        if code == "pos":
            return await self.positions(s)
        if code == "ord":
            return await self.orders(s)
        if code == "ch":
            return await self.chart(s)
        return Reply("这个按钮已失效。", [[("⬅️ 菜单", "h")]])

    async def _tap_ticket(self, token: str, user_id: int) -> Reply:
        ticket = self._tickets.get(token)
        if ticket is None or ticket.used or ticket.expires <= self.clock():
            return Reply("这个按钮已失效，请重新操作。", [[("⬅️ 菜单", "h")]])
        s = self.hub.strategies.get(ticket.sid)
        if s is None:
            return Reply("这个策略已经不在清单里了。")
        if not ticket.confirm:  # an offer only opens a confirmation, so it can be reused
            return self.ask(ticket.action, s, ticket.args, ticket.prompt)
        ticket.used = True
        return await self.execute(ticket, s, token, user_id)

    async def execute(self, ticket: Ticket, s: Strategy, op: str, user_id: int) -> Reply:
        args = {k: v for k, v in ticket.args.items() if k != "old"}
        ok, outcome = await self.call(s, ticket.action, args)
        label = LABELS[ticket.action]
        if isinstance(outcome, Result):
            text = f"{s.name} {label}：{outcome.message or '完成'}"
            if ticket.action == "set_param":
                old, value = ticket.args.get("old"), ticket.args["value"]
                change = f"{old!r} → {value!r}" if old is not None else repr(value)
                text = f"✏️ {s.name} {ticket.args['name']}：{change}"
                if outcome.message:
                    text += f"\n{outcome.message}"
        else:
            text = f"{s.name} {label}：{outcome}"
        self.audit.write(
            ticket.action, strategy=s.id, user=user_id, op=op, args=args, ok=ok, result=text
        )
        return Reply(text, [[("⬅️ 返回", f"o:{s.id}")]])
