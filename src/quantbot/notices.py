"""When and how loudly to send: quiet hours, connection changes, expiry reminders."""

from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from quantbot.i18n import tr

# Kinds of message. Quiet hours deliver "info" and "trade" silently; the others ring.
KINDS = ("info", "trade", "alert", "error")
LOUD = {"alert", "error"}
REMIND_BEFORE = (timedelta(hours=48), timedelta(hours=12), timedelta(0))
FEED_RETENTION_DAYS = 30
FEED_PAGE_SIZE = 50


class Feed:
    """Web notification history, separate from the client delivery inbox."""

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "web-notices.sqlite3"
        self.initialized = False

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        if not self.initialized:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.close(os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600))
        with closing(sqlite3.connect(self.path, timeout=0.25)) as db, db:
            db.row_factory = sqlite3.Row
            if not self.initialized:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS web_notices (
                        id TEXT PRIMARY KEY, created REAL NOT NULL, strategy TEXT NOT NULL,
                        text TEXT NOT NULL, kind TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS web_notices_recent ON web_notices(created);
                    CREATE INDEX IF NOT EXISTS web_notices_unread_alerts ON web_notices(created)
                        WHERE seen=0 AND kind IN ('alert', 'error');
                    """)
                self.initialized = True
            yield db

    def add(self, strategy: str, text: str, kind: str, *, notice_id: str | None = None) -> None:
        now = time.time()
        with self._connect() as db:
            db.execute(
                "DELETE FROM web_notices WHERE created < ?", (now - FEED_RETENTION_DAYS * 86400,)
            )
            db.execute(
                """INSERT OR IGNORE INTO web_notices (id, created, strategy, text, kind)
                   VALUES (?, ?, ?, ?, ?)""",
                (notice_id or uuid.uuid4().hex, now, strategy, text, kind),
            )

    @staticmethod
    def _item(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "time": datetime.fromtimestamp(row["created"], timezone.utc).isoformat(),
            "strategy": row["strategy"],
            "text": row["text"],
            "kind": row["kind"],
            "read": bool(row["seen"]),
        }

    def summary(self) -> tuple[list[dict[str, Any]], int]:
        since = time.time() - FEED_RETENTION_DAYS * 86400
        with self._connect() as db:
            recent = db.execute(
                "SELECT * FROM web_notices WHERE created >= ? ORDER BY created DESC LIMIT 20",
                (since,),
            )
            items = [self._item(row) for row in recent]
            unread = db.execute(
                """SELECT COUNT(*) FROM web_notices
                   WHERE created >= ? AND seen=0 AND kind IN ('alert', 'error')""",
                (since,),
            ).fetchone()[0]
        return items, unread

    def list(
        self, *, strategy: str, kind: str, days: int, unread: bool, offset: int
    ) -> dict[str, Any]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM web_notices
                   WHERE created >= ? AND (?='' OR strategy=?) AND (?=0 OR seen=0)
                     AND (?='' OR kind=? OR (?='critical' AND kind IN ('alert', 'error')))
                   ORDER BY created DESC, id DESC LIMIT ? OFFSET ?""",
                (
                    time.time() - days * 86400,
                    strategy,
                    strategy,
                    unread,
                    kind,
                    kind,
                    kind,
                    FEED_PAGE_SIZE + 1,
                    offset,
                ),
            ).fetchall()
            strategies = db.execute(
                "SELECT DISTINCT strategy FROM web_notices WHERE created >= ? ORDER BY strategy",
                (time.time() - FEED_RETENTION_DAYS * 86400,),
            )
            return {
                "items": [self._item(row) for row in rows[:FEED_PAGE_SIZE]],
                "has_more": len(rows) > FEED_PAGE_SIZE,
                "strategies": [row[0] for row in strategies],
            }

    def mark(self, notice_id: str, *, read: bool) -> bool:
        with self._connect() as db:
            return (
                db.execute("UPDATE web_notices SET seen=? WHERE id=?", (read, notice_id)).rowcount
                > 0
            )


