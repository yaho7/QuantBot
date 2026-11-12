"""Private, bounded audit logs for actions from Web, Telegram and the CLI."""

from __future__ import annotations

import json
import logging
import os
import stat
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from quantbot.config import Store

AUDIT_FILE = "audit.jsonl"
MAX_BYTES = 2 * 1024 * 1024
BACKUPS = 3

log = logging.getLogger(__name__)


def _archive(path: Path, index: int) -> Path:
    return path.with_name(f"{path.name}.{index}")


def _open(path: Path, flags: int) -> int:
    fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise OSError("Audit log must be a regular private file")
    return fd


class Audit:
    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)
        self.store = Store(self.dir, filename=AUDIT_FILE)
        self.path = self.store.path

    def write(self, action: str, **detail: Any) -> bool:
        record = {"time": datetime.now(timezone.utc).isoformat(), "action": action, **detail}
        line = (json.dumps(record, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        if len(line) > MAX_BYTES:
            record = {key: record[key] for key in ("time", "action", "op", "ok") if key in record}
            record["truncated"] = True
            line = (json.dumps(record, default=str) + "\n").encode("utf-8")
        try:
            with self.store.locked():
                if self._size() + len(line) > MAX_BYTES:
                    self._rotate()
                with os.fdopen(
                    _open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT), "ab"
                ) as fh:
                    os.fchmod(fh.fileno(), 0o600)
                    fh.write(line)
            return True
        except OSError:
            log.exception("Could not write audit entry %s (operation %s)", action, detail.get("op"))
            return False

    def _size(self) -> int:
        try:
            with os.fdopen(_open(self.path, os.O_RDONLY), "rb") as fh:
                os.fchmod(fh.fileno(), 0o600)
                return os.fstat(fh.fileno()).st_size
        except FileNotFoundError:
            return 0

    def _rotate(self) -> None:
        for index in range(BACKUPS, 0, -1):
            source = _archive(self.path, index - 1) if index > 1 else self.path
            try:
                os.replace(source, _archive(self.path, index))
            except FileNotFoundError:
                continue


def read_audit(path: Path, limit: int) -> list[dict[str, Any]]:
    """Return recent valid records, newest first, including rotated logs."""
    records: deque[dict[str, Any]] = deque(maxlen=limit)
    for file in [*(_archive(path, index) for index in range(BACKUPS, 0, -1)), path]:
        try:
            with os.fdopen(_open(file, os.O_RDONLY), encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(record, dict):
                        records.append(record)
        except FileNotFoundError:
            continue
        except OSError:
            log.exception("Could not read audit records from %s", file)
    return list(reversed(records))
