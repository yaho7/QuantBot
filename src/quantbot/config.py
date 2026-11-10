"""Settings live in one JSON file in the data volume, written by `quantbot setup` and `add`.

Nothing has to be passed through the environment. Two optional variables
change where things are: QB_DATA_DIR (default ~/.config/quantbot) and
QB_LISTEN (default: `listen` in the file, a random free port on 127.0.0.1 picked
the first time, so only programs on this machine can connect).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import socket
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from quantbot.notices import parse_quiet

STRATEGY_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
BOT_TOKEN = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")
MIN_TOKEN = 16
FILE_NAME = "quantbot.json"
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
    raise ConfigError("找不到空闲端口，请用 --port 指定一个")


def check_listen(listen: str) -> str:
    host, _, port = listen.strip().rpartition(":")
    if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ConfigError(f"监听地址 {listen!r} 不对，要像 127.0.0.1:23456")
    return f"{host}:{int(port)}"


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class StrategyConfig:
    id: str
    name: str
    token: str = field(repr=False)


@dataclass(frozen=True)
class Settings:
    tg_token: str = field(repr=False)
    owner_id: int
    strategies: tuple[StrategyConfig, ...]
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8080
    quiet_hours: tuple[int, int] | None = None
    timezone: str = "Asia/Shanghai"
    heartbeat_url: str | None = None

    def telegram_key(self) -> tuple[Any, ...]:
        """Everything that needs a restart to change. Strategies reload on their own."""
        return (self.tg_token, self.owner_id, self.quiet_hours, self.timezone, self.heartbeat_url)


def data_dir(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    if env.get("QB_DATA_DIR"):
        return Path(env["QB_DATA_DIR"]).expanduser()
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME") or Path.home()) / ".config")
    return Path(base) / "quantbot"


def new_token() -> str:
    return secrets.token_urlsafe(32)


def check_strategy_id(sid: str) -> str:
    if not STRATEGY_ID.match(sid):
        raise ConfigError("id 只能用小写字母、数字、- 和 _，最多 32 个字符，例如 momentum")
    return sid


def check_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ConfigError(f"不认识时区 {name}，例如 Asia/Shanghai 或 America/New_York") from exc
    return name


def check_url(url: str | None) -> str | None:
    if url and not url.startswith(("https://", "http://")):
        raise ConfigError("地址要以 https:// 或 http:// 开头")
    return url or None


class Store:
    """Reads and writes quantbot.json. Writes are atomic and the file is private."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.path = directory / FILE_NAME

    def exists(self) -> bool:
        return self.path.is_file()

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
            raise ConfigError(f"{self.path} 读不出来：{exc}") from exc
        if not isinstance(data, dict):
            raise ConfigError(f"{self.path} 格式不对")
        return data

    def write(self, data: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".quantbot-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # ------------------------------------------------------------ settings

    def ensure_listen(self, env: Mapping[str, str] | None = None) -> str:
        """The address QuantBot listens on. The first time, pick a free random port and save it."""
        env = os.environ if env is None else env
        if env.get("QB_LISTEN"):
            return check_listen(env["QB_LISTEN"])
        data = self.read()
        if data.get("listen"):
            return check_listen(str(data["listen"]))
        data["listen"] = f"{LOCALHOST}:{free_port()}"
        self.write(data)
        return str(data["listen"])

    def strategies(self, data: dict[str, Any] | None = None) -> tuple[StrategyConfig, ...]:
        data = self.read() if data is None else data
        found = []
        for item in data.get("strategies") or []:
            sid, token = str(item.get("id", "")), str(item.get("token", ""))
            if not STRATEGY_ID.match(sid) or len(token) < MIN_TOKEN:
                raise ConfigError(f"{self.path} 里的策略 {sid!r} 不完整")
            found.append(StrategyConfig(sid, str(item.get("name") or sid), token))
        return tuple(found)

    def settings(self, env: Mapping[str, str] | None = None) -> Settings:
        """The running settings, or ConfigError saying what is missing."""
        env = os.environ if env is None else env
        data = self.read()
        telegram = data.get("telegram") or {}
        token, owner = str(telegram.get("token") or ""), telegram.get("owner_id")
        if not token or not isinstance(owner, int):
            raise ConfigError("还没配置 Telegram。运行：quantbot setup")
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
        )
