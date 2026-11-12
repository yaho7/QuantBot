"""The internal HTTP API strategies call. See PROTOCOL.md."""

from __future__ import annotations

import json
import logging
import math
import re
from collections.abc import Callable
from typing import Any

from aiohttp import web

from quantbot.hub import EventError, Hub, Strategy

log = logging.getLogger("quantbot.server")

MAX_BODY = 6 * 1024 * 1024
MAX_WAIT = 30.0
HUB_KEY = web.AppKey("hub", Hub)
STRATEGY_KEY = web.RequestKey("strategy", Strategy)


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


@web.middleware
async def authenticate(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.path in {"/", "/healthz", "/ui"} or request.path.startswith("/ui/"):
        return await handler(request)  # the web page checks its own cookie
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    strategy = request.app[HUB_KEY].by_token(token.strip()) if scheme == "Bearer" else None
    if strategy is None:
        return _error(401, "unknown token")
    request[STRATEGY_KEY] = strategy
    return await handler(request)


async def _body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json(loads=json.loads)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise web.HTTPBadRequest(
            text='{"ok":false,"error":"body must be JSON"}', content_type="application/json"
        ) from exc
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(
            text='{"ok":false,"error":"body must be a JSON object"}',
            content_type="application/json",
        )
    return body


async def events(request: web.Request) -> web.Response:
    strategy: Strategy = request[STRATEGY_KEY]
    hub = request.app[HUB_KEY]
    token = strategy.token
    try:
        body = await _body(request)
        if not hub.authorized(strategy, token):
            return _error(401, "unknown token")
        hub.event(strategy, body)
    except EventError as exc:
        return _error(400, str(exc))
    return web.json_response({"ok": True})


async def commands(request: web.Request) -> web.Response:
    try:
        wait = float(request.query.get("wait", "25"))
    except ValueError:
        return _error(400, "wait must be a number of seconds")
    if not math.isfinite(wait):
        return _error(400, "wait must be finite")
    wait = min(max(wait, 0.0), MAX_WAIT)
    reply = await request.app[HUB_KEY].poll(
        request[STRATEGY_KEY], wait, claims=request.query.get("claims") == "1"
    )
    return _error(401, "unknown token") if reply is None else web.json_response(reply)


async def claim(request: web.Request) -> web.Response:
    strategy = request[STRATEGY_KEY]
    hub = request.app[HUB_KEY]
    token = strategy.token
    body = await _body(request)
    if not hub.authorized(strategy, token):
        return _error(401, "unknown token")
    grant = body.get("grant")
    if not isinstance(grant, str) or not re.fullmatch(r"[0-9a-f]{32}", grant):
        return _error(400, "grant must be a 32-digit hex nonce")
    if not hub.claim(strategy, request.match_info["command_id"], grant):
        return _error(409, "execution grant unavailable")
    return web.json_response({"ok": True})


async def result(request: web.Request) -> web.Response:
    strategy = request[STRATEGY_KEY]
    hub = request.app[HUB_KEY]
    token = strategy.token
    body = await _body(request)
    if not hub.authorized(strategy, token):
        return _error(401, "unknown token")
    found = hub.result(strategy, request.match_info["command_id"], body)
    if not found:
        return _error(404, "unknown or finished command")
    return web.json_response({"ok": True})


async def healthz(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def make_app(hub: Hub, page: Callable[[web.Application], None] | None = None) -> web.Application:
    app = web.Application(middlewares=[authenticate], client_max_size=MAX_BODY)
    app[HUB_KEY] = hub
    if page is not None:
        page(app)
    app.add_routes(
        [
            web.get("/healthz", healthz),
            web.post("/v1/events", events),
            web.get("/v1/commands", commands),
            web.post("/v1/commands/{command_id}/claim", claim),
            web.post("/v1/commands/{command_id}/result", result),
        ]
    )
    return app
