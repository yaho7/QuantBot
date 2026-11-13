"""HTTP transport for the control plane."""

import asyncio
import json
import logging
import sqlite3
import time
from contextlib import asynccontextmanager, suppress
from ipaddress import IPv4Address, ip_address
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import uuid4

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

from quantbot import __version__

from .auth import digest, password_hash, password_matches
from .control_models import ControlID, ControlInvocation, ControlRegistry, ControlValues
from .dashboard_models import Component, Dashboard, HistoryQuery
from .errors import Problem
from .management import register as register_management
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
    Name,
    Reconciliation,
    SessionOpen,
    SetupAdmin,
    Snapshot,
    Stamp,
    StrategyCreate,
    StrategySettings,
    TokenPermissions,
    TokenSettings,
)
from .registry import Registry
from .report_models import DATA_TYPES, MetricDefinitions, ReportBatch
from .responses import (
    AgentSession,
    AuditView,
    CommandQueue,
    CommandState,
    CommandView,
    ControlCatalog,
    ControlView,
    CredentialIssued,
    CredentialView,
    Error,
    EventAck,
    HeartbeatAck,
    MetricDefinitionsAck,
    MetricsAck,
    Permit,
    ReportsAck,
    SnapshotAck,
    StrategyCreated,
    StrategyDetail,
    StrategyView,
)
from .runtime import Runtime, exclusive_database
from .sandbox import BODY_LIMIT as SANDBOX_BODY_LIMIT
from .sandbox import PREFIX as SANDBOX_PREFIX
from .sandbox import Sandboxes, SandboxRoutes, storage_full
from .schemas import schema_document
from .telegram_service import supervise
from .telegram_settings import TelegramConfig, TelegramUpdate

COOKIE = "quantbot_session"
BODY_LIMIT = 1024 * 1024
bearer = HTTPBearer(auto_error=False, scheme_name="StrategyToken")
cookie = APIKeyCookie(name=COOKIE, auto_error=False, scheme_name="AdministratorSession")
COMMON_ERRORS = {
    401: {"model": Error, "description": "Credential missing, invalid, revoked or expired"},
    403: {"model": Error, "description": "Insufficient permission"},
    409: {"model": Error, "description": "Session, revision, idempotency or state conflict"},
    422: {"model": Error, "description": "Invalid schema or parameters"},
}
agent = APIRouter(tags=["Agent"], responses=COMMON_ERRORS)
admin = APIRouter(prefix="/api/admin", tags=["Administration"], responses=COMMON_ERRORS)
log = logging.getLogger(__name__)


def runtime(request: Request) -> Runtime:
    if hasattr(request.state, "sandbox_runtime"):
        return request.state.sandbox_runtime
    return request.app.state.runtime


async def administrator(request: Request, session: Annotated[str | None, Depends(cookie)]):
    return runtime(request).auth.administrator(session)


def credentials(scope, *, executor=False, registration=False, stateless=False):
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
        source = (
            credential
            if stateless
            else service.strategies.agent(credential, session, executor=executor)
        )
        if scope == "telemetry":
            request.state.telemetry_source = credential.strategy_id
        return source

    return Depends(dependency)


ADMIN = Depends(administrator)
REGISTER = credentials("session", registration=True)
SESSION = credentials("session")
TELEMETRY = credentials("telemetry")
MONITOR = credentials("telemetry", stateless=True)
CONTROL = credentials("control")
EXECUTOR_CONTROL = credentials("control", executor=True)
EXECUTOR_COMMANDS = credentials("commands", executor=True)


@agent.post("/session", response_model=AgentSession, response_model_exclude_unset=True)
async def session(request: Request, body: SessionOpen, credential=REGISTER):
    """Register an instance and obtain its session ID."""
    if body.instance_id.startswith("monitor:"):
        raise Problem(422, "Instance IDs starting with monitor: are reserved for basic monitoring")
    return runtime(request).strategies.connect(credential, body)


