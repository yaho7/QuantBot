"""Everything QuantBot knows about each strategy, and the commands waiting for it.

All of this lives on the bot's asyncio loop: the HTTP server and the Telegram
handlers run there. Execution grants and pause intents survive restarts.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from quantbot.config import MAX_ORDER_QTY, StrategyConfig, valid_order_qty
from quantbot.i18n import tr
from quantbot.notices import Connections, Expiries
from quantbot.operations import Operations, protected
from quantbot.strategy_features import ActionSpec, Metric, parse_actions, record_metric
from quantbot.workspace_credentials import fingerprint

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
    state: str | None = None
    operation_id: str | None = None


@dataclass
class Command:
    id: str
    name: str
    args: dict[str, Any]
    created: float
    future: asyncio.Future[Result]
    delivered_at: float | None = None
    expires_at: float | None = None


@dataclass
class Strategy:
    id: str
    name: str
    token: str = field(repr=False)
    max_order_qty: float = MAX_ORDER_QTY
    commands: tuple[str, ...] = ()
    actions: dict[str, ActionSpec] = field(default_factory=dict)
    metrics: dict[str, Metric] = field(default_factory=dict)
    said_hello: bool = False
    status_text: str | None = None
    paused: bool | None = None
    status_at: float | None = None
    last_seen: float | None = None
    polling: int = 0
    claim_poll_at: float | None = None
    pause_retry_at: float = 0
    was_online: bool = False
    pending: dict[str, Command] = field(default_factory=dict)
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    def supports(self, name: str) -> bool:
        if name.startswith("action:"):
            return name.removeprefix("action:") in self.actions
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
        wall_clock: Callable[[], float] = time.time,
        operation_path: Path | None = None,
        operation_ttl: float = 15.0,
    ) -> None:
        self.strategies = {
            s.id: Strategy(s.id, s.name, s.token, s.max_order_qty) for s in strategies
        }
        self.notify = notify
        self.offline_after = offline_after
        self.redeliver_after = redeliver_after
        self.undelivered_ttl = undelivered_ttl
        self.result_ttl = result_ttl
        self.clock = clock
        self.wall_clock = wall_clock
        self.operation_ttl = operation_ttl
        self.operations = Operations(operation_path)
        self._workspace_tokens: dict[str, tuple[str, str]] = {}
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
                        command.future.set_result(Result(False, tr("这个策略已经被删除。")))
                old.wake.set()
                changes.append(tr("删除 {0}", sid))
        for sid, config in wanted.items():
            current = self.strategies.get(sid)
            if current is None:
                self.strategies[sid] = Strategy(
                    sid, config.name, config.token, config.max_order_qty
                )
                changes.append(tr("添加 {0}", sid))
                continue
            if current.token != config.token:
                current.token = config.token
                current.claim_poll_at = None
                current.wake.set()
                changes.append(tr("换了 {0} 的 token", sid))
            if current.name != config.name:
                current.name = config.name
                changes.append(tr("{0} 改名为 {1}", sid, config.name))
            current.max_order_qty = config.max_order_qty
        order = list(wanted)
        self.strategies = dict(sorted(self.strategies.items(), key=lambda kv: order.index(kv[0])))
        return changes

    # ----------------------------------------------------------- lookups

    def by_token(self, token: str) -> Strategy | None:
        match = None
        for strategy in self.strategies.values():  # check them all: constant time per token
            if self.authorized(strategy, token):
                match = strategy
        return match

    def set_workspace_credentials(self, records: list[dict[str, Any]]) -> None:
        tokens = {
            item["QB_NAME"]: (item["QB_TOKEN"], item["primary"])
            for item in records
            if all(isinstance(item.get(key), str) for key in ("QB_NAME", "QB_TOKEN", "primary"))
            and (strategy := self.strategies.get(item["QB_NAME"])) is not None
            and item["primary"] == fingerprint(strategy.token)
        }
        for sid, strategy in self.strategies.items():
            if self._workspace_tokens.get(sid) != tokens.get(sid):
                strategy.claim_poll_at = None
                strategy.wake.set()
        self._workspace_tokens = tokens

    def online(self, strategy: Strategy) -> bool:
        if strategy.polling:
            return True
        seen = strategy.last_seen
        return seen is not None and self.clock() - seen < self.offline_after

    def age(self, strategy: Strategy) -> float | None:
        return None if strategy.status_at is None else self.clock() - strategy.status_at

    # ------------------------------------------------------- bot side

    def send(
        self,
        strategy: Strategy,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        operation_id: str | None = None,
    ) -> Command:
        if name not in COMMANDS and not (name.startswith("action:") and strategy.supports(name)):
            raise ValueError(f"unknown command {name}")
        command = Command(
            operation_id or uuid.uuid4().hex,
            name,
            dict(args or {}),
            self.clock(),
            asyncio.get_running_loop().create_future(),
        )
        if protected(name):
            now = self.wall_clock()
            if name == "manual_order" and not valid_order_qty(
                command.args.get("qty"), strategy.max_order_qty
            ):
                command.future.set_result(
                    Result(
                        False, tr("数量要是大于 0 且不超过 {0} 的有限数。", strategy.max_order_qty)
                    )
                )
                return command
            if not self.online(strategy):
                command.future.set_result(Result(False, tr("策略离线，操作未发送。")))
                return command
            if (
                strategy.claim_poll_at is None
                or self.clock() - strategy.claim_poll_at >= self.offline_after
            ):
                command.future.set_result(Result(False, tr("请先更新策略客户端的交易控制协议。")))
                return command
            if name == "resume" and self.operations.pause_intent(strategy.id):
                command.future.set_result(Result(False, tr("策略尚未确认暂停，暂时不能恢复开仓。")))
                return command
            self.operations.expire(now, self.result_ttl)
            command.expires_at = now + self.operation_ttl
            row, created = self.operations.create(
                strategy.id, command.id, name, command.args, now, command.expires_at
            )
            if not created:
                recorded = json.loads(row["result"]) if row["result"] is not None else {}
                message = tr("已有同类操作 {0}（{1}）。请查看该操作记录。", row["id"], row["state"])
                command.future.set_result(
                    Result(False, message, recorded.get("data"), row["state"], row["id"])
                )
                return command
        elif name == "pause":
            command.id = self.operations.save_pause(strategy.id, command.id)
            if command.id in strategy.pending:
                return strategy.pending[command.id]
        strategy.pending[command.id] = command
        strategy.wake.set()
        return command

    # -------------------------------------------------- strategy side

    def _seen(self, strategy: Strategy) -> None:
        strategy.last_seen = self.clock()
        if not strategy.was_online:
            if strategy.said_hello or strategy.status_at is not None:
                self.notify(strategy.name, tr("🟢 恢复在线"), "info", None)
            strategy.was_online = True

    def _deliverable(self, strategy: Strategy, claims: bool) -> list[Command]:
        now = self.clock()
        cid = self.operations.pause_intent(strategy.id)
        if cid and cid not in strategy.pending and now >= strategy.pause_retry_at:
            strategy.pending[cid] = Command(
                cid, "pause", {}, now, asyncio.get_running_loop().create_future()
            )
        ready = []
        for command in strategy.pending.values():
            if command.expires_at is not None:
                if (
                    not claims
                    or command.delivered_at is not None
                    or not self.operations.accept(strategy.id, command.id, self.wall_clock())
                ):
                    continue
            elif (
                command.delivered_at is not None
                and now - command.delivered_at < self.redeliver_after
            ):
                continue
            command.delivered_at = now
            ready.append(command)
        return ready

    def authorized(self, strategy: Strategy, token: str) -> bool:
        if self.strategies.get(strategy.id) is not strategy:
            return False
        workspace, primary = self._workspace_tokens.get(strategy.id, ("", ""))
        workspace_match = hmac.compare_digest(workspace.encode(), token.encode())
        primary_match = hmac.compare_digest(strategy.token.encode(), token.encode())
        return primary_match or (workspace_match and primary == fingerprint(strategy.token))

    async def poll(
        self, strategy: Strategy, wait: float, *, claims: bool = False, token: str | None = None
    ) -> dict[str, Any] | None:
        self._seen(strategy)
        if claims:
            strategy.claim_poll_at = self.clock()
        strategy.polling += 1
        token = strategy.token if token is None else token
        try:
            deadline = self.clock() + wait
            while self.authorized(strategy, token):
                ready = self._deliverable(strategy, claims)
                left = deadline - self.clock()
                if ready or left <= 0:
                    return {
                        "commands": [
                            {
                                "id": c.id,
                                "name": c.name,
                                "args": c.args,
                                **(
                                    {"expires_at": c.expires_at} if c.expires_at is not None else {}
                                ),
                            }
                            for c in ready
                        ],
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

    def claim(self, strategy: Strategy, cid: str, grant: str) -> bool:
        return self.operations.claim(strategy.id, cid, grant, self.wall_clock())

    def result(self, strategy: Strategy, command_id: str, body: dict[str, Any]) -> bool:
        self._seen(strategy)
        operation = self.operations.get(strategy.id, command_id)
        if operation is not None:
            if not self.operations.finish(strategy.id, command_id, body, self.wall_clock()):
                return False
            operation = self.operations.get(strategy.id, command_id)
            body = json.loads(operation["result"])
        command = strategy.pending.pop(command_id, None)
        if command is None:
            if body.get("ok") and self.operations.pause_intent(strategy.id) == command_id:
                self.operations.clear_pause(strategy.id, command_id)
                return True
            return operation is not None
        if command.name == "pause":
            if body.get("ok"):
                self.operations.clear_pause(strategy.id, command_id)
                strategy.paused = True
            else:
                # The intent is still pending. Retry with a fresh ID so a failed cached
                # result cannot prevent a pause after storage or connectivity recovers.
                self.operations.retry_pause(strategy.id, command_id, uuid.uuid4().hex)
                strategy.pause_retry_at = self.clock() + self.redeliver_after
        if command.name == "resume" and body.get("ok"):
            strategy.paused = False
        result = Result(
            bool(body.get("ok")),
            _text(body.get("message")),
            body.get("data"),
            operation["state"] if operation is not None else None,
            command_id if operation is not None else None,
        )
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
            try:
                actions = parse_actions(body.get("actions", []))
            except ValueError as exc:
                raise EventError(str(exc)) from exc
            strategy.actions = actions
            strategy.commands = tuple(n for n in COMMANDS if n in names)
            strategy.said_hello = True
        elif kind == "status":
            self._status(strategy, body)
        elif kind == "metric":
            try:
                record_metric(strategy.metrics, body, int(time.time()))
            except ValueError as exc:
                raise EventError(str(exc)) from exc
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
                    self.notify(strategy.name, tr("✅ {0} 已恢复连接", name), "info", None)
                else:
                    text = tr("🔌 {0} 断开", name) + (f"：{detail}" if detail else "")
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
        self.operations.expire(self.wall_clock(), self.result_ttl)
        for strategy in self.strategies.values():
            if strategy.was_online and not self.online(strategy):
                strategy.was_online = False
                self.notify(
                    strategy.name,
                    tr("🔴 离线：{0} 秒没有来取命令", int(self.offline_after)),
                    "alert",
                    None,
                )
            for command in list(strategy.pending.values()):
                state = None
                if command.expires_at is not None:
                    row = self.operations.get(strategy.id, command.id)
                    state = row["state"] if row is not None else "UNKNOWN"
                    if state == "FAILED":
                        message = tr("执行许可已过期，操作未执行。")
                    elif state == "UNKNOWN":
                        message = tr("执行结果未知，请到券商端核对。")
                    else:
                        continue
                elif command.name == "pause":
                    continue
                elif command.delivered_at is None and now - command.created >= self.undelivered_ttl:
                    message = tr("命令 2 分钟内没有被策略取走，已作废。")
                elif command.delivered_at is not None and now - command.created >= self.result_ttl:
                    message = tr("命令已发出，但一直没有回报结果。请到券商端核对。")
                else:
                    continue
                strategy.pending.pop(command.id, None)
                if not command.future.done():
                    command.future.set_result(
                        Result(
                            False, message, state=state, operation_id=command.id if state else None
                        )
                    )
        for key, message in self.expiries.due():
            strategy = self.strategies.get(key.split(":", 1)[0])
            if strategy is not None:
                self.notify(strategy.name, message, "alert", None)
