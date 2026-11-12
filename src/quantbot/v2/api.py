"""HTTP transport for the v2 control plane."""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.security import APIKeyCookie, HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles

from .auth import digest, password_matches
from .db import encode
from .errors import Problem
from .models import (
    Category,
    CommandRequest,
    CommandResult,
    ControlReport,
    Events,
    Heartbeat,
    Key,
    Login,
    Metrics,
    Reconciliation,
    SessionOpen,
    Snapshot,
    Stamp,
    StrategyCreate,
    StrategySettings,
    TokenSettings,
)
from .runtime import Runtime, exclusive_database

COOKIE = "quantbot_v2_session"
BODY_LIMIT = 1024 * 1024
bearer = HTTPBearer(auto_error=False, scheme_name="StrategyToken")
cookie = APIKeyCookie(name=COOKIE, auto_error=False, scheme_name="AdministratorSession")
agent = APIRouter(prefix="/api/v2/agent", tags=["Agent"])
admin = APIRouter(prefix="/api/v2/admin", tags=["Administration"])
log = logging.getLogger(__name__)


def runtime(request: Request) -> Runtime:
    return request.app.state.runtime


async def administrator(request: Request, session: Annotated[str | None, Depends(cookie)]):
    return runtime(request).auth.administrator(session)


def credentials(scope, *, executor=False, registration=False):
    async def dependency(
        request: Request,
        token: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
        session: Annotated[str | None, Header(alias="X-Agent-Session")] = None,
    ):
        service = runtime(request)
        credential = service.auth.authenticate(token.credentials if token else None, scope)
        service.limit("agent", credential.id, 240, 60)
        if registration:
            service.limit("session", credential.id, 30, 60)
            return credential
        return service.strategies.agent(credential, session, executor=executor)

    return Depends(dependency)


ADMIN = Depends(administrator)
REGISTER = credentials("session", registration=True)
SESSION = credentials("session")
TELEMETRY = credentials("telemetry")
CONTROL = credentials("control")
EXECUTOR_CONTROL = credentials("control", executor=True)
EXECUTOR_COMMANDS = credentials("commands", executor=True)


@agent.post("/session")
async def session(request: Request, body: SessionOpen, credential=REGISTER):
    """Register an instance and obtain its session ID."""
    return runtime(request).strategies.connect(credential, body)


@agent.put("/heartbeat")
async def heartbeat(
    request: Request,
    body: Heartbeat,
    source=SESSION,
):
    """Keep the session active and report runtime health."""
    service = runtime(request)
    return service.strategies.heartbeat(source, body)


@agent.put("/snapshot")
async def snapshot(request: Request, body: Snapshot, source=TELEMETRY):
    """Replace the instance snapshot, retaining time-series samples."""
    return runtime(request).telemetry.snapshot(source, body)


@agent.post("/events")
async def events(request: Request, body: Events, source=TELEMETRY):
    """Ingest events idempotently by strategy and event ID."""
    return runtime(request).telemetry.events(source, body)


@agent.post("/metrics")
async def metrics(request: Request, body: Metrics, source=TELEMETRY):
    """Ingest a batch of timestamped metric points, including historical backfill."""
    return runtime(request).telemetry.metrics(source, body)


@agent.get("/control")
async def control(request: Request, source=CONTROL):
    return runtime(request).strategies.control(source["strategy_id"])


@agent.put("/control/reported")
async def report_control(request: Request, body: ControlReport, source=EXECUTOR_CONTROL):
    return runtime(request).commands.report(source, body)


@agent.get("/commands")
async def commands(
    request: Request,
    token: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    session_id: Annotated[str | None, Header(alias="X-Agent-Session")] = None,
    wait: Annotated[float, Query(ge=0, le=25)] = 0,
    revision: Annotated[int | None, Query(ge=0)] = None,
):
    """Wait for queued work or a newer desired revision. A response is not an execution permit."""
    service = runtime(request)
    deadline = time.monotonic() + wait
    secret = token.credentials if token else None
    credential = service.auth.authenticate(secret, "commands")
    service.limit("agent", credential.id, 240, 60)
    source = service.strategies.agent(credential, session_id, executor=True)
    if session_id in service.polling:
        raise Problem(409, "A command poll is already in progress")
    service.polling.add(session_id)
    try:
        while True:
            credential = service.auth.authenticate(secret, "commands")
            source = service.strategies.agent(credential, session_id, executor=True)
            work = service.commands.poll(source)
            state = service.strategies.control(source["strategy_id"])
            remaining = deadline - time.monotonic()
            if (
                work
                or remaining <= 0
                or (revision is not None and revision != state["desired"]["revision"])
            ):
                return {"commands": work, "control": state}
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(service.change.wait(), min(remaining, 3))
            if await request.is_disconnected():
                return Response(status_code=204)
    finally:
        service.polling.discard(session_id)


