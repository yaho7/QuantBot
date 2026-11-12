"""One self-hosted control plane process per SQLite database."""

import asyncio
import fcntl
import logging
import math
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from pathlib import Path

from .auth import Auth
from .commands import Commands
from .control_registry import Controls
from .db import Database
from .errors import Problem
from .registry import Registry
from .strategies import Strategies
from .telemetry import Telemetry

log = logging.getLogger(__name__)


@contextmanager
def exclusive_database(path: Path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another QuantBot server is already using this database") from None
        yield


class Runtime:
    def __init__(self, path, clock=time.time):
        self.db = Database(path)
        self.clock = clock
        self.change = asyncio.Event()
        self.version = 0
        self.auth = Auth(self.db, clock)
        self.strategies = Strategies(self.db, self.auth, clock, self.wake)
        self.commands = Commands(self.db, self.strategies, clock, self.wake)
        self.strategies.commands = self.commands
        self.telemetry = Telemetry(self.db, self.strategies, clock, self.wake)
        self.controls = Controls(self)
        self.commands.controls = self.controls
        self.registry = Registry(self)
        self.telemetry.registry = self.strategies.registry = self.registry
        self.requests = defaultdict(deque)
        self.rate_limit_swept = 0
        self.polling = set()

    def wake(self):
        self.version += 1
        self.change.set()
        self.change = asyncio.Event()

    def limit(self, lane, key, count, seconds):
        now = time.monotonic()
        if now - self.rate_limit_swept >= 60:
            self.requests = defaultdict(
                deque, {k: q for k, q in self.requests.items() if q and q[-1] > now - 300}
            )
            self.rate_limit_swept = now
        queue = self.requests[(lane, key)]
        while queue and queue[0] <= now - seconds:
            queue.popleft()
        if len(queue) >= count:
            raise Problem(
                429, "Rate limit exceeded", retry_after=max(1, math.ceil(queue[0] + seconds - now))
            )
        queue.append(now)

    async def upkeep(self):
        last_purge = float("-inf")
        while True:
            self.commands.sweep()
            with self.db.transaction():
                for row in self.db.all("SELECT id FROM strategies WHERE archived_at IS NULL"):
                    self.strategies.refresh_presence(row["id"])
            if self.clock() - last_purge >= 3600:
                self.telemetry.purge()
                last_purge = self.clock()
            await asyncio.sleep(3)
