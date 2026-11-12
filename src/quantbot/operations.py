"""Durable execution grants and outcomes for commands with side effects."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

PROTECTED_COMMANDS = {"resume", "manual_order", "cancel", "flatten", "set_param", "stop"}


def protected(name: str) -> bool:
    return name in PROTECTED_COMMANDS or name.startswith("action:")


class Operations:
    def __init__(self, path: Path | None) -> None:
        if path is not None:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
        self.db = sqlite3.connect(path if path is not None else ":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, sid TEXT NOT NULL, name TEXT NOT NULL,
                args TEXT NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL,
                grant TEXT, result TEXT, updated REAL NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_open_operation
                ON operations(sid, name)
                WHERE state IN ('CREATED', 'ACCEPTED', 'EXECUTING', 'UNKNOWN');
            CREATE INDEX IF NOT EXISTS operation_updates ON operations(sid, updated);
            CREATE TABLE IF NOT EXISTS pause_intents (sid TEXT PRIMARY KEY, id TEXT NOT NULL);
            """
        )

    def get(self, sid: str, cid: str) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT * FROM operations WHERE sid=? AND id=?", (sid, cid)
        ).fetchone()

    def recent(self, sid: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            """SELECT id, name, args, state, updated, result FROM operations WHERE sid=?
                ORDER BY state IN ('CREATED', 'ACCEPTED', 'EXECUTING', 'UNKNOWN') DESC,
                         updated DESC LIMIT 50""",
            (sid,),
        )
        return [
            {**row, "args": json.loads(row["args"]), "result": json.loads(row["result"] or "null")}
            for row in rows
        ]

    def create(
        self, sid: str, cid: str, name: str, args: dict[str, Any], now: float, expires: float
    ) -> tuple[sqlite3.Row, bool]:
        payload = json.dumps(args, sort_keys=True, allow_nan=False)
        with self.db:
            # Take the write lock before checking for a conflict or a recent exact retry.
            self.db.execute("BEGIN IMMEDIATE")
            existing = self.db.execute(
                """SELECT * FROM operations WHERE sid=? AND (
                    id=? OR (name=? AND (state IN ('CREATED', 'ACCEPTED', 'EXECUTING', 'UNKNOWN')
                    OR (state='SUCCEEDED' AND args=? AND updated>=?))))
                    ORDER BY id=? DESC,
                        state IN ('CREATED', 'ACCEPTED', 'EXECUTING', 'UNKNOWN') DESC LIMIT 1""",
                (sid, cid, name, payload, now - 30, cid),
            ).fetchone()
            if existing is not None:
                return existing, False
            self.db.execute(
                "INSERT INTO operations VALUES (?, ?, ?, ?, ?, 'CREATED', NULL, NULL, ?)",
                (cid, sid, name, payload, expires, now),
            )
        return self.get(sid, cid), True

    def accept(self, sid: str, cid: str, now: float) -> bool:
        with self.db:
            changed = self.db.execute(
                """UPDATE operations SET state='ACCEPTED', updated=?
                   WHERE sid=? AND id=? AND state='CREATED' AND expires>?""",
                (now, sid, cid, now),
            ).rowcount
        return bool(changed)

    def claim(self, sid: str, cid: str, grant: str, now: float) -> bool:
        with self.db:
            changed = self.db.execute(
                """UPDATE operations SET state='EXECUTING', grant=?, updated=?
                   WHERE sid=? AND id=? AND state='ACCEPTED' AND expires>?
                   AND (name!='resume' OR NOT EXISTS (SELECT 1 FROM pause_intents WHERE sid=?))""",
                (grant, now, sid, cid, now, sid),
            ).rowcount
        return bool(changed)

    def finish(self, sid: str, cid: str, body: dict[str, Any], now: float) -> bool:
        if type(body.get("ok")) is not bool or not isinstance(body.get("grant"), str):
            return False
        state = "UNKNOWN" if body.get("unknown") else ("SUCCEEDED" if body["ok"] else "FAILED")
        with self.db:
            changed = self.db.execute(
                """UPDATE operations SET state=?, result=?, updated=? WHERE sid=? AND id=?
                   AND grant=? AND (state='EXECUTING' OR (state='UNKNOWN' AND result IS NULL))""",
                (
                    state,
                    json.dumps({k: v for k, v in body.items() if k != "grant"}, allow_nan=False),
                    now,
                    sid,
                    cid,
                    body["grant"],
                ),
            ).rowcount
        if changed:
            return True
        row = self.get(sid, cid)
        return row is not None and row["grant"] == body.get("grant") and row["result"] is not None

    def reconcile(self, sid: str, cid: str, ok: bool, note: str, now: float) -> bool:
        with self.db:
            changed = self.db.execute(
                """UPDATE operations SET state=?, result=?, updated=?
                   WHERE sid=? AND id=? AND state='UNKNOWN'""",
                (
                    "SUCCEEDED" if ok else "FAILED",
                    json.dumps({"ok": ok, "message": note}),
                    now,
                    sid,
                    cid,
                ),
            ).rowcount
        return bool(changed)

    def expire(self, now: float, result_ttl: float) -> None:
        with self.db:
            self.db.execute(
                """UPDATE operations SET state='FAILED', updated=?
                   WHERE state IN ('CREATED', 'ACCEPTED') AND expires<=?""",
                (now, now),
            )
            self.db.execute(
                """UPDATE operations SET state='UNKNOWN', updated=?
                   WHERE state='EXECUTING' AND updated<=?""",
                (now, now - result_ttl),
            )

    def pause_intent(self, sid: str) -> str | None:
        row = self.db.execute("SELECT id FROM pause_intents WHERE sid=?", (sid,)).fetchone()
        return row["id"] if row is not None else None

    def save_pause(self, sid: str, cid: str) -> str:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO pause_intents VALUES (?, ?)", (sid, cid))
        return self.pause_intent(sid) or cid

    def clear_pause(self, sid: str, cid: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM pause_intents WHERE sid=? AND id=?", (sid, cid))

    def retry_pause(self, sid: str, cid: str, retry_id: str) -> None:
        with self.db:
            self.db.execute(
                "UPDATE pause_intents SET id=? WHERE sid=? AND id=?", (retry_id, sid, cid)
            )
