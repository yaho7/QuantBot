"""The web page: the strategies, their buttons, recent notices and the audit log.

It shares QuantBot's port. `quantbot setup` asks whether it listens on this machine
only (open it through an SSH tunnel or Tailscale) or on every address. You sign in
with the admin username and password set in `quantbot setup` (or `quantbot password`).
Five wrong tries lock the form for 15 minutes. As a fallback, `/web` in Telegram or
`quantbot web` on the server gives a one-time login link that is valid for 5 minutes.
Either way you get a session cookie for 12 hours.

Every action goes through the same Core.call as Telegram, so a strategy sees the
same commands, and each change is written to the audit log with `user: "web"`.
POSTs must carry the X-QuantBot header, which other sites cannot add, on top of the
SameSite=Strict cookie.

Links and cookies are signed with `web_secret` from quantbot.json, so the CLI can
make a link the running bot accepts. Changing the password makes a new `web_secret`,
which signs everyone out; so does removing it.
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import hmac
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any

from aiohttp import web

from quantbot.config import (
    BOT_TOKEN,
    ConfigError,
    Store,
    check_strategy_id,
    check_timezone,
    check_url,
)
from quantbot.core import LABELS, NAME, SYMBOL, Core, check_type
from quantbot.hub import Hub, Result
from quantbot.service import Service, ServiceError
from quantbot.updates import Updater

LINK_TTL = 5 * 60
SESSION_TTL = 12 * 3600
COOKIE = "quantbot_session"
FEED_SIZE = 300
AUDIT_LIMIT = 500
USERNAME = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
MIN_PASSWORD = 8
LOGIN_TRIES = 5
LOGIN_LOCK = 15 * 60
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, digest = stored.split("$")
        if kind != "scrypt":
            return False
        expected = bytes.fromhex(digest)
        got = hashlib.scrypt(
            password.encode(),
            salt=bytes.fromhex(salt),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, expected)


def static_dir() -> Path:
    return Path(str(resources.files("quantbot") / "web"))


@dataclass
class Feed:
    """The last notices QuantBot sent, newest last, for the page."""

    items: collections.deque[dict[str, Any]] = field(
        default_factory=lambda: collections.deque(maxlen=FEED_SIZE)
    )

    def add(self, strategy: str, text: str, kind: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.items.append({"time": now, "strategy": strategy, "text": text, "kind": kind})


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()[:32]


class WebAuth:
    def __init__(self, secret: str, clock: Callable[[], float] = time.time) -> None:
        self.secret = secret
        self.clock = clock
        self._used: dict[str, float] = {}  # login nonce -> expiry
        self._fails: dict[str, list[float]] = {}  # client -> times of wrong passwords

    def session(self) -> str:
        """A fresh session cookie value."""
        expires = int(self.clock()) + SESSION_TTL
        return f"{expires}.{_sign(self.secret, f'session.{expires}')}"

    def locked(self, who: str) -> int:
        """Seconds until `who` may try a password again; 0 if they may now."""
        now = self.clock()
        fails = [t for t in self._fails.get(who, []) if t > now - LOGIN_LOCK]
        self._fails[who] = fails
        return 0 if len(fails) < LOGIN_TRIES else int(fails[0] + LOGIN_LOCK - now) + 1

    def failed(self, who: str) -> None:
        self._fails.setdefault(who, []).append(self.clock())

    def succeeded(self, who: str) -> None:
        self._fails.pop(who, None)

    def link_token(self) -> str:
        expires = int(self.clock()) + LINK_TTL
        nonce = secrets.token_urlsafe(12)
        message = f"login.{expires}.{nonce}"
        return f"{expires}.{nonce}.{_sign(self.secret, message)}"

    def redeem(self, token: str) -> str | None:
        """A login link's token -> a session cookie value, once, before it expires."""
        try:
            expires_text, nonce, sig = token.split(".")
            expires = int(expires_text)
        except ValueError:
            return None
        now = self.clock()
        self._used = {k: v for k, v in self._used.items() if v > now}
        good = hmac.compare_digest(sig, _sign(self.secret, f"login.{expires}.{nonce}"))
        if not good or expires <= now or nonce in self._used:
            return None
        self._used[nonce] = expires
        return self.session()

    def valid(self, cookie: str | None) -> bool:
        if not cookie:
            return False
        try:
            expires_text, sig = cookie.split(".")
            expires = int(expires_text)
        except ValueError:
            return False
        good = hmac.compare_digest(sig, _sign(self.secret, f"session.{expires}"))
        return good and expires > self.clock()