@agent.put("/heartbeat", response_model=HeartbeatAck, response_model_exclude_unset=True)
async def heartbeat(
    request: Request,
    body: Heartbeat,
    source=SESSION,
):
    """Keep the session active and report runtime health."""
    service = runtime(request)
    return service.strategies.heartbeat(source, body)


@agent.put("/snapshot", response_model=SnapshotAck)
async def snapshot(request: Request, body: Snapshot, source=TELEMETRY):
    """Replace the instance snapshot, retaining time-series samples."""
    return runtime(request).telemetry.snapshot(source, body)


@agent.post("/events", response_model=EventAck)
async def events(request: Request, body: Events, source=TELEMETRY):
    """Ingest events idempotently by strategy and event ID."""
    return runtime(request).telemetry.events(source, body)


@agent.post("/metrics", response_model=MetricsAck)
async def metrics(request: Request, body: Metrics, source=TELEMETRY):
    """Ingest a batch of timestamped metric points, including historical backfill."""
    return runtime(request).telemetry.metrics(source, body)


@agent.post("/reports", response_model=ReportsAck)
async def reports(request: Request, body: ReportBatch, source=TELEMETRY):
    """Ingest a batch of validated, explicitly typed records."""
    return runtime(request).registry.reports(source, body)


@agent.post("/monitor/{instance_id}", response_model=ReportsAck)
async def monitor(request: Request, instance_id: Key, body: ReportBatch, credential=MONITOR):
    """Report telemetry and refresh presence with a Bearer Token, without a session header."""
    if len(instance_id) > 56:
        raise Problem(422, "Monitoring instance ID must have at most 56 characters")
    service = runtime(request)
    source = service.strategies.monitor(credential, f"monitor:{instance_id}")
    counts = service.registry.reports(source, body)
    service.strategies.heartbeat(source)
    return counts


@agent.put("/metric-definitions", response_model=MetricDefinitionsAck)
async def define_metrics(request: Request, body: MetricDefinitions, source=TELEMETRY):
    """Register metric metadata. Charts become available after points are received."""
    return runtime(request).registry.register_metrics(source, body)


@agent.put("/controls", response_model=ControlCatalog, response_model_exclude_unset=True)
async def publish_controls(request: Request, body: ControlRegistry, source=EXECUTOR_CONTROL):
    """Publish a complete control registry. Use a higher revision to update or remove controls."""
    return runtime(request).controls.publish(source, body)


@agent.put("/controls/state", response_model=ControlCatalog, response_model_exclude_unset=True)
async def publish_values(request: Request, body: ControlValues, source=EXECUTOR_CONTROL):
    """Report actual values and disabled states for the currently registered revision."""
    return runtime(request).controls.actual(source, body)


@agent.get("/control", response_model=ControlView, response_model_exclude_unset=True)
async def control(request: Request, source=CONTROL):
    return runtime(request).strategies.control(source["strategy_id"])


@agent.put("/control/reported", response_model=ControlView, response_model_exclude_unset=True)
async def report_control(request: Request, body: ControlReport, source=EXECUTOR_CONTROL):
    return runtime(request).commands.report(source, body)


@agent.get("/commands", response_model=CommandQueue, response_model_exclude_unset=True)
async def commands(
    request: Request,
    token: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    session_id: Annotated[str | None, Header(alias="X-Agent-Session")] = None,
    wait: Annotated[float, Query(ge=0, le=25)] = 0,
    revision: Annotated[int | None, Query(ge=0)] = None,
):
    """Wait for queued work or a newer desired revision. A response is not an execution permit."""
    service = runtime(request)
    deadline = time.monotonic() + (
        min(wait, 3) if getattr(request.state, "sandbox_runtime", None) else wait
    )
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


@agent.post("/commands/{command_id}/claim", response_model=Permit)
async def claim(request: Request, command_id: Key, source=EXECUTOR_COMMANDS):
    """Consume the only opportunity to obtain a permit for this command."""
    return runtime(request).commands.claim(source, command_id)


@agent.post("/commands/{command_id}/result", response_model=CommandView)
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


def setup_allowed(request: Request) -> bool:
    return request.state.local_access or request.url.scheme == "https"


