"""QuantBot client for Python trading programs. One file, standard library only.

`quantbot link` in your project adds this to it. Then:

    from quantbot_client import QuantBot

    qb = QuantBot("momentum")           # finds QuantBot on this machine by itself
    qb.on("positions", lambda: broker.positions_text())
    qb.on("flatten", flatten_my_positions)

    with qb:                            # an exception here is reported, then re-raised
        while not qb.stopping:
            trade_once(allow_new=qb.can_open())
            qb.status(f"净值 {equity:.2f}")
            qb.heartbeat()              # optional, needs QB_HEARTBEAT_URL
            if not qb.sleep(60):        # runs button commands while it waits
                break

Commands run on the thread that calls `sleep()` or `process()`, never on a
background thread, so handlers can touch trading state without locks. When
QuantBot is down, trading goes on: the client keeps retrying in the background.
See PROTOCOL.md for the wire format.
"""

from __future__ import annotations

import base64
import collections
import json
import logging
import os
import queue
import re
import secrets
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

__all__ = ["QuantBot"]

log = logging.getLogger("quantbot_client")

COMMANDS = (
    "status", "pause", "resume", "positions", "orders", "cancel", "flatten",
    "params", "set_param", "manual_order", "chart", "stop",
)  # fmt: skip
DATA_COMMANDS = {"status", "orders", "params", "chart"}  # the return value is data
POLL_WAIT = 25
REMEMBER_RESULTS = 200
EVENT_BACKLOG = 500
_WAKE = object()


NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _config_path() -> Path:
    """Where QuantBot on this machine keeps its settings (see quantbot/config.py)."""
    if os.environ.get("QB_DATA_DIR"):
        return Path(os.environ["QB_DATA_DIR"]).expanduser() / "quantbot.json"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "quantbot" / "quantbot.json"


def _default_name() -> str:
    """The project folder's name, made into a valid strategy id."""
    name = re.sub(r"[^a-z0-9_-]+", "-", Path.cwd().name.lower()).strip("-_")[:32]
    return name if NAME.match(name) else "strategy"


def _url_from(listen: str) -> str:
    host, _, port = listen.rpartition(":")
    return f"http://{'127.0.0.1' if host in {'0.0.0.0', '::', ''} else host}:{port}"  # noqa: S104


def connect_locally(name: str, display_name: str | None = None) -> tuple[str, str]:
    """Find this strategy in the local QuantBot settings, adding it if it is new.

    Returns (url, token). QuantBot picks up a new strategy within seconds.
    """
    path = _config_path()
    try:
        data = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"No QuantBot settings at {path}. Install QuantBot on this machine and run "
            "`quantbot setup`, or set QB_URL and QB_TOKEN."
        ) from exc
    items = data.setdefault("strategies", [])
    found = next((item for item in items if item.get("id") == name), None)
    if found is None:
        found = {"id": name, "name": display_name or name, "token": secrets.token_urlsafe(32)}
        items.append(found)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".quantbot-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        log.info("Added %s to QuantBot", name)
    listen = os.environ.get("QB_LISTEN") or data.get("listen")
    if not listen:
        raise RuntimeError("QuantBot has not picked its port yet. Run `quantbot setup` first.")
    return _url_from(str(listen)), str(found["token"])


