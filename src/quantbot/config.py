"""Settings live in one JSON file in the data volume, written by `quantbot setup` and `add`.

Nothing has to be passed through the environment. Two optional variables
change where things are: QB_DATA_DIR (default ~/.config/quantbot) and
QB_LISTEN (default: `listen` in the file, a random free port on 127.0.0.1 picked
the first time, so only programs on this machine can connect).
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import socket
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from quantbot.i18n import DEFAULT_LANGUAGE, normalize_language, tr
from quantbot.notices import parse_quiet

STRATEGY_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
BOT_TOKEN = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")
MIN_TOKEN = 16
FILE_NAME = "quantbot.json"
USED_LINKS_FILE = "used-web-links.json"
LOCALHOST = "127.0.0.1"
PORT_RANGE = (20000, 39999)  # below most systems' range for outgoing connections


def port_free(port: int, host: str = LOCALHOST) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def free_port(tries: int = 100) -> int:
    """A random free port in PORT_RANGE."""
    for _ in range(tries):
        port = secrets.choice(range(PORT_RANGE[0], PORT_RANGE[1] + 1))
        if port_free(port):
            return port
    raise ConfigError(tr("找不到空闲端口，请用 --port 指定一个"))


def check_listen(listen: str) -> str:
    host, _, port = listen.strip().rpartition(":")
    if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ConfigError(tr("监听地址 {0!r} 不对，要像 127.0.0.1:23456", listen))
    return f"{host}:{int(port)}"


def local_origin(listen: str) -> str:
    host, _, port = listen.rpartition(":")
    if host in {"0.0.0.0", "::", ""}:  # noqa: S104
        host = LOCALHOST
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"


class ConfigError(ValueError):
    pass


MAX_ORDER_QTY = 1_000_000


def valid_order_qty(value: object, maximum: float) -> bool:
    # Compare before isfinite() so oversized integers cannot overflow float conversion.
    return type(value) in (int, float) and 0 < value <= maximum and math.isfinite(value)


@dataclass(frozen=True)
class StrategyConfig:
    id: str
    name: str
    token: str = field(repr=False)
    max_order_qty: float = MAX_ORDER_QTY


@dataclass(frozen=True)
class Settings:
    tg_token: str | None = field(repr=False)  # None: no Telegram, the web page only
    owner_id: int | None
    strategies: tuple[StrategyConfig, ...]
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8080
    quiet_hours: tuple[int, int] | None = None
    timezone: str = "Asia/Shanghai"
    heartbeat_url: str | None = None
    public_url: str | None = None
    language: str = DEFAULT_LANGUAGE

    @property
    def telegram(self) -> bool:
        return bool(self.tg_token) and self.owner_id is not None

    def telegram_key(self) -> tuple[Any, ...]:
        """Everything that needs a restart to change. Strategies reload on their own."""
        return (
            self.tg_token,
            self.owner_id,
            self.host,
            self.port,
            self.quiet_hours,
            self.timezone,
            self.heartbeat_url,
        )


def data_dir(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    if env.get("QB_DATA_DIR"):
        return Path(env["QB_DATA_DIR"]).expanduser()
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME") or Path.home()) / ".config")
    return Path(base) / "quantbot"


def new_token() -> str:
    return secrets.token_urlsafe(32)


def set_web_admin(data: dict[str, Any], admin: dict[str, str]) -> bool:
    """Rotate the session secret when the administrator credentials change."""
    if data.get("web_admin") == admin:
        return False
    data["web_admin"] = admin
    data["web_secret"] = new_token()
    return True


def strategy_item(data: dict[str, Any], sid: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in data.get("strategies") or []
            if isinstance(item, dict) and item.get("id") == sid
        ),
        None,
    )


def require_strategy(data: dict[str, Any], sid: str) -> dict[str, Any]:
    item = strategy_item(data, sid)
    if item is None:
        raise ConfigError(tr("没有策略 {0}。", sid))
    return item


def add_strategy(data: dict[str, Any], sid: str, name: str) -> dict[str, Any]:
    if strategy_item(data, sid):
        raise ConfigError(tr("已经有策略 {0}。", sid))
    item = {"id": sid, "name": name, "token": new_token()}
    items = data.get("strategies") or []
    items.append(item)
    data["strategies"] = items
    return item


def check_strategy_id(sid: str) -> str:
    if not STRATEGY_ID.match(sid):
        raise ConfigError(tr("id 只能用小写字母、数字、- 和 _，最多 32 个字符，例如 momentum"))
    return sid


@lru_cache(maxsize=1)
def timezones() -> tuple[str, ...]:
    return tuple(sorted(available_timezones(), key=str.casefold))


def check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ConfigError(
            tr("不认识时区 {0}，例如 Asia/Shanghai 或 America/New_York", name)
        ) from exc
    return name


def check_url(url: str | None) -> str | None:
    if url and not url.startswith(("https://", "http://")):
        raise ConfigError(tr("地址要以 https:// 或 http:// 开头"))
    return url or None


def check_public_url(url: str | None) -> str | None:
    if not url:
        return None
    message = tr("网页地址需要是域名或 IP 的 HTTP(S) 地址，例如 https://bot.example.com。")
    try:
        if not isinstance(url, str):
            raise ValueError
        url = url.strip()
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.path not in {"", "/", "/ui", "/ui/"}
            or any(char.isspace() or char in "\\%?#" or ord(char) < 32 for char in url)
        ):
            raise ValueError
        port = parsed.port
        if port == 0:
            raise ValueError
        host = parsed.hostname
        if ":" in host:
            host = f"[{host}]"
        else:
            host = host.encode("idna").decode("ascii")
            if not re.fullmatch(r"[a-z0-9.-]+", host):
                raise ValueError
    except ValueError as exc:
        raise ConfigError(message) from exc
    default_port = 443 if parsed.scheme == "https" else 80
    suffix = f":{port}" if port is not None and port != default_port else ""
    return f"{parsed.scheme}://{host}{suffix}"


class Store:
    """Reads and writes a settings file. Writes are atomic and the file is private."""

    def __init__(self, directory: Path, *, filename: str = FILE_NAME) -> None:
        self.dir = directory
        self.path = directory / filename

    def exists(self) -> bool:
        return self.path.is_file()

    def language(self) -> str:
        try:
            return normalize_language(self.read().get("language"))
        except ConfigError:
            return DEFAULT_LANGUAGE

    def mtime(self) -> int | None:
        try:
            return self.path.stat().st_mtime_ns
        except FileNotFoundError:
            return None

    def read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            raise ConfigError(tr("{0} 读不出来：{1}", self.path, exc)) from exc
        if not isinstance(data, dict):
            raise ConfigError(tr("{0} 格式不对", self.path))
        return data

    def write(self, data: dict[str, Any]) -> None:
        with self._locked():
            self._write(data)

    def _write(self, data: dict[str, Any]) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".quantbot-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.dir.mkdir(parents=True, exist_ok=True)
        with self.path.with_name(f".{self.path.name}.lock").open("a") as lock:
            if os.name == "posix":
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    @contextmanager
    def edit(self) -> Iterator[dict[str, Any]]:
        """Merge edits against the current settings under a short process lock."""
        with self._locked():
            data = self.read()
            before = deepcopy(data)
            yield data
            if data != before:
                self._write(data)

    # ------------------------------------------------------------ settings

    def ensure_listen(self, env: Mapping[str, str] | None = None) -> str:
        """The address QuantBot listens on. The first time, pick a free random port and save it."""
        env = os.environ if env is None else env
        if env.get("QB_LISTEN"):
            return check_listen(env["QB_LISTEN"])
        data = self.read()
        if data.get("listen"):
            return check_listen(str(data["listen"]))
        with self.edit() as data:
            if not data.get("listen"):
                data["listen"] = f"{LOCALHOST}:{free_port()}"
            return check_listen(str(data["listen"]))

    def web_secret(self) -> str:
        """The key that signs web login links and cookies. Made the first time it is needed."""
        data = self.read()
        if data.get("web_secret"):
            return str(data["web_secret"])
        with self.edit() as data:
            if not data.get("web_secret"):
                data["web_secret"] = new_token()
            return str(data["web_secret"])

    def strategies(self, data: dict[str, Any] | None = None) -> tuple[StrategyConfig, ...]:
        data = self.read() if data is None else data
        found = []
        for item in data.get("strategies") or []:
            sid, token = str(item.get("id", "")), str(item.get("token", ""))
            if not STRATEGY_ID.match(sid) or len(token) < MIN_TOKEN:
                raise ConfigError(tr("{0} 里的策略 {1!r} 不完整", self.path, sid))
            limit = item.get("max_order_qty", MAX_ORDER_QTY)
            if not valid_order_qty(limit, MAX_ORDER_QTY):
                raise ConfigError(tr("策略 {0} 的下单数量上限无效。", sid))
            found.append(StrategyConfig(sid, str(item.get("name") or sid), token, limit))
        return tuple(found)

    def settings(self, env: Mapping[str, str] | None = None) -> Settings:
        """The running settings, or ConfigError saying what is missing."""
        env = os.environ if env is None else env
        data = self.read()
        telegram = data.get("telegram") or {}
        token = str(telegram.get("token") or "") or None
        owner = telegram.get("owner_id") if isinstance(telegram.get("owner_id"), int) else None
        if not (token and owner is not None):
            token, owner = None, None  # Telegram is optional; half a setting counts as none
        host, _, port = self.ensure_listen(env).rpartition(":")
        try:
            quiet = parse_quiet(data.get("quiet_hours"))
        except ValueError as exc:
            raise ConfigError(str(exc)) from exc
        return Settings(
            tg_token=token,
            owner_id=owner,
            strategies=self.strategies(data),
            data_dir=self.dir,
            host=host,
            port=int(port),
            quiet_hours=quiet,
            timezone=check_timezone(str(data.get("timezone") or "Asia/Shanghai")),
            heartbeat_url=check_url(data.get("heartbeat_url")),
            public_url=check_public_url(data.get("public_url")),
            language=normalize_language(data.get("language")),
        )