@admin.get("/setup")
async def setup_status(request: Request) -> dict[str, bool]:
    required = not runtime(request).auth.has_administrator()
    return {"required": required, "available": required and setup_allowed(request)}


@admin.post("/setup", status_code=201)
async def setup_admin(request: Request, body: SetupAdmin):
    if not setup_allowed(request):
        raise Problem(403, "Use HTTPS or localhost to set up the administrator")
    origin = f"{request.url.scheme}://{request.url.netloc}"
    if request.headers.get("origin") != origin:
        raise Problem(403, "Setup requires a same-origin browser request")
    service = runtime(request)
    if service.auth.has_administrator():
        raise Problem(409, "An administrator is already configured")
    service.limit("setup", "global", 8, 60)
    hashed_password = await asyncio.to_thread(password_hash, body.password)
    actor = f"web:{body.username}"
    with service.db.transaction():
        if not service.auth.create_administrator(body.username, hashed_password):
            raise Problem(409, "An administrator is already configured")
        service.strategies.audit(actor, "admin.configure")
        session = service.auth.session(actor)
    response = set_cookie(request, session)
    response.status_code = 201
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
    latest = service.db.one("SELECT value FROM settings WHERE name='administrator'")
    if not matched or body.username != account["username"] or latest != configured:
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


@admin.get("/strategies", response_model=list[StrategyView])
async def list_strategies(request: Request, actor=ADMIN):
    return runtime(request).strategies.list()


@admin.post(
    "/strategies",
    status_code=201,
    response_model=StrategyCreated,
    response_model_exclude_unset=True,
)
async def create_strategy(request: Request, body: StrategyCreate, actor=ADMIN):
    return runtime(request).strategies.create(body, actor)


@admin.get(
    "/strategies/{strategy_id}", response_model=StrategyDetail, response_model_exclude_unset=True
)
async def strategy(request: Request, strategy_id: Key, instance: Key | None = None, actor=ADMIN):
    return runtime(request).strategies.detail(strategy_id, instance)


@admin.put(
    "/strategies/{strategy_id}", response_model=StrategyDetail, response_model_exclude_unset=True
)
async def update_strategy(request: Request, strategy_id: Key, body: StrategySettings, actor=ADMIN):
    return runtime(request).strategies.update(strategy_id, body, actor)


@admin.get("/strategies/{strategy_id}/tokens", response_model=list[CredentialView])
async def tokens(request: Request, strategy_id: Key, actor=ADMIN):
    return runtime(request).strategies.tokens(strategy_id)


@admin.post("/strategies/{strategy_id}/tokens", status_code=201, response_model=CredentialIssued)
async def new_token(request: Request, strategy_id: Key, body: TokenSettings, actor=ADMIN):
    return runtime(request).strategies.change_token(strategy_id, actor, body)


@admin.put("/strategies/{strategy_id}/tokens/{token_id}/permissions", response_model=CredentialView)
async def update_token_permissions(
    request: Request, strategy_id: Key, token_id: Key, body: TokenPermissions, actor=ADMIN
):
    """Change an active credential's scopes without replacing its Secret."""
    return runtime(request).strategies.update_token_permissions(strategy_id, actor, token_id, body)


@admin.post(
    "/strategies/{strategy_id}/tokens/{token_id}/rotate",
    status_code=201,
    response_model=CredentialIssued,
)
async def rotate_token(
    request: Request, strategy_id: Key, token_id: Key, body: TokenSettings, actor=ADMIN
):
    return runtime(request).strategies.rotate_token(strategy_id, actor, token_id, body)


@admin.post(
    "/strategies/{strategy_id}/tokens/{token_id}/regenerate",
    status_code=201,
    response_model=CredentialIssued,
)
async def regenerate_token(request: Request, strategy_id: Key, token_id: Key, actor=ADMIN):
    """Keep permissions and expiry, issue a replacement, and immediately revoke the old Token."""
    return runtime(request).strategies.regenerate_token(strategy_id, actor, token_id)