def login_url(listen: str, token: str) -> str:
    host, _, port = listen.rpartition(":")
    host = "127.0.0.1" if host in {"0.0.0.0", "::", ""} else host  # noqa: S104
    return f"http://{host}:{port}/ui/login?t={token}"


# ---------------------------------------------------------------- handlers

AUTH_KEY = web.AppKey("web_auth", WebAuth)
FEED_KEY = web.AppKey("web_feed", Feed)
AUDIT_KEY = web.AppKey("web_audit", Path)
WEB_HUB_KEY = web.AppKey("web_hub", Hub)


CORE_KEY = web.AppKey("web_core", Core)
CSRF_HEADER = "X-QuantBot"
WEB_USER = "web"
CHANGES = {"pause", "resume", "cancel", "flatten", "set_param", "manual_order", "stop"}
READS = {"status", "positions", "orders", "params", "chart"}


@dataclass
class UpdateActions:
    updater: Updater
    restart: Callable[[], None] | None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_check: float = 0
    updated: bool = False


UPDATE_KEY = web.AppKey("web_update", UpdateActions)


def _need_login(request: web.Request) -> web.Response | None:
    if not request.app[AUTH_KEY].valid(request.cookies.get(COOKIE)):
        return web.json_response({"ok": False, "error": "login required"}, status=401)
    if request.method == "POST" and request.headers.get(CSRF_HEADER) != "1":
        return web.json_response({"ok": False, "error": "missing X-QuantBot header"}, status=403)
    return None


def _answer(ok: bool, message: str, data: Any = None) -> web.Response:
    return web.json_response({"ok": ok, "message": message, "data": data})


async def _args(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _check_args(name: str, args: dict[str, Any], params: dict[str, Any] | None) -> dict[str, Any]:
    """The arguments a command may carry, validated like the Telegram commands."""
    if name == "cancel":
        order_id = str(args.get("order_id") or "")
        if not order_id:
            raise ValueError("缺少挂单 id")
        return {"order_id": order_id}
    if name == "set_param":
        key = str(args.get("name") or "")
        if not NAME.match(key) or "value" not in args:
            raise ValueError("要给出参数名和值")
        value = args["value"]
        if params is not None:
            if key not in params:
                raise ValueError(f"没有参数 {key}")
            ok, value = check_type(params[key], value)
            if not ok:
                raise ValueError(f"{key} 现在是 {type(params[key]).__name__}，不能改成 {value!r}")
        return {"name": key, "value": value}
    if name == "manual_order":
        side, symbol, qty = args.get("side"), str(args.get("symbol") or ""), args.get("qty")
        if side not in {"buy", "sell"} or not SYMBOL.match(symbol):
            raise ValueError("要给出方向（买或卖）和代码")
        if isinstance(qty, bool) or not isinstance(qty, int | float) or not qty > 0:
            raise ValueError("数量要是大于 0 的数")
        return {"side": side, "symbol": symbol.upper(), "qty": qty}
    return {}


async def command(request: web.Request) -> web.Response:
    """POST /ui/api/strategies/{sid}/{command} with the command's arguments as JSON."""
    if (denied := _need_login(request)) is not None:
        return denied
    core = request.app[CORE_KEY]
    s = core.hub.strategies.get(request.match_info["sid"])
    name = request.match_info["command"]
    if s is None:
        return web.json_response({"ok": False, "error": "unknown strategy"}, status=404)
    if name not in CHANGES | READS:
        return web.json_response({"ok": False, "error": "unknown command"}, status=404)
    params = None
    if name == "set_param" and s.supports("params"):
        ok, outcome = await core.call(s, "params")
        if not isinstance(outcome, Result):
            return _answer(False, str(outcome))
        params = outcome.data if isinstance(outcome.data, dict) else {}
    try:
        args = _check_args(name, await _args(request), params)
    except ValueError as exc:
        return _answer(False, str(exc))
    ok, outcome = await core.call(s, name, args)
    message = outcome.message if isinstance(outcome, Result) else str(outcome)
    data = outcome.data if isinstance(outcome, Result) else None
    if ok and name in {"pause", "resume"}:
        s.paused = name == "pause"
    if name in CHANGES:
        old = (params or {}).get(args.get("name", "")) if name == "set_param" else None
        if ok and name == "set_param" and not message:
            message = f"{args['name']}：{old!r} → {args['value']!r}"
        core.audit.write(
            name,
            strategy=s.id,
            user=WEB_USER,
            args=args,
            ok=ok,
            result=f"{s.name} {LABELS[name]}：{message or '完成'}",
        )
    return _answer(ok, message or ("完成" if ok else "失败"), data)


# ------------------------------------------------------------- settings

STORE_KEY = web.AppKey("web_store", Store)
TELEGRAM_KEY = web.AppKey("web_telegram", object)  # cli.telegram, replaced in tests


def _telegram(request: web.Request) -> Any:
    return request.app[TELEGRAM_KEY]


async def _bot_call(request: web.Request, token: str, method: str, **params: Any) -> Any:
    call = _telegram(request)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: call(token, method, **params))


