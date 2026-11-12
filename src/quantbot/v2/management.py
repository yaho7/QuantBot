"""Web administration for account security, strategy lifecycle and platform data."""

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import StringConstraints

from .auth import password_hash, password_matches
from .db import encode
from .errors import Problem
from .models import Key, Payload


class PasswordChange(Payload):
    current_password: Annotated[str, StringConstraints(min_length=1, max_length=1024)]
    new_password: Annotated[str, StringConstraints(min_length=12, max_length=1024)]


class ExecutorAssignment(Payload):
    instance_id: Key


def register(app, administrator, session_cookie):
    router = APIRouter(prefix="/api/v2/admin", tags=["Administration"])
    admin = Depends(administrator)

    @router.get("/overview")
    async def overview(request: Request, actor=admin):
        service = request.app.state.runtime
        strategies = service.strategies.list()
        counts = {
            status: sum(item["status"] == status for item in strategies)
            for status in ("online", "offline", "abnormal")
        }
        account = None
        if len(strategies) == 1 and strategies[0]["status"] != "offline":
            detail = service.strategies.detail(strategies[0]["id"])
            snapshot = detail["snapshot"] or {}
            accounts = snapshot.get("accounts", [])
            if len(accounts) == 1:
                account = {
                    **accounts[0],
                    "observed_at": snapshot.get("observed_at"),
                    "strategy_id": detail["id"],
                }
        events = service.db.all(
            """SELECT strategy_id, payload FROM strategy_events
               WHERE json_type(payload, '$.fill')='object'
               ORDER BY occurred_at DESC LIMIT 8"""
        )
        return {
            "counts": counts,
            "strategies": strategies,
            "account": account,
            "recent_fills": [
                {"strategy_id": e["strategy_id"], **json.loads(e["payload"])} for e in events
            ],
            "alerts": service.strategies.alert_rows(limit=8),
            "commands": service.commands.list(limit=8),
        }

    @router.get("/strategies/archived")
    async def archived(request: Request, actor=admin):
        return request.app.state.runtime.strategies.list(archived=True)

    @router.delete("/strategies/{strategy_id}")
    async def archive(request: Request, strategy_id: Key, actor=admin):
        return request.app.state.runtime.commands.archive(strategy_id, actor)

    @router.post("/strategies/{strategy_id}/restore")
    async def restore(request: Request, strategy_id: Key, actor=admin):
        return request.app.state.runtime.strategies.restore(strategy_id, actor)

    @router.put("/strategies/{strategy_id}/executor")
    async def executor(request: Request, strategy_id: Key, body: ExecutorAssignment, actor=admin):
        return request.app.state.runtime.commands.assign(strategy_id, body.instance_id, actor)

    @router.get("/system")
    async def system(request: Request, actor=admin):
        service = request.app.state.runtime
        db = service.db
        return {
            "version": "2.0.0",
            "public_url": request.app.state.public_url,
            "storage": "SQLite",
            "schema_version": db.one("PRAGMA user_version")[0],
            "counts": dict(
                db.one(
                    """SELECT (SELECT count(*) FROM strategies WHERE archived_at IS NULL)
                           AS strategies,
                   (SELECT count(*) FROM strategies WHERE archived_at IS NOT NULL)
                       AS archived,
                   (SELECT count(*) FROM metric_samples) AS metrics,
                   (SELECT count(*) FROM strategy_events) AS events,
                   (SELECT count(*) FROM typed_reports) AS reports,
                   (SELECT count(*) FROM commands) AS commands"""
                )
            ),
            "telegram_status": service.telegram.status,
        }

    @router.put("/system/password")
    async def change_password(request: Request, body: PasswordChange, actor=admin):
        service = request.app.state.runtime
        service.limit("password", actor, 5, 300)
        existing = service.db.one("SELECT value FROM settings WHERE name='administrator'")
        if existing is None:
            raise Problem(503, "Initialize the administrator account on the server")
        account = json.loads(existing["value"])
        if not await asyncio.to_thread(
            password_matches, body.current_password, account["password_hash"]
        ):
            raise Problem(401, "Invalid current password")
        if body.current_password == body.new_password:
            raise Problem(422, "Choose a different password")
        account["password_hash"] = await asyncio.to_thread(password_hash, body.new_password)
        with service.db.transaction():
            changed = service.db.execute(
                "UPDATE settings SET value=? WHERE name='administrator' AND value=?",
                (encode(account), existing["value"]),
            )
            if changed.rowcount != 1:
                raise Problem(409, "Administrator credentials changed during this request")
            service.db.execute("DELETE FROM admin_sessions")
            service.db.execute("DELETE FROM login_links")
            service.strategies.audit(actor, "admin.change_password")
            secret = service.auth.session(actor)
        return session_cookie(request, secret)

    app.include_router(router)