def parse_quiet(spec: str | None) -> tuple[int, int] | None:
    """`"23-07"` -> (23, 7). Empty means no quiet hours."""
    if not spec or not spec.strip():
        return None
    match = re.fullmatch(r"\s*(\d{1,2})\s*-\s*(\d{1,2})\s*", spec)
    if not match:
        raise ValueError("TG_QUIET_HOURS must look like 23-07")
    start, end = int(match.group(1)), int(match.group(2))
    if not (0 <= start <= 23 and 0 <= end <= 24) or start == end % 24:
        raise ValueError("TG_QUIET_HOURS hours must be 0-23 and differ")
    return start, end % 24


def is_quiet(hour: int, span: tuple[int, int] | None) -> bool:
    if span is None:
        return False
    start, end = span
    return start <= hour < end if start < end else hour >= start or hour < end


class Connections:
    """Report a connection only when it changes. Unknown counts as up."""

    def __init__(self) -> None:
        self._up: dict[str, bool] = {}
        self._lock = threading.Lock()

    def change(self, name: str, ok: bool) -> bool:
        with self._lock:
            before = self._up.get(name, True)
            self._up[name] = ok
            return before != ok


class Expiries:
    """Remind 48 hours and 12 hours before something expires, and when it has expired."""

    def __init__(self) -> None:
        self._items: dict[str, tuple[str, datetime, set[timedelta]]] = {}
        self._lock = threading.Lock()

    def watch(self, key: str, label: str, expires_at: datetime) -> None:
        if expires_at.tzinfo is None:
            raise ValueError("expires_at needs a time zone, e.g. datetime.now(timezone.utc)")
        with self._lock:
            current = self._items.get(key)
            if current is None or current[1] != expires_at:
                self._items[key] = (label, expires_at, set())  # renewed: remind again

    def due(self, now: datetime | None = None) -> list[tuple[str, str]]:
        """(key, message) for each reminder that is due now. Each one is sent once."""
        now = now or datetime.now(timezone.utc)
        messages = []
        with self._lock:
            for key, (label, expires_at, sent) in self._items.items():
                left = expires_at - now
                passed = [mark for mark in REMIND_BEFORE if left <= mark and mark not in sent]
                if not passed:
                    continue
                sent.update(REMIND_BEFORE if left <= timedelta(0) else passed)
                if left <= timedelta(0):
                    messages.append((key, tr("⛔ {0} 的授权已经过期，请重新授权。", label)))
                else:
                    hours = max(1, int(left.total_seconds() // 3600))
                    text = tr("⏰ {0} 的授权约 {1} 小时后过期，请尽快续期。", label, hours)
                    messages.append((key, text))
        return messages


@dataclass(frozen=True)
class Notice:
    sid: str
    id: str
    strategy: str
    text: str
    kind: str
    image: bytes | None


class NoticeInbox:
    """Commit an event before acknowledging the client and retain its ID on delivery."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS notice_inbox (
                sid TEXT NOT NULL, id TEXT NOT NULL, strategy TEXT NOT NULL,
                text TEXT NOT NULL, kind TEXT NOT NULL, image BLOB,
                created REAL NOT NULL, retry_at REAL NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (sid, id)
            );
            CREATE INDEX IF NOT EXISTS notice_due ON notice_inbox(retry_at) WHERE delivered=0;
            """)

    def accept(self, notice: Notice, now: float) -> bool:
        with self.db:
            return (
                self.db.execute(
                    """INSERT OR IGNORE INTO notice_inbox
                   (sid, id, strategy, text, kind, image, created, retry_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        notice.sid,
                        notice.id,
                        notice.strategy,
                        notice.text,
                        notice.kind,
                        notice.image,
                        now,
                        now,
                    ),
                ).rowcount
                == 1
            )

    def due(self, now: float, limit: int) -> list[Notice]:
        return [
            Notice(*row)
            for row in self.db.execute(
                """SELECT sid, id, strategy, text, kind, image FROM notice_inbox
               WHERE delivered=0 AND retry_at<=? ORDER BY retry_at, created LIMIT ?""",
                (now, limit),
            )
        ]

    def defer(self, notice: Notice, until: float) -> None:
        with self.db:
            self.db.execute(
                "UPDATE notice_inbox SET retry_at=? WHERE sid=? AND id=?",
                (until, notice.sid, notice.id),
            )

    def finish(self, notice: Notice) -> None:
        with self.db:
            self.db.execute(
                """UPDATE notice_inbox SET delivered=1, text='', image=NULL
                   WHERE sid=? AND id=?""",
                (notice.sid, notice.id),
            )
