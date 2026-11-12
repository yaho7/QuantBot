"""Latest snapshots, idempotent event ingest, and durable observations."""

import json
from datetime import datetime
from decimal import Decimal

from .db import encode, record
from .errors import Problem


class Telemetry:
    def __init__(self, db, strategies, clock, wake):
        self.db = db
        self.strategies = strategies
        self.clock = clock
        self.wake = wake

    def cutoff(self, sid):
        return self.clock() - self.strategies.settings(sid)["retention_days"] * 86400

    @staticmethod
    def timestamp_value(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()

    def observation(self, value):
        observed = value.timestamp()
        if observed > self.clock() + 300:
            raise Problem(422, "Observation timestamp is more than five minutes in the future")
        return observed

    def snapshot(self, agent, snapshot):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        observed = self.observation(snapshot.observed_at)
        if observed < self.cutoff(sid):
            raise Problem(422, "Snapshot is outside the configured retention period")
        payload = encode(snapshot.model_dump(mode="json"))
        with self.db.transaction():
            previous = self.db.one(
                "SELECT * FROM snapshots WHERE strategy_id=? AND instance_id=?", (sid, instance)
            )
            if previous and observed == previous["observed_at"] and payload != previous["payload"]:
                raise Problem(409, "Snapshot timestamp already identifies a different report")
            current = not previous or observed > previous["observed_at"]
            if current:
                self.db.execute(
                    """INSERT INTO snapshots VALUES (?, ?, ?, ?)
                       ON CONFLICT(strategy_id, instance_id) DO UPDATE SET
                       observed_at=excluded.observed_at, payload=excluded.payload""",
                    (sid, instance, observed, payload),
                )
            for metric in snapshot.metrics:
                self.sample(sid, instance, metric, observed)
            self.registry.account_samples(sid, instance, snapshot.accounts, observed)
            self.registry.performance_samples(sid, instance, snapshot.performance, observed)
            self.registry.from_snapshot(sid, instance, snapshot, observed)
            self.registry.clear_failures(sid, ("snapshot",))
        self.wake()
        return {"current": current, "observed_at": snapshot.observed_at}

    def sample(self, sid, instance, metric, observed):
        if metric.name.startswith(("account.", "performance.")):
            raise Problem(422, "This metric namespace is reserved for structured snapshots")
        return self.insert_sample(
            sid,
            instance,
            metric.name,
            metric.account_id or "",
            metric.unit or "",
            observed,
            metric.value,
            metric.label,
        )

    def insert_sample(self, sid, instance, name, account, unit, observed, value, label):
        key = (sid, instance, name, account, unit, observed)
        changed = self.db.execute(
            "INSERT OR IGNORE INTO metric_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (*key, value, label),
        ).rowcount
        if not changed:
            previous = self.db.one(
                """SELECT value FROM metric_samples WHERE strategy_id=? AND instance_id=?
                   AND name=? AND account_id=? AND unit=? AND observed_at=?""",
                key,
            )
            if Decimal(previous["value"]) != Decimal(value):
                raise Problem(409, "Metric timestamp already identifies a different sample")
        return changed

    def metrics(self, agent, points):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        cutoff = self.cutoff(sid)
        inserted = 0
        with self.db.transaction():
            for point in points.metrics:
                observed = self.observation(point.observed_at)
                if observed >= cutoff:
                    inserted += self.sample(sid, instance, point, observed)
            self.registry.clear_failures(sid, ("metric",))
        self.wake()
        return {"inserted": inserted, "ignored": len(points.metrics) - inserted}

    def events(self, agent, batch):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        cutoff = self.cutoff(sid)
        accepted, duplicate, ignored = [], [], []
        with self.db.transaction():
            for event in batch.events:
                observed = self.observation(event.occurred_at)
                if observed < cutoff:
                    ignored.append(event.id)
                    continue
                if self.insert_event(sid, instance, event, observed):
                    accepted.append(event.id)
                else:
                    duplicate.append(event.id)
            self.registry.clear_failures(sid, ("event",))
        self.wake()
        return {"accepted": accepted, "duplicates": duplicate, "ignored": ignored}

    def insert_event(self, sid, instance, event, observed):
        payload = encode(event.model_dump(mode="json"))
        previous = self.db.one(
            "SELECT payload FROM strategy_events WHERE strategy_id=? AND id=?",
            (sid, event.id),
        )
        if previous:
            if previous["payload"] != payload:
                raise Problem(409, "Event ID already identifies a different event")
            return False
        if event.fill:
            fill = self.db.one(
                """SELECT json_extract(payload, '$.fill') AS value FROM strategy_events
                   WHERE strategy_id=? AND json_type(payload, '$.fill')='object'
                   AND json_extract(payload, '$.fill.account_id')=?
                   AND json_extract(payload, '$.fill.fill_id')=?""",
                (sid, event.fill.account_id, event.fill.fill_id),
            )
            if fill:
                if json.loads(fill["value"]) != event.fill.model_dump(mode="json"):
                    raise Problem(409, "Fill identity already refers to different execution data")
                return False
        self.db.execute(
            "INSERT INTO strategy_events VALUES (?, ?, ?, ?, ?)",
            (sid, event.id, instance, observed, payload),
        )
        if (
            event.category in {"trade", "open", "close", "risk", "error", "warning", "alert"}
            or event.severity in {"warning", "error", "critical"}
            or (event.category == "custom" and event.attributes.get("important") is True)
        ):
            self.strategies.alert(
                sid,
                event.category,
                event.severity,
                event.message,
                f"event:{event.dedup_key}" if event.dedup_key else None,
            )
        return True

    def history(self, sid, name=None, instance=None, start=None, end=None, limit=1000):
        self.strategies.row(sid)
        rows = self.db.all(
            """SELECT * FROM metric_samples WHERE strategy_id=?
               AND (? IS NULL OR name=?) AND (? IS NULL OR instance_id=?)
               AND (? IS NULL OR observed_at>=?) AND (? IS NULL OR observed_at<=?)
               ORDER BY observed_at DESC LIMIT ?""",
            (sid, name, name, instance, instance, start, start, end, end, limit),
        )
        return [
            record(row, times=("observed_at",), omit=("strategy_id",)) for row in reversed(rows)
        ]

    def event_rows(self, sid=None, category=None, limit=100, start=None, end=None, before=None):
        if sid:
            self.strategies.row(sid)
        rows = self.db.all(
            """SELECT * FROM strategy_events WHERE (? IS NULL OR strategy_id=?)
               AND (? IS NULL OR json_extract(payload, '$.category')=?)
               AND (? IS NULL OR occurred_at>=?) AND (? IS NULL OR occurred_at<=?)
               AND (? IS NULL OR occurred_at<?)
               ORDER BY occurred_at DESC, id DESC LIMIT ?""",
            (sid, sid, category, category, start, start, end, end, before, before, limit),
        )
        return [
            {
                "strategy_id": row["strategy_id"],
                "instance_id": row["instance_id"],
                **json.loads(row["payload"]),
            }
            for row in rows
        ]

    def purge(self):
        with self.db.transaction():
            for strategy in self.strategies.list():
                sid = strategy["id"]
                cutoff = self.cutoff(sid)
                self.db.execute(
                    "DELETE FROM metric_samples WHERE strategy_id=? AND observed_at<?",
                    (sid, cutoff),
                )
                self.db.execute(
                    "DELETE FROM strategy_events WHERE strategy_id=? AND occurred_at<?",
                    (sid, cutoff),
                )
                self.db.execute(
                    "DELETE FROM alerts WHERE strategy_id=? AND created_at<?", (sid, cutoff)
                )
                self.db.execute(
                    "DELETE FROM typed_reports WHERE strategy_id=? AND observed_at<?", (sid, cutoff)
                )
                self.db.execute(
                    "DELETE FROM report_event_ids WHERE strategy_id=? AND observed_at<?",
                    (sid, cutoff),
                )
            self.db.execute("DELETE FROM admin_sessions WHERE expires_at<=?", (self.clock(),))
            self.db.execute("DELETE FROM login_links WHERE expires_at<=?", (self.clock(),))
