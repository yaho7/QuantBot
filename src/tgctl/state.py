"""State that must survive a restart: the pause switch, plus an audit log."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class State:
    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._path = self.dir / "state.json"
        self._audit = self.dir / "audit.jsonl"
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {"paused": False, "pause_reason": ""}
        try:
            loaded = json.loads(self._path.read_text("utf-8"))
            if isinstance(loaded, dict):
                self._data.update(loaded)
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            # A damaged file must not resume trading silently: start paused.
            self._data.update(paused=True, pause_reason="state file could not be read")

    @property
    def paused(self) -> bool:
        with self._lock:
            return bool(self._data["paused"])

    @property
    def pause_reason(self) -> str:
        with self._lock:
            return str(self._data.get("pause_reason") or "")

    def set_paused(self, paused: bool, reason: str = "") -> bool:
        """Change the switch and save it. Returns True when it changed."""
        with self._lock:
            changed = bool(self._data["paused"]) != paused
            self._data.update(paused=paused, pause_reason=reason if paused else "")
            self._save()
            return changed

    def _save(self) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".state-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self._data, fh)
            os.replace(tmp, self._path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def audit(self, action: str, **detail: Any) -> None:
        record = {"time": datetime.now(timezone.utc).isoformat(), "action": action, **detail}
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock, self._audit.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
