"""Settings from the environment and the strategy list from strategies.yaml."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from quantgram.notices import parse_quiet

STRATEGY_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
MIN_TOKEN = 16


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
    host: str = "0.0.0.0"  # noqa: S104 - the Docker network needs it; publish no port
    port: int = 8080
    quiet_hours: tuple[int, int] | None = None
    timezone: str = "Asia/Shanghai"
    heartbeat_url: str | None = None


def load_strategies(path: Path, env: Mapping[str, str]) -> tuple[StrategyConfig, ...]:
    try:
        raw = yaml.safe_load(path.read_text("utf-8")) or {}
    except FileNotFoundError as exc:
        raise ConfigError(f"Strategy list not found: {path}") from exc
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} is not valid YAML: {exc}") from exc
    items = raw.get("strategies") if isinstance(raw, dict) else None
    if not isinstance(items, list) or not items:
        raise ConfigError(f"{path} needs a non-empty `strategies:` list")
    found: list[StrategyConfig] = []
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise ConfigError(f"Strategy {index} must be a mapping")
        sid = str(item.get("id", ""))
        if not STRATEGY_ID.match(sid):
            raise ConfigError(f"Strategy {index}: id must be lowercase letters, digits, - or _")
        if "token" in item:
            token = str(item["token"])
        elif "token_env" in item:
            token = env.get(str(item["token_env"]), "")
            if not token:
                raise ConfigError(f"{sid}: environment variable {item['token_env']} is not set")
        else:
            raise ConfigError(f"{sid}: set token_env (or token)")
        if len(token) < MIN_TOKEN:
            raise ConfigError(f"{sid}: token must be at least {MIN_TOKEN} characters")
        found.append(StrategyConfig(sid, str(item.get("name") or sid), token))
    if len({s.id for s in found}) != len(found):
        raise ConfigError("Strategy ids must be unique")
    if len({s.token for s in found}) != len(found):
        raise ConfigError("Each strategy needs its own token")
    return tuple(found)


def load(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    token = env.get("TG_TOKEN", "")
    owner = env.get("TG_OWNER_ID", "")
    if not token:
        raise ConfigError("TG_TOKEN is not set")
    if not owner.lstrip("-").isdigit():
        raise ConfigError("TG_OWNER_ID must be your numeric Telegram id")
    listen = env.get("QG_LISTEN", "0.0.0.0:8080")  # noqa: S104
    host, _, port = listen.rpartition(":")
    if not host or not port.isdigit():
        raise ConfigError("QG_LISTEN must look like 0.0.0.0:8080")
    try:
        quiet = parse_quiet(env.get("TG_QUIET_HOURS"))
    except ValueError as exc:
        raise ConfigError(str(exc)) from exc
    return Settings(
        tg_token=token,
        owner_id=int(owner),
        strategies=load_strategies(Path(env.get("QG_CONFIG", "/config/strategies.yaml")), env),
        data_dir=Path(env.get("QG_DATA_DIR", "/data")),
        host=host,
        port=int(port),
        quiet_hours=quiet,
        timezone=env.get("TG_TIMEZONE", "Asia/Shanghai"),
        heartbeat_url=env.get("HEARTBEAT_URL") or None,
    )
