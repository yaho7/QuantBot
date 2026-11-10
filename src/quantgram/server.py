"""The internal HTTP API strategies call. See PROTOCOL.md."""

from __future__ import annotations

import json
import logging
from typing import Any

from aiohttp import web

from quantgram.hub import EventError, Hub, Strategy

log = logging.getLogger("quantgram.server")

MAX_BODY = 6 * 1024 * 1024
MAX_WAIT = 30.0
HUB_KEY = web.AppKey("hub", Hub)
STRATEGY_KEY = web.RequestKey("strategy", Strategy)


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


@web.middleware
async def authenticate(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.path == "/healthz":
        return await handler(request)
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
    try:
        request.app[HUB_KEY].event(strategy, await _body(request))
    except EventError as exc:
        return _error(400, str(exc))
    return web.json_response({"ok": True})


async def commands(request: web.Request) -> web.Response:
    try:
        wait = float(request.query.get("wait", "25"))
    except ValueError:
        return _error(400, "wait must be a number of seconds")
    wait = min(max(wait, 0.0), MAX_WAIT)
    reply = await request.app[HUB_KEY].poll(request[STRATEGY_KEY], wait)
    return web.json_response(reply)


async def result(request: web.Request) -> web.Response:
    found = request.app[HUB_KEY].result(
        request[STRATEGY_KEY], request.match_info["command_id"], await _body(request)
    )
    if not found:
        return _error(404, "unknown or finished command")
    return web.json_response({"ok": True})


async def healthz(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


def make_app(hub: Hub) -> web.Application:
    app = web.Application(middlewares=[authenticate], client_max_size=MAX_BODY)
    app[HUB_KEY] = hub
    app.add_routes(
        [
            web.get("/healthz", healthz),
            web.post("/v1/events", events),
            web.get("/v1/commands", commands),
            web.post("/v1/commands/{command_id}/result", result),
        ]
    )
    return app