@agent.post("/commands/{command_id}/claim")
async def claim(request: Request, command_id: Key, source=EXECUTOR_COMMANDS):
    """Consume the only opportunity to obtain a permit for this command."""
    return runtime(request).commands.claim(source, command_id)


@agent.post("/commands/{command_id}/result")
async def result(
    request: Request,
    command_id: Key,
    body: CommandResult,
    source=EXECUTOR_COMMANDS,
):
    """Report an execution outcome. Retrying the same receipt is idempotent."""
    return runtime(request).commands.finish(source, command_id, body)


def set_cookie(request, value):
    response = JSONResponse({"authenticated": True})
    response.set_cookie(
        COOKIE,
        value,
        httponly=True,
        samesite="strict",
        max_age=43200,
        secure=request.url.scheme == "https",
    )
    return response


@admin.post("/login")
async def login(request: Request, body: Login):
    service = runtime(request)
    service.limit("login", request.client.host, 8, 300)
    service.limit("login", "global", 32, 60)
    configured = service.db.one("SELECT value FROM settings WHERE name='administrator'")
    if configured is None:
        raise Problem(503, "Initialize an administrator on the server")
    account = json.loads(configured["value"])
    matched = await asyncio.to_thread(password_matches, body.password, account["password_hash"])
    if not matched or body.username != account["username"]:
        raise Problem(401, "Invalid administrator credentials")
    service.strategies.audit(f"web:{body.username}", "admin.login")
    return set_cookie(request, service.auth.session(f"web:{body.username}"))


@admin.post("/login/link")
async def link_login(request: Request, body: Annotated[dict[str, str], Body()]):
    service = runtime(request)
    service.limit("login", request.client.host, 8, 300)
    secret = body.get("ticket")
    if not secret or len(secret) != 43 or set(body) != {"ticket"}:
        raise Problem(401, "Invalid or expired login link")
    return set_cookie(request, service.auth.consume_link(secret))


@admin.get("/session")
async def admin_session(actor=ADMIN):
    return {"actor": actor}


@admin.post("/logout")
async def logout(request: Request, actor=ADMIN):
    runtime(request).db.execute(
        "DELETE FROM admin_sessions WHERE digest=?", (digest(request.cookies[COOKIE]),)
    )
    response = Response(status_code=204)
    response.delete_cookie(COOKIE)
    return response


@admin.get("/strategies")
async def list_strategies(request: Request, actor=ADMIN):
    return runtime(request).strategies.list()


@admin.post("/strategies", status_code=201)
async def create_strategy(request: Request, body: StrategyCreate, actor=ADMIN):
    return runtime(request).strategies.create(body, actor)


@admin.get("/strategies/{strategy_id}")
async def strategy(request: Request, strategy_id: Key, instance: Key | None = None, actor=ADMIN):
    return runtime(request).strategies.detail(strategy_id, instance)


@admin.put("/strategies/{strategy_id}")
async def update_strategy(request: Request, strategy_id: Key, body: StrategySettings, actor=ADMIN):
    return runtime(request).strategies.update(strategy_id, body, actor)


@admin.get("/strategies/{strategy_id}/tokens")
async def tokens(request: Request, strategy_id: Key, actor=ADMIN):
    return runtime(request).strategies.tokens(strategy_id)


@admin.post("/strategies/{strategy_id}/tokens", status_code=201)
async def new_token(request: Request, strategy_id: Key, body: TokenSettings, actor=ADMIN):
    return runtime(request).strategies.change_token(strategy_id, actor, body)


