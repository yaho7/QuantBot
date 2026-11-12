"""Persistent command state machine shared by all administrator surfaces."""

import json
import secrets
from decimal import Decimal
from uuid import uuid4

from .auth import digest
from .db import encode, record, timestamp
from .errors import Problem
from .models import (
    MANDATORY_CONFIRM,
    RISK_ACTIONS,
    SHADOW_ACTIONS,
    STANDARD,
    Capability,
)

PENDING = ("confirmation_required", "pending", "accepted")
RESULT_TIMEOUT = 120
SHADOW_TTL = 86400
CONFIRM_TTL = 45
COMMAND_TTL = 60
PERMIT_TTL = 10


class Commands:
    def __init__(self, db, strategies, clock, wake):
        self.db = db
        self.strategies = strategies
        self.clock = clock
        self.wake = wake

    def row(self, command_id, sid=None):
        row = self.db.one(
            "SELECT * FROM commands WHERE id=? AND (? IS NULL OR strategy_id=?)",
            (command_id, sid, sid),
        )
        if row is None:
            raise Problem(404, "Command not found")
        return row

    @staticmethod
    def public(row):
        return record(
            row,
            documents=("arguments", "result"),
            times=("created_at", "updated_at", "expires_at"),
            omit=("fingerprint", "session_id"),
        )

    def list(self, sid=None, limit=50, before=None):
        return [
            self.public(row)
            for row in self.db.all(
                """SELECT * FROM commands WHERE (? IS NULL OR strategy_id=?)
               AND (? IS NULL OR rowid<(SELECT rowid FROM commands WHERE id=?))
               ORDER BY rowid DESC LIMIT ?""",
                (sid, sid, before, before, limit),
            )
        ]

    def capability(self, sid, action, *, live):
        self.strategies.active(sid)
        agent = self.strategies.executor(sid, live=live)
        if not agent:
            raise Problem(409, "The strategy has no available executor")
        declaration = json.loads(agent["declarations"])
        if not declaration["executor"]:
            raise Problem(409, "The instance is not currently configured to execute commands")
        item = next((item for item in declaration["capabilities"] if item["id"] == action), None)
        if item is None:
            raise Problem(422, "The executor has not declared this action")
        return agent, Capability.model_validate(item)

    @staticmethod
    def parameters(schema, supplied):
        if set(supplied) - schema.keys():
            raise Problem(422, "Unknown command parameter")
        args = {}
        for name, param in schema.items():
            value = supplied.get(name, param.default)
            if name not in supplied and value is None and not param.required:
                continue
            if not param.accepts(value):
                raise Problem(422, f"Invalid parameter {name}")
            if param.type == "decimal":
                value = format(Decimal(value), "f")
                if "." in value:
                    value = value.rstrip("0").rstrip(".")
                if Decimal(value) == 0:
                    value = "0"
            args[name] = value
        return args

    def arguments(self, cap, supplied):
        args = self.parameters(cap.parameters, supplied)
        if cap.id in {"buy", "sell"} and Decimal(args["quantity"]) <= 0:
            raise Problem(422, "Order quantity must be positive")
        return args

    def trading_policy(self, sid, risky, *, except_id=""):
        if not risky:
            return
        settings = self.strategies.settings(sid)
        if settings["mode"] == "live" and not settings["live_trading_enabled"]:
            raise Problem(403, "Live trading operations are disabled for this strategy")
        if self.db.one(
            """SELECT 1 FROM commands WHERE strategy_id=? AND id<>? AND risky=1
               AND state IN ('executing', 'unknown')""",
            (sid, except_id),
        ):
            raise Problem(409, "A trading command is still executing or awaiting reconciliation")

    def create_control(self, sid, control_id, body, actor):
        return self.create(sid, body, actor, control_id=control_id)

    def create(self, sid, body, actor, *, control_id=None):
        now = self.clock()
        request = encode([sid, control_id, body.model_dump(mode="json", exclude={"request_id"})])
        self.sweep()
        with self.db.transaction():
            existing = self.db.one(
                "SELECT * FROM commands WHERE actor=? AND request_id=?", (actor, body.request_id)
            )
            if existing:
                legacy = encode([sid, body.action, body.arguments]) if not control_id else None
                if existing["fingerprint"] not in (request, legacy):
                    raise Problem(409, "This request ID was used for another operation")
                return self.public(existing)
            if control_id:
                control_revision = body.revision
                action, supplied = self.controls.invocation(sid, control_id, body)
            else:
                control_revision = None
                action, supplied = body.action, body.arguments
            self.check_binding(sid, control_id, action)
            shadow = action in SHADOW_ACTIONS
            agent, cap = self.capability(sid, action, live=not shadow)
            args = self.arguments(cap, supplied)
            risky, protected = self.bound_safety(cap, sid, control_id, control_revision)
            self.trading_policy(sid, risky)
            if risky:
                previous = self.db.one(
                    """SELECT * FROM commands WHERE strategy_id=? AND action=? AND arguments=?
                       AND ((state IN ('pending','accepted') AND expires_at>?)
                            OR (state='succeeded' AND updated_at>?))
                       ORDER BY created_at DESC LIMIT 1""",
                    (sid, cap.id, encode(args), now, now - 60),
                )
                if previous:
                    raise Problem(409, f"Equivalent command already exists ({previous['id']})")
            cid = str(uuid4())
            state = "confirmation_required" if protected else "pending"
            expires = now + (CONFIRM_TTL if protected else SHADOW_TTL if shadow else COMMAND_TTL)
            self.db.execute(
                """INSERT INTO commands
                   (id, strategy_id, instance_id, session_id, actor, request_id, action, arguments,
                    fingerprint, state, protected, risky, created_at, updated_at, expires_at,
                    control_id, control_revision)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    cid,
                    sid,
                    agent["instance_id"],
                    None if shadow else agent["session_id"],
                    actor,
                    body.request_id,
                    cap.id,
                    encode(args),
                    request,
                    state,
                    protected,
                    risky,
                    now,
                    now,
                    expires,
                    control_id,
                    control_revision,
                ),
            )
            self.strategies.audit(
                actor,
                "command.create",
                sid,
                command_id=cid,
                action_id=cap.id,
                control_id=control_id,
                control_revision=control_revision,
                arguments=args,
                state=state,
            )
            if shadow and not protected:
                self.set_desired(self.row(cid), now)
        self.wake()
        return self.public(self.row(cid))

    def confirm(self, command_id, actor):
        now = self.clock()
        self.sweep()
        with self.db.transaction():
            row = self.row(command_id)
            if row["actor"] != actor:
                raise Problem(403, "Only the requesting administrator can confirm")
            if not row["protected"] or row["state"] != "confirmation_required":
                raise Problem(409, "Confirmation is no longer available")
            sid = row["strategy_id"]
            shadow = row["action"] in SHADOW_ACTIONS
            agent, cap = self.capability(sid, row["action"], live=not shadow)
            self.check_target(row, agent, cap, shadow)
            self.trading_policy(sid, row["risky"], except_id=command_id)
            if row["risky"] and self.db.one(
                """SELECT 1 FROM commands WHERE strategy_id=? AND id<>? AND action=?
                   AND arguments=? AND (state IN ('pending','accepted')
                       OR (state='succeeded' AND updated_at>?))""",
                (sid, command_id, row["action"], row["arguments"], now - 60),
            ):
                raise Problem(409, "An equivalent command is already queued or recently completed")
            self.db.execute(
                "UPDATE commands SET state='pending', updated_at=?, expires_at=? WHERE id=?",
                (now, now + (SHADOW_TTL if shadow else COMMAND_TTL), command_id),
            )
            self.strategies.audit(actor, "command.confirm", sid, command_id=command_id)
            if shadow:
                self.set_desired(row, now)
        self.wake()
        return self.public(self.row(command_id))

    @staticmethod
    def safety(cap):
        risky = cap.high_risk or cap.id in RISK_ACTIONS or cap.id not in STANDARD
        return risky, risky or cap.confirm or cap.id in MANDATORY_CONFIRM

    def check_binding(self, sid, cid, action):
        if not cid and action not in SHADOW_ACTIONS and self.controls.bound_action(sid, action):
            raise Problem(409, "Use the registered control component for this action")

    def bound_safety(self, cap, sid, cid, revision):
        risky, protected = self.safety(cap)
        if cid:
            return self.controls.safety(sid, cid, revision, risky, protected)
        return risky, protected

    def check_target(self, row, agent, cap, shadow=False):
        sid, cid, revision = row["strategy_id"], row["control_id"], row["control_revision"]
        self.check_binding(sid, cid, cap.id)
        safety = self.bound_safety(cap, sid, cid, revision)
        if (
            agent["instance_id"] != row["instance_id"]
            or (not shadow and agent["session_id"] != row["session_id"])
            or encode(self.arguments(cap, json.loads(row["arguments"]))) != row["arguments"]
            or safety != (bool(row["risky"]), bool(row["protected"]))
        ):
            raise Problem(409, "Executor or command definition changed")

    def set_desired(self, command, now):
        sid = command["strategy_id"]
        key, value = SHADOW_ACTIONS[command["action"]]
        desired = self.db.one("SELECT * FROM desired_state WHERE strategy_id=?", (sid,))
        state = json.loads(desired["state"])
        state[key] = value
        revision = desired["revision"] + 1
        self.db.execute(
            "UPDATE desired_state SET state=?, revision=?, updated_at=? WHERE strategy_id=?",
            (encode(state), revision, now, sid),
        )
        self.db.execute("UPDATE commands SET revision=? WHERE id=?", (revision, command["id"]))
        for row in self.db.all(
            """SELECT * FROM commands WHERE strategy_id=? AND revision IS NOT NULL
               AND id<>? AND state='pending'""",
            (sid, command["id"]),
        ):
            prior_key, prior_value = SHADOW_ACTIONS[row["action"]]
            if state[prior_key] != prior_value:
                self.transition(row, "superseded", "A newer control request replaced this value")

    def report(self, agent, body):
        sid = agent["strategy_id"]
        with self.db.transaction():
            control = self.strategies.control(sid)
            prior = control["reported"]
            if body.revision > control["desired"]["revision"] or (
                control["reported_current"] and body.revision < prior["revision"]
            ):
                raise Problem(409, "Invalid control revision; fetch the current state")
            reported = body.model_dump(mode="json")
            self.db.execute(
                """INSERT INTO reported_state VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_id) DO UPDATE SET instance_id=excluded.instance_id,
                   session_id=excluded.session_id, revision=excluded.revision, state=excluded.state,
                   updated_at=excluded.updated_at""",
                (
                    sid,
                    agent["instance_id"],
                    agent["session_id"],
                    body.revision,
                    encode(reported),
                    self.clock(),
                ),
            )
            if self.strategies.control(sid)["in_sync"]:
                for row in self.db.all(
                    """SELECT * FROM commands WHERE strategy_id=? AND state='pending'
                       AND revision<=? AND expires_at>?""",
                    (sid, body.revision, self.clock()),
                ):
                    key, value = SHADOW_ACTIONS[row["action"]]
                    if reported[key] == value:
                        self.transition(
                            row, "succeeded", result={"applied_revision": body.revision}
                        )
        self.wake()
        return self.strategies.control(sid)

    def poll(self, agent):
        sid = agent["strategy_id"]
        self.sweep()
        with self.db.transaction():
            rows = self.db.all(
                """SELECT * FROM commands WHERE strategy_id=? AND session_id=? AND revision IS NULL
                   AND state IN ('pending','accepted') AND expires_at>?
                   ORDER BY created_at LIMIT 20""",
                (sid, agent["session_id"], self.clock()),
            )
            for row in rows:
                if row["state"] == "pending":
                    self.transition(row, "accepted")
        return [self.public(self.row(row["id"])) for row in rows]

    def claim(self, agent, cid):
        sid = agent["strategy_id"]
        now = self.clock()
        self.sweep()
        with self.db.transaction():
            row = self.row(cid, sid)
            if (
                row["state"] != "accepted"
                or row["revision"] is not None
                or row["expires_at"] <= now
            ):
                raise Problem(409, "An execution permit is no longer available")
            executor, cap = self.capability(sid, row["action"], live=True)
            self.check_target(row, executor, cap)
            if row["session_id"] != agent["session_id"]:
                raise Problem(403, "The command is assigned to a different session")
            self.trading_policy(sid, row["risky"], except_id=cid)
            if row["risky"] and not self.strategies.control(sid)["in_sync"]:
                raise Problem(409, "Synchronize desired and reported controls before claiming")
            permit = secrets.token_urlsafe(32)
            self.db.execute(
                "INSERT INTO command_executions VALUES (?, ?, ?, ?, NULL)",
                (cid, agent["instance_id"], digest(permit), now),
            )
            self.transition(row, "executing")
        self.wake()
        return {
            "permit": permit,
            "start_before": timestamp(min(now + PERMIT_TTL, row["expires_at"])),
            "server_time": timestamp(now),
        }

    def finish(self, agent, cid, body):
        sid = agent["strategy_id"]
        receipt = encode(body.model_dump(mode="json", exclude={"permit"}))
        with self.db.transaction():
            row = self.row(cid, sid)
            execution = self.db.one("SELECT * FROM command_executions WHERE command_id=?", (cid,))
            if (
                not execution
                or execution["instance_id"] != agent["instance_id"]
                or not secrets.compare_digest(execution["permit_hash"], digest(body.permit))
            ):
                raise Problem(403, "Invalid execution permit")
            if execution["receipt"] == receipt:
                return self.public(row)
            if row["state"] not in {"executing", "unknown"} or (
                execution["receipt"] and body.status == "unknown"
            ):
                raise Problem(409, "A final result has already been recorded")
            self.db.execute(
                "UPDATE command_executions SET receipt=? WHERE command_id=?", (receipt, cid)
            )
            self.transition(row, body.status, body.error, body.result)
        self.wake()
        return self.public(self.row(cid))

    def cancel(self, cid, actor):
        self.sweep()
        with self.db.transaction():
            row = self.row(cid)
            if row["actor"] != actor:
                raise Problem(403, "Only the requesting administrator can cancel")
            if row["state"] not in PENDING or row["revision"] is not None:
                raise Problem(409, "This operation can no longer be cancelled")
            self.transition(row, "cancelled", actor=actor)
        self.wake()
        return self.public(self.row(cid))

    def reconcile(self, cid, body, actor):
        with self.db.transaction():
            row = self.row(cid)
            if row["state"] != "unknown":
                raise Problem(409, "Only an unknown result can be reconciled")
            self.transition(
                row,
                body.status,
                result={"evidence": body.evidence, "verified_by": actor},
                actor=actor,
            )
        self.wake()
        return self.public(self.row(cid))

    def transition(self, row, state, error=None, result=None, *, actor="service"):
        self.db.execute(
            "UPDATE commands SET state=?, updated_at=?, error=?, result=? WHERE id=?",
            (state, self.clock(), error, encode(result) if result is not None else None, row["id"]),
        )
        sid = row["strategy_id"]
        self.strategies.audit(
            actor,
            f"command.{state}",
            sid,
            command_id=row["id"],
            previous=row["state"],
            error=error,
            result=result,
        )
        if state in {"succeeded", "failed", "unknown", "expired", "superseded", "cancelled"}:
            self.strategies.alert(
                sid,
                "command",
                "warning" if state in {"failed", "unknown"} else "info",
                f"{row['action']} · {state} · {row['id']}",
                f"command:{row['id']}:{state}",
            )

    def sweep(self, *, restart=False):
        now = self.clock()
        with self.db.transaction():
            rows = self.db.all(
                """SELECT * FROM commands WHERE
                   (state IN ('confirmation_required','pending','accepted') AND
                        (expires_at<=? OR (? AND revision IS NULL)))
                   OR (state='executing' AND (? OR updated_at<=?))""",
                (now, restart, restart, now - RESULT_TIMEOUT),
            )
            for row in rows:
                if row["state"] == "executing":
                    self.transition(
                        row, "unknown", "Execution was granted; final result unavailable"
                    )
                else:
                    self.transition(row, "expired", "Command expired before execution")
        if rows:
            self.wake()

    def archive(self, sid, actor):
        self.sweep()
        with self.db.transaction():
            strategy = self.strategies.row(sid)
            if strategy["archived_at"] is None:
                self.safe_change_executor(sid)
                self.expire_queued(sid, "Strategy archived")
                now = self.clock()
                self.db.execute(
                    "UPDATE strategies SET archived_at=?, presence='offline' WHERE id=?", (now, sid)
                )
                self.db.execute(
                    "UPDATE strategy_tokens SET revoked_at=? "
                    "WHERE strategy_id=? AND revoked_at IS NULL",
                    (now, sid),
                )
                self.strategies.audit(actor, "strategy.archive", sid)
        self.wake()
        return self.strategies.detail(sid)

    def assign(self, sid, instance_id, actor):
        self.sweep()
        with self.db.transaction():
            row = self.strategies.active(sid)
            if row["executor_id"] == instance_id:
                return self.strategies.detail(sid)
            if self.strategies.executor(sid, live=True):
                raise Problem(409, "Disconnect the current executor before reassigning it")
            agent = next(
                (i for i in self.strategies.instances(sid) if i["instance_id"] == instance_id),
                None,
            )
            if (
                not self.strategies.eligible(agent)
                or not json.loads(agent["declarations"])["executor"]
            ):
                raise Problem(422, "Select a connected instance that declared executor capability")
            self.safe_change_executor(sid)
            self.expire_queued(sid, "Executor reassigned", only_one_time=True)
            self.db.execute("UPDATE strategies SET executor_id=? WHERE id=?", (instance_id, sid))
            self.strategies.audit(
                actor, "executor.assign", sid, instance_id=instance_id, previous=row["executor_id"]
            )
            self.strategies.refresh_presence(sid)
        self.wake()
        return self.strategies.detail(sid)

    def safe_change_executor(self, sid):
        if self.db.one(
            """SELECT 1 FROM commands WHERE strategy_id=? AND
               (state='executing' OR (state='unknown' AND risky=1))""",
            (sid,),
        ):
            raise Problem(409, "Resolve executing or unknown trading commands first")

    def expire_queued(self, sid, reason, *, only_one_time=False):
        for row in self.db.all(
            """SELECT * FROM commands WHERE strategy_id=?
               AND state IN ('confirmation_required','pending','accepted')
               AND (NOT ? OR revision IS NULL)""",
            (sid, only_one_time),
        ):
            self.transition(row, "expired", reason)
