"""Bounded, process-local sandboxes for exercising the real Agent API."""

import asyncio
import hmac
import math
import secrets
import sqlite3
import threading
from collections import deque
from dataclasses import dataclass, field

from starlette.requests import Request
from starlette.responses import JSONResponse

from .auth import digest
from .control_models import ControlInvocation
from .db import encode, timestamp
from .errors import Problem
from .models import CommandRequest, StrategyCreate
from .runtime import Runtime

PREFIX = "/api/sandbox/agent"
TTL = 3600
MAX_SESSIONS = 8
MAX_HISTORY = 32
MAX_IN_FLIGHT = 6
KEY_IN_FLIGHT = 2
BODY_LIMIT = 64 * 1024
KEY_RATE = 120
GLOBAL_RATE = 600
DB_PAGES = 1024
SCOPES = ["session", "telemetry", "control", "commands"]
STEPS = {"session", "heartbeat", "telemetry", "controls", "control_sync", "command"}


@dataclass
class SandboxSession:
    strategy_id: str
    key: str
    secret: str
    expires: float
    runtime: Runtime | None
    closed: bool = False
    in_flight: int = 0
    requests: deque = field(default_factory=lambda: deque(maxlen=40))
    steps: set = field(default_factory=set)
    seeded: set = field(default_factory=set)
    diagnostics: dict = field(default_factory=dict)


class ClosedAuth:
    def authenticate(self, secret, scope):
        raise Problem(401, "Sandbox Key is closed")