def _service_installed() -> bool:
    try:
        return Service.detect().installed()
    except ServiceError:
        return False


async def update_get(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    updater = actions.updater
    return web.json_response(
        {
            "version": updater.current().label,
            "result": updater.cached(),
            "uv": updater.uv() is not None,
            "service": _service_installed(),
            "updated": actions.updated,
        }
    )


async def update_check(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    if actions.updated or actions.lock.locked():
        return _answer(False, "更新正在进行，或正在等待重启。")
    now = time.monotonic()
    if now < actions.next_check:
        return _answer(False, "每分钟可以检查一次，请稍后再试。")
    actions.next_check = now + 60
    async with actions.lock:
        result = await asyncio.to_thread(actions.updater.check)
    return _answer(not result["error"], result["error"] or "已检查更新。", result)


async def update_post(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    if actions.updated or actions.lock.locked():
        return _answer(False, "更新正在进行，或正在等待重启。")
    async with actions.lock:
        result = actions.updater.cached() or {}
        if not result.get("available"):
            return _answer(False, "没有可安装的更新，请先检查更新。")
        ok, output = await asyncio.to_thread(actions.updater.upgrade)
        actions.updated = ok
        request.app[CORE_KEY].audit.write(
            "update",
            user=WEB_USER,
            ok=ok,
            revision=result.get("latest"),
            result="已安装更新" if ok else "安装更新失败",
            output=output,
        )
        if not ok:
            return _answer(False, f"更新失败。{output}")
        restart = actions.restart if _service_installed() else None
        if restart is None:
            return _answer(True, "已更新。请在服务器上停止 QuantBot，再运行 quantbot run。")
        response = _answer(True, "已更新，后台服务即将重启。网页会自动重连。")
        try:
            await response.prepare(request)
            await response.write_eof()
        finally:
            restart()
        return response


async def settings_get(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    data = request.app[STORE_KEY].read()
    tg = data.get("telegram") or {}
    return web.json_response(
        {
            "bot_username": tg.get("bot_username") or "",
            "owner_id": tg.get("owner_id"),
            "owner_name": tg.get("owner_name") or "",
            "quiet_hours": data.get("quiet_hours") or "",
            "timezone": data.get("timezone") or "Asia/Shanghai",
            "heartbeat_url": data.get("heartbeat_url") or "",
            "listen": data.get("listen") or "",
            "telegram": bool(tg.get("token")),
        }
    )


async def settings_post(request: web.Request) -> web.Response:
    """Change the Telegram link and notice settings. Fields left out stay as they are."""
    from quantbot.cli import TelegramError
    from quantbot.notices import parse_quiet

    if (denied := _need_login(request)) is not None:
        return denied
    body = await _args(request)
    store = request.app[STORE_KEY]
    data = store.read()
    tg = dict(data.get("telegram") or {})
    old_key = (tg.get("token"), tg.get("owner_id"))
    if body.get("remove_telegram"):
        data.pop("telegram", None)
        store.write(data)
        request.app[CORE_KEY].audit.write(
            "settings", user=WEB_USER, ok=True, result="断开了 Telegram，只用网页"
        )
        return _answer(True, "已断开 Telegram。QuantBot 几秒后重启，之后只用网页。")
    try:
        token = str(body.get("token") or "").strip()
        if token:
            if not BOT_TOKEN.match(token):
                raise ValueError("这不像 bot token，应该像 123456789:AAH...")
            try:
                me = await _bot_call(request, token, "getMe")
            except TelegramError as exc:
                raise ValueError(f"Telegram 不认这个 token：{exc}") from exc
            tg.update(token=token, bot_username=me.get("username", ""))
        if "owner_id" in body:
            owner = str(body["owner_id"]).strip()
            if not owner.lstrip("-").isdigit():
                raise ValueError("主人 id 是一串数字")
            if int(owner) != tg.get("owner_id"):
                tg.update(owner_id=int(owner), owner_name="")
        if "quiet_hours" in body:
            quiet = str(body["quiet_hours"] or "").strip()
            parse_quiet(quiet)
            data["quiet_hours"] = quiet or None
        if "timezone" in body:
            data["timezone"] = check_timezone(str(body["timezone"] or "Asia/Shanghai").strip())
        if "heartbeat_url" in body:
            data["heartbeat_url"] = check_url(str(body["heartbeat_url"] or "").strip())
    except (ValueError, ConfigError) as exc:
        return _answer(False, str(exc))
    if bool(tg.get("token")) != isinstance(tg.get("owner_id"), int):
        return _answer(False, "接 Telegram 要同时填 bot token 和主人 id")
    restart = (tg.get("token"), tg.get("owner_id")) != old_key
    note = ""
    if restart and tg.get("token"):
        try:
            await _bot_call(
                request,
                tg["token"],
                "sendMessage",
                chat_id=tg["owner_id"],
                text="✅ QuantBot 的 Telegram 设置在网页上改好了。",
            )
            note = "已用新设置发了一条测试消息。"
        except TelegramError as exc:
            return _answer(False, f"测试消息发不出去，没有保存：{exc}。先给 bot 发一条消息再试。")
    if tg.get("token"):
        data["telegram"] = tg
    store.write(data)
    request.app[CORE_KEY].audit.write(
        "settings",
        user=WEB_USER,
        ok=True,
        result="改了设置" + ("（Telegram 的 bot 或主人）" if restart else ""),
        fields=sorted(k for k in body if k != "token") + (["token"] if token else []),
    )
    note += " QuantBot 几秒后用新设置重启，网页会断开一下再连上。"
    return _answer(True, f"已保存。{note}".strip())


async def prompt(request: web.Request) -> web.Response:
    """GET /ui/api/prompt?id=momentum&name=动量 -> the "copy for AI" message."""
    from quantbot.prompt import ai_prompt

    if (denied := _need_login(request)) is not None:
        return denied
    sid = request.query.get("id", "")
    try:
        check_strategy_id(sid)
    except ConfigError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    known = request.app[CORE_KEY].hub.strategies.get(sid)
    name = request.query.get("name", "").strip()[:64] or (known.name if known else sid)
    return web.json_response({"text": ai_prompt(sid, name)})


async def pause_all(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    core = request.app[CORE_KEY]
    reply = await core.pause_all(WEB_USER)
    return _answer(True, reply.text)


async def login(request: web.Request) -> web.StreamResponse:
    cookie = request.app[AUTH_KEY].redeem(request.query.get("t", ""))
    if cookie is None:
        return web.Response(
            status=403,
            content_type="text/html",
            charset="utf-8",
            text=_message_page(
                "链接已失效",
                "登录链接只能用一次，5 分钟内有效。在 Telegram 里发 /web，"
                "或在服务器上运行 quantbot web，拿一个新的。",
            ),
        )
    redirect = web.HTTPFound("/ui/")
    _set_session(redirect, cookie)
    raise redirect


def _set_session(response: web.StreamResponse, cookie: str) -> None:
    response.set_cookie(
        COOKIE, cookie, max_age=SESSION_TTL, path="/ui", httponly=True, samesite="Strict"
    )


async def password_login(request: web.Request) -> web.Response:
    """POST /ui/api/login with {username, password}."""
    if request.headers.get(CSRF_HEADER) != "1":
        return web.json_response({"ok": False, "error": "missing X-QuantBot header"}, status=403)
    auth = request.app[AUTH_KEY]
    who = request.remote or "?"
    if wait := auth.locked(who):
        return _answer(False, f"密码错了太多次，{(wait + 59) // 60} 分钟后再试。")
    admin = request.app[STORE_KEY].read().get("web_admin") or {}
    if not admin.get("password"):
        return _answer(False, "还没设管理员账号。在服务器上运行 quantbot password。")
    body = await _args(request)
    username, password = str(body.get("username") or ""), str(body.get("password") or "")
    loop = asyncio.get_running_loop()
    good = await loop.run_in_executor(None, check_password, password, str(admin["password"]))
    good = hmac.compare_digest(username.encode(), str(admin.get("username")).encode()) and good
    request.app[CORE_KEY].audit.write("login", user=WEB_USER, ok=good, client=who)
    if not good:
        auth.failed(who)
        return _answer(False, "用户名或密码不对。")
    auth.succeeded(who)
    response = _answer(True, "已登录")
    _set_session(response, auth.session())
    return response


async def logout(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None and denied.status == 403:
        return denied
    response = web.json_response({"ok": True})
    response.del_cookie(COOKIE, path="/ui")
    return response


async def overview(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    hub = request.app[WEB_HUB_KEY]
    strategies = []
    for s in hub.strategies.values():
        seen = None if s.last_seen is None else round(hub.clock() - s.last_seen, 1)
        strategies.append(
            {
                "id": s.id,
                "name": s.name,
                "online": hub.online(s),
                "connected": s.said_hello,
                "paused": s.paused,
                "status": s.status_text,
                "status_age": None if (age := hub.age(s)) is None else round(age, 1),
                "last_seen": seen,
                "commands": list(s.commands),
                "pending": len(s.pending),
            }
        )
    feed = list(request.app[FEED_KEY].items)[::-1]
    return web.json_response({"strategies": strategies, "feed": feed})


def read_audit(path: Path, limit: int) -> list[dict[str, Any]]:
    """The newest `limit` audit records, newest first."""
    try:
        lines = path.read_text("utf-8").splitlines()[-limit:]
    except FileNotFoundError:
        return []
    records = []
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


async def audit(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    try:
        limit = max(1, min(int(request.query.get("limit", "200")), AUDIT_LIMIT))
    except ValueError:
        limit = 200
    return web.json_response({"records": read_audit(request.app[AUDIT_KEY], limit)})


def _message_page(title: str, text: str) -> str:
    return (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" '
        'content="width=device-width,initial-scale=1"><title>QuantBot</title>'
        '<body style="font-family:system-ui,sans-serif;background:#fffcf0;color:#100f0f;'
        'max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">'
        f'<h1 style="font-family:Georgia,serif;font-weight:500">{title}</h1><p>{text}</p>'
    )


async def page(request: web.Request) -> web.StreamResponse:
    root = static_dir()
    name = request.match_info.get("path", "") or "index.html"
    target = (root / name).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        target = root / "index.html"  # client-side routes
    if not target.is_file():
        return web.Response(
            status=503,
            content_type="text/html",
            charset="utf-8",
            text=_message_page("网页还没构建", "这个安装里没有网页文件。请运行 quantbot update。"),
        )
    response = web.FileResponse(target)
    if target.name == "index.html":
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


async def redirect_root(request: web.Request) -> web.StreamResponse:
    raise web.HTTPFound("/ui/")


def add_routes(
    app: web.Application,
    core: Core,
    auth: WebAuth,
    feed: Feed,
    audit_path: Path,
    store: Store,
    telegram: Callable[..., Any] | None = None,
    *,
    restart: Callable[[], None] | None = None,
    updater: Updater | None = None,
) -> None:
    if telegram is None:
        from quantbot.cli import telegram as telegram_api

        telegram = telegram_api
    app[STORE_KEY] = store
    app[TELEGRAM_KEY] = telegram
    hub = core.hub
    app[CORE_KEY] = core
    app[WEB_HUB_KEY] = hub
    app[AUTH_KEY] = auth
    app[FEED_KEY] = feed
    app[AUDIT_KEY] = audit_path
    app[UPDATE_KEY] = UpdateActions(updater or Updater(store.dir), restart)
    app.add_routes(
        [
            web.get("/", redirect_root),
            web.get("/ui", redirect_root),
            web.get("/ui/login", login),
            web.post("/ui/api/login", password_login),
            web.post("/ui/api/logout", logout),
            web.get("/ui/api/overview", overview),
            web.get("/ui/api/audit", audit),
            web.post("/ui/api/pause-all", pause_all),
            web.get("/ui/api/prompt", prompt),
            web.get("/ui/api/settings", settings_get),
            web.post("/ui/api/settings", settings_post),
            web.get("/ui/api/update", update_get),
            web.post("/ui/api/update/check", update_check),
            web.post("/ui/api/update", update_post),
            web.post("/ui/api/strategies/{sid}/{command}", command),
            web.get("/ui/", page),
            web.get("/ui/{path:.+}", page),
        ]
    )