@admin.post("/strategies/{strategy_id}/tokens/{token_id}/rotate", status_code=201)
async def rotate_token(
    request: Request, strategy_id: Key, token_id: Key, body: TokenSettings, actor=ADMIN
):
    return runtime(request).strategies.change_token(strategy_id, actor, body, revoke=token_id)


@admin.delete("/strategies/{strategy_id}/tokens/{token_id}", status_code=204)
async def revoke_token(request: Request, strategy_id: Key, token_id: Key, actor=ADMIN):
    runtime(request).strategies.change_token(strategy_id, actor, revoke=token_id)
    return Response(status_code=204)


def bounds(start, end):
    if start and end and start > end:
        raise Problem(422, "Start must precede end")
    return start.timestamp() if start else None, end.timestamp() if end else None


@admin.get("/strategies/{strategy_id}/metrics")
async def metric_history(
    request: Request,
    strategy_id: Key,
    name: Key | None = None,
    instance: Key | None = None,
    start: Stamp | None = None,
    end: Stamp | None = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 1000,
    actor=ADMIN,
):
    return runtime(request).telemetry.history(
        strategy_id, name, instance, *bounds(start, end), limit
    )


@admin.get("/events")
async def event_history(
    request: Request,
    strategy_id: Key | None = None,
    category: Category | None = None,
    start: Stamp | None = None,
    end: Stamp | None = None,
    before: Stamp | None = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    actor=ADMIN,
):
    return runtime(request).telemetry.event_rows(
        strategy_id,
        category,
        limit,
        *bounds(start, end),
        before.timestamp() if before else None,
    )


@admin.get("/alerts")
async def alerts(
    request: Request,
    strategy_id: Key | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    actor=ADMIN,
):
    return runtime(request).strategies.alert_rows(strategy_id, limit)


@admin.get("/commands")
async def list_commands(
    request: Request,
    strategy_id: Key | None = None,
    before: Key | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    actor=ADMIN,
):
    service = runtime(request).commands
    service.sweep()
    return service.list(strategy_id, limit, before)


@admin.get("/commands/{command_id}")
async def command_detail(request: Request, command_id: Key, actor=ADMIN):
    service = runtime(request).commands
    service.sweep()
    return service.public(service.row(command_id))


@admin.post("/strategies/{strategy_id}/commands", status_code=201)
async def create_command(request: Request, strategy_id: Key, body: CommandRequest, actor=ADMIN):
    service = runtime(request)
    service.limit("operations", actor, 30, 60)
    return service.commands.create(strategy_id, body, actor)


@admin.post("/commands/{command_id}/confirm")
async def confirm(request: Request, command_id: Key, actor=ADMIN):
    service = runtime(request)
    service.limit("operations", actor, 30, 60)
    return service.commands.confirm(command_id, actor)


@admin.post("/commands/{command_id}/reconcile")
async def reconcile(request: Request, command_id: Key, body: Reconciliation, actor=ADMIN):
    return runtime(request).commands.reconcile(command_id, body, actor)


@admin.get("/audit")
async def audit(
    request: Request,
    strategy_id: Key | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    actor=ADMIN,
):
    from .db import record

    rows = runtime(request).db.all(
        """SELECT * FROM audit_log WHERE (? IS NULL OR strategy_id=?)
           ORDER BY id DESC LIMIT ?""",
        (strategy_id, strategy_id, limit),
    )
    return [record(row, documents=("detail",), times=("created_at",)) for row in rows]


