"""Pings to an outside monitor such as Healthchecks.io.

The monitor alerts on its own when pings stop, so it still works when the
program and the bot are both stuck.
"""

from __future__ import annotations

import logging
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable

log = logging.getLogger("tgctl.heartbeat")

Opener = Callable[[urllib.request.Request, float], object]


def _open(request: urllib.request.Request, timeout: float) -> object:
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - user URL
        return response.status


class Heartbeat:
    def __init__(self, url: str | None, min_interval: float = 30.0, opener: Opener = _open) -> None:
        if url and not url.startswith(("https://", "http://")):
            raise ValueError("HEARTBEAT_URL must start with https:// or http://")
        self.url = url.rstrip("/") if url else None
        self.min_interval = min_interval
        self._open = opener
        self._last = float("-inf")
        self._lock = threading.Lock()

    def ping(self) -> bool:
        """Ping in the background, at most once per `min_interval`. Never blocks."""
        if not self.url:
            return False
        with self._lock:
            now = time.monotonic()
            if now - self._last < self.min_interval:
                return False
            self._last = now
        threading.Thread(target=self._send, args=(self.url, None), daemon=True).start()
        return True

    def fail(self, message: str = "") -> None:
        """Report a failure now (Healthchecks.io's `/fail` endpoint)."""
        if self.url:
            self._send(self.url + "/fail", message[-10_000:].encode("utf-8"))

    def _send(self, url: str, body: bytes | None) -> None:
        # The scheme is checked to be http(s) in __init__.
        request = urllib.request.Request(url, data=body, method="POST" if body else "GET")  # noqa: S310
        try:
            self._open(request, 10.0)
        except Exception as exc:  # noqa: BLE001 - a monitor outage must not stop trading
            # The ping URL is a secret: log only its host.
            log.warning("Heartbeat to %s failed: %s", urllib.parse.urlsplit(url).netloc, exc)
