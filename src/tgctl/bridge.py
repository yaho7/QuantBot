"""The channel between the bot and the trading thread.

The bot never touches strategy state itself. It submits a command; the trading
thread runs it when it calls `sleep()` or `process()`, and the result comes
back through a `concurrent.futures.Future`.
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any

_WAKE = object()  # queued by request_stop() so a waiting sleep() returns at once


class Stopped(Exception):
    """The trading thread is stopping and will not run this command."""


class Bridge:
    def __init__(self) -> None:
        self._queue: queue.Queue[Any] = queue.Queue()
        self._stop = threading.Event()

    # ---------------------------------------------------------------- bot side

    def submit(self, fn: Callable[..., Any], *args: Any) -> Future[Any]:
        """Queue `fn(*args)` for the trading thread."""
        future: Future[Any] = Future()
        if self._stop.is_set():
            future.set_exception(Stopped("The program is stopping."))
        else:
            self._queue.put((fn, args, future))
        return future

    def request_stop(self) -> None:
        self._stop.set()
        self._queue.put(_WAKE)

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def cancel_pending(self) -> None:
        """Fail every command still waiting, so nobody waits for it forever."""
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return
            if item is not _WAKE:
                item[2].set_exception(Stopped("The program stopped before running this."))

    # ------------------------------------------------------------ trading side

    def process(self) -> int:
        """Run every command waiting now. Returns how many ran."""
        count = 0
        while True:
            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return count
            count += self._run(item)

    def sleep(self, seconds: float) -> bool:
        """Wait up to `seconds`, running commands as they arrive.

        Returns False as soon as a stop is requested, True when the time is up.
        """
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            self.process()
            if self._stop.is_set():
                return False
            left = deadline - time.monotonic()
            if left <= 0:
                return True
            try:
                item = self._queue.get(timeout=left)
            except queue.Empty:
                continue
            self._run(item)

    @staticmethod
    def _run(item: Any) -> int:
        if item is _WAKE:
            return 0
        fn, args, future = item
        if not future.set_running_or_notify_cancel():
            return 0
        try:
            future.set_result(fn(*args))
        except BaseException as exc:  # noqa: BLE001 - every failure goes back to the caller
            future.set_exception(exc)
            if not isinstance(exc, Exception):
                raise
        return 1