@admin.delete("/strategies/{strategy_id}/tokens/{token_id}", status_code=204)
async def revoke_token(request: Request, strategy_id: Key, token_id: Key, actor=ADMIN):
    runtime(request).strategies.change_token(strategy_id, actor, revoke=token_id)
    return Response(status_code=204)


@admin.post("/strategies/{strategy_id}/tokens/{token_id}/reveal", response_model=CredentialIssued)
async def reveal_token(request: Request, strategy_id: Key, token_id: Key, actor=ADMIN):
    """Reveal an active access key to an authenticated administrator and record the access."""
    service = runtime(request)
    service.limit("token-reveal", actor, 20, 60)
    service.strategies.active(strategy_id)
    secret = service.auth.reveal(strategy_id, token_id)
    service.strategies.audit(actor, "token.reveal", strategy_id, token_id=token_id)
    return {"token": secret, **service.auth.token_metadata(strategy_id, token_id)}


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


@admin.get("/strategies/{strategy_id}/components")
async def components(request: Request, strategy_id: Key, actor=ADMIN):
    """Discover compatible charts from observed standard records."""
    return runtime(request).registry.discover(strategy_id)


@admin.get("/strategies/{strategy_id}/dashboard")
async def dashboard(request: Request, strategy_id: Key, actor=ADMIN):
    return runtime(request).registry.dashboard(strategy_id)


@admin.put("/strategies/{strategy_id}/dashboard")
async def save_dashboard(request: Request, strategy_id: Key, body: Dashboard, actor=ADMIN):
    return runtime(request).registry.save_dashboard(strategy_id, body, actor)


@admin.post("/history/metrics")
async def compare_metrics(request: Request, body: HistoryQuery, actor=ADMIN):
    """Compare exact series across strategies with optional UTC bucket aggregation."""
    return runtime(request).registry.history(body)


@admin.get("/strategies/{strategy_id}/market")
async def market(
    request: Request,
    strategy_id: Key,
    instance: Key,
    symbol: Name,
    interval_seconds: Annotated[int, Query(ge=1, le=2678400)],
    start: Stamp,
    end: Stamp,
    limit: Annotated[int, Query(ge=1, le=3000)] = 1000,
    actor=ADMIN,
):
    """Query reported OHLCV and order, fill, signal, and risk markers."""
    return runtime(request).registry.market(
        strategy_id,
        instance,
        symbol,
        interval_seconds,
        *bounds(start, end),
        limit,
    )


