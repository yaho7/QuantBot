"""Registration, single executor assignment, and connection diagnostics."""

import json
import secrets
from uuid import uuid4

from .db import encode, record, timestamp
from .errors import Problem

HEARTBEAT_INTERVAL = 15
OFFLINE_AFTER = 50
SEVERITIES = ("debug", "info", "warning", "error", "critical")


class Strategies:
    def __init__(self, db, auth, clock, wake):
        self.db = db
        self.auth = auth
        self.clock = clock
        self.wake = wake
        self.boot = uuid4().hex

    def audit(self, actor, action, strategy_id=None, **detail):
        self.db.execute(
            """INSERT INTO audit_log(strategy_id, actor, action, detail, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (strategy_id, actor, action, encode(detail), self.clock()),
        )

    def alert(self, strategy_id, category, severity, message, dedup_key=None, window=300):
        now = self.clock()
        if strategy_id:
            policy = self.settings(strategy_id)["alerts"]
            if (
                not policy["enabled"]
                or SEVERITIES.index(severity) < SEVERITIES.index(policy["minimum"])
                or (policy["categories"] and category not in policy["categories"])
            ):
                return
        if dedup_key and self.db.one(
            "SELECT 1 FROM alerts WHERE strategy_id IS ? AND dedup_key=? AND created_at>?",
            (strategy_id, dedup_key, now - window),
        ):
            return
        self.db.execute(
            """INSERT INTO alerts(strategy_id, category, severity, message, dedup_key, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (strategy_id, category, severity, message, dedup_key, now),
        )

    def row(self, strategy_id):
        row = self.db.one("SELECT * FROM strategies WHERE id=?", (strategy_id,))
        if row is None:
            raise Problem(404, "Strategy not found")
        return row

    def active(self, strategy_id):
        row = self.row(strategy_id)
        if row["archived_at"] is not None:
            raise Problem(409, "Restore the strategy before changing its configuration")
        return row

    def restore(self, sid, actor):
        with self.db.transaction():
            row = self.row(sid)
            if row["archived_at"] is not None:
                self.db.execute("UPDATE strategies SET archived_at=NULL WHERE id=?", (sid,))
                self.audit(actor, "strategy.restore", sid)
        self.wake()
        return self.detail(sid)

    def settings(self, strategy_id):
        return json.loads(self.row(strategy_id)["settings"])

    def create(self, body, actor):
        sid = str(uuid4())
        now = self.clock()
        settings = body.model_dump(mode="json", exclude={"token"})
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO strategies(id, settings, created_at) VALUES (?, ?, ?)",
                (sid, encode(settings), now),
            )
            self.db.execute("INSERT INTO desired_state VALUES (?, 0, '{}', ?)", (sid, now))
            token = self.auth.issue(sid, body.token)
            self.audit(actor, "strategy.create", sid, token_id=token["id"])
        self.wake()
        return {"strategy": self.detail(sid), "credential": token}

    def update(self, sid, body, actor):
        with self.db.transaction():
            previous = json.loads(self.active(sid)["settings"])
            settings = body.model_dump(mode="json")
            self.db.execute("UPDATE strategies SET settings=? WHERE id=?", (encode(settings), sid))
            if settings["disconnect_policy"] != previous["disconnect_policy"]:
                self.db.execute(
                    "UPDATE desired_state SET revision=revision+1, updated_at=? "
                    "WHERE strategy_id=?",
                    (self.clock(), sid),
                )
            if settings["mode"] != previous["mode"] or (
                previous["live_trading_enabled"] and not settings["live_trading_enabled"]
            ):
                self.db.execute(
                    """UPDATE commands SET state='expired', error='Trading policy changed',
                       updated_at=? WHERE strategy_id=? AND risky=1
                       AND state IN ('confirmation_required', 'pending', 'accepted')""",
                    (self.clock(), sid),
                )
            self.audit(actor, "strategy.update", sid, previous=previous, settings=settings)
        self.wake()
        return self.detail(sid)

    def tokens(self, sid):
        self.row(sid)
        return [
            self.auth.public_token(row)
            for row in self.db.all(
                "SELECT * FROM strategy_tokens WHERE strategy_id=? ORDER BY created_at DESC", (sid,)
            )
        ]

    def change_token(self, sid, actor, options=None, revoke=None):
        with self.db.transaction():
            self.active(sid)
            if revoke:
                self.auth.token_metadata(sid, revoke)
                self.db.execute(
                    """UPDATE strategy_tokens SET revoked_at=coalesce(revoked_at, ?)
                       WHERE id=? AND strategy_id=?""",
                    (self.clock(), revoke, sid),
                )
                self.audit(actor, "token.revoke", sid, token_id=revoke)
            token = self.auth.issue(sid, options) if options else None
            if token:
                self.audit(actor, "token.issue", sid, token_id=token["id"], replaced=revoke)
            self.refresh_presence(sid)
        self.wake()
        return token

    def eligible(self, agent, now=None):
        if not agent:
            return False
        now = self.clock() if now is None else now
        return (
            agent["boot_id"] == self.boot
            and agent["last_seen"] + OFFLINE_AFTER > now
            and agent["revoked_at"] is None
            and (agent["expires_at"] is None or agent["expires_at"] > now)
        )

    def instances(self, sid):
        return self.db.all(
            """SELECT i.*, t.revoked_at, t.expires_at, t.scopes FROM agent_instances i
               JOIN strategy_tokens t ON t.id=i.token_id
               WHERE i.strategy_id=? ORDER BY i.last_seen DESC, i.instance_id""",
            (sid,),
        )

    def executor(self, sid, *, live=False):
        strategy = self.row(sid)
        executor = next(
            (a for a in self.instances(sid) if a["instance_id"] == strategy["executor_id"]), None
        )
        if not executor or (live and not self.eligible(executor)):
            return None
        return executor

    def connect(self, credential, body):
        sid = credential.strategy_id
        if (body.executor or body.capabilities) and "control" not in credential.scopes:
            raise Problem(403, "Executor declarations require the control scope")
        if (
            body.executor
            and any(cap.id not in {"pause_entry", "resume_entry"} for cap in body.capabilities)
            and "commands" not in credential.scopes
        ):
            raise Problem(403, "One-time capabilities require the commands scope")
        now = self.clock()
        with self.db.transaction():
            strategy = self.row(sid)
            prior = next(
                (a for a in self.instances(sid) if a["instance_id"] == body.instance_id), None
            )
            if prior and prior["token_id"] != credential.id and self.eligible(prior, now):
                raise Problem(409, "Instance is already attached to another active credential")
            executor_id = strategy["executor_id"]
            if executor_id is None and body.executor:
                executor_id = body.instance_id
                self.db.execute(
                    "UPDATE strategies SET executor_id=? WHERE id=?", (executor_id, sid)
                )
                self.audit("agent", "executor.assign", sid, instance_id=executor_id)
            reused = (
                prior
                and prior["boot_id"] == self.boot
                and prior["token_id"] == credential.id
                and prior["last_seen"] + OFFLINE_AFTER > now
            )
            session = prior["session_id"] if reused else secrets.token_urlsafe(24)
            self.db.execute(
                """INSERT INTO agent_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_id, instance_id) DO UPDATE SET
                   token_id=excluded.token_id, session_id=excluded.session_id,
                   boot_id=excluded.boot_id, declarations=excluded.declarations,
                   runtime=excluded.runtime, last_seen=excluded.last_seen""",
                (
                    sid,
                    body.instance_id,
                    credential.id,
                    session,
                    self.boot,
                    encode(body.model_dump(mode="json")),
                    prior["runtime"] if reused else "{}",
                    now,
                ),
            )
            self.refresh_presence(sid)
        self.wake()
        return {
            "strategy_id": sid,
            "session_id": session,
            "instance_id": body.instance_id,
            "executor": executor_id == body.instance_id and body.executor,
            "heartbeat_interval_seconds": HEARTBEAT_INTERVAL,
            "offline_after_seconds": OFFLINE_AFTER,
            "mode": json.loads(strategy["settings"])["mode"],
            "control": self.control(sid),
        }

    def agent(self, credential, session_id, *, executor=False):
        if not session_id or len(session_id) != 32:
            raise Problem(409, "Establish an agent session first")
        row = self.db.one(
            """SELECT i.*, s.executor_id FROM agent_instances i JOIN strategies s
               ON s.id=i.strategy_id WHERE i.strategy_id=? AND i.token_id=?
               AND i.session_id=? AND i.boot_id=?""",
            (credential.strategy_id, credential.id, session_id, self.boot),
        )
        if row is None or row["last_seen"] + OFFLINE_AFTER <= self.clock():
            raise Problem(409, "Agent session ended; reconnect")
        if executor and (
            row["executor_id"] != row["instance_id"]
            or not json.loads(row["declarations"])["executor"]
        ):
            raise Problem(403, "This instance is not the authorized executor")
        return row

    def heartbeat(self, agent, body):
        now = self.clock()
        sid = agent["strategy_id"]
        with self.db.transaction():
            self.db.execute(
                "UPDATE agent_instances SET last_seen=?, runtime=? WHERE session_id=?",
                (now, encode(body.model_dump(mode="json")), agent["session_id"]),
            )
            self.refresh_presence(sid)
        return {"server_time": timestamp(now), "control": self.control(sid)}

    def refresh_presence(self, sid):
        row = self.row(sid)
        active = [a for a in self.instances(sid) if self.eligible(a)]
        if row["executor_id"]:
            active = [a for a in active if a["instance_id"] == row["executor_id"]]
        health = [json.loads(a["runtime"]) for a in active]
        status = "offline"
        if health:
            status = (
                "abnormal"
                if any(
                    h.get("health") in {"error", "degraded"} or h.get("broker_connected") is False
                    for h in health
                )
                else "online"
            )
        if row["presence"] != status:
            self.db.execute("UPDATE strategies SET presence=? WHERE id=?", (status, sid))
            category = "error" if status == "abnormal" else status
            self.alert(
                sid,
                category,
                "info" if status == "online" else "warning",
                f"策略状态变更为 {status}",
                category,
            )
        now = self.clock()
        for instance, runtime in zip(active, health, strict=True):
            raw = runtime.get("authorization_expires_at")
            if raw:
                from datetime import datetime

                when = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
                if when <= now + 3 * 86400:
                    self.alert(
                        sid,
                        "authorization",
                        "warning",
                        f"券商授权到期时间 {raw}",
                        f"broker-auth:{instance['instance_id']}:{raw}",
                        86400,
                    )
        for token in self.db.all(
            """SELECT id, expires_at FROM strategy_tokens WHERE strategy_id=? AND revoked_at IS NULL
               AND expires_at BETWEEN ? AND ?""",
            (sid, now - 86400, now + 3 * 86400),
        ):
            self.alert(
                sid,
                "authorization",
                "warning",
                f"接入令牌 {token['id']} 到期时间 {timestamp(token['expires_at'])}",
                f"token-auth:{token['id']}",
                86400,
            )

    def list(self, *, archived=False):
        return [
            self.summary(row)
            for row in self.db.all(
                """SELECT * FROM strategies WHERE (archived_at IS NOT NULL)=?
                   ORDER BY created_at DESC, id""",
                (archived,),
            )
        ]

    def summary(self, row):
        sid = row["id"]
        instances = self.instances(sid)
        return {
            "id": sid,
            **json.loads(row["settings"]),
            "status": row["presence"],
            "executor_id": row["executor_id"],
            "archived_at": timestamp(row["archived_at"]),
            "created_at": timestamp(row["created_at"]),
            "last_seen": timestamp(max((i["last_seen"] for i in instances), default=None)),
        }

    def detail(self, sid, instance_id=None):
        summary = self.summary(self.row(sid))
        agents = self.instances(sid)
        if instance_id and not any(agent["instance_id"] == instance_id for agent in agents):
            raise Problem(404, "Instance not found")
        selected = instance_id or summary["executor_id"]
        if not selected:
            recent = self.db.one(
                """SELECT instance_id FROM (
                       SELECT instance_id, observed_at FROM snapshots WHERE strategy_id=?
                       UNION ALL
                       SELECT instance_id, observed_at FROM typed_reports WHERE strategy_id=?
                   ) ORDER BY observed_at DESC LIMIT 1""",
                (sid, sid),
            )
            selected = recent["instance_id"] if recent else None
        snapshot = self.db.one(
            "SELECT payload FROM snapshots WHERE strategy_id=? AND instance_id=?", (sid, selected)
        )
        snapshot = self.registry.merge(
            sid,
            selected,
            json.loads(snapshot["payload"]) if snapshot else None,
        )
        executor = self.executor(sid)
        return {
            **summary,
            "control": self.control(sid),
            "capabilities": json.loads(executor["declarations"])["capabilities"]
            if executor
            else [],
            "executor_online": bool(
                self.eligible(executor) and json.loads(executor["declarations"])["executor"]
            ),
            "snapshot": snapshot,
            "snapshot_instance_id": selected if snapshot else None,
            "instances": [
                {
                    "instance_id": a["instance_id"],
                    "online": self.eligible(a),
                    "last_seen": timestamp(a["last_seen"]),
                    "runtime": json.loads(a["runtime"]),
                    "declarations": json.loads(a["declarations"]),
                    "token_id": a["token_id"],
                }
                for a in agents
            ],
        }

    def control(self, sid):
        desired = self.db.one("SELECT * FROM desired_state WHERE strategy_id=?", (sid,))
        reported = self.db.one("SELECT * FROM reported_state WHERE strategy_id=?", (sid,))
        config = self.settings(sid)
        state = json.loads(desired["state"])
        executor = self.executor(sid, live=True)
        report = json.loads(reported["state"]) if reported else None
        current = bool(reported and executor and reported["session_id"] == executor["session_id"])
        synced = bool(
            current
            and reported["revision"] == desired["revision"]
            and all(report.get(k) == v for k, v in state.items())
            and report.get("disconnect_policy_applied") == config["disconnect_policy"]
        )
        return {
            "desired": {
                "revision": desired["revision"],
                **state,
                "disconnect_policy": config["disconnect_policy"],
                "updated_at": timestamp(desired["updated_at"]),
            },
            "reported": {
                **report,
                "instance_id": reported["instance_id"],
                "updated_at": timestamp(reported["updated_at"]),
            }
            if reported
            else None,
            "reported_current": current,
            "in_sync": synced,
            "effective_entry_enabled": (
                report["entry_enabled"] and not report["risk_locked"]
                if current and "risk_locked" in report
                else None
            ),
        }

    def alert_rows(self, sid=None, limit=50):
        rows = self.db.all(
            "SELECT * FROM alerts WHERE (? IS NULL OR strategy_id=?) ORDER BY id DESC LIMIT ?",
            (sid, sid, limit),
        )
        return [record(row, times=("created_at",)) for row in rows]
