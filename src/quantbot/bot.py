"""Telegram on one side, the internal HTTP API on the other, one asyncio loop."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from zoneinfo import ZoneInfo

from aiohttp import web
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.error import BadRequest, TelegramError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    filters,
)

from quantbot.audit import Audit
from quantbot.config import Settings
from quantbot.core import Buttons, Core, Reply
from quantbot.heartbeat import Heartbeat
from quantbot.hub import Hub, Strategy
from quantbot.notices import LOUD, is_quiet
from quantbot.server import make_app

log = logging.getLogger("quantbot")

MAX_MESSAGE = 4000
MAX_CAPTION = 1000
SWEEP_EVERY = 5.0
HEARTBEAT_EVERY = 60.0

HELP = """/menu 所有策略
/use <id> 切换当前策略
/status 当前策略的状态
/pause /resume 暂停、恢复开仓
/positions /orders /chart 持仓、挂单、净值图
/flatten 平仓（要确认）
/stop 让策略停止（要确认）
/set <名字> <值> 改参数（要确认）
/buy /sell <代码> <数量> 手动下单（要确认）"""

COMMANDS = [
    ("menu", "所有策略"),
    ("status", "当前策略的状态"),
    ("use", "切换当前策略"),
    ("pause", "暂停开仓"),
    ("resume", "恢复开仓"),
    ("positions", "持仓"),
    ("orders", "挂单"),
    ("chart", "净值图"),
    ("flatten", "平仓"),
    ("stop", "让策略停止"),
    ("set", "改参数"),
    ("buy", "手动买入"),
    ("sell", "手动卖出"),
    ("help", "命令说明"),
]


def markup(buttons: Buttons) -> InlineKeyboardMarkup | None:
    if not buttons:
        return None
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(label, callback_data=data) for label, data in row]
            for row in buttons
        ]
    )


def silent(kind: str, quiet: tuple[int, int] | None, now: datetime) -> bool:
    """Quiet hours deliver everything, but only alerts and errors make a sound."""
    return kind not in LOUD and is_quiet(now.hour, quiet)


class QuantBot:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.tz = ZoneInfo(settings.timezone)
        self.hub = Hub(settings.strategies, self._hub_notice)
        self.core = Core(
            self.hub,
            Audit(settings.data_dir),
            owner_id=settings.owner_id,
            notify=lambda name, text, kind: self._hub_notice(name, text, kind, None),
        )
        self.heartbeat = Heartbeat(settings.heartbeat_url, min_interval=HEARTBEAT_EVERY - 5)
        self.app = (
            Application.builder()
            .token(settings.tg_token)
            .concurrent_updates(True)  # a slow strategy must not hold up the others
            .post_init(self._started)
            .post_shutdown(self._stopped)
            .build()
        )
        self._runner: web.AppRunner | None = None
        self._upkeep: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        owner = filters.User(user_id=settings.owner_id)
        handlers = {
            "start": self._menu,
            "menu": self._menu,
            "help": self._help,
            "status": self._status,
            "use": self._use,
            "pause": self._pause,
            "resume": self._resume,
            "positions": self._positions,
            "orders": self._orders,
            "chart": self._chart,
            "flatten": self._flatten,
            "stop": self._stop,
            "set": self._set,
            "buy": self._buy,
            "sell": self._sell,
        }
        for name, handler in handlers.items():
            self.app.add_handler(CommandHandler(name, handler, filters=owner))
        self.app.add_handler(CallbackQueryHandler(self._tap))
        self.app.add_error_handler(self._error)

    def run(self) -> None:
        # Taps sent while QuantBot was down are dropped instead of run late.
        self.app.run_polling(
            drop_pending_updates=True, allowed_updates=["message", "callback_query"]
        )

    # ------------------------------------------------------------ lifecycle

    async def _started(self, app: Application) -> None:
        server = make_app(self.hub)
        self._runner = web.AppRunner(server, access_log=None, shutdown_timeout=2)
        await self._runner.setup()
        await web.TCPSite(self._runner, self.settings.host, self.settings.port).start()
        log.info("Strategy API on %s:%s", self.settings.host, self.settings.port)
        await app.bot.set_my_commands([BotCommand(n, d) for n, d in COMMANDS])
        self._upkeep = asyncio.create_task(self._upkeep_loop())
        names = "、".join(s.name for s in self.hub.strategies.values())
        await self._send(f"🟢 QuantBot 已启动。策略：{names}", "info")

    async def _stopped(self, app: Application) -> None:
        if self._upkeep:
            self._upkeep.cancel()
        if self._runner:
            await self._runner.cleanup()

    async def _upkeep_loop(self) -> None:
        while True:
            try:
                self.hub.sweep()
                self.heartbeat.ping()
            except Exception:  # noqa: BLE001 - upkeep must keep going
                log.exception("Upkeep failed")
            await asyncio.sleep(SWEEP_EVERY)

    # ------------------------------------------------------------- sending

    def _hub_notice(self, name: str, text: str, kind: str, image: bytes | None) -> None:
        task = asyncio.get_running_loop().create_task(self._send(f"[{name}] {text}", kind, image))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, text: str, kind: str, image: bytes | None = None) -> None:
        quiet = silent(kind, self.settings.quiet_hours, datetime.now(self.tz))
        owner = self.settings.owner_id
        try:
            if image:
                await self.app.bot.send_photo(
                    owner, image, caption=text[:MAX_CAPTION], disable_notification=quiet
                )
            else:
                await self.app.bot.send_message(
                    owner, text[:MAX_MESSAGE], disable_notification=quiet
                )
        except TelegramError:
            log.exception("Could not send a Telegram message")

    async def _show(self, update: Update, reply: Reply, edit: bool = False) -> None:
        keyboard = markup(reply.buttons)
        text = reply.text[:MAX_MESSAGE] or "（空）"
        query = update.callback_query
        if reply.image:
            target = query.message if query else update.effective_message
            await target.reply_photo(reply.image, caption=text[:MAX_CAPTION], reply_markup=keyboard)
        elif edit and query:
            try:
                await query.edit_message_text(text, reply_markup=keyboard)
            except BadRequest as exc:
                if "not modified" not in str(exc).lower():
                    await query.message.reply_text(text, reply_markup=keyboard)
        else:
            await update.effective_message.reply_text(text, reply_markup=keyboard)

    # ------------------------------------------------------------ handlers

    async def _tap(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if query is None or not self.core.allowed(query.from_user.id):
            if query:
                await query.answer()
            return
        await query.answer()
        reply = await self.core.tap(query.data or "", query.from_user.id)
        await self._show(update, reply, edit=True)

    async def _menu(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._show(update, await self.core.home())

    async def _help(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._show(update, Reply(HELP))

    async def _with_target(
        self, update: Update, run: Callable[[Strategy], Awaitable[Reply]]
    ) -> None:
        target = self.core.target()
        if isinstance(target, Reply):
            await self._show(update, target)
            return
        await self._show(update, await run(target))

    async def _status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, lambda s: self.core.open(s.id))

    async def _use(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not context.args:
            await self._show(update, Reply("选一个策略：", self.core.picker()))
            return
        await self._show(update, await self.core.open(context.args[0].lower()))

    async def _pause(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        uid = update.effective_user.id
        await self._with_target(update, lambda s: self.core.switch(s, "pause", uid))

    async def _resume(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        uid = update.effective_user.id
        await self._with_target(update, lambda s: self.core.switch(s, "resume", uid))

    async def _positions(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, self.core.positions)

    async def _orders(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, self.core.orders)

    async def _chart(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, self.core.chart)

    async def _flatten(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, lambda s: _now(self.core.request("flatten", s)))

    async def _stop(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._with_target(update, lambda s: _now(self.core.request("stop", s)))

    async def _set(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        raw = " ".join(context.args or [])
        await self._with_target(update, lambda s: self.core.request_set(s, raw))

    async def _buy(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        raw = " ".join(context.args or [])
        await self._with_target(update, lambda s: _now(self.core.request_order(s, "buy", raw)))

    async def _sell(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        raw = " ".join(context.args or [])
        await self._with_target(update, lambda s: _now(self.core.request_order(s, "sell", raw)))

    async def _error(self, update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        log.error("Handler failed", exc_info=context.error)


async def _now(reply: Reply) -> Reply:
    return reply