class Sandboxes:
    def __init__(self, clock):
        self.clock = clock
        self.sessions = {}
        self.keys = {}
        self.limits = {}
        self.in_flight = 0
        self.loop = asyncio.new_event_loop()
        self.worker = threading.Thread(target=self.loop.run_forever, name="quantbot-sandbox")
        self.worker.start()

    async def call(self, coroutine):
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coroutine, self.loop))

    async def shutdown(self):
        await self.call(self.clean(close_all=True))
        self.loop.call_soon_threadsafe(self.loop.stop)
        await asyncio.to_thread(self.worker.join)
        self.loop.close()

    def limit(self, key, count):
        now = self.loop.time()
        queue = self.limits.setdefault(key, deque())
        while queue and queue[0] <= now - 60:
            queue.popleft()
        if len(queue) >= count:
            raise Problem(
                429,
                "Sandbox request rate exceeded",
                retry_after=max(1, math.ceil(queue[0] + 60 - now)),
            )
        queue.append(now)

    def deactivate(self, session):
        self.keys.pop(digest(session.secret), None)
        self.limits.pop(session.key, None)
        session.secret = ""
        if session.runtime and not session.in_flight:
            session.diagnostics = self.diagnostics(session)
            session.runtime.db.close()
            session.runtime = None

    async def clean(self, close_all=False):
        now = self.clock()
        for sid, session in list(self.sessions.items()):
            if close_all or session.closed or session.expires <= now:
                self.deactivate(session)
                if not session.runtime and (close_all or session.expires + TTL <= now):
                    self.sessions.pop(sid)

    def new(self, sid):
        if len(self.keys) >= MAX_SESSIONS:
            raise Problem(429, "All sandbox session slots are in use", retry_after=60)
        if len(self.sessions) >= MAX_HISTORY and sid not in self.sessions:
            oldest = next((key for key, item in self.sessions.items() if not item.runtime), None)
            if oldest is None:
                raise Problem(429, "Sandbox session limit reached", retry_after=60)
            self.sessions.pop(oldest)
        service = Runtime(None, self.clock)
        try:
            service.db.execute(f"PRAGMA max_page_count={DB_PAGES}")
            now = self.clock()
            session = SandboxSession(
                sid, secrets.token_hex(12), "qbs_" + secrets.token_urlsafe(32), now + TTL, service
            )
            strategy = StrategyCreate(name="QuantBot Sandbox", mode="paper")
            with service.db.transaction():
                service.db.execute(
                    "INSERT INTO strategies(id, settings, created_at) VALUES (?, ?, ?)",
                    (sid, encode(strategy.model_dump(mode="json", exclude={"token"})), now),
                )
                service.db.execute("INSERT INTO desired_state VALUES (?, 0, '{}', ?)", (sid, now))
                service.db.execute(
                    "INSERT INTO strategy_tokens VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
                    (
                        session.key,
                        sid,
                        digest(session.secret),
                        encode(SCOPES),
                        now,
                        session.expires,
                    ),
                )
        except BaseException:
            service.db.close()
            raise
        self.sessions[sid] = session
        self.keys[digest(session.secret)] = session
        return session

    @staticmethod
    def diagnostics(session):
        service = session.runtime
        sid = session.strategy_id
        registry = service.controls.public(sid)
        commands = service.commands.list(sid, 10)
        return {
            "registry_revision": registry["revision"],
            "controls": [
                {"id": item["id"], "label": item["label"], "type": item["type"]}
                for item in registry["controls"]
            ],
            "control": service.strategies.control(sid),
            "commands": [
                {"id": item["id"], "action": item["action"], "state": item["state"]}
                for item in commands
            ],
        }

    async def manage(self, sid, action, expected=None):
        try:
            return await self._manage(sid, action, expected)
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode == sqlite3.SQLITE_FULL:
                raise Problem(507, "Sandbox storage limit reached") from None
            raise

    async def _manage(self, sid, action, expected):
        await self.clean()
        session = self.sessions.get(sid)
        if action == "copy":
            if session and session.runtime and (session.closed or session.expires <= self.clock()):
                raise Problem(409, "The previous sandbox still has a request in progress")
            if not session or not session.runtime:
                session = self.new(sid)
        if not session:
            if action == "status":
                return None
            raise Problem(404, "Sandbox session not found")
        if expected and not hmac.compare_digest(expected, session.key):
            raise Problem(409, "The sandbox session has changed")
        if action == "close":
            session.closed = True
            if session.runtime:
                session.runtime.auth = ClosedAuth()
                session.runtime.wake()
            self.deactivate(session)
        elif action == "renew":
            if not session.secret:
                raise Problem(409, "Create a new sandbox after expiry or closure")
            session.expires = self.clock() + TTL
            session.runtime.db.execute(
                "UPDATE strategy_tokens SET expires_at=?", (session.expires,)
            )
        elif action in {"pause_entry", "resume_entry", "refresh"}:
            if not session.secret:
                raise Problem(409, "Sandbox is inactive")
            self.simulate(session, action, secrets.token_hex(16))
        status = "closed" if session.closed else "active" if session.secret else "expired"
        return {
            "strategy_id": sid,
            "key": session.key,
            "expires_at": timestamp(session.expires),
            "status": status,
            "passed": STEPS <= session.steps,
            "steps": sorted(session.steps),
            "requests": list(reversed(session.requests)),
            **(self.diagnostics(session) if session.runtime else session.diagnostics),
            **({"secret": session.secret} if action == "copy" else {}),
        }

    @staticmethod
    def simulate(session, action, request_id):
        service = session.runtime
        sid = session.strategy_id
        registry = service.controls.public(sid)
        binding = next(
            (
                item
                for item in registry["controls"]
                if item.get("command") == action
                and item["type"] == "button"
                or item.get("command") == "set_trading_enabled"
                and action.endswith("_entry")
            ),
            None,
        )
        if binding:
            value = action == "resume_entry" if binding["type"] == "toggle" else None
            command = service.commands.create_control(
                sid,
                binding["id"],
                ControlInvocation(
                    revision=registry["revision"], request_id=request_id, value=value
                ),
                "sandbox",
            )
        else:
            command = service.commands.create(
                sid, CommandRequest(action=action, request_id=request_id), "sandbox"
            )
        if command["state"] == "confirmation_required":
            service.commands.confirm(command["id"], "sandbox")

    def observe(self, session, scope, path, status, request_id):
        session.requests.append(
            {
                "at": timestamp(self.clock()),
                "method": scope["method"],
                "path": path[:180],
                "status": status,
                "request_id": request_id,
                "errors": scope["state"].get("sandbox_validation", []),
            }
        )
        if status != 200 or session.closed or session.expires <= self.clock():
            return
        service = session.runtime
        sid = session.strategy_id
        steps = {"/session": "session", "/heartbeat": "heartbeat", "/controls": "controls"}
        if path in steps:
            if path != "/controls" or service.controls.public(sid)["controls"]:
                session.steps.add(steps[path])
        if path == "/control/reported":
            control = service.strategies.control(sid)
            if control["in_sync"] and control["desired"]["revision"] > 0:
                session.steps.add("control_sync")
        if path in {"/reports", "/snapshot", "/metrics", "/events"} or path.startswith("/monitor/"):
            session.steps.add("telemetry")
        if path.endswith("/result"):
            cid = path.split("/")[2]
            if service.commands.row(cid)["state"] == "succeeded":
                session.steps.add("command")

        # Start the sample operations once each, when their capability becomes available.
        if path in {"/session", "/commands", "/control", "/controls"}:
            caps = service.controls.capabilities(sid, live=True)
            for action in ("pause_entry", "refresh"):
                if action in session.seeded or action not in caps:
                    continue
                if action == "refresh" and not service.controls.row(sid):
                    continue
                try:
                    self.simulate(session, action, f"auto-{action}")
                except Problem:
                    continue
                except sqlite3.OperationalError as exc:
                    if exc.sqlite_errorcode != sqlite3.SQLITE_FULL:
                        raise
                    continue
                session.seeded.add(action)

    async def dispatch(self, app, scope, receive, send, secret, path, request_id):
        session = None
        admitted = False
        status = 500
        try:
            self.limit("global", GLOBAL_RATE)
            session = self.keys.get(digest(secret)) if secret else None
            if not session or session.expires <= self.clock() or session.closed:
                raise Problem(401, "Sandbox Key is invalid, expired or closed")
            self.limit(session.key, KEY_RATE)
            if session.in_flight >= KEY_IN_FLIGHT:
                raise Problem(
                    429, "Too many concurrent requests for this Sandbox Key", retry_after=1
                )
            session.in_flight += 1
            admitted = True
            scope["state"] = {**scope.get("state", {}), "sandbox_runtime": session.runtime}

            async def capture(message):
                nonlocal status
                if message["type"] == "http.response.start":
                    status = message["status"]
                await send(message)

            await app(scope, receive, capture)
        except Problem as exc:
            status = exc.status
            headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
            await JSONResponse({"detail": str(exc)}, status, headers=headers)(scope, receive, send)
        finally:
            if admitted:
                try:
                    self.observe(session, scope, path, status, request_id)
                finally:
                    session.in_flight -= 1
                    if session.closed or session.expires <= self.clock():
                        self.deactivate(session)

    async def route(self, app, scope, receive, send):
        request = Request(scope)
        path = scope["path"].removeprefix(PREFIX)
        if path == scope["path"] or not path.startswith("/"):
            await JSONResponse({"detail": "Not found"}, 404)(scope, receive, send)
            return
        if self.in_flight >= MAX_IN_FLIGHT:
            await JSONResponse({"detail": "Sandbox is busy"}, 429, headers={"Retry-After": "1"})(
                scope, receive, send
            )
            return
        scheme, _, secret = request.headers.get("authorization", "").partition(" ")
        secret = (
            secret
            if scheme.lower() == "bearer" and secret.startswith("qbs_") and len(secret) == 47
            else ""
        )
        self.in_flight += 1
        main = asyncio.get_running_loop()

        async def bridge_receive():
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(receive(), main))

        async def bridge_send(message):
            await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(send(message), main))

        try:
            await self.call(
                self.dispatch(
                    app,
                    scope,
                    bridge_receive,
                    bridge_send,
                    secret,
                    path,
                    scope["state"]["request_id"],
                )
            )
        finally:
            self.in_flight -= 1


class SandboxRoutes:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        pool = scope["app"].state.sandboxes
        await pool.route(self.app, scope, receive, send)


async def storage_full(request: Request, exc: sqlite3.OperationalError):
    if exc.sqlite_errorcode == sqlite3.SQLITE_FULL:
        return JSONResponse({"detail": "Sandbox storage limit reached"}, 507)
    raise exc
