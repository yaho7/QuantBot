"""Everything QuantBot knows about each strategy, and the commands waiting for it.

All of this lives on the bot's asyncio loop: the HTTP server and the Telegram
handlers run there, so no locks are needed. Nothing is saved: after a restart
the strategies say hello again and pending commands are gone, which is safer
than running them late.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from quantbot.config import StrategyConfig
from quantbot.notices import Connections, Expiries

COMMANDS = (
    "status", "pause", "resume", "positions", "orders", "cancel", "flatten",
    "params", "set_param", "manual_order", "chart", "stop",
)  # fmt: skip
EVENT_KINDS = {
    "fill": "trade",
    "info": "info",
    "summary": "info",
    "alert": "alert",
    "error": "error",
}
EVENT_ICONS = {"fill": "🧾 ", "info": "", "summary": "📅 ", "alert": "⚠️ ", "error": "❌ "}
MAX_TEXT = 3500

# (strategy name, text, kind, image) -> delivered to Telegram by the bot
Notify = Callable[[str, str, str, "bytes | None"], None]


class EventError(ValueError):
    pass


@dataclass
class Result:
    ok: bool
    message: str = ""
    data: Any = None


@dataclass
class Command:
    id: str
    name: str
    args: dict[str, Any]
    created: float
    future: asyncio.Future[Result]
    delivered_at: float | None = None


@dataclass
class Strategy:
    id: str
    name: str
    token: str = field(repr=False)
    commands: tuple[str, ...] = ()
    said_hello: bool = False
    status_text: str | None = None
    paused: bool | None = None
    status_at: float | None = None
    last_seen: float | None = None
    polling: int = 0
    was_online: bool = False
    pending: dict[str, Command] = field(default_factory=dict)
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    def supports(self, name: str) -> bool:
        return name in self.commands


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Hub:
    def __init__(
        self,
        strategies: tuple[StrategyConfig, ...],
        notify: Notify,
        *,
        offline_after: float = 45.0,
        redeliver_after: float = 20.0,
        undelivered_ttl: float = 120.0,
        result_ttl: float = 600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.strategies = {s.id: Strategy(s.id, s.name, s.token) for s in strategies}
        self.notify = notify
        self.offline_after = offline_after
        self.redeliver_after = redeliver_after
        self.undelivered_ttl = undelivered_ttl
        self.result_ttl = result_ttl
        self.clock = clock
        self.connections = Connections()
        self.expiries = Expiries()

    def sync(self, strategies: tuple[StrategyConfig, ...]) -> list[str]:
        """Apply a changed strategy list without a restart. Returns what changed."""
        changes = []
        wanted = {s.id: s for s in strategies}
        for sid in list(self.strategies):
            if sid not in wanted:
                old = self.strategies.pop(sid)
                for command in old.pending.values():
                    if not command.future.done():
                        command.future.set_result(Result(False, "这个策略已经被删除。"))
                old.wake.set()
                changes.append(f"删除 {sid}")
        for sid, config in wanted.items():
            current = self.strategies.get(sid)
            if current is None:
                self.strategies[sid] = Strategy(sid, config.name, config.token)
                changes.append(f"添加 {sid}")
                continue
            if current.token != config.token:
                current.token = config.token
                current.wake.set()
                changes.append(f"换了 {sid} 的 token")
            if current.name != config.name:
                current.name = config.name
                changes.append(f"{sid} 改名为 {config.name}")
        order = list(wanted)
        self.strategies = dict(sorted(self.strategies.items(), key=lambda kv: order.index(kv[0])))
        return changes

    # ----------------------------------------------------------- lookups

    def by_token(self, token: str) -> Strategy | None:
        match = None
        for strategy in self.strategies.values():  # check them all: constant time per token
            if hmac.compare_digest(strategy.token.encode(), token.encode()):
                match = strategy
        return match

    def online(self, strategy: Strategy) -> bool:
        if strategy.polling:
            return True
        seen = strategy.last_seen
        return seen is not None and self.clock() - seen < self.offline_after

    def age(self, strategy: Strategy) -> float | None:
        return None if strategy.status_at is None else self.clock() - strategy.status_at

    # ------------------------------------------------------- bot side

    def send(self, strategy: Strategy, name: str, args: dict[str, Any] | None = None) -> Command:
        if name not in COMMANDS:
            raise ValueError(f"unknown command {name}")
        command = Command(
            uuid.uuid4().hex,
            name,
            dict(args or {}),
            self.clock(),
            asyncio.get_running_loop().create_future(),
        )
        strategy.pending[command.id] = command
        strategy.wake.set()
        return command

    # -------------------------------------------------- strategy side

    def _seen(self, strategy: Strategy) -> None:
        strategy.last_seen = self.clock()
        if not strategy.was_online:
            if strategy.said_hello or strategy.status_at is not None:
                self.notify(strategy.name, "🟢 恢复在线", "info", None)
            strategy.was_online = True

    def _deliverable(self, strategy: Strategy) -> list[Command]:
        now = self.clock()
        ready = [
            c
            for c in strategy.pending.values()
            if c.delivered_at is None or now - c.delivered_at >= self.redeliver_after
        ]
        for command in ready:
            command.delivered_at = now
        return ready

    def authorized(self, strategy: Strategy, token: str) -> bool:
        return self.strategies.get(strategy.id) is strategy and strategy.token == token

    async def poll(self, strategy: Strategy, wait: float) -> dict[str, Any] | None:
        self._seen(strategy)
        strategy.polling += 1
        token = strategy.token
        try:
            deadline = self.clock() + wait
            while self.authorized(strategy, token):
                ready = self._deliverable(strategy)
                left = deadline - self.clock()
                if ready or left <= 0:
                    return {
                        "commands": [{"id": c.id, "name": c.name, "args": c.args} for c in ready],
                        "need_hello": not strategy.said_hello,
                    }
                strategy.wake.clear()
                try:
                    await asyncio.wait_for(strategy.wake.wait(), min(left, self.redeliver_after))
                except asyncio.TimeoutError:
                    pass
            return None
        finally:
            strategy.polling -= 1
            if self.authorized(strategy, token):
                self._seen(strategy)

    def result(self, strategy: Strategy, command_id: str, body: dict[str, Any]) -> bool:
        self._seen(strategy)
        command = strategy.pending.pop(command_id, None)
        if command is None:
            return False
        result = Result(bool(body.get("ok")), _text(body.get("message")), body.get("data"))
        if command.name == "status" and result.ok and isinstance(result.data, dict):
            self._status(strategy, result.data)
        if not command.future.done():
            command.future.set_result(result)
        return True

    def event(self, strategy: Strategy, body: dict[str, Any]) -> None:
        self._seen(strategy)
        kind = body.get("type")
        if kind == "hello":
            names = body.get("commands")
            if not isinstance(names, list):
                raise EventError("hello needs a `commands` list")
            strategy.commands = tuple(n for n in COMMANDS if n in names)
            strategy.said_hello = True
        elif kind == "status":
            self._status(strategy, body)
        elif kind in EVENT_KINDS:
            image = None
            if kind == "summary" and body.get("image"):
                try:
                    image = base64.b64decode(str(body["image"]), validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise EventError("image must be base64 PNG data") from exc
            text = EVENT_ICONS[kind] + _text(body.get("message"))
            self.notify(strategy.name, text, EVENT_KINDS[kind], image)
        elif kind == "connection":
            name, ok = _text(body.get("name"), 64), body.get("ok")
            if not name or not isinstance(ok, bool):
                raise EventError("connection needs `name` and a true/false `ok`")
            if self.connections.change(f"{strategy.id}:{name}", ok):
                detail = _text(body.get("detail"), 500)
                if ok:
                    self.notify(strategy.name, f"✅ {name} 已恢复连接", "info", None)
                else:
                    text = f"🔌 {name} 断开" + (f"：{detail}" if detail else "")
                    self.notify(strategy.name, text, "alert", None)
        elif kind == "expiry":
            label = _text(body.get("name"), 64)
            try:
                expires_at = datetime.fromisoformat(str(body.get("expires_at")))
                if not label:
                    raise ValueError("no name")
                self.expiries.watch(f"{strategy.id}:{label}", label, expires_at)
            except ValueError as exc:
                raise EventError(
                    "expiry needs `name` and an ISO `expires_at` with a time zone"
                ) from exc
        else:
            raise EventError(f"unknown event type {kind!r}")

    def _status(self, strategy: Strategy, data: dict[str, Any]) -> None:
        strategy.status_text = _text(data.get("text"))
        paused = data.get("paused")
        strategy.paused = paused if isinstance(paused, bool) else None
        strategy.status_at = self.clock()

    # ------------------------------------------------------- upkeep

    def sweep(self) -> None:
        """Run every few seconds: offline alerts, stale commands, expiry reminders."""
        now = self.clock()
        for strategy in self.strategies.values():
            if strategy.was_online and not self.online(strategy):
                strategy.was_online = False
                self.notify(
                    strategy.name,
                    f"🔴 离线：{int(self.offline_after)} 秒没有来取命令",
                    "alert",
                    None,
                )
            for command in list(strategy.pending.values()):
                if command.delivered_at is None and now - command.created >= self.undelivered_ttl:
                    message = "命令 2 分钟内没有被策略取走，已作废。"
                elif command.delivered_at is not None and now - command.created >= self.result_ttl:
                    message = "命令已发出，但一直没有回报结果。请到券商端核对。"
                else:
                    continue
                strategy.pending.pop(command.id, None)
                if not command.future.done():
                    command.future.set_result(Result(False, message))
        for key, message in self.expiries.due():
            strategy = self.strategies.get(key.split(":", 1)[0])
            if strategy is not None:
                self.notify(strategy.name, message, "alert", None)
