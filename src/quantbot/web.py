"""The web page: the strategies, their buttons, recent notices and the audit log.

It shares QuantBot's port. `quantbot setup` asks whether it listens on this machine
only (open it through an SSH tunnel or Tailscale) or on every address. You sign in
with the admin username and password set in `quantbot setup` (or `quantbot password`).
Five wrong tries lock the form for 15 minutes. As a fallback, `/web` in Telegram or
`quantbot web` on the server gives a one-time login link that is valid for 5 minutes.
Either way you get a revocable session cookie with a 12-hour lifetime and a
30-minute idle limit.

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
import logging
import os
import re
import secrets
import subprocess
import time
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from importlib import resources
from ipaddress import ip_address
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from quantbot.audit import read_audit
from quantbot.config import (
    BOT_TOKEN,
    ConfigError,
    Store,
    add_strategy,
    check_public_url,
    check_strategy_id,
    check_timezone,
    check_url,
    local_origin,
    new_token,
    require_strategy,
    set_web_admin,
    strategy_item,
    timezones,
    valid_order_qty,
)
from quantbot.core import LABELS, NAME, SYMBOL, Core, check_type
from quantbot.editor import EDITOR_FILE, Editor, editor_lock
from quantbot.github import DEVICE_URL, DeviceLogin, GitHubEditor
from quantbot.hub import Hub, Result, Strategy
from quantbot.i18n import LANGUAGES, language, language_tag, normalize_language, tr, use_language
from quantbot.operations import protected
from quantbot.service import Service, ServiceError
from quantbot.strategy_features import action_arguments
from quantbot.templates import (
    QUICKSTART_COMMAND,
    QUICKSTART_FILE,
    quickstart_source,
    refresh_workspace_sources,
    runtime_sdk,
)
from quantbot.updates import Updater
from quantbot.workspace import (
    WORKSPACE_FILE,
    registered_roots,
    unregister_workspace,
    web_create_directory,
    web_directories,
    web_initialize,
    workspace_id,
    workspace_projects,
)
from quantbot.workspace_credentials import WorkspaceCredentials
from quantbot.workspace_files import WorkspaceChanges, search
from quantbot.workspace_runtime import WorkspaceRuntime
from quantbot.workspace_terminal import TerminalProcess

LINK_TTL = 5 * 60
SESSION_TTL = 12 * 3600
SESSION_IDLE = 30 * 60
SESSIONS_FILE = "web-sessions.json"
COOKIE = "quantbot_session"
FEED_SIZE = 300
AUDIT_LIMIT = 500
USERNAME = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
MIN_PASSWORD = 8
LOGIN_TRIES = 5
LOGIN_LOCK = 15 * 60
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
log = logging.getLogger(__name__)
CONTENT_SECURITY = (
    "default-src 'self'; "
    "script-src 'self' 'sha256-zaV3cqbEF7/lEt8EvoL8K5MC0f9bqUjrq0UokUoEpvU='; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "connect-src 'self' ws: wss:; worker-src 'self' blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


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

    def add(self, strategy: str, text: str, kind: str, *, notice_id: str | None = None) -> None:
        if notice_id and any(item.get("id") == notice_id for item in self.items):
            return
        now = datetime.now(timezone.utc).isoformat()
        item = {"time": now, "strategy": strategy, "text": text, "kind": kind}
        if notice_id:
            item["id"] = notice_id
        self.items.append(item)


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()[:32]


class WebAuth:
    def __init__(
        self,
        secret: str,
        clock: Callable[[], float] = time.time,
        *,
        used_links: Store | None = None,
        sessions: Store | None = None,
    ) -> None:
        self.secret = secret
        self.clock = clock
        self.used_links = used_links
        self.sessions = sessions
        self._sessions: dict[str, Any] = {}
        self._used: dict[str, float] = {}  # login nonce -> expiry
        self._fails: dict[str, list[float]] = {}  # client -> times of wrong passwords
        self._confirmations: dict[str, tuple[float, str]] = {}

    def confirmation(self, scope: str) -> str:
        now = self.clock()
        self._confirmations = {
            key: value for key, value in self._confirmations.items() if value[0] > now
        }
        if len(self._confirmations) >= 1024:
            self._confirmations.pop(next(iter(self._confirmations)))
        ticket = secrets.token_hex(16)
        self._confirmations[ticket] = (now + 30, scope)
        return ticket

    def consume_confirmation(self, ticket: object, scope: str) -> bool:
        if not isinstance(ticket, str) or ticket not in self._confirmations:
            return False
        expires, expected = self._confirmations[ticket]
        if expires <= self.clock() or not hmac.compare_digest(expected, scope):
            return False
        del self._confirmations[ticket]
        return True

    def session(self) -> str:
        """A fresh session cookie value."""
        now = self.clock()
        expires = int(now) + SESSION_TTL
        sid = secrets.token_urlsafe(24)
        with self._session_data() as sessions:
            for key, entry in list(sessions.items()):
                if entry["expires"] <= now or entry["seen"] <= now - SESSION_IDLE:
                    del sessions[key]
            if len(sessions) >= 256:
                del sessions[min(sessions, key=lambda key: sessions[key]["seen"])]
            sessions[sid] = {"expires": expires, "seen": now}
        return f"{expires}.{sid}.{_sign(self.secret, f'session.{expires}.{sid}')}"

    def _session_data(self) -> AbstractContextManager[dict[str, Any]]:
        return self.sessions.edit() if self.sessions else nullcontext(self._sessions)

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
        good = hmac.compare_digest(
            sig.encode(), _sign(self.secret, f"login.{expires}.{nonce}").encode()
        )
        if not good or expires <= now:
            return None
        if self.used_links is not None:
            with self.used_links.edit() as used:
                if not self._consume_link(used, nonce, expires, now):
                    return None
        elif not self._consume_link(self._used, nonce, expires, now):
            return None
        return self.session()

    @staticmethod
    def _consume_link(used: dict[str, Any], nonce: str, expires: int, now: float) -> bool:
        for key, expiry in list(used.items()):
            if expiry <= now:
                del used[key]
        if nonce in used:
            return False
        used[nonce] = expires
        return True

    def _session_id(self, cookie: str | None) -> str | None:
        if not cookie:
            return None
        try:
            expires_text, sid, sig = cookie.split(".")
            expires = int(expires_text)
        except ValueError:
            return None
        good = hmac.compare_digest(
            sig.encode(), _sign(self.secret, f"session.{expires}.{sid}").encode()
        )
        return sid if good and expires > self.clock() else None

    def valid(self, cookie: str | None, *, touch: bool = True) -> bool:
        sid = self._session_id(cookie)
        if sid is None:
            return False
        now = self.clock()
        with self._session_data() as sessions:
            entry = sessions.get(sid)
            if entry is None:
                return False
            if entry["expires"] <= now or entry["seen"] <= now - SESSION_IDLE:
                del sessions[sid]
                return False
            if touch and now - entry["seen"] >= 60:
                entry["seen"] = now
            return True

    def revoke(self, cookie: str | None) -> None:
        if (sid := self._session_id(cookie)) is not None:
            with self._session_data() as sessions:
                sessions.pop(sid, None)


def login_url(
    listen: str,
    token: str,
    public_url: str | None = None,
    *,
    workspace: bool = False,
    project: str = "",
) -> str:
    host, _, port = listen.rpartition(":")
    host = "127.0.0.1" if host in {"0.0.0.0", "::", ""} else host  # noqa: S104
    origin = public_url or f"http://{host}:{port}"
    view = "&view=workspace" if workspace else ""
    project_query = (
        f"&workspace={project}" if workspace and re.fullmatch(r"[a-f0-9]{24}", project) else ""
    )
    return f"{origin}/ui/login?t={token}{view}{project_query}"


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
    updated: bool = False


UPDATE_KEY = web.AppKey("web_update", UpdateActions)


def _need_login(request: web.Request) -> web.Response | None:
    # Read-only background polling does not renew idle sessions.
    touch = request.method != "GET"
    if not request.app[AUTH_KEY].valid(request.cookies.get(COOKIE), touch=touch):
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


def _check_args(
    name: str, args: dict[str, Any], params: dict[str, Any] | None, strategy: Strategy
) -> dict[str, Any]:
    """The arguments a command may carry, validated like the Telegram commands."""
    if name == "cancel":
        order_id = args.get("order_id")
        if not isinstance(order_id, str) or not 1 <= len(order_id) <= 256:
            raise ValueError(tr("缺少挂单 id"))
        return {"order_id": order_id}
    if name == "set_param":
        key = str(args.get("name") or "")
        if not NAME.match(key) or "value" not in args:
            raise ValueError(tr("要给出参数名和值"))
        value = args["value"]
        try:
            json.dumps(value, allow_nan=False)
        except ValueError as exc:
            raise ValueError(tr("参数值必须是有效的 JSON，数值必须有限。")) from exc
        if params is not None:
            if key not in params:
                raise ValueError(tr("没有参数 {0}", key))
            ok, value = check_type(params[key], value)
            if not ok:
                raise ValueError(
                    tr("{0} 现在是 {1}，不能改成 {2!r}", key, type(params[key]).__name__, value)
                )
        return {"name": key, "value": value}
    if name == "manual_order":
        side, symbol, qty = args.get("side"), str(args.get("symbol") or ""), args.get("qty")
        if side not in ("buy", "sell") or not SYMBOL.fullmatch(symbol):
            raise ValueError(tr("要给出方向（买或卖）和代码"))
        if not valid_order_qty(qty, strategy.max_order_qty):
            raise ValueError(tr("数量要是大于 0 且不超过 {0} 的有限数。", strategy.max_order_qty))
        return {"side": side, "symbol": symbol.upper(), "qty": qty}
    return {}


def _confirm(
    request: web.Request, strategy: Strategy, name: str, args: dict[str, Any], body: dict[str, Any]
) -> web.Response | None:
    auth = request.app[AUTH_KEY]
    if not auth.valid(request.cookies.get(COOKIE)):
        return web.json_response({"ok": False, "error": "login required"}, status=401)
    scope = _sign(
        auth.secret,
        json.dumps(
            [request.cookies[COOKIE], strategy.id, strategy.token, name, args],
            sort_keys=True,
        ),
    )
    if body.get("prepare") is True:
        return _answer(True, "", {"ticket": auth.confirmation(scope)})
    if not auth.consume_confirmation(body.get("ticket"), scope):
        return _answer(False, tr("请使用未过期的一次性票据确认此操作。"))
    return None


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
    body = await _args(request)
    try:
        args = _check_args(name, body, params, s)
    except ValueError as exc:
        return _answer(False, str(exc))
    if protected(name) and (answer := _confirm(request, s, name, args, body)) is not None:
        return answer
    ok, outcome = await core.call(
        s, name, args, operation_id=body["ticket"] if protected(name) else None
    )
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
            op=outcome.operation_id if isinstance(outcome, Result) else None,
            args=args,
            ok=ok,
            result=f"{s.name} {tr(LABELS[name])}：{message or tr('完成')}",
        )
    response = {"ok": ok, "message": message or (tr("完成") if ok else tr("失败")), "data": data}
    if isinstance(outcome, Result) and outcome.operation_id:
        response.update(operation_id=outcome.operation_id, state=outcome.state)
    return web.json_response(response)


# ------------------------------------------------------------- settings

STORE_KEY = web.AppKey("web_store", Store)
TELEGRAM_KEY = web.AppKey("web_telegram", object)  # cli.telegram, replaced in tests
EDITOR_LOCK = web.AppKey("web_editor_locks", dict)


async def strategy_action(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    core = request.app[CORE_KEY]
    strategy = core.hub.strategies.get(request.match_info["sid"])
    action = strategy.actions.get(request.match_info["action"]) if strategy else None
    if strategy is None or action is None:
        return _answer(False, tr("策略没有提供此操作。"))
    if not core.hub.online(strategy):
        return _answer(False, tr("请等策略上线后再执行此操作。"))
    body = await _args(request)
    try:
        args = action_arguments(action, body.get("args", {}))
    except ValueError as exc:
        return _answer(False, str(exc))
    name = f"action:{action.id}"
    if action.confirm and (answer := _confirm(request, strategy, name, args, body)) is not None:
        return answer
    ok, outcome = await core.call(
        strategy, name, args, operation_id=body["ticket"] if action.confirm else None
    )
    message = outcome.message if isinstance(outcome, Result) else str(outcome)
    data = outcome.data if isinstance(outcome, Result) else None
    core.audit.write(
        "strategy_action",
        user=WEB_USER,
        strategy=strategy.id,
        operation=action.id,
        ok=ok,
        op=outcome.operation_id if isinstance(outcome, Result) else None,
    )
    response = {"ok": ok, "message": message or tr("操作已完成。"), "data": data}
    if isinstance(outcome, Result) and outcome.operation_id:
        response.update(operation_id=outcome.operation_id, state=outcome.state)
    return web.json_response(response)


async def strategy_operations(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    core = request.app[CORE_KEY]
    hub, sid = core.hub, request.match_info["sid"]
    if sid not in hub.strategies:
        raise web.HTTPNotFound()
    hub.operations.expire(hub.wall_clock(), hub.result_ttl)
    if request.method == "GET":
        return web.json_response({"operations": hub.operations.recent(sid)})
    body = await _args(request)
    ok, note = body.get("ok"), body.get("note")
    if type(ok) is not bool or not isinstance(note, str) or not 1 <= len(note.strip()) <= 500:
        return _answer(False, tr("请填写核对结果和说明。"))
    cid = request.match_info["operation_id"]
    if not hub.operations.reconcile(sid, cid, ok, note.strip(), hub.wall_clock()):
        return _answer(False, tr("只能核对执行结果未知的操作。"))
    core.audit.write("reconcile", strategy=sid, user=WEB_USER, op=cid, ok=ok, result=note)
    return _answer(True, tr("已保存核对结果。"))


async def strategy_metric(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    strategy = request.app[CORE_KEY].hub.strategies.get(request.match_info["sid"])
    metric = strategy.metrics.get(request.query.get("name", "")) if strategy else None
    if metric is None:
        return _answer(False, tr("策略还没有上报此指标。"))
    return _answer(
        True,
        "",
        {
            **metric.summary(),
            "points": [{"time": time, "value": value} for time, value in metric.points],
        },
    )


@dataclass
class GitHubActions:
    editor: GitHubEditor
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending: tuple[str, DeviceLogin] | None = None


GITHUB_KEY = web.AppKey("web_github", GitHubActions)
TERMINALS_KEY = web.AppKey("web_workspace_terminals", dict)
RUNTIME_KEY = web.AppKey("web_workspace_runtimes", dict)
CHANGES_KEY = web.AppKey("web_workspace_changes", WorkspaceChanges)
CHANGES_CLOSING_KEY = web.AppKey("web_workspace_changes_closing", asyncio.Event)


def _telegram(request: web.Request) -> Any:
    return request.app[TELEGRAM_KEY]


async def _bot_call(request: web.Request, token: str, method: str, **params: Any) -> Any:
    call = _telegram(request)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: call(token, method, **params))


def _project(request: web.Request) -> str:
    return request.headers.get("X-QuantBot-Workspace") or request.query.get("workspace", "")


def _editor(request: web.Request) -> Editor:
    return Editor.for_project(request.app[STORE_KEY].dir, _project(request))


def _edit_lock(request: web.Request, editor: Editor) -> asyncio.Lock:
    return request.app[EDITOR_LOCK].setdefault(editor.root, asyncio.Lock())


async def workspace_list(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    try:
        projects = await asyncio.to_thread(workspace_projects, request.app[STORE_KEY].dir)
        return _answer(True, "", {"projects": projects})
    except ConfigError as exc:
        return _answer(False, str(exc))


async def workspace_remove(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    app, store = request.app, request.app[STORE_KEY]
    project = request.match_info["project"]
    try:
        editor = Editor.for_project(store.dir, project)
        runtime = _runtime(app, editor)
        async with runtime.lock, _edit_lock(request, editor):
            if await runtime.is_running():
                return _answer(False, tr("请先停止工作区程序，再移除工作区。"))
            credentials = WorkspaceCredentials(store.dir)
            credentials.revoke(editor.root)
            app[WEB_HUB_KEY].set_workspace_credentials(credentials.records())
            await asyncio.to_thread(unregister_workspace, store.dir, editor.root)
            await asyncio.gather(
                *(
                    socket.close(code=1001)
                    for socket, root in tuple(app[TERMINALS_KEY].items())
                    if root == editor.root
                )
            )
            app[RUNTIME_KEY].pop(editor.root, None)
    except (ConfigError, OSError, asyncio.TimeoutError) as exc:
        return _answer(False, str(exc))
    app[CORE_KEY].audit.write("workspace_remove", user=WEB_USER, project=str(editor.root), ok=True)
    return _answer(True, tr("已移除工作区。"), {"projects": workspace_projects(store.dir)})


async def workspace_setup(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    directory = request.app[STORE_KEY].dir
    action = request.match_info.get("action")
    if action is None:
        try:
            result = await asyncio.to_thread(
                web_directories, directory, request.query.get("path", "")
            )
            return _answer(True, "", result)
        except ConfigError as exc:
            return _answer(False, str(exc))
        except OSError:
            return _answer(False, tr("无法打开目录，请检查目录和权限。"))
    body = await _args(request)
    path = body.get("path", "")
    name = body.get("name", "")
    if not isinstance(path, str) or not isinstance(name, str):
        return _answer(False, tr("请选择一个工作区文件夹。"))
    audit = request.app[CORE_KEY].audit
    try:
        if action == "folder":
            result = await asyncio.to_thread(web_create_directory, directory, path, name)
            message = tr("文件夹已创建。")
            data = {"path": result}
        else:
            workspace = await asyncio.to_thread(web_initialize, directory, path)
            message = tr("工作区已初始化。")
            data = {"path": str(workspace.root), "id": workspace_id(workspace.root)}
    except ConfigError as exc:
        message = str(exc)
    except subprocess.TimeoutExpired:
        message = tr("初始化工作区超时，请在服务器上重试。")
    except OSError:
        message = tr("无法打开目录，请检查目录和权限。")
    else:
        audit.write(f"workspace_{action}", user=WEB_USER, ok=True, result=message)
        return _answer(True, message, data)
    audit.write(f"workspace_{action}", user=WEB_USER, ok=False, result=message)
    return _answer(False, message)


async def workspace_terminal(request: web.Request) -> web.StreamResponse:
    if (denied := _need_login(request)) is not None:
        return denied
    store = request.app[STORE_KEY]
    origin = request.headers.get("Origin")
    public_url = check_public_url(store.read().get("public_url"))
    allowed = {f"{request.scheme}://{request.host}"}
    if public_url:
        allowed.add(public_url)
    if origin not in allowed:
        return _answer(False, tr("终端连接必须来自 QuantBot 网页。"))
    terminals = request.app[TERMINALS_KEY]
    if len(terminals) >= 12:
        return _answer(False, tr("打开的终端过多，请先关闭一个。"))
    socket = web.WebSocketResponse(heartbeat=25, max_msg_size=65_536, compress=False)
    if not socket.can_prepare(request).ok:
        return _answer(False, tr("终端需要 WebSocket 连接。"))
    try:
        editor = _editor(request)
        workspace = editor.workspace()
        if workspace is None:
            raise ConfigError(tr("请先在服务器上运行 quantbot workspace init。"))
        parts = editor._parts(request.query.get("path", ""))
        with editor._directory(parts):
            cwd = workspace.root.joinpath(*parts)
    except (ConfigError, OSError) as exc:
        return _answer(False, str(exc))

    audit = request.app[CORE_KEY].audit
    terminals[socket] = workspace.root
    try:
        await socket.prepare(request)
        try:
            terminal = await TerminalProcess.start(workspace, cwd)
        except (ConfigError, OSError) as exc:
            audit.write("terminal_open", user=WEB_USER, ok=False, result=str(exc))
            await socket.send_json({"type": "error", "message": str(exc)})
            return socket
        try:
            audit.write("terminal_open", user=WEB_USER, ok=True, result=tr("已打开工作区终端。"))
            await socket.send_json({"type": "ready"})
            await _bridge_terminal(request, socket, terminal)
        finally:
            await terminal.close()
    finally:
        terminals.pop(socket, None)
        await socket.close()
    return socket


async def _bridge_terminal(
    request: web.Request, socket: web.WebSocketResponse, terminal: TerminalProcess
) -> None:
    auth, cookie = request.app[AUTH_KEY], request.cookies.get(COOKIE)

    async def send() -> None:
        while data := await terminal.read():
            await socket.send_bytes(data)

    async def receive() -> None:
        async for message in socket:
            if not auth.valid(cookie, touch=message.type == WSMsgType.BINARY):
                return
            if message.type == WSMsgType.BINARY:
                await terminal.write(message.data)
            elif message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except ValueError:
                    continue
                if not isinstance(payload, dict):
                    continue
                kind = payload.get("type")
                if kind == "resize":
                    columns, rows = payload.get("cols"), payload.get("rows")
                    if type(columns) is int and type(rows) is int:
                        await terminal.resize(columns, rows)
                elif kind == "ping" and type(payload.get("sent")) in {float, int}:
                    sent = payload["sent"]
                    if 0 <= sent < 10**12:
                        await socket.send_json({"type": "pong", "sent": sent})

    async def watch_session() -> None:
        while auth.valid(cookie, touch=False):
            await asyncio.sleep(5)

    tasks = [asyncio.create_task(task()) for task in (send, receive, watch_session)]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _close_terminals(app: web.Application) -> None:
    await asyncio.gather(*(socket.close(code=1001) for socket in tuple(app[TERMINALS_KEY])))


async def workspace_program(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    action = request.match_info.get("action", "")
    audit = request.app[CORE_KEY].audit
    try:
        editor = _editor(request)
        workspace = editor.workspace()
        if workspace is None:
            raise ConfigError(tr("请先在服务器上运行 quantbot workspace init。"))
        runtime = _runtime(request.app, editor)
        credentials = WorkspaceCredentials(editor.data_dir)
        binding = credentials.for_root(editor.root)
        if not action:
            return _answer(
                True,
                "",
                {
                    **await runtime.status(),
                    "strategy_id": binding.read().get("QB_NAME", ""),
                },
            )
        body = await _args(request)
        async with runtime.lock:
            if action == "configure":
                command = body.get("command")
                if not isinstance(command, str):
                    return _answer(False, tr("请输入有效的启动命令。"))
                await runtime.configure(command)
                message = tr("启动命令已保存。")
            elif action == "start":
                await _start_program(request.app, editor, runtime)
                message = tr("已启动工作区程序。")
            elif action == "stop":
                await runtime.stop()
                hub = request.app[WEB_HUB_KEY]
                sid = binding.read().get("QB_NAME")
                if (strategy := hub.strategies.get(sid)) is not None:
                    hub.mark_stopped(strategy)
                message = tr("已停止工作区程序。")
            else:
                hub = request.app[CORE_KEY].hub
                if action == "unbind":
                    credentials.revoke(editor.root)
                else:
                    sid = body.get("id") if action == "bind" else binding.read().get("QB_NAME")
                    strategy = hub.strategies.get(sid) if isinstance(sid, str) else None
                    if strategy is None:
                        return _answer(False, tr("请选择一个已注册的策略。"))
                    if action == "bind" and (await runtime.status())["running"]:
                        return _answer(False, tr("请先停止程序，再修改策略绑定。"))
                    credentials.bind(editor.root, sid, strategy.token, rotate=action == "rotate")
                hub.set_workspace_credentials(credentials.records())
                message = tr("已更新工作区策略绑定。")
            status = await runtime.status()
            status["strategy_id"] = binding.read().get("QB_NAME", "")
    except (ConfigError, OSError, asyncio.TimeoutError) as exc:
        if action:
            audit.write(f"workspace_{action}", user=WEB_USER, ok=False, result=str(exc))
        return _answer(False, str(exc))
    audit.write(
        f"workspace_{action}", user=WEB_USER, ok=True, project=str(editor.root), result=message
    )
    return _answer(True, message, status)


def _runtime(app: web.Application, editor: Editor) -> WorkspaceRuntime:
    runtimes = app[RUNTIME_KEY]
    if editor.root not in runtimes:
        runtimes[editor.root] = WorkspaceRuntime(editor.data_dir, editor.root)
    return runtimes[editor.root]


async def _start_program(app: web.Application, editor: Editor, runtime: WorkspaceRuntime) -> None:
    workspace = editor.workspace()
    if workspace is None:
        raise ConfigError(tr("请先在服务器上运行 quantbot workspace init。"))
    hub, store = app[WEB_HUB_KEY], app[STORE_KEY]
    credentials = WorkspaceCredentials(editor.data_dir).for_root(editor.root)
    binding = credentials.read()
    strategy = hub.by_token(binding.get("QB_TOKEN", "")) if binding else None
    if binding and (strategy is None or strategy.id != binding.get("QB_NAME")):
        raise ConfigError(tr("工作区策略绑定已失效，请重新绑定。"))
    async with app[EDITOR_LOCK].setdefault(editor.root, asyncio.Lock()):
        official = await asyncio.to_thread(refresh_workspace_sources, editor)
    sdk = await asyncio.to_thread(runtime_sdk, store.dir)
    await runtime.start(
        workspace,
        credentials.path if binding else None,
        local_origin(store.ensure_listen()) if binding else "",
        sdk,
        official.get(QUICKSTART_FILE, ""),
    )


async def refresh_workspace_clients(app: web.Application) -> None:
    """Install bundled SDK files and refresh running official paper demos after an upgrade."""
    store, hub = app[STORE_KEY], app[WEB_HUB_KEY]
    snapshot = store.read()
    for project in workspace_projects(store.dir):
        if not project["managed"]:
            continue
        try:
            editor = Editor.for_project(store.dir, project["id"])
            runtime = _runtime(app, editor)
            async with runtime.lock:
                async with app[EDITOR_LOCK].setdefault(editor.root, asyncio.Lock()):
                    official = await asyncio.to_thread(refresh_workspace_sources, editor)
                revision = official.get(QUICKSTART_FILE)
                sid = f"quickstart-{project['id'][:16]}"
                item = strategy_item(snapshot, sid)
                if (
                    not revision
                    or revision == runtime.source_revision
                    or item is None
                    or item.get("quickstart_workspace") != project["id"]
                ):
                    continue
                binding = WorkspaceCredentials(store.dir).for_root(editor.root).read()
                strategy = hub.by_token(binding.get("QB_TOKEN", ""))
                if strategy is None or strategy.id != sid:
                    continue
                status = await runtime.status()
                if status["running"] and status["command"] == QUICKSTART_COMMAND:
                    await runtime.stop()
                    hub.mark_stopped(strategy)
                    await _start_program(app, editor, runtime)
        except (OSError, ConfigError, asyncio.TimeoutError):
            log.exception("Could not refresh workspace SDK in %s", project["path"])


async def launch_quickstart(app: web.Application, project: str = "") -> dict[str, Any]:
    store, hub = app[STORE_KEY], app[WEB_HUB_KEY]
    if not project:
        known = [item for item in workspace_projects(store.dir) if item["managed"]]
        selected = next((item for item in known if item["default"]), known[0] if known else None)
        if selected is None:
            return {"needs_setup": True}
        project = selected["id"]
    editor = Editor.for_project(store.dir, project)
    if editor.workspace() is None:
        return {"needs_setup": True}
    runtime = _runtime(app, editor)
    sid = f"quickstart-{project[:16]}"
    credentials = WorkspaceCredentials(store.dir)
    async with runtime.lock:
        status = await runtime.status()
        binding = credentials.for_root(editor.root).read()
        if status["command"] not in {"", QUICKSTART_COMMAND} or (
            binding and binding.get("QB_NAME") != sid
        ):
            raise ConfigError(tr("此工作区已有程序配置，请使用另一个工作区运行快速入手。"))
        if status["running"]:
            if status["command"] == QUICKSTART_COMMAND and sid in hub.strategies:
                running_strategy = hub.strategies[sid]
                if running_strategy.said_hello and hub.ready_for_claims(running_strategy):
                    return {"id": sid, "project": project, "file": QUICKSTART_FILE}
                raise ConfigError(tr("模拟策略尚未连接。请在工作区查看程序日志。"))
            raise ConfigError(tr("工作区程序已经在运行。"))

        def seed() -> None:
            refresh_workspace_sources(editor)
            with editor_lock(store.dir, editor.root):
                editor.seed(QUICKSTART_FILE, quickstart_source())

        async with app[EDITOR_LOCK].setdefault(editor.root, asyncio.Lock()):
            await asyncio.to_thread(seed)
        with store.edit() as data:
            item = strategy_item(data, sid)
            if item is None:
                item = add_strategy(data, sid, tr("快速入手（模拟）"))
                item["quickstart_workspace"] = project
                item["max_order_qty"] = 100
            if item.get("quickstart_workspace") != project:
                raise ConfigError(tr("模拟策略 ID 已被使用。"))
            strategies = store.strategies(data)
        hub.sync(strategies)
        credentials.bind(editor.root, sid, item["token"])
        hub.set_workspace_credentials(credentials.records())
        await runtime.configure(QUICKSTART_COMMAND)
        started_at = hub.clock()
        await _start_program(app, editor, runtime)
    strategy = hub.strategies[sid]
    for _ in range(60):
        if (
            strategy.said_hello
            and strategy.claim_poll_at is not None
            and strategy.claim_poll_at >= started_at
            and hub.ready_for_claims(strategy)
        ):
            return {"id": sid, "project": project, "file": QUICKSTART_FILE}
        await asyncio.sleep(0.1)
    raise ConfigError(tr("模拟策略尚未连接。请在工作区查看程序日志。"))


async def quickstart(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    if request.method == "GET":
        return web.Response(
            text=quickstart_source(),
            content_type="text/x-python",
            headers={
                "Content-Disposition": f'attachment; filename="{QUICKSTART_FILE}"',
                "Cache-Control": "no-store",
            },
        )
    try:
        data = await launch_quickstart(request.app, _project(request))
    except (ConfigError, OSError, asyncio.TimeoutError) as exc:
        return _answer(False, str(exc))
    return _answer(True, "", data)


async def _stop_workspace_program(app: web.Application) -> None:
    async def stop(runtime: WorkspaceRuntime) -> None:
        async with runtime.lock:
            await runtime.stop()

    await asyncio.gather(
        *(stop(runtime) for runtime in app[RUNTIME_KEY].values() if runtime.systemd is None)
    )


async def editor_read(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    path = request.query.get("path", "")

    def read() -> dict[str, Any]:
        editor = _editor(request)
        if request.match_info["kind"] == "tree":
            return {"entries": editor.entries(path)}
        return asdict(editor.read(path))

    try:
        return _answer(True, "", await asyncio.to_thread(read))
    except ConfigError as exc:
        return _answer(False, str(exc))
    except OSError:
        return _answer(False, tr("无法打开这个路径，请检查文件是否存在且可读。"))


async def editor_save(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    body = await _args(request)
    path, content, revision = body.get("path"), body.get("content"), body.get("revision")
    if not all(isinstance(value, str) for value in (path, content, revision)):
        return _answer(False, tr("请选择文件并确认要保存的改动。"))

    try:
        editor = _editor(request)
    except ConfigError as exc:
        return _answer(False, str(exc))

    def save() -> dict[str, str]:
        with editor_lock(editor.data_dir, editor.root):
            return asdict(editor.save(path, content, revision))

    async with _edit_lock(request, editor):
        try:
            result = await asyncio.to_thread(save)
            ok, message = True, tr("文件已保存。")
        except ConfigError as exc:
            result, ok, message = None, False, str(exc)
        except OSError:
            result, ok, message = None, False, tr("无法保存这个路径，请检查文件和目录权限。")
        request.app[CORE_KEY].audit.write(
            "editor_save", user=WEB_USER, ok=ok, result=f"{path}：{message}"
        )
    return _answer(ok, message, result)


async def editor_change(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    body = await _args(request)
    action = request.match_info["action"]
    path, destination = body.get("path"), body.get("destination", "")
    if not isinstance(path, str) or not isinstance(destination, str):
        return _answer(False, tr("请选择编辑目录内的相对路径。"))

    try:
        editor = _editor(request)
    except ConfigError as exc:
        return _answer(False, str(exc))

    def change() -> None:
        with editor_lock(editor.data_dir, editor.root):
            editor.change(action, path, destination)

    async with _edit_lock(request, editor):
        try:
            await asyncio.to_thread(change)
        except FileExistsError:
            return _answer(False, tr("目标路径已存在。"))
        except ConfigError as exc:
            return _answer(False, str(exc))
        except OSError:
            return _answer(False, tr("无法更改路径，请检查文件和目录权限。"))
        request.app[CORE_KEY].audit.write(
            "editor_change",
            user=WEB_USER,
            ok=True,
            operation=action,
            path=path,
            destination=destination,
        )
    return _answer(True, "", {"path": destination or path})


async def editor_search(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    query = request.query.get("q", "").strip()
    if not query or len(query) > 200 or "\0" in query:
        return _answer(True, "", [])
    try:
        editor = await asyncio.to_thread(_editor, request)
        return _answer(
            True,
            "",
            await search(
                editor,
                query,
                request.query.get("mode") == "content",
                ignored=request.query.get("ignored") == "true",
            ),
        )
    except ConfigError as exc:
        return _answer(False, str(exc))
    except OSError:
        return _answer(False, tr("无法搜索工作区。"))


async def editor_events(request: web.Request) -> web.StreamResponse:
    if (denied := _need_login(request)) is not None:
        return denied
    try:
        editor = await asyncio.to_thread(_editor, request)
    except ConfigError as exc:
        return _answer(False, str(exc))
    response = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        }
    )
    async with request.app[CHANGES_KEY].subscribe(editor.root) as changed:
        await response.prepare(request)
        try:
            while _need_login(request) is None and not request.app[CHANGES_CLOSING_KEY].is_set():
                await response.write(b"data: refresh\n\n")
                try:
                    await asyncio.wait_for(changed.wait(), 15)
                except asyncio.TimeoutError:
                    pass
                changed.clear()
        except ConnectionError:
            pass
    return response


async def _close_workspace_changes(app: web.Application) -> None:
    app[CHANGES_CLOSING_KEY].set()
    await app[CHANGES_KEY].close()


async def github_get(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    try:
        status = await asyncio.to_thread(request.app[GITHUB_KEY].editor.status)
        return _answer(True, "", status)
    except (ConfigError, OSError) as exc:
        return _answer(False, str(exc))


async def local_git(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    try:
        editor = _editor(request)
    except ConfigError as exc:
        return _answer(False, str(exc))
    git = GitHubEditor(editor.data_dir, _project(request))
    operation = request.match_info.get("action", "")
    if request.method == "GET":
        try:
            if operation == "diff":
                path = request.query.get("path", "")
                staged = request.query.get("staged") == "true"
                data = await asyncio.to_thread(git.diff, path, staged)
            elif operation == "branches":
                data = await asyncio.to_thread(git.branches)
            else:
                data = await asyncio.to_thread(git.local_status)
            return _answer(True, "", data)
        except (ConfigError, OSError) as exc:
            return _answer(False, str(exc))
    body = await _args(request)
    audit = request.app[CORE_KEY].audit
    async with _edit_lock(request, editor):
        try:
            if operation in {"stage", "unstage", "commit"}:
                paths = body.get("paths", [])
                if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
                    return _answer(False, tr("请选择要操作的 Git 文件。"))
                if operation == "commit":
                    message = body.get("message")
                    if not isinstance(message, str):
                        return _answer(False, tr("请填写有效的提交说明。"))
                    revision = await asyncio.to_thread(git.commit, paths, message)
                    data = {"revision": revision}
                else:
                    data = await asyncio.to_thread(git.stage, paths, operation == "stage")
            elif operation == "init":
                data = await asyncio.to_thread(git.initialize)
            elif operation == "switch":
                branch = body.get("branch")
                if not isinstance(branch, str):
                    return _answer(False, tr("请填写有效的 Git 分支名。"))
                data = await asyncio.to_thread(git.switch, branch)
            else:
                data = await asyncio.to_thread(git.sync, operation)
        except (ConfigError, OSError) as exc:
            audit.write(f"git_{operation}", user=WEB_USER, ok=False, result=str(exc))
            return _answer(False, str(exc))
        audit.write(f"git_{operation}", user=WEB_USER, ok=True, revision=data.get("revision"))
        return _answer(True, "", data)


async def github_post(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[GITHUB_KEY]
    operation = request.match_info["action"]
    body = await _args(request)
    audit = request.app[CORE_KEY].audit
    async with actions.lock:
        try:
            if operation == "bind":
                if not actions.pending or actions.pending[1].done.done():
                    actions.pending = secrets.token_urlsafe(16), await actions.editor.begin()
                state, login = actions.pending
                try:
                    code = await asyncio.wait_for(asyncio.shield(login.code), 15)
                    if not code:
                        raise ConfigError(tr("GitHub 授权未启动，请检查服务器网络后重试。"))
                except asyncio.TimeoutError as exc:
                    actions.pending = None
                    await login.close()
                    raise ConfigError(tr("GitHub 授权未启动，请检查服务器网络后重试。")) from exc
                return _answer(True, "", {"url": DEVICE_URL, "code": code, "state": state})
            if operation in {"authorize", "cancel"}:
                if not actions.pending or body.get("state") != actions.pending[0]:
                    return _answer(False, tr("请重新开始 GitHub 授权。"))
                _, login = actions.pending
                if operation == "cancel":
                    await login.close()
                    actions.pending = None
                    return _answer(True, "")
                if not login.done.done():
                    return _answer(True, "", {"ready": False})
                if not await login.done:
                    actions.pending = None
                    raise ConfigError(tr("GitHub 授权未完成，请重试。"))
                if not login.reported:
                    audit.write("github", user=WEB_USER, ok=True, operation="login")
                    login.reported = True
                return _answer(True, "", {"ready": True})
            if operation == "repositories":
                repos = await asyncio.to_thread(actions.editor.repositories)
                return _answer(True, "", {"repositories": repos})
            if operation == "select":
                repo = body.get("repo")
                folder = body.get("folder", "")
                if not isinstance(repo, str) or not isinstance(folder, str):
                    return _answer(False, tr("请选择 GitHub 已授权的仓库。"))
                directory = request.app[STORE_KEY].dir
                project = _project(request)

                def clone() -> dict[str, Any]:
                    if not folder:
                        git = GitHubEditor(directory, project) if project else actions.editor
                        return {**git.select(repo), "project": project}
                    GitHubEditor.repository_url(repo)
                    path = web_create_directory(directory, "", folder)
                    workspace = web_initialize(directory, path)
                    created = workspace_id(workspace.root)
                    try:
                        result = GitHubEditor(directory, created).select(repo)
                    except ConfigError as exc:
                        raise ConfigError(
                            tr("目录 {0} 已创建，可以打开后重试。{1}", path, exc)
                        ) from exc
                    return {**result, "project": created}

                data = await asyncio.to_thread(clone)
                audit.write("github", user=WEB_USER, ok=True, operation="clone", repo=repo)
                return _answer(True, "", data)
            if actions.pending:
                _, login = actions.pending
                actions.pending = None
                await login.close()
            await asyncio.to_thread(actions.editor.logout)
            audit.write("github", user=WEB_USER, ok=True, operation="logout")
            return _answer(True, "")
        except (ConfigError, OSError, ValueError) as exc:
            audit.write("github", user=WEB_USER, ok=False, operation=operation)
            return _answer(
                False, str(exc) if isinstance(exc, ConfigError) else tr("GitHub 操作失败，请重试。")
            )


async def _close_github(app: web.Application) -> None:
    actions = app[GITHUB_KEY]
    if actions.pending:
        _, login = actions.pending
        actions.pending = None
        await login.close()


def _service() -> Service | None:
    try:
        service = Service.detect()
    except ServiceError:
        return None
    return service if service.installed() else None


def _service_installed() -> bool:
    return _service() is not None


async def _reply_and_restart(
    request: web.Request, restart: Callable[[], None], message: str
) -> web.Response:
    response = _answer(True, message)
    try:
        await response.prepare(request)
        await response.write_eof()
    finally:
        restart()
    return response


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


async def update_impact(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    app = request.app
    store = app[STORE_KEY]
    snapshot = store.read()
    credentials = WorkspaceCredentials(store.dir)

    async def inspect(project: dict[str, Any]) -> dict[str, str] | None:
        try:
            editor = Editor.for_project(store.dir, project["id"])
            runtime = _runtime(app, editor)
            if not await runtime.is_running():
                return None
            sid = f"quickstart-{project['id'][:16]}"
            item = strategy_item(snapshot, sid)
            demo = (
                item is not None
                and item.get("quickstart_workspace") == project["id"]
                and credentials.for_root(editor.root).read().get("QB_NAME") == sid
                and runtime.command == QUICKSTART_COMMAND
            )
            impact = "demo" if demo else "independent" if runtime.systemd else "stops"
        except (ConfigError, OSError, asyncio.TimeoutError):
            impact = "unknown"
        return {"name": project["name"], "impact": impact}

    projects = workspace_projects(store.dir)
    checks = await asyncio.gather(*(inspect(project) for project in projects if project["managed"]))
    return web.json_response({"programs": [result for result in checks if result is not None]})


async def update_check(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    if actions.updated or actions.lock.locked():
        return _answer(False, tr("更新正在进行，或正在等待重启。"))
    async with actions.lock:
        result = await asyncio.to_thread(actions.updater.check)
    return _answer(not result["error"], result["error"] or tr("已检查更新。"), result)


async def update_post(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    if actions.updated or actions.lock.locked():
        return _answer(False, tr("更新正在进行，或正在等待重启。"))
    async with actions.lock:
        result = actions.updater.cached() or {}
        if not result.get("available"):
            return _answer(False, tr("没有可安装的更新，请先检查更新。"))
        ok, output = await asyncio.to_thread(actions.updater.upgrade)
        actions.updated = ok
        request.app[CORE_KEY].audit.write(
            "update",
            user=WEB_USER,
            ok=ok,
            revision=result.get("latest"),
            result=tr("已安装更新") if ok else tr("安装更新失败"),
            output=output,
        )
        if not ok:
            return _answer(False, tr("更新失败。{0}", output))
        restart = actions.restart if _service_installed() else None
        if restart is None:
            return _answer(True, tr("已更新。请在服务器上停止 QuantBot，再运行 quantbot run。"))
        return await _reply_and_restart(
            request, restart, tr("已更新，后台服务即将重启。网页会自动重连。")
        )


def _redact_diagnostics(text: str, store: Store) -> str:
    settings = store.read()
    values = [
        settings.get("web_secret"),
        (settings.get("telegram") or {}).get("token"),
        (settings.get("web_admin") or {}).get("password"),
        *(item.get("token") for item in settings.get("strategies") or [] if isinstance(item, dict)),
    ]
    for value in values:
        if isinstance(value, str) and value:
            text = text.replace(value, tr("[已隐藏]"))
    return re.sub(
        r"(?:gh[oprstu]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|\d{5,}:[A-Za-z0-9_-]{30,})",
        tr("[已隐藏]"),
        text,
    )


async def service_get(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    service = _service()
    diagnostics = request.match_info["kind"]
    try:
        text = ""
        if service:
            load = service.status if diagnostics == "status" else service.recent_logs
            text = await asyncio.to_thread(load)
            text = _redact_diagnostics(text, request.app[STORE_KEY])[-24_000:]
    except (ServiceError, OSError) as exc:
        message = _redact_diagnostics(str(exc), request.app[STORE_KEY])
        return _answer(False, message)
    response = _answer(True, "", {"installed": service is not None, "text": text})
    response.headers["Cache-Control"] = "no-store"
    return response


async def service_restart(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    actions = request.app[UPDATE_KEY]
    if actions.restart is None or not _service_installed():
        return _answer(False, tr("请在服务器上重启当前运行的 QuantBot。"))
    if (
        actions.lock.locked()
        or any(lock.locked() for lock in request.app[EDITOR_LOCK].values())
        or request.app[GITHUB_KEY].lock.locked()
    ):
        return _answer(False, tr("有更新或文件操作正在进行，请稍后再试。"))
    async with actions.lock:
        request.app[CORE_KEY].audit.write(
            "service_restart", user=WEB_USER, ok=True, result=tr("请求重启后台服务")
        )
        return await _reply_and_restart(
            request, actions.restart, tr("正在重启后台服务，网页会自动重连。")
        )


async def timezone_list(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    return web.json_response(await asyncio.to_thread(timezones))


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
            "public_url": check_public_url(data.get("public_url")) or "",
            "telegram": bool(tg.get("token")),
            "admin_username": (data.get("web_admin") or {}).get("username") or "",
            "language": normalize_language(data.get("language")),
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
    tg = dict(store.read().get("telegram") or {})
    old_key = (tg.get("token"), tg.get("owner_id"))
    if body.get("remove_telegram"):
        with store.edit() as data:
            data.pop("telegram", None)
        request.app[CORE_KEY].audit.write(
            "settings", user=WEB_USER, ok=True, result=tr("断开了 Telegram，只用网页")
        )
        return _answer(True, tr("已断开 Telegram。QuantBot 几秒后重启，之后只用网页。"))
    changes: dict[str, Any] = {}
    try:
        if "language" in body:
            if body["language"] not in LANGUAGES:
                raise ValueError(tr("请选择简体中文或英语。"))
            changes["language"] = body["language"]
        token = str(body.get("token") or "").strip()
        if token:
            if not BOT_TOKEN.match(token):
                raise ValueError(tr("这不像 bot token，应该像 123456789:AAH..."))
            try:
                me = await _bot_call(request, token, "getMe")
            except TelegramError as exc:
                raise ValueError(tr("Telegram 不认这个 token：{0}", exc)) from exc
            tg.update(token=token, bot_username=me.get("username", ""))
        if "owner_id" in body:
            owner = str(body["owner_id"]).strip()
            if not owner.lstrip("-").isdigit():
                raise ValueError(tr("主人 id 是一串数字"))
            if int(owner) != tg.get("owner_id"):
                tg.update(owner_id=int(owner), owner_name="")
        if "quiet_hours" in body:
            quiet = str(body["quiet_hours"] or "").strip()
            parse_quiet(quiet)
            changes["quiet_hours"] = quiet or None
        if "timezone" in body:
            changes["timezone"] = check_timezone(str(body["timezone"] or "Asia/Shanghai").strip())
        if "heartbeat_url" in body:
            changes["heartbeat_url"] = check_url(str(body["heartbeat_url"] or "").strip())
    except (ValueError, ConfigError) as exc:
        return _answer(False, str(exc))
    if bool(tg.get("token")) != isinstance(tg.get("owner_id"), int):
        return _answer(False, tr("接 Telegram 要同时填 bot token 和主人 id"))
    restart = (tg.get("token"), tg.get("owner_id")) != old_key
    note = ""
    if restart and tg.get("token"):
        try:
            await _bot_call(
                request,
                tg["token"],
                "sendMessage",
                chat_id=tg["owner_id"],
                text=tr("✅ QuantBot 的 Telegram 设置在网页上改好了。"),
            )
            note = tr("已用新设置发了一条测试消息。")
        except TelegramError as exc:
            return _answer(
                False, tr("测试消息发不出去，没有保存：{0}。先给 bot 发一条消息再试。", exc)
            )
    with store.edit() as data:
        if token or "owner_id" in body:
            fresh_tg = data.get("telegram") or {}
            if (fresh_tg.get("token"), fresh_tg.get("owner_id")) != old_key:
                return _answer(False, tr("Telegram 设置已变更，请刷新后再试。"))
            if tg.get("token"):
                data["telegram"] = tg
        data.update(changes)
    request.app[CORE_KEY].audit.write(
        "settings",
        user=WEB_USER,
        ok=True,
        result=tr("改了设置") + (tr("（Telegram 的 bot 或主人）") if restart else ""),
        fields=sorted(k for k in body if k != "token") + (["token"] if token else []),
    )
    if restart or changes.keys() - {"language"}:
        note += tr(" QuantBot 几秒后用新设置重启，网页会断开一下再连上。")
    return _answer(True, tr("已保存。{0}", note).strip())


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


async def strategy_config(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    body = await _args(request)
    action = request.match_info["action"]
    store = request.app[STORE_KEY]
    core = request.app[CORE_KEY]
    try:
        snapshot = store.read()
        public_url = check_public_url(snapshot.get("public_url")) or ""
        listen = str(snapshot.get("listen") or "")
        url = public_url or (f"http://{listen}" if listen.startswith("127.0.0.1:") else "")
        sid = check_strategy_id(str(body.get("id") or ""))
        name = str(body.get("name") or "").strip()
        if len(name) > 64 or (action == "rename" and not name):
            raise ConfigError(tr("请填写 1 到 64 个字符的显示名称。"))
        if action == "credentials":
            item = require_strategy(snapshot, sid)
        else:
            with store.edit() as data:
                if action == "add":
                    item = add_strategy(data, sid, name or sid)
                else:
                    item = require_strategy(data, sid)
                    if action == "rename":
                        item["name"] = name
                    elif action == "rotate":
                        item["token"] = new_token()
                    else:
                        data["strategies"].remove(item)
                strategies = store.strategies(data)
            core.hub.sync(strategies)
    except ConfigError as exc:
        return _answer(False, str(exc))
    message = {
        "add": tr("已添加策略。"),
        "rename": tr("已更新显示名称。"),
        "remove": tr("已移除策略，连接令牌已失效。"),
        "credentials": tr("已查看策略连接信息。"),
        "rotate": tr("已换发令牌。请用新令牌重新连接策略。"),
    }[action]
    result = {"id": sid, "name": item["name"]}
    if action in {"add", "credentials", "rotate"}:
        result.update(token=item["token"], url=url)
    core.audit.write(f"strategy_{action}", user=WEB_USER, strategy=sid, ok=True, result=message)
    response = _answer(True, message, result)
    response.headers["Cache-Control"] = "no-store"
    return response


async def login(request: web.Request) -> web.StreamResponse:
    cookie = request.app[AUTH_KEY].redeem(request.query.get("t", ""))
    if cookie is None:
        return web.Response(
            status=403,
            content_type="text/html",
            charset="utf-8",
            text=_message_page(
                tr("链接已失效"),
                tr(
                    "登录链接只能用一次，5 分钟内有效。在 Telegram 里发 /web，"
                    "或在服务器上运行 quantbot web，拿一个新的。"
                ),
            ),
        )
    workspace = request.query.get("view") == "workspace"
    project = request.query.get("workspace", "")
    target = "/ui/?view=workspace" if workspace else "/ui/"
    if workspace and re.fullmatch(r"[a-f0-9]{24}", project):
        target += f"&workspace={project}"
    if request.query.get("quickstart") == "1":
        target = "/ui/?quickstart=1"
    redirect = web.HTTPFound(target)
    public_url = check_public_url(request.app[STORE_KEY].read().get("public_url"))
    _set_session(redirect, cookie, secure=_secure_session(request, public_url))
    raise redirect


def _secure_session(request: web.Request, public_url: str | None) -> bool:
    return request.secure or bool(public_url and public_url.startswith("https://"))


def _login_client(request: web.Request, tunnel: bool, public_url: str | None) -> str:
    peer = request.remote or "?"
    if not tunnel or not public_url or not public_url.startswith("https://"):
        return peer
    forwarded = request.headers.getall("CF-Connecting-IP", ())
    try:
        if (
            len(forwarded) == 1
            and "%" not in forwarded[0]
            and ip_address(peer).is_loopback
            and check_public_url(f"https://{request.host}") == public_url
        ):
            return str(ip_address(forwarded[0]))
    except ValueError:
        pass
    return peer


def _set_session(response: web.StreamResponse, cookie: str, *, secure: bool) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(
        COOKIE,
        cookie,
        max_age=SESSION_TTL,
        path="/ui",
        httponly=True,
        samesite="Strict",
        secure=secure,
    )


async def password_login(request: web.Request) -> web.Response:
    """POST /ui/api/login with {username, password}."""
    if request.headers.get(CSRF_HEADER) != "1":
        return web.json_response({"ok": False, "error": "missing X-QuantBot header"}, status=403)
    auth = request.app[AUTH_KEY]
    data = request.app[STORE_KEY].read()
    public_url = check_public_url(data.get("public_url"))
    who = _login_client(request, bool(data.get("web_tunnel")), public_url)
    admin = data.get("web_admin") or {}
    if not admin.get("password"):
        return _answer(False, tr("还没设管理员账号。在服务器上运行 quantbot password。"))
    body = await _args(request)
    username, password = str(body.get("username") or ""), str(body.get("password") or "")
    if wait := auth.locked(who):
        return _answer(False, tr("密码错了太多次，{0} 分钟后再试。", (wait + 59) // 60))
    auth.failed(who)  # Reserve an attempt before yielding to the password checker.
    good = await asyncio.to_thread(check_password, password, str(admin["password"]))
    good = hmac.compare_digest(username.encode(), str(admin.get("username")).encode()) and good
    good = good and request.app[STORE_KEY].read().get("web_admin") == admin
    request.app[CORE_KEY].audit.write("login", user=WEB_USER, ok=good, client=who)
    if not good:
        return _answer(False, tr("用户名或密码不对。"))
    auth.succeeded(who)
    response = _answer(True, tr("已登录"))
    _set_session(response, auth.session(), secure=_secure_session(request, public_url))
    return response


async def password_change(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    body = await _args(request)
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not USERNAME.fullmatch(username):
        return _answer(False, tr("用户名可用字母、数字和 _ . -，最多 32 个字符。"))
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        return _answer(False, tr("密码至少 {0} 位。", MIN_PASSWORD))
    if body.get("confirm") != password:
        return _answer(False, tr("两次输入的新密码不同。"))

    store = request.app[STORE_KEY]
    auth = request.app[AUTH_KEY]
    audit = request.app[CORE_KEY].audit
    settings = store.read()
    old_admin = settings.get("web_admin")
    old_hash = (old_admin or {}).get("password")
    public_url = check_public_url(settings.get("public_url"))
    if old_hash:
        current = body.get("current")
        if not isinstance(current, str) or not current:
            return _answer(False, tr("请输入当前密码。"))
        who = _login_client(request, bool(settings.get("web_tunnel")), public_url)
        if wait := auth.locked(who):
            return _answer(False, tr("密码错了太多次，{0} 分钟后再试。", (wait + 59) // 60))
        auth.failed(who)
        if not await asyncio.to_thread(check_password, current, str(old_hash)):
            audit.write("password", user=WEB_USER, ok=False, result=tr("当前密码错误"))
            return _answer(False, tr("当前密码不对。"))
        auth.succeeded(who)

    hashed = await asyncio.to_thread(hash_password, password)
    with store.edit() as data:
        if data.get("web_admin") != old_admin:
            return _answer(False, tr("管理员账号已变更，请重新登录。"))
        set_web_admin(data, {"username": username, "password": hashed})
        secret = data["web_secret"]
        public_url = check_public_url(data.get("public_url"))
    auth.secret = secret
    audit.write("password", user=WEB_USER, ok=True, result=tr("改了网页管理员账号"))
    response = _answer(True, tr("管理员账号已更新，其他会话需要重新登录。"))
    _set_session(response, auth.session(), secure=_secure_session(request, public_url))
    return response


async def web_link(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None:
        return denied
    public_url = check_public_url(request.app[STORE_KEY].read().get("public_url")) or ""
    token = request.app[AUTH_KEY].link_token()
    request.app[CORE_KEY].audit.write(
        "web_link", user=WEB_USER, ok=True, result=tr("生成一次性登录链接")
    )
    response = _answer(True, "", {"url": f"{public_url}/ui/login?t={token}"})
    response.headers["Cache-Control"] = "no-store"
    return response


async def logout(request: web.Request) -> web.Response:
    if (denied := _need_login(request)) is not None and denied.status == 403:
        return denied
    request.app[AUTH_KEY].revoke(request.cookies.get(COOKIE))
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
                "stopped": s.stopped,
                "connected": s.said_hello,
                "paused": s.paused,
                "status": s.status_text,
                "status_age": None if (age := hub.age(s)) is None else round(age, 1),
                "last_seen": seen,
                "commands": list(s.commands),
                "actions": [asdict(action) for action in s.actions.values()],
                "metrics": [metric.summary() for metric in s.metrics.values()],
                "pending": len(s.pending),
            }
        )
    feed = list(request.app[FEED_KEY].items)[::-1]
    directory = request.app[STORE_KEY].dir
    editor_root = Store(directory, filename=EDITOR_FILE).read().get("root")
    managed_roots = registered_roots(Store(directory, filename=WORKSPACE_FILE).read())
    return web.json_response(
        {
            "strategies": strategies,
            "feed": feed,
            "editor_enabled": bool(editor_root),
            "workspace_managed": bool(editor_root and Path(editor_root) in managed_roots),
        }
    )


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
        f'<!doctype html><html lang="{language_tag()}"><meta charset="utf-8"><meta name="viewport" '
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
            text=_message_page(
                tr("网页还没构建"), tr("这个安装里没有网页文件。请运行 quantbot update。")
            ),
        )
    if target.name != "index.html":
        return web.FileResponse(
            target, headers={"Cache-Control": "public, max-age=31536000, immutable"}
        )
    if language() == "zh":
        return web.FileResponse(target, headers={"Cache-Control": "no-store"})
    html = target.read_text("utf-8").replace('<html lang="zh-CN">', '<html lang="en">', 1)
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})


async def redirect_root(request: web.Request) -> web.StreamResponse:
    raise web.HTTPFound("/ui/")


@web.middleware
async def _use_web_language(
    request: web.Request, handler: Callable[..., Any]
) -> web.StreamResponse:
    with use_language(request.app[STORE_KEY].language()):
        return await handler(request)


def _loopback_peer(request: web.Request) -> bool:
    try:
        peer = ip_address(request.remote or "")
    except ValueError:
        return False
    return (getattr(peer, "ipv4_mapped", None) or peer).is_loopback


@web.middleware
async def _protect_transport(
    request: web.Request, handler: Callable[..., Any]
) -> web.StreamResponse:
    if request.path != "/healthz" and not request.secure and not _loopback_peer(request):
        public_url = check_public_url(request.app[STORE_KEY].read().get("public_url"))
        if os.environ.get("QB_REQUIRE_HTTPS") == "1" or (public_url or "").startswith("https://"):
            return web.json_response({"ok": False, "error": "HTTPS required"}, status=426)
    return await handler(request)


async def _security_headers(request: web.Request, response: web.StreamResponse) -> None:
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "no-referrer")
    headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.path.startswith("/ui"):
        headers.setdefault("Content-Security-Policy", CONTENT_SECURITY)
    if request.path.startswith("/ui/api/"):
        headers.setdefault("Cache-Control", "no-store")
    if request.secure:
        headers.setdefault("Strict-Transport-Security", "max-age=31536000")


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
    app.middlewares.append(_use_web_language)
    app.middlewares.insert(0, _protect_transport)
    app.on_response_prepare.append(_security_headers)
    app[TELEGRAM_KEY] = telegram
    hub = core.hub
    hub.set_workspace_credentials(WorkspaceCredentials(store.dir).records())
    app[CORE_KEY] = core
    app[WEB_HUB_KEY] = hub
    app[AUTH_KEY] = auth
    app[FEED_KEY] = feed
    app[AUDIT_KEY] = audit_path
    app[UPDATE_KEY] = UpdateActions(updater or Updater(store.dir), restart)
    app[EDITOR_LOCK] = {}
    app[GITHUB_KEY] = GitHubActions(GitHubEditor(store.dir))
    app[TERMINALS_KEY] = {}
    app[RUNTIME_KEY] = {}
    app[CHANGES_KEY] = WorkspaceChanges()
    app[CHANGES_CLOSING_KEY] = asyncio.Event()
    app.on_shutdown.append(_close_workspace_changes)
    app.on_shutdown.append(_close_terminals)
    app.on_shutdown.append(_close_github)
    app.on_shutdown.append(_stop_workspace_program)
    app.add_routes(
        [
            web.get("/", redirect_root),
            web.get("/ui", redirect_root),
            web.get("/ui/login", login),
            web.post("/ui/api/login", password_login),
            web.post("/ui/api/logout", logout),
            web.post("/ui/api/password", password_change),
            web.post("/ui/api/web-link", web_link),
            web.get("/ui/api/overview", overview),
            web.get("/ui/api/audit", audit),
            web.post("/ui/api/pause-all", pause_all),
            web.get("/ui/api/quickstart/file", quickstart),
            web.post("/ui/api/quickstart", quickstart),
            web.post(
                "/ui/api/strategy-config/{action:add|rename|remove|credentials|rotate}",
                strategy_config,
            ),
            web.get("/ui/api/prompt", prompt),
            web.get("/ui/api/settings", settings_get),
            web.get("/ui/api/timezones", timezone_list),
            web.post("/ui/api/settings", settings_post),
            web.get("/ui/api/update", update_get),
            web.get("/ui/api/update/impact", update_impact),
            web.post("/ui/api/update/check", update_check),
            web.post("/ui/api/update", update_post),
            web.get("/ui/api/service/{kind:status|logs}", service_get),
            web.post("/ui/api/service/restart", service_restart),
            web.get("/ui/api/editor/{kind:tree|file}", editor_read),
            web.post("/ui/api/editor/file", editor_save),
            web.post("/ui/api/editor/files/{action:file|folder|move|copy|delete}", editor_change),
            web.get("/ui/api/editor/search", editor_search),
            web.get("/ui/api/editor/events", editor_events),
            web.get("/ui/api/editor/github", github_get),
            web.get("/ui/api/editor/git", local_git),
            web.get("/ui/api/workspace/terminal", workspace_terminal),
            web.get("/ui/api/workspaces", workspace_list),
            web.post("/ui/api/workspaces/{project:[a-f0-9]{24}}/remove", workspace_remove),
            web.get("/ui/api/workspace/directories", workspace_setup),
            web.post("/ui/api/workspace/{action:folder|init}", workspace_setup),
            web.get("/ui/api/workspace/program", workspace_program),
            web.post(
                "/ui/api/workspace/program/{action:configure|start|stop|bind|rotate|unbind}",
                workspace_program,
            ),
            web.get("/ui/api/editor/git/{action:diff|branches}", local_git),
            web.post(
                "/ui/api/editor/git/{action:init|stage|unstage|commit|check|pull|push|switch}",
                local_git,
            ),
            web.post(
                "/ui/api/editor/github/{action:bind|authorize|cancel|repositories|select|logout}",
                github_post,
            ),
            web.post("/ui/api/strategies/{sid}/actions/{action}", strategy_action),
            web.get("/ui/api/strategies/{sid}/operations", strategy_operations),
            web.post("/ui/api/strategies/{sid}/operations/{operation_id}", strategy_operations),
            web.get("/ui/api/strategies/{sid}/metrics", strategy_metric),
            web.post("/ui/api/strategies/{sid}/{command}", command),
            web.get("/ui/", page),
            web.get("/ui/{path:.+}", page),
        ]
    )
