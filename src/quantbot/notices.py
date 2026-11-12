"""When and how loudly to send: quiet hours, connection changes, expiry reminders."""

from __future__ import annotations

import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from quantbot.i18n import tr

# Kinds of message. Quiet hours deliver "info" and "trade" silently; the others ring.
KINDS = ("info", "trade", "alert", "error")
LOUD = {"alert", "error"}
REMIND_BEFORE = (timedelta(hours=48), timedelta(hours=12), timedelta(0))


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
