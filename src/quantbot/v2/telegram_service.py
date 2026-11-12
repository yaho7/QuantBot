"""Telegram's user interface for the same queries and commands used by the Web API."""

import asyncio
import logging
import shlex
from collections import defaultdict
from contextlib import suppress
from decimal import Decimal
from io import BytesIO
from urllib.parse import urlencode
from uuid import UUID

from PIL import Image, ImageDraw
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import BadRequest, TelegramError
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, MessageHandler, filters

from .commands import Commands
from .errors import Problem
from .models import SHADOW_ACTIONS, Capability, CommandRequest
from .telegram_controls import TelegramControls
from .telegram_settings import TelegramUpdate

log = logging.getLogger(__name__)
PAGE_SIZE = 7
STATUS = {"online": "在线", "offline": "离线", "abnormal": "异常"}
STATES = {
    "confirmation_required": "等待确认",
    "pending": "待执行或等待状态同步",
    "accepted": "已投递",
    "executing": "执行中",
    "succeeded": "策略已确认成功",
    "failed": "执行失败",
    "unknown": "结果未知，需核对",
    "expired": "已过期",
    "cancelled": "已取消",
    "superseded": "已被新操作替代",
}
SHORTCUTS = {
    "pause": "pause_entry",
    "resume": "resume_entry",
    "refresh": "refresh",
    "flatten": "flatten",
    "set": "set_parameters",
    "buy": "buy",
    "sell": "sell",
    "cancel": "cancel_order",
    "close": "close_position",
}
MENU = {
    "menu": "策略列表",
    "use": "按 ID 选择策略",
    "status": "当前策略状态",
    "positions": "持仓",
    "orders": "订单",
    "chart": "账户净值图",
    "alerts": "告警列表",
    "events": "策略事件",
    "operations": "命令和执行结果",
    "pause": "暂停新开仓",
    "resume": "恢复新开仓",
    "refresh": "请求刷新数据",
    "action": "执行已声明的自定义操作",
    "controls": "已注册的控制组件",
    "notifications": "通知状态或开关",
    "web": "一次性网页登录",
    "quickstart": "HTTP 接入说明",
    "help": "命令说明",
}


def button(text, data):
    return InlineKeyboardButton(text[:70], callback_data=data)


def chart_photo(rows):
    points = [Decimal(row["value"]) for row in rows]
    if len(points) < 2:
        return None
    image = Image.new("RGB", (680, 330), "#10202b")
    draw = ImageDraw.Draw(image)
    lo, hi = min(points), max(points)
    scale = hi - lo
    coordinates = [
        (
            22 + round(i * 636 / (len(points) - 1)),
            270 - int((p - lo) / scale * 224) if scale else 156,
        )
        for i, p in enumerate(points)
    ]
    draw.line((22, 286, 658, 286), fill="#425864", width=1)
    draw.line(coordinates, fill="#55dcc9", width=3)
    draw.text((22, 15), f"{rows[0]['account_id']} / {rows[0]['unit']}"[:85], fill="#f1f7fa")
    draw.text((22, 300), f"Last {points[-1]}   Min {lo}   Max {hi}"[:90], fill="#f1f7fa")
    output = BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