@admin.get("/strategies/{strategy_id}/components/{component}")
async def component_data(
    request: Request,
    strategy_id: Key,
    component: Component,
    start: Stamp,
    end: Stamp,
    limit: Annotated[int, Query(ge=1, le=1000)] = 250,
    bucket_seconds: Annotated[int, Query(ge=60, le=604800)] = 3600,
    actor=ADMIN,
):
    """Retrieve normalized current data or the selected component's historical records."""
    return runtime(request).registry.component_data(
        strategy_id,
        component,
        *bounds(start, end),
        limit,
        bucket_seconds,
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


@admin.get("/commands", response_model=list[CommandView])
async def list_commands(
    request: Request,
    strategy_id: Key | None = None,
    before: Key | None = None,
    state: CommandState | None = None,
    unknown_first: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    actor=ADMIN,
):
    service = runtime(request).commands
    service.sweep()
    return service.list(strategy_id, limit, before, state=state, unknown_first=unknown_first)


@admin.get("/commands/{command_id}", response_model=CommandView)
async def command_detail(request: Request, command_id: Key, actor=ADMIN):
    service = runtime(request).commands
    service.sweep()
    return service.public(service.row(command_id))


@admin.get(
    "/strategies/{strategy_id}/controls",
    response_model=ControlCatalog,
    response_model_exclude_unset=True,
)
async def read_controls(request: Request, strategy_id: Key, actor=ADMIN):
    """Read the registered components and last agent-reported state."""
    return runtime(request).controls.public(strategy_id)


@admin.post(
    "/strategies/{strategy_id}/controls/{control_id}/invoke",
    status_code=201,
    response_model=CommandView,
)
async def invoke_control(
    request: Request,
    strategy_id: Key,
    control_id: ControlID,
    body: ControlInvocation,
    actor=ADMIN,
):
    """Create a command through the validated control binding and registry revision."""
    service = runtime(request)
    service.limit("operations", actor, 30, 60)
    return service.commands.create_control(strategy_id, control_id, body, actor)


@admin.post("/commands/{command_id}/cancel", response_model=CommandView)
async def cancel_command(request: Request, command_id: Key, actor=ADMIN):
    return runtime(request).commands.cancel(command_id, actor)


@admin.post("/strategies/{strategy_id}/commands", status_code=201, response_model=CommandView)
async def create_command(request: Request, strategy_id: Key, body: CommandRequest, actor=ADMIN):
    service = runtime(request)
    service.limit("operations", actor, 30, 60)
    return service.commands.create(strategy_id, body, actor)


@admin.post("/commands/{command_id}/confirm", response_model=CommandView)
async def confirm(request: Request, command_id: Key, actor=ADMIN):
    service = runtime(request)
    service.limit("operations", actor, 30, 60)
    return service.commands.confirm(command_id, actor)


@admin.post("/commands/{command_id}/reconcile", response_model=CommandView)
async def reconcile(request: Request, command_id: Key, body: Reconciliation, actor=ADMIN):
    return runtime(request).commands.reconcile(command_id, body, actor)


@admin.get("/audit", response_model=list[AuditView])
async def audit(
    request: Request,
    strategy_id: Key | None = None,
    command_id: Key | None = None,
    action: Key | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    actor=ADMIN,
):
    """Read the audit trail, optionally restricted to a strategy, command, or action."""
    from .db import record

    rows = runtime(request).db.all(
        """SELECT * FROM audit_log WHERE (? IS NULL OR strategy_id=?)
           AND (? IS NULL OR json_extract(detail, '$.command_id')=?)
           AND (? IS NULL OR action=?)
           ORDER BY id DESC LIMIT ?""",
        (strategy_id, strategy_id, command_id, command_id, action, action, limit),
    )
    return [record(row, documents=("detail",), times=("created_at",)) for row in rows]


def unique_json(items):
    result = dict(items)
    if len(result) != len(items):
        raise ValueError("Duplicate JSON keys")
    return result


def docker_bridge_peer(peer: str) -> bool:
    try:
        address = ip_address(peer)
    except ValueError:
        return False
    if not isinstance(address, IPv4Address):
        return False
    first, second, *_ = address.packed
    return first == 10 or (first == 172 and 16 <= second <= 31) or (first, second) == (192, 168)


def sandbox_pool(request):
    return request.app.state.sandboxes


@admin.get("/strategies/{strategy_id}/sandbox")
async def sandbox_status(request: Request, strategy_id: Key, actor=ADMIN):
    runtime(request).strategies.row(strategy_id)
    return await sandbox_pool(request).call(sandbox_pool(request).manage(strategy_id, "status"))


@admin.post("/strategies/{strategy_id}/sandbox")
async def sandbox_copy(request: Request, strategy_id: Key, actor=ADMIN):
    runtime(request).strategies.active(strategy_id)
    pool = sandbox_pool(request)
    session = await pool.call(pool.manage(strategy_id, "copy"))
    origin = request.app.state.public_url or f"{request.url.scheme}://{request.url.netloc}"
    return {**session, "endpoint": origin.rstrip("/") + SANDBOX_PREFIX}


@admin.post("/strategies/{strategy_id}/sandbox/{key}/{action}")
async def sandbox_action(
    request: Request,
    strategy_id: Key,
    key: Key,
    action: Literal["renew", "close", "pause_entry", "resume_entry", "refresh"],
    actor=ADMIN,
):
    runtime(request).strategies.row(strategy_id)
    pool = sandbox_pool(request)
    return await pool.call(pool.manage(strategy_id, action, key))


class Transport:
    def __init__(self, app, public_url=None, docker_local_http=False, sandbox_inner=False):
        self.app = app
        self.origin = public_url
        self.docker_local_http = docker_local_http
        self.sandbox_inner = sandbox_inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        path = request.url.path
        sandbox = path.startswith(SANDBOX_PREFIX + "/")
        request_id = uuid4().hex if path.startswith("/api/agent/") or sandbox else None
        if not self.sandbox_inner:
            request.state.request_id = request_id
        peer = request.client.host if request.client else ""
        host = request.url.netloc
        origin = f"{request.url.scheme}://{host}"
        local_host = request.url.hostname in {"127.0.0.1", "::1", "localhost"}
        local_peer = peer in {"127.0.0.1", "::1"}
        # The default Compose publishes on host loopback. Docker can NAT its source
        # address to a private bridge address before forwarding it into the container.
        local_access = (
            local_host
            and not any(
                header in request.headers
                for header in ("x-forwarded-proto", "x-forwarded-for", "forwarded")
            )
            and (local_peer or (self.docker_local_http and docker_bridge_peer(peer)))
        )
        request.state.local_access = local_access
        error = None
        if request.url.scheme != "https" and not local_access:
            error = (426, "HTTPS is required for remote connections")
        elif self.origin and request.url.scheme == "https" and host != urlsplit(self.origin).netloc:
            error = (421, "Request host does not match the configured public URL")
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and path.startswith("/api/admin"):
            if request.headers.get("origin") not in {None, origin}:
                error = (403, "Cross-origin administrator request rejected")
            elif request.headers.get("sec-fetch-site") == "cross-site":
                error = (403, "Cross-site administrator request rejected")

        async def protected_send(message):
            if message["type"] == "http.response.start":
                headers = message["headers"]
                if request_id:
                    headers.append((b"x-quantbot-request-id", request_id.encode()))
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

        if error and not self.sandbox_inner:
            await JSONResponse({"detail": error[1]}, status_code=error[0])(
                scope, receive, protected_send
            )
            return

        if sandbox and not self.sandbox_inner:
            await self.app(scope, receive, protected_send)
            return
        if self.sandbox_inner:
            protected_send = send
        if request.method in {"POST", "PUT", "PATCH"}:
            chunks = bytearray()
            body_deadline = time.monotonic() + 5
            while True:
                try:
                    item = (
                        await asyncio.wait_for(receive(), max(0, body_deadline - time.monotonic()))
                        if self.sandbox_inner
                        else await receive()
                    )
                except TimeoutError:
                    await JSONResponse({"detail": "Sandbox request body timed out"}, 408)(
                        scope, receive, protected_send
                    )
                    return
                if item["type"] == "http.disconnect":
                    return
                chunks.extend(item.get("body", b""))
                if len(chunks) > (SANDBOX_BODY_LIMIT if self.sandbox_inner else BODY_LIMIT):
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
                    body = json.loads(chunks, object_pairs_hook=unique_json)
                    canonical = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
                except (ValueError, RecursionError):
                    await JSONResponse({"detail": "Invalid JSON"}, status_code=400)(
                        scope, receive, protected_send
                    )
                    return
                chunks = canonical
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


@admin.get("/telegram")
async def telegram_settings(request: Request, actor=ADMIN):
    return runtime(request).telegram.public()


@admin.put("/telegram")
async def update_telegram(request: Request, body: TelegramUpdate, actor=ADMIN):
    return runtime(request).telegram.update(body, actor)


def make_app(
    path: Path,
    *,
    public_url=None,
    bootstrap=None,
    clock=time.time,
    configure=None,
    telegram_token=None,
    telegram_network=True,
    local_url=None,
    docker_local_http=False,
):
    @asynccontextmanager
    async def lifespan(app):
        with exclusive_database(path):
            service = Runtime(path, clock)
            app.state.runtime = service
            app.state.public_url = public_url
            workers = []
            service.telegram = TelegramConfig(service, telegram_token)
            app.state.sandboxes = Sandboxes(clock)
            try:
                if bootstrap:
                    bootstrap(service)
                service.commands.sweep(restart=True)
                workers.append(asyncio.create_task(service.upkeep()))

                async def clean_sandboxes():
                    while True:
                        await asyncio.sleep(15)
                        await app.state.sandboxes.call(app.state.sandboxes.clean())

                workers.append(asyncio.create_task(clean_sandboxes()))
                if telegram_network:
                    workers.append(
                        asyncio.create_task(
                            supervise(service, service.telegram, public_url or local_url)
                        )
                    )
                yield
            finally:
                for worker in workers:
                    worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                await app.state.sandboxes.shutdown()
                service.db.close()

    app = FastAPI(title="QuantBot API", version=__version__, lifespan=lifespan)
    app.add_middleware(Transport, public_url=public_url, docker_local_http=docker_local_http)
    app.include_router(agent, prefix="/api/agent")
    sandbox_app = FastAPI(
        title="QuantBot Sandbox API",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    sandbox_app.add_middleware(Transport, sandbox_inner=True)
    sandbox_app.include_router(agent, prefix="/agent")
    sandbox_app.add_exception_handler(sqlite3.OperationalError, storage_full)
    app.mount("/api/sandbox", SandboxRoutes(sandbox_app), name="sandbox")
    register_management(app, administrator, set_cookie)
    app.include_router(admin)

    @sandbox_app.exception_handler(Problem)
    @app.exception_handler(Problem)
    async def problem(request, exc):
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        return JSONResponse({"detail": str(exc)}, status_code=exc.status, headers=headers)

    @app.get("/api/data-types", tags=["Schemas"])
    async def data_types():
        return Registry.definition()

    @app.get("/api/schemas/{kind}", tags=["Schemas"])
    async def schema(kind: str):
        return schema_document(kind)

    @sandbox_app.exception_handler(RequestValidationError)
    @app.exception_handler(RequestValidationError)
    async def validation(request, exc):
        sid = getattr(request.state, "telemetry_source", None)
        if sid:
            resource = request.url.path.rsplit("/", 1)[-1]
            kind = {
                "snapshot": "snapshot",
                "events": "event",
                "metrics": "metric",
                "metric-definitions": "metric",
            }.get(resource, "unrecognized")
            rejected = {kind}
            if (resource == "reports" or "/monitor/" in request.url.path) and isinstance(
                exc.body, dict
            ):
                records = exc.body.get("records")
                if isinstance(records, list):
                    rejected = set()
                    for error in exc.errors():
                        loc = error["loc"]
                        if len(loc) > 2 and loc[1] == "records" and isinstance(loc[2], int):
                            raw = records[loc[2]]
                            value = raw.get("type") if isinstance(raw, dict) else None
                            rejected.add(value if value in DATA_TYPES else "unrecognized")
                    rejected = rejected or {"unrecognized"}
            runtime(request).registry.reject(sid, rejected)
        errors = [{"location": err["loc"], "type": err["type"]} for err in exc.errors()]
        if hasattr(request.state, "sandbox_runtime"):
            request.state.sandbox_validation = [error["type"] for error in errors[:5]]
        return JSONResponse(
            {"detail": "Request does not match the API schema", "errors": errors},
            status_code=422,
        )

    @app.get("/healthz", include_in_schema=False)
    async def health():
        return {"status": "ok"}

    @app.get("/api/stream", tags=["Administration"])
    async def stream(request: Request, actor=ADMIN):
        async def updates():
            service = runtime(request)
            seen = service.versions.copy()
            while not await request.is_disconnected():
                try:
                    service.auth.administrator(request.cookies.get(COOKIE))
                except Problem:
                    return
                changed = service.change
                topics = [
                    topic for topic, version in service.versions.items() if seen[topic] != version
                ]
                if topics:
                    seen = service.versions.copy()
                    yield f"event: update\ndata: {json.dumps(topics)}\n\n"
                else:
                    yield ": connected\n\n"
                try:
                    await asyncio.wait_for(changed.wait(), 15)
                except TimeoutError:
                    pass

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
