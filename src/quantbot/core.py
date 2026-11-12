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
from dataclasses import dataclass, field, replace
from typing import Any

from quantbot.audit import Audit
from quantbot.config import valid_order_qty
from quantbot.hub import Hub, Result, Strategy
from quantbot.i18n import tr
from quantbot.operations import protected

Buttons = list[list[tuple[str, str]]]  # rows of (label, callback data)

SYMBOL = re.compile(r"^[A-Za-z0-9.\-/]{1,15}$")
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
CONFIRM_TEXT = {
    "flatten": "确定平掉 {name} 的仓位？只会平它能确认归属的仓位。",
    "stop": "确定让 {name} 停止？挂着的止损单会保留。",
    "resume": "确定让 {name} 恢复开仓？",
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
        value = json.loads(text)
        json.dumps(value, allow_nan=False)
        return value
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
        return tr("还没有状态")
    if seconds < 60:
        return tr("{0} 秒前", int(seconds))
    if seconds < 3600:
        return tr("{0} 分钟前", int(seconds // 60))
    return tr("{0} 小时前", int(seconds // 3600))


class Core:
    def __init__(
        self,
        hub: Hub,
        audit: Audit,
        *,
        owner_id: int | None,
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
        return self.owner_id is not None and user_id == self.owner_id

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
            return found if found else Reply(tr("没有策略 {0}。", sid), self.picker())
        if self.current in strategies:
            return strategies[self.current]
        if len(strategies) == 1:
            return next(iter(strategies.values()))
        return Reply(tr("先选一个策略："), self.picker())

    def picker(self) -> Buttons:
        return [[(f"{self._dot(s)} {s.name}", f"o:{s.id}")] for s in self.hub.strategies.values()]

    def _dot(self, strategy: Strategy) -> str:
        return "🟢" if self.hub.online(strategy) else "🔴"

    async def call(
        self,
        strategy: Strategy,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        operation_id: str | None = None,
    ) -> tuple[bool, Result | str]:
        """Send a command and wait for the result. (False, text) when it fails, is slow or
        the strategy does not support it."""
        action = (
            strategy.actions.get(name.removeprefix("action:"))
            if name.startswith("action:")
            else None
        )
        label = action.label if action else tr(LABELS.get(name, name))
        if strategy.said_hello and not strategy.supports(name):
            return False, tr("{0} 不支持{1}。", strategy.name, label)
        online = self.hub.online(strategy)
        if not online and name != "pause":
            return False, tr("{0} 离线，命令未发送。", strategy.name)
        command = self.hub.send(strategy, name, args, operation_id=operation_id)
        if not online:
            return False, tr("{0} 离线，暂停意图已保存，等待策略确认。", strategy.name)
        try:
            result = await asyncio.wait_for(asyncio.shield(command.future), self.command_timeout)
        except asyncio.TimeoutError:

            def later(done: asyncio.Future[Result]) -> None:
                if not done.cancelled():
                    outcome = done.result()
                    text = outcome.message or (tr("完成") if outcome.ok else tr("失败"))
                    kind = "info" if outcome.ok else "alert"
                    self.notify(strategy.name, f"{label}：{text}", kind)

            command.future.add_done_callback(later)
            if protected(name):
                row = self.hub.operations.get(strategy.id, command.id)
                state = row["state"] if row is not None else "UNKNOWN"
                return False, Result(
                    False,
                    tr("操作 {0} 尚无回执。请先核对操作记录和券商状态。", command.id),
                    state=state,
                    operation_id=command.id,
                )
            return False, tr("命令已发出，还没回报结果。结果到了会推送给你。")
        if result.operation_id:
            if result.state == "UNKNOWN":
                message = tr(
                    "操作 {0} 的结果未知，请到券商端核对。{1}",
                    result.operation_id,
                    result.message,
                )
            elif result.state == "FAILED":
                message = tr("失败：{0}", result.message or tr("没有说明原因"))
            else:
                message = result.message
            return result.ok, replace(result, message=message)
        if not result.ok:
            return False, tr("失败：{0}", result.message or tr("没有说明原因"))
        return True, result

    # --------------------------------------------------------------- pages

    async def home(self) -> Reply:
        strategies = list(self.hub.strategies.values())
        if not strategies:
            return Reply(tr("还没有策略。在服务器上运行：\nquantbot add <id> --name <名字>"))
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
        rows.append([(tr("🔄 刷新"), "h"), (tr("⏸ 全部暂停开仓"), "pa")])
        return Reply("\n".join(lines), rows)

    def page_buttons(self, s: Strategy) -> Buttons:
        rows: Buttons = []
        first = [(tr("🔄 刷新"), f"o:{s.id}")]
        can_pause = not s.said_hello or s.supports("pause")
        can_resume = not s.said_hello or s.supports("resume")
        if can_pause and s.paused is not True:
            first.append((tr("⏸ 暂停开仓"), f"p:{s.id}"))
        if can_resume and s.paused is not False:
            first.append((tr("▶️ 恢复开仓"), f"r:{s.id}"))
        rows.append(first)
        second = [
            (label, f"{code}:{s.id}")
            for name, label, code in (
                ("positions", tr("📊 持仓"), "pos"),
                ("orders", tr("📋 挂单"), "ord"),
                ("chart", tr("📈 净值图"), "ch"),
            )
            if s.supports(name)
        ]
        if second:
            rows.append(second)
        third = [
            (label, self._ticket(name, s.id, {}, confirm=False))
            for name, label in (("flatten", tr("🧹 平仓")), ("stop", tr("⏹ 停止")))
            if s.supports(name)
        ]
        if third:
            rows.append(third)
        if len(self.hub.strategies) > 1:
            rows.append([(tr("⬅️ 全部策略"), "h")])
        return rows

    def page_text(self, s: Strategy, note: str = "") -> str:
        lines = [f"{self._dot(s)} {s.name} · {ago(self.hub.age(s))}"]
        if s.paused:
            lines.append(tr("⏸ 已暂停开仓"))
        if note:
            lines.append(note)
        if s.status_text:
            lines.append("")
            lines.append(s.status_text)
        elif not s.said_hello:
            lines.append(tr("还没有连上过 QuantBot。"))
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
            note = tr("离线：下面是最后一次的状态。")
        return Reply(self.page_text(s, note), self.page_buttons(s))

    # -------------------------------------------------------- simple commands

    async def switch(self, s: Strategy, name: str, user_id: int) -> Reply:
        if name == "resume":
            return self.request(name, s)
        ok, outcome = await self.call(s, name)
        if ok and isinstance(outcome, Result):
            s.paused = name == "pause"
        message = outcome.message if isinstance(outcome, Result) else outcome
        self.audit.write(name, strategy=s.id, user=user_id, ok=ok, result=message)
        default = (
            tr("⏸ 已暂停开仓。已有仓位和止损照常。") if name == "pause" else tr("▶️ 已恢复开仓。")
        )
        note = (message or default) if ok else message
        return Reply(self.page_text(s, note), self.page_buttons(s))

    async def pause_all(self, user_id: int | str) -> Reply:
        targets = [
            s for s in self.hub.strategies.values() if not s.said_hello or s.supports("pause")
        ]
        if not targets:
            return Reply(tr("没有在线、能暂停的策略。"), [[(tr("⬅️ 全部策略"), "h")]])
        outcomes = await asyncio.gather(*(self.call(s, "pause") for s in targets))
        lines = []
        for s, (ok, outcome) in zip(targets, outcomes, strict=True):
            if ok:
                s.paused = True
            lines.append(f"{'⏸' if ok else '⚠️'} {s.name}：{tr('已暂停') if ok else outcome}")
        self.audit.write("pause_all", user=user_id, strategies=[s.id for s in targets])
        return Reply("\n".join(lines), [[(tr("⬅️ 全部策略"), "h")]])

    async def positions(self, s: Strategy) -> Reply:
        ok, outcome = await self.call(s, "positions")
        text = (outcome.message or tr("没有持仓。")) if isinstance(outcome, Result) else outcome
        return Reply(f"📊 {s.name}\n{text}", [[(tr("⬅️ 返回"), f"o:{s.id}")]])

    async def orders(self, s: Strategy) -> Reply:
        back = [(tr("🔄 刷新"), f"ord:{s.id}"), (tr("⬅️ 返回"), f"o:{s.id}")]
        ok, outcome = await self.call(s, "orders")
        if not isinstance(outcome, Result):
            return Reply(outcome, [back])
        items = outcome.data if isinstance(outcome.data, list) else []
        if not items:
            return Reply(f"📋 {s.name}\n{outcome.message or tr('没有挂单。')}", [back])
        lines, rows = [f"📋 {s.name}"], []
        for index, item in enumerate(items[:20], 1):
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or item.get("id"))
            lines.append(f"{index}. {text}")
            if s.supports("cancel") and item.get("id") is not None:
                prompt = tr("确定撤掉 {0} 的第 {1} 个挂单？\n{2}", s.name, index, text)
                data = self._ticket(
                    "cancel", s.id, {"order_id": str(item["id"])}, confirm=False, prompt=prompt
                )
                rows.append([(tr("❌ 撤单 {0}", index), data)])
        rows.append(back)
        return Reply("\n".join(lines), rows)

    async def chart(self, s: Strategy) -> Reply:
        back = [[(tr("⬅️ 返回"), f"o:{s.id}")]]
        ok, outcome = await self.call(s, "chart")
        if not isinstance(outcome, Result):
            return Reply(outcome, back)
        try:
            image = base64.b64decode(str(outcome.data or ""), validate=True)
        except (binascii.Error, ValueError):
            image = b""
        if not image:
            return Reply(tr("净值图是空的。"), back)
        return Reply(outcome.message or f"📈 {s.name}", back, image)

    # ------------------------------------------- requests that need a second tap

    def ask(self, action: str, s: Strategy, args: dict[str, Any], prompt: str = "") -> Reply:
        text = prompt or tr(CONFIRM_TEXT[action], name=s.name)
        confirm = self._ticket(action, s.id, args, confirm=True)
        return Reply(
            tr("{0}\n30 秒内有效。", text), [[(tr("✅ 确定"), confirm), (tr("取消"), f"o:{s.id}")]]
        )

    def request(self, action: str, s: Strategy) -> Reply:
        if s.said_hello and not s.supports(action):
            return Reply(tr("{0} 不支持{1}。", s.name, tr(LABELS[action])))
        return self.ask(action, s, {})

    async def request_set(self, s: Strategy, raw: str) -> Reply:
        if s.said_hello and not s.supports("set_param"):
            return Reply(tr("{0} 不支持改参数。", s.name))
        name, _, value_text = raw.strip().partition(" ")
        if not NAME.match(name) or not value_text.strip():
            return Reply(tr("用法：/set 名字 值，例如 /set rsi_len 10"))
        value = parse_value(value_text)
        old: Any = None
        if s.supports("params"):
            ok, outcome = await self.call(s, "params")
            if not isinstance(outcome, Result):
                return Reply(outcome)
            current = outcome.data if isinstance(outcome.data, dict) else {}
            if name not in current:
                names = "、".join(sorted(current)) or tr("（没有）")
                return Reply(tr("{0} 没有参数 {1}。可以改的有：{2}", s.name, name, names))
            old = current[name]
            ok, value = check_type(old, value)
            if not ok:
                return Reply(
                    tr("{0} 现在是 {1}，不能改成 {2!r}。", name, type(old).__name__, value)
                )
        change = f"{old!r} → {value!r}" if old is not None else repr(value)
        args = {"name": name, "value": value, "old": old}
        return self.ask(
            "set_param",
            s,
            args,
            tr("确定把 {0} 的 {1} 改成 {2!r}？（{3}）", s.name, name, value, change),
        )

    def request_order(self, s: Strategy, side: str, raw: str) -> Reply:
        if s.said_hello and not s.supports("manual_order"):
            return Reply(tr("{0} 不支持手动下单。", s.name))
        parts = raw.split()
        word = tr("买入") if side == "buy" else tr("卖出")
        if len(parts) != 2 or not SYMBOL.match(parts[0]):
            return Reply(tr("用法：/{0} 代码 数量，例如 /{1} QQQ 10", side, side))
        qty = parse_value(parts[1])
        if not valid_order_qty(qty, s.max_order_qty):
            return Reply(tr("数量要是大于 0 且不超过 {0} 的有限数。", s.max_order_qty))
        symbol = parts[0].upper()
        args = {"side": side, "symbol": symbol, "qty": qty}
        return self.ask(
            "manual_order", s, args, tr("确定让 {0} {1} {2} {3}？", s.name, word, symbol, qty)
        )

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
        return Reply(tr("这个按钮已失效。"), [[(tr("⬅️ 菜单"), "h")]])

    async def _tap_ticket(self, token: str, user_id: int) -> Reply:
        ticket = self._tickets.get(token)
        if ticket is None or ticket.used or ticket.expires <= self.clock():
            return Reply(tr("这个按钮已失效，请重新操作。"), [[(tr("⬅️ 菜单"), "h")]])
        s = self.hub.strategies.get(ticket.sid)
        if s is None:
            return Reply(tr("这个策略已经不在清单里了。"))
        if not ticket.confirm:  # an offer only opens a confirmation, so it can be reused
            return self.ask(ticket.action, s, ticket.args, ticket.prompt)
        ticket.used = True
        return await self.execute(ticket, s, token, user_id)

    async def execute(self, ticket: Ticket, s: Strategy, op: str, user_id: int) -> Reply:
        args = {k: v for k, v in ticket.args.items() if k != "old"}
        ok, outcome = await self.call(s, ticket.action, args, operation_id=op)
        label = tr(LABELS[ticket.action])
        if isinstance(outcome, Result):
            text = f"{s.name} {label}：{outcome.message or tr('完成')}"
            if ok and ticket.action == "set_param":
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
        return Reply(text, [[(tr("⬅️ 返回"), f"o:{s.id}")]])