class TelegramInterface:
    def __init__(self, service, config, public_url):
        self.service = service
        self.config = config
        self.public_url = public_url
        self.components = TelegramControls(service, button, self.operation)

    async def handle(self, update, context):
        query = update.callback_query
        user = update.effective_user
        chat = update.effective_chat
        allowed = bool(
            self.config.get().enabled
            and user
            and chat
            and chat.type == "private"
            and user.id in self.config.get().admins
        )
        if query:
            await query.answer(text=None if allowed else "没有操作权限")
        if not allowed:
            return
        uid = user.id
        actor = f"telegram:{uid}"
        photo = None
        try:
            if query and (query.data or "").startswith("tc:"):
                response = self.components.route(query.data[3:], actor, uid, update.update_id)
            elif not query and not update.effective_message.text.startswith("/"):
                response = self.components.text(
                    uid,
                    actor,
                    update.update_id,
                    update.effective_message.text,
                )
                if response is None:
                    return
            else:
                self.components.dismiss(uid)
                data = (
                    query.data
                    if query
                    else update.effective_message.text.split()[0].split("@")[0][1:]
                )
                args = [] if query else context.args
                response = self.dispatch(data or "", args, actor, uid, update.update_id)
            text, keyboard, photo = response
        except (Problem, ValueError, IndexError) as exc:
            text = str(exc) if isinstance(exc, Problem) else "参数格式无效，请检查命令说明。"
            keyboard = [[button("策略列表", "p:0")]]
        markup = InlineKeyboardMarkup(keyboard) if keyboard else None
        if photo:
            await update.effective_message.reply_photo(
                photo,
                caption=text[:1000],
                reply_markup=markup,
            )
        elif query:
            try:
                await query.edit_message_text(text[:4000], reply_markup=markup)
            except BadRequest as exc:
                if "not modified" not in str(exc).lower():
                    await update.effective_message.reply_text(text[:4000], reply_markup=markup)
        else:
            await update.effective_message.reply_text(text[:4000], reply_markup=markup)

    def target(self, uid, explicit=None):
        if explicit:
            detail = self.service.strategies.detail(explicit)
            self.config.selection(uid, explicit)
            return detail
        selected = self.config.selection(uid)
        if selected:
            try:
                return self.service.strategies.detail(selected)
            except Problem as exc:
                if exc.status != 404:
                    raise
        items = self.service.strategies.list()
        if len(items) == 1:
            return self.service.strategies.detail(items[0]["id"])
        raise Problem(409, "请先在 /menu 选择策略")

    def dispatch(self, data, args, actor, uid, update_id):
        parts = data.split(":")
        route = parts[0]
        if route in {"start", "menu", "p"} or (route == "use" and not args):
            text, rows = self.menu(int(parts[1]) if route == "p" else 0)
            return text, rows, None
        if route == "help":
            return "\n".join(f"/{key} · {label}" for key, label in MENU.items()), [], None
        if route in {"web", "quickstart"}:
            if not self.public_url:
                return "请先为 QuantBot 配置 HTTPS 访问地址。", [], None
            if route == "quickstart":
                return f"HTTP 接入说明\n{self.public_url}/ui/#api\n{self.public_url}/docs", [], None
            link = self.service.auth.login_link(actor)
            self.service.strategies.audit(actor, "admin.login_link")
            suffix = (
                "\n本机地址可通过 SSH 端口转发访问。" if self.public_url.startswith("http:") else ""
            )
            target = f"{self.public_url}/ui/#login?{urlencode({'ticket': link})}"
            return f"5 分钟内可用一次\n{target}{suffix}", [], None
        if route in {"alerts", "notifications"}:
            return self.notifications(route, args, actor)
        if route in {"confirm", "cancelop", "op"}:
            cid = str(UUID(parts[1]))
            row = self.service.commands.row(cid)
            if route != "op" and row["control_id"]:
                raise Problem(409, "请使用控制面板生成的确认或取消按钮")
            if route == "confirm":
                command = self.service.commands.confirm(cid, actor)
            elif route == "cancelop":
                command = self.service.commands.cancel(cid, actor)
            else:
                command = self.service.commands.public(row)
            return self.operation(command, uid)
        if route == "pauseall":
            return self.pause_all(actor, update_id)
        explicit = args[0] if route == "use" else parts[1] if len(parts) > 1 else None
        strategy = self.target(uid, explicit)
        sid = strategy["id"]
        back = [[button("返回策略", f"s:{sid}"), button("所有策略", "p:0")]]
        if route in {"controls", "controlpanel"}:
            return self.components.open(sid, uid)
        if route in {"s", "status", "use"}:
            text, rows = self.strategy(strategy)
            return text, rows, None
        if route in {
            "positions",
            "pos",
            "orders",
            "ord",
            "chart",
            "equ",
            "events",
            "evt",
            "operations",
            "ops",
        }:
            return self.read_strategy(route, strategy, back)
        if route in SHORTCUTS or route in {"a", "action"}:
            if route == "a":
                action = parts[2]
            elif route == "action":
                if not args:
                    raise Problem(422, "用法 /action <指令 ID> 参数=值")
                action, *args = args
            else:
                action = SHORTCUTS[route]
            cap = next((item for item in strategy["capabilities"] if item["id"] == action), None)
            if cap is None:
                raise Problem(422, "该策略未声明此操作")
            if route == "a" and cap["parameters"]:
                fields = "\n".join(
                    f"{key} · {item['label']} ({item['type']})"
                    + (f" 可选值 {', '.join(item['choices'])}" if item["choices"] else "")
                    + (f" 默认 {item['default']}" if item["default"] is not None else "")
                    for key, item in cap["parameters"].items()
                )
                return f"{cap['label']}\n{fields}\n\n/action {action} 参数=值", back, None
            parsed = self.parse_parameters(action, cap["parameters"], args)
            self.service.limit("operations", actor, 30, 60)
            command = self.service.commands.create(
                sid,
                CommandRequest(action=action, arguments=parsed, request_id=f"tg:{update_id}"),
                actor,
            )
            return self.operation(command, uid)
        raise Problem(404, "请使用 /help 查看命令")

    def menu(self, page):
        items = self.service.strategies.list()
        end = max(0, (len(items) - 1) // PAGE_SIZE)
        page = min(max(0, page), end)
        rows = [
            [button(f"{STATUS[s['status']]} · {s['name']}", f"s:{s['id']}")]
            for s in items[page * PAGE_SIZE : (page + 1) * PAGE_SIZE]
        ]
        nav = []
        if page:
            nav.append(button("上一页", f"p:{page - 1}"))
        if page < end:
            nav.append(button("下一页", f"p:{page + 1}"))
        if nav:
            rows.append(nav)
        if items:
            rows.append([button("暂停全部策略新开仓", "pauseall")])
        return (
            f"策略列表 · {page + 1}/{end + 1}" if items else "尚无策略。请在 Web 创建策略。"
        ), rows

    def strategy(self, strategy):
        sid = strategy["id"]
        state = strategy["control"]
        reported = state["reported"] or {}
        actual = "未知"
        risk = "未知"
        if state["reported_current"]:
            actual = "允许" if reported["entry_enabled"] else "已暂停"
            risk = "已锁定" if reported.get("risk_locked") else "未锁定"
        desired = state["desired"].get("entry_enabled")
        requested = "由策略决定" if desired is None else "允许" if desired else "暂停"
        lines = [
            f"{strategy['name']} · {STATUS[strategy['status']]}",
            f"交易权限 {actual} · 期望 {requested} · 风控 {risk}",
            f"最近连接 {strategy['last_seen'] or '尚未接入'}",
        ]
        snapshot = strategy["snapshot"] or {}
        for account in snapshot.get("accounts", [])[:5]:
            lines.append(f"{account['account_id']} {account['currency']} 净值 {account['equity']}")
        for name, value in snapshot.get("performance", {}).items():
            if value is not None:
                lines.append(f"{name} {value}")
        for item in snapshot.get("metrics", [])[:10]:
            lines.append(f"{item['label'] or item['name']} {item['value']} {item['unit'] or ''}")
        rows = [
            [
                button("刷新页面", f"s:{sid}"),
                button("持仓", f"pos:{sid}"),
                button("订单", f"ord:{sid}"),
                button("净值", f"equ:{sid}"),
            ],
            [button("事件", f"evt:{sid}"), button("操作记录", f"ops:{sid}")],
        ]
        settings = self.service.strategies.settings(sid)
        for raw in strategy["capabilities"]:
            action = raw["id"]
            if self.service.controls.bound_action(sid, action) and action not in SHADOW_ACTIONS:
                continue
            if action not in SHADOW_ACTIONS and not strategy["executor_online"]:
                continue
            risky, _ = Commands.safety(Capability.model_validate(raw))
            if risky and settings["mode"] == "live" and not settings["live_trading_enabled"]:
                continue
            rows.append([button(raw["label"], f"a:{sid}:{action}")])
        if self.service.controls.public(sid)["controls"]:
            rows.insert(1, [button("控制面板", f"controlpanel:{sid}")])
        rows.append([button("所有策略", "p:0")])
        return "\n".join(lines), rows

    def read_strategy(self, route, strategy, back):
        sid = strategy["id"]
        snapshot = strategy["snapshot"] or {}
        if route in {"positions", "pos"}:
            lines = []
            for key, label in (
                ("strategy_positions", "策略归属持仓"),
                ("broker_positions", "券商账户持仓"),
            ):
                lines.append(label)
                lines.extend(
                    f"{p['symbol']} · {p['quantity']} · {p['account_id']}"
                    for p in snapshot.get(key, [])[:15]
                )
                if not snapshot.get(key):
                    lines.append("暂无上报")
        elif route in {"orders", "ord"}:
            lines = [
                f"{o['order_id']} · {o['symbol']} · {o['side']} {o['quantity']} · {o['status']}"
                for o in [*snapshot.get("open_orders", []), *snapshot.get("completed_orders", [])][
                    :18
                ]
            ]
            for cap in strategy["capabilities"]:
                if (
                    cap["id"] == "cancel_order"
                    and strategy["executor_online"]
                    and not self.service.controls.bound_action(sid, "cancel_order")
                ):
                    back.insert(0, [button("撤销订单", f"a:{sid}:cancel_order")])
        elif route in {"chart", "equ"}:
            samples = self.service.telemetry.history(sid, "account.equity", limit=500)
            series = defaultdict(list)
            for item in samples:
                series[(item["instance_id"], item["account_id"], item["unit"])].append(item)
            selected = max(
                series.values(), key=len, default=[]
            )  # preserve the account/currency basis
            return (
                ("账户净值历史" if len(selected) >= 2 else "净值历史至少需要两个点"),
                back,
                chart_photo(selected[-120:]),
            )
        elif route in {"events", "evt"}:
            lines = [
                f"{e['category']} · {e['message'][:150]}"
                for e in self.service.telemetry.event_rows(sid, limit=15)
            ]
        else:
            commands = self.service.commands.list(sid, 12)
            lines = [
                f"{item['action']} · {STATES.get(item['state'], item['state'])}"
                for item in commands
            ]
            back = [
                [button(line, f"op:{item['id']}")]
                for item, line in zip(commands, lines, strict=True)
            ] + back
        return "\n".join(lines) or "暂无上报数据", back, None

    def notifications(self, route, args, actor):
        settings = self.config.get()
        if route == "notifications":
            if args:
                if args[0] not in {"on", "off"}:
                    raise Problem(422, "用法 /notifications on 或 /notifications off")
                updated = settings.model_dump()
                updated["notify"] = args[0] == "on"
                self.config.update(TelegramUpdate.model_validate(updated), actor)
                settings = self.config.get()
            return (
                f"推送{'已开启' if settings.notify else '已关闭'} · 最低级别 {settings.minimum}\n"
                f"分类 {', '.join(settings.categories) or '全部'}\n"
                "/notifications on|off · /alerts [分类]",
                [],
                None,
            )
        rows = self.service.strategies.alert_rows(limit=100)
        if args:
            rows = [row for row in rows if row["category"] == args[0]]
        return (
            "\n".join(
                f"{row['category']} · {row['severity']} · {row['message'][:160]}"
                for row in rows[:18]
            )
            or "暂无告警",
            [],
            None,
        )

    @staticmethod
    def parse_parameters(action, schema, raw):
        if action in {"buy", "sell"} and len(raw) == 2 and "=" not in raw[0]:
            raw = [f"symbol={raw[0]}", f"quantity={raw[1]}"]
        elif action == "set_parameters" and len(raw) == 2 and "=" not in raw[0]:
            raw = [f"{raw[0]}={raw[1]}"]
        elif action in {"cancel_order", "close_position"} and len(raw) == 1 and "=" not in raw[0]:
            field = "order_id" if action == "cancel_order" else "position_id"
            raw = [f"{field}={raw[0]}"]
        args = {}
        for item in shlex.split(" ".join(raw)):
            name, sep, value = item.partition("=")
            if not sep or name not in schema or name in args:
                raise ValueError("Invalid argument")
            if schema[name]["type"] == "integer":
                value = int(value)
            elif schema[name]["type"] == "boolean":
                if value not in {"true", "false"}:
                    raise ValueError("Invalid boolean")
                value = value == "true"
            args[name] = value
        return args

    def operation(self, command, user=None):
        cid = command["id"]
        strategy = self.service.strategies.detail(command["strategy_id"])
        text = f"{strategy['name']} · {command['action']}\n{STATES[command['state']]}\n{cid}"
        if command["arguments"]:
            text += f"\n参数 {command['arguments']}"
        if command["error"]:
            text += f"\n{command['error']}"
        if command["result"] is not None:
            text += f"\n回执 {command['result']}"
        if command["action"] in SHADOW_ACTIONS and strategy["control"]["reported_current"]:
            report = strategy["control"]["reported"]
            text += f"\n本地风控{'已锁定' if report.get('risk_locked') else '未锁定'}"
        rows = [
            [button("刷新结果", f"op:{cid}"), button("返回策略", f"s:{command['strategy_id']}")]
        ]
        owner = user is not None and command["actor"] == f"telegram:{user}"
        if owner and command["state"] == "confirmation_required":
            confirm = (
                self.components.command_button("确认执行", user, command, "confirm")
                if command["control_id"]
                else button("确认执行", f"confirm:{cid}")
            )
            rows.insert(0, [confirm])
            text += f"\n确认截止 {command['expires_at']}"
        if (
            owner
            and command["state"] in {"confirmation_required", "pending", "accepted"}
            and command["revision"] is None
        ):
            cancel = (
                self.components.command_button("取消请求", user, command, "cancel_command")
                if command["control_id"]
                else button("取消请求", f"cancelop:{cid}")
            )
            rows.insert(1, [cancel])
        return text, rows, None

    def pause_all(self, actor, update_id):
        self.service.limit("operations", actor, 30, 60)
        lines = []
        rows = []
        for item in self.service.strategies.list():
            try:
                self.service.commands.capability(item["id"], "pause_entry", live=False)
            except Problem:
                continue
            request = f"tg:{update_id}:{item['id']}"
            command = self.service.commands.create(
                item["id"],
                CommandRequest(action="pause_entry", request_id=request),
                actor,
            )
            lines.append(f"{item['name']} · {STATES[command['state']]}")
            if command["state"] == "confirmation_required":
                rows.append([button(f"确认 {item['name']}", f"confirm:{command['id']}")])
        return "\n".join(lines) or "没有支持暂停新开仓的策略", rows, None


class Delivery:
    def __init__(self, service, config):
        self.service = service
        self.config = config

    async def send(self, bot):
        settings = self.config.get()
        db = self.service.db
        now = self.service.clock()
        for user_id in settings.admins:
            cursor = db.one("SELECT * FROM telegram_cursors WHERE user_id=?", (user_id,))
            if (
                not cursor
                or max(cursor["retry_at"], cursor["last_sent"] + settings.min_interval_seconds)
                > now
            ):
                continue
            rows = db.all(
                "SELECT * FROM alerts WHERE id>? ORDER BY id LIMIT 100", (cursor["alert_id"],)
            )
            for row in rows:
                if not self.config.notice_allowed(settings, row):
                    db.execute(
                        "UPDATE telegram_cursors SET alert_id=? WHERE user_id=?",
                        (row["id"], user_id),
                    )
                    continue
                strategy = (
                    self.service.strategies.settings(row["strategy_id"])["name"]
                    if (row["strategy_id"])
                    else "QuantBot"
                )
                try:
                    await bot.send_message(
                        user_id,
                        f"[{strategy}] {row['category']} · {row['message']}"[:4000],
                        disable_notification=self.config.silent(settings, row),
                    )
                except TelegramError as exc:
                    log.warning("Telegram notification delivery failed (%s)", type(exc).__name__)
                    failures = cursor["failures"] + 1
                    db.execute(
                        """UPDATE telegram_cursors SET failures=?, retry_at=? WHERE user_id=?""",
                        (failures, now + min(3600, 10 * 2 ** min(failures, 8)), user_id),
                    )
                else:
                    db.execute(
                        """UPDATE telegram_cursors SET alert_id=?, last_sent=?, failures=0,
                           retry_at=0 WHERE user_id=?""",
                        (row["id"], now, user_id),
                    )
                break


async def supervise(service, config, public_url):
    interface = TelegramInterface(service, config, public_url)
    delivery = Delivery(service, config)
    app = None
    active_token = None

    async def handle_error(update, context):
        log.warning("Telegram update failed (%s)", type(context.error).__name__)

    def polling_error(error):
        config.status = "error"
        log.warning("Telegram polling failed (%s)", type(error).__name__)

    async def stop():
        nonlocal app, active_token
        if app:
            if app.updater.running:
                await app.updater.stop()
            if app.running:
                await app.stop()
            await app.shutdown()
            app = None
            active_token = None

    try:
        while True:
            settings = config.get()
            desired = config.token() if settings.enabled and settings.admins else None
            if active_token != desired:
                await stop()
            if not desired:
                config.status = "disabled"
            elif not app:
                try:
                    app = Application.builder().token(desired).build()
                    app.add_handler(
                        CommandHandler(
                            list(dict.fromkeys([*MENU, *SHORTCUTS, "start"])), interface.handle
                        )
                    )
                    app.add_handler(CallbackQueryHandler(interface.handle))
                    app.add_handler(
                        MessageHandler(filters.TEXT & ~filters.COMMAND, interface.handle)
                    )
                    app.add_error_handler(handle_error)
                    await app.initialize()
                    await app.start()
                    await app.updater.start_polling(
                        allowed_updates=["message", "callback_query"],
                        drop_pending_updates=True,
                        bootstrap_retries=0,
                        error_callback=polling_error,
                    )
                    await app.bot.set_my_commands(
                        [BotCommand(name, desc) for name, desc in MENU.items()]
                    )
                    active_token = desired
                    config.status = "connected"
                except TelegramError as exc:
                    config.status = "error"
                    log.warning("Telegram startup failed (%s)", type(exc).__name__)
                    await stop()
            elif config.status == "error":
                try:
                    await app.bot.get_me()
                except TelegramError:
                    pass
                else:
                    config.status = "connected"
            if app and active_token:
                await delivery.send(app.bot)
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(config.connection_changed.wait(), 2 if app else 10)
            config.connection_changed.clear()
    finally:
        await stop()