class QuantBot:
    def __init__(
        self,
        name: str | None = None,
        *,
        display_name: str | None = None,
        url: str | None = None,
        token: str | None = None,
        heartbeat_url: str | None = None,
        state_file: str | None = None,
    ) -> None:
        """Connect to QuantBot.

        With QuantBot on the same machine, a name is all it takes:
        `QuantBot("momentum")`. Without one, the project folder's name is used.
        The strategy is added to QuantBot the first time it connects.
        QB_URL and QB_TOKEN (or url= and token=) connect to a QuantBot elsewhere.
        """
        url = url or os.environ.get("QB_URL", "")
        token = token or os.environ.get("QB_TOKEN", "")
        if not token:
            name = name or os.environ.get("QB_NAME") or _default_name()
            if not NAME.match(name):
                raise ValueError("Strategy name: lowercase letters, digits, - and _, e.g. momentum")
            local_url, token = connect_locally(name, display_name)
            url = url or local_url
        if not url.startswith(("http://", "https://")):
            raise ValueError("QB_URL must start with http:// or https://")
        self.name = name
        self.url = url.rstrip("/")
        self._token = token
        self._heartbeat_url = heartbeat_url or os.environ.get("QB_HEARTBEAT_URL") or None
        if self._heartbeat_url and not self._heartbeat_url.startswith(("http://", "https://")):
            raise ValueError("QB_HEARTBEAT_URL must start with https:// or http://")
        self._last_beat = float("-inf")
        self._state_file = state_file or os.environ.get("QB_STATE_FILE") or None
        self._handlers: dict[str, Callable[..., Any]] = {}
        self._commands: queue.Queue[Any] = queue.Queue()
        self._events: collections.deque[tuple[str, dict[str, Any]]] = collections.deque(
            maxlen=EVENT_BACKLOG
        )
        self._events_ready = threading.Event()
        self._seen: collections.OrderedDict[str, dict[str, Any] | None] = (
            collections.OrderedDict()
        )  # command id -> result (None while it waits to run)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._closed = threading.Event()
        self._threads: list[threading.Thread] = []
        self._hello_sent = False
        self.paused = self._load_paused()

    # ------------------------------------------------------------- setup

    def on(self, name: str, handler: Callable[..., Any]) -> QuantBot:
        """Handle a command. The handler gets the command's args as keyword arguments.

        Return a text for people, or data for `status`, `orders`, `params` and
        `chart` (PNG bytes). Raise an exception to report a failure.
        `pause`, `resume` and `stop` work without a handler.
        """
        if name not in COMMANDS:
            raise ValueError(f"Unknown command {name!r}. Known: {', '.join(COMMANDS)}")
        self._handlers[name] = handler
        if self._hello_sent:
            self._hello()
        return self

    def command(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Decorator form of `on()`."""

        def register(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.on(name, fn)
            return fn

        return register

    def start(self) -> QuantBot:
        if self._threads:
            return self
        self._hello()
        for target, name in (
            (self._poll_loop, "quantbot-poll"),
            (self._send_loop, "quantbot-send"),
        ):
            thread = threading.Thread(target=target, name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def close(self, timeout: float = 5.0) -> None:
        """Send what is left (up to `timeout` seconds) and stop the background threads."""
        self._stop.set()
        self._commands.put(_WAKE)
        deadline = time.monotonic() + timeout
        while self._events and time.monotonic() < deadline and self._threads:
            time.sleep(0.05)
        self._closed.set()
        self._events_ready.set()

    def __enter__(self) -> QuantBot:
        return self.start()

    def __exit__(self, kind: Any, error: BaseException | None, tb: Any) -> None:
        if error is not None and not isinstance(error, KeyboardInterrupt):
            text = "".join(traceback.format_exception(kind, error, tb))
            self.error(f"程序出错退出：{type(error).__name__}: {error}\n\n{text[-1500:]}")
            self.heartbeat_fail(text)
        self.close()

    # ------------------------------------------------ for the trading loop

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def can_open(self) -> bool:
        """Check right before placing an order that opens or grows a position."""
        return not self.paused and not self.stopping

    def sleep(self, seconds: float) -> bool:
        """Wait, running commands as they arrive. False as soon as a stop is requested."""
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            self.process()
            if self.stopping:
                return False
            left = deadline - time.monotonic()
            if left <= 0:
                return True
            try:
                item = self._commands.get(timeout=left)
            except queue.Empty:
                continue
            self._run(item)

    def process(self) -> int:
        """Run every command waiting now, without waiting. Returns how many ran."""
        count = 0
        while True:
            try:
                item = self._commands.get_nowait()
            except queue.Empty:
                return count
            count += self._run(item)

    # --------------------------------------------------------- reporting

    def status(self, text: str, paused: bool | None = None) -> None:
        """A snapshot shown on the strategy page. Send one each round."""
        self._event("status", text=text, paused=self.paused if paused is None else paused)

    def fill(self, message: str) -> None:
        self._event("fill", message=message)

    def info(self, message: str) -> None:
        self._event("info", message=message)

    def alert(self, message: str) -> None:
        self._event("alert", message=message)

    def error(self, message: str) -> None:
        self._event("error", message=message)

    def summary(self, message: str, png: bytes | None = None) -> None:
        image = base64.b64encode(png).decode() if png else None
        self._event("summary", message=message, image=image)

    def connection(self, name: str, ok: bool, detail: str = "") -> None:
        """Report a connection's state. QuantBot only notifies when it changes."""
        self._event("connection", name=name, ok=ok, detail=detail)

    def expiry(self, name: str, expires_at: Any) -> None:
        """When a login runs out (a timezone-aware datetime), e.g. Schwab's 7 days."""
        value = expires_at.isoformat() if hasattr(expires_at, "isoformat") else str(expires_at)
        self._event("expiry", name=name, expires_at=value)

    def risk_triggered(self, reason: str) -> None:
        """Pause new positions and say why."""
        self._set_paused(True)
        self.alert(f"风控触发，已暂停开仓：{reason}")

    def heartbeat(self) -> bool:
        """Ping QB_HEARTBEAT_URL after a good round, at most every 30 seconds."""
        if not self._heartbeat_url or time.monotonic() - self._last_beat < 30:
            return False
        self._last_beat = time.monotonic()
        threading.Thread(target=self._beat, args=(self._heartbeat_url, None), daemon=True).start()
        return True

    def heartbeat_fail(self, message: str = "") -> None:
        if self._heartbeat_url:
            self._beat(self._heartbeat_url.rstrip("/") + "/fail", message[-10_000:].encode())

    # ---------------------------------------------------------- internals

    def _event(self, kind: str, **fields: Any) -> None:
        body = {"type": kind, **{k: v for k, v in fields.items() if v is not None}}
        self._events.append(("/v1/events", body))
        self._events_ready.set()

    def _hello(self) -> None:
        names = sorted({"pause", "resume", "stop", *self._handlers})
        self._event("hello", commands=names)
        self._hello_sent = True

    def _load_paused(self) -> bool:
        if not self._state_file:
            return False
        try:
            with open(self._state_file, encoding="utf-8") as fh:
                return bool(json.load(fh).get("paused"))
        except FileNotFoundError:
            return False
        except (OSError, ValueError):
            return True  # a damaged file must not resume trading silently

    def _set_paused(self, paused: bool) -> None:
        self.paused = paused
        if self._state_file:
            tmp = self._state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"paused": paused}, fh)
            os.replace(tmp, self._state_file)

    def _request(self, method: str, path: str, body: Any = None, timeout: float = 10) -> Any:
        data = None if body is None else json.dumps(body, default=str).encode()
        request = urllib.request.Request(  # noqa: S310 - scheme checked in __init__
            self.url + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return json.loads(response.read() or b"null")

    def _poll_loop(self) -> None:
        backoff = 1.0
        while not self.stopping:
            try:
                reply = self._request(
                    "GET", f"/v1/commands?wait={POLL_WAIT}", timeout=POLL_WAIT + 10
                )
                backoff = 1.0
            except urllib.error.HTTPError as exc:
                log.warning("QuantBot refused the poll: HTTP %s", exc.code)
                self._stop.wait(min(backoff, 30))
                backoff *= 2
                continue
            except (OSError, ValueError) as exc:
                log.info("QuantBot not reachable (%s); trading goes on", exc)
                self._stop.wait(min(backoff, 30))
                backoff *= 2
                continue
            if reply.get("need_hello"):
                self._hello()
            for command in reply.get("commands") or []:
                self._accept(command)

    def _accept(self, command: dict[str, Any]) -> None:
        cid = str(command.get("id", ""))
        if not cid:
            return
        with self._lock:
            if cid in self._seen:
                done = self._seen[cid]
                if done is not None:  # ran already: report the same result again
                    self._events.append((f"/v1/commands/{cid}/result", done))
                    self._events_ready.set()
                return
            self._seen[cid] = None
            while len(self._seen) > REMEMBER_RESULTS:
                self._seen.popitem(last=False)
        self._commands.put(command)

    def _run(self, item: Any) -> int:
        if item is _WAKE:
            return 0
        cid, name = str(item["id"]), str(item.get("name"))
        args = item.get("args") or {}
        try:
            result = {"ok": True, **self._execute(name, args)}
        except Exception as exc:  # noqa: BLE001 - the error is the answer
            result = {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
        with self._lock:
            self._seen[cid] = result
        self._events.append((f"/v1/commands/{urllib.parse.quote(cid)}/result", result))
        self._events_ready.set()
        return 1

    def _execute(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        handler = self._handlers.get(name)
        if name == "stop":
            if handler:
                handler(**args)
            self._stop.set()
            return {"message": "正在停止，交易循环退出后结束。"}
        if handler is None and name in {"pause", "resume"}:
            self._set_paused(name == "pause")
            return {
                "message": "已暂停开仓。已有仓位和止损照常。" if name == "pause" else "已恢复开仓。"
            }
        if handler is None:
            raise RuntimeError(f"这个程序不支持 {name}")
        if name in {"pause", "resume"}:
            self._set_paused(name == "pause")
        value = handler(**args)
        if name not in DATA_COMMANDS:
            return {"message": "" if value is None else str(value)}
        if name == "status" and isinstance(value, str):
            value = {"text": value, "paused": self.paused}
        if name == "chart" and isinstance(value, bytes | bytearray):
            value = base64.b64encode(bytes(value)).decode()
        return {"data": value}

    def _send_loop(self) -> None:
        backoff = 1.0
        while not self._closed.is_set() or self._events:
            if not self._events:
                self._events_ready.clear()
                if self._closed.is_set():
                    return
                self._events_ready.wait(1.0)
                continue
            path, body = self._events[0]
            try:
                self._request("POST", path, body)
            except urllib.error.HTTPError as exc:
                if exc.code >= 500 or exc.code == 429:
                    self._closed.wait(min(backoff, 30))
                    backoff *= 2
                    continue
                if exc.code != 404:  # 404: an old command QuantBot no longer waits for
                    log.warning("QuantBot rejected %s: HTTP %s", path, exc.code)
            except (OSError, ValueError):
                if self._closed.is_set():
                    return
                self._closed.wait(min(backoff, 30))
                backoff *= 2
                continue
            backoff = 1.0
            self._events.popleft()

    def _beat(self, url: str, body: bytes | None) -> None:
        request = urllib.request.Request(url, data=body, method="POST" if body else "GET")  # noqa: S310
        try:
            with urllib.request.urlopen(request, timeout=10):  # noqa: S310
                pass
        except OSError as exc:
            log.warning("Heartbeat failed: %s", exc)