class Transport:
    def __init__(self, app, public_url):
        self.app = app
        self.origin = public_url

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        path = request.url.path
        peer = request.client.host if request.client else ""
        host = request.url.netloc
        origin = f"{request.url.scheme}://{host}"
        error = None
        if request.url.scheme != "https" and (
            peer not in {"127.0.0.1", "::1"}
            or request.url.hostname not in {"127.0.0.1", "::1", "localhost"}
        ):
            error = (426, "HTTPS is required for remote connections")
        elif self.origin and request.url.scheme == "https" and host != urlsplit(self.origin).netloc:
            error = (421, "Request host does not match the configured public URL")
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and path.startswith("/api/v2/admin"):
            if request.headers.get("origin") not in {None, origin}:
                error = (403, "Cross-origin administrator request rejected")
            elif request.headers.get("sec-fetch-site") == "cross-site":
                error = (403, "Cross-site administrator request rejected")
        if error:
            await JSONResponse({"detail": error[1]}, status_code=error[0])(scope, receive, send)
            return

        async def protected_send(message):
            if message["type"] == "http.response.start":
                headers = message["headers"]
                headers.extend(
                    [
                        (b"x-content-type-options", b"nosniff"),
                        (b"x-frame-options", b"DENY"),
                        (b"referrer-policy", b"no-referrer"),
                    ]
                )
                if path.startswith("/api/") or path in {"/", "/ui", "/ui/"}:
                    headers.append((b"cache-control", b"no-store"))
                if request.url.scheme == "https":
                    headers.append((b"strict-transport-security", b"max-age=31536000"))
                if path not in {"/docs", "/redoc"}:
                    headers.append(
                        (
                            b"content-security-policy",
                            b"default-src 'self'; "
                            b"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                            b"object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
                        )
                    )
            await send(message)

        if request.method in {"POST", "PUT", "PATCH"}:
            chunks = bytearray()
            while True:
                item = await receive()
                if item["type"] == "http.disconnect":
                    return
                chunks.extend(item.get("body", b""))
                if len(chunks) > BODY_LIMIT:
                    await JSONResponse({"detail": "Request body is too large"}, status_code=413)(
                        scope, receive, protected_send
                    )
                    return
                if not item.get("more_body"):
                    break
            if chunks:
                content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type != "application/json":
                    await JSONResponse({"detail": "Use application/json"}, status_code=415)(
                        scope, receive, protected_send
                    )
                    return
                try:
                    canonical = encode(json.loads(chunks))
                except (ValueError, RecursionError):
                    await JSONResponse({"detail": "Invalid JSON"}, status_code=400)(
                        scope, receive, protected_send
                    )
                    return
                chunks = canonical.encode()
            original_receive = receive
            delivered = False

            async def replay():
                nonlocal delivered
                if delivered:
                    return await original_receive()
                delivered = True
                return {"type": "http.request", "body": bytes(chunks), "more_body": False}

            receive = replay
        await self.app(scope, receive, protected_send)


def make_app(path: Path, *, public_url=None, bootstrap=None, clock=time.time, configure=None):
    @asynccontextmanager
    async def lifespan(app):
        with exclusive_database(path):
            service = Runtime(path, clock)
            app.state.runtime = service
            app.state.public_url = public_url
            worker = None
            try:
                if bootstrap:
                    bootstrap(service)
                service.commands.sweep(restart=True)
                worker = asyncio.create_task(service.upkeep())
                yield
            finally:
                if worker:
                    worker.cancel()
                    with suppress(asyncio.CancelledError):
                        await worker
                service.db.close()

    app = FastAPI(title="QuantBot API", version="2.0.0", lifespan=lifespan)
    app.add_middleware(Transport, public_url=public_url)
    app.include_router(agent)
    app.include_router(admin)

    @app.exception_handler(Problem)
    async def problem(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation(request, exc):
        return JSONResponse(
            {
                "detail": "Request does not match the API schema",
                "errors": [{"location": err["loc"], "type": err["type"]} for err in exc.errors()],
            },
            status_code=422,
        )

    @app.get("/healthz", include_in_schema=False)
    async def health():
        return {"status": "ok"}

    @app.get("/api/v2/stream", tags=["Administration"])
    async def stream(request: Request, actor=ADMIN):
        async def updates():
            service = runtime(request)
            while not await request.is_disconnected():
                try:
                    service.auth.administrator(request.cookies.get(COOKIE))
                except Problem:
                    return
                changed = service.change
                yield f"event: update\ndata: {service.version}\n\n"
                try:
                    await asyncio.wait_for(changed.wait(), 15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"

        return StreamingResponse(
            updates(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    if configure:
        configure(app)
    static = Path(__file__).resolve().parents[1] / "web"
    if static.is_dir():
        app.mount("/ui", StaticFiles(directory=static, html=True), name="console")

    @app.get("/", include_in_schema=False)
    async def index():
        return RedirectResponse("/ui/")

    @app.get("/favicon.svg", include_in_schema=False)
    async def favicon():
        return FileResponse(static / "favicon.svg")

    return app
