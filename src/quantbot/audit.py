"""An append-only record of every action taken from Telegram."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AUDIT_FILE = "audit.jsonl"


class Audit:
    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / AUDIT_FILE
        self._lock = threading.Lock()

    def write(self, action: str, **detail: Any) -> None:
        record = {"time": datetime.now(timezone.utc).isoformat(), "action": action, **detail}
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock, self.path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
