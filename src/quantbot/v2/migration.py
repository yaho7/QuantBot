"""Read-only v1 import and consistent SQLite backup."""

import json
import re
import shutil
import sqlite3
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import NAMESPACE_URL, uuid5

from .auth import digest
from .db import encode
from .models import StrategySettings
from .runtime import Runtime, exclusive_database
from .telegram_settings import TG_TOKEN, TelegramConfig, TelegramUpdate

LEGACY_CONFIG = "quantbot.json"
LEGACY_DATABASES = ("operations.sqlite3", "web-notices.sqlite3")
LEGACY_LOGS = ("audit.jsonl", "audit.jsonl.1", "audit.jsonl.2", "audit.jsonl.3")
OLD_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
OLD_PASSWORD = re.compile(r"scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}")
COMMAND_STATES = {
    "CREATED": "expired",
    "ACCEPTED": "expired",
    "EXECUTING": "unknown",
    "UNKNOWN": "unknown",
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "EXPIRED": "expired",
    "CANCELLED": "cancelled",
}


def readonly(path: Path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def backup_sqlite(source: Path, destination: Path):
    if not source.is_file():
        raise ValueError(f"Database does not exist: {source}")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.touch(mode=0o600, exist_ok=False)
    try:
        with closing(readonly(source)) as old, closing(sqlite3.connect(destination)) as new:
            old.backup(new)
            if new.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Backup database integrity check failed")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def legacy_backup(source, destination):
    config = source / LEGACY_CONFIG
    if not config.is_file():
        raise ValueError(f"Legacy configuration was not found in {source}")
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in (LEGACY_CONFIG, *LEGACY_LOGS):
        path = source / name
        if path.is_file():
            target = destination / name
            target.touch(mode=0o600, exist_ok=False)
            shutil.copyfile(path, target)
    for name in LEGACY_DATABASES:
        path = source / name
        if path.is_file():
            backup_sqlite(path, destination / name)


def legacy_rows(path, table):
    if not path.is_file():
        return []
    queries = {
        "operations": "SELECT * FROM operations ORDER BY updated",
        "pause_intents": "SELECT * FROM pause_intents",
        "web_notices": "SELECT * FROM web_notices ORDER BY created",
    }
    with closing(readonly(path)) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone():
            return []
        return connection.execute(queries[table]).fetchall()


def import_strategies(service, config, mode, now):
    db = service.db
    strategies = {}
    for item in config.get("strategies") or []:
        sid = str(item.get("id", ""))
        if not OLD_ID.fullmatch(sid) or sid in strategies:
            raise ValueError("Legacy configuration contains an invalid or duplicate strategy ID")
        name = (str(item.get("name") or sid).strip() or sid)[:100]
        strategies[sid] = name
        settings = StrategySettings(name=name, mode=mode).model_dump(mode="json")
        db.execute(
            "INSERT INTO strategies(id, settings, created_at) VALUES (?, ?, ?)",
            (sid, encode(settings), now),
        )
        db.execute("INSERT INTO desired_state VALUES (?, 0, '{}', ?)", (sid, now))
        if isinstance(item.get("token"), str) and item["token"]:
            db.execute(
                """INSERT INTO strategy_tokens
                   (id, strategy_id, digest, scopes, created_at, revoked_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    f"v1-{sid}",
                    sid,
                    digest(sid + ":" + item["token"]),
                    encode(["session", "telemetry"]),
                    now,
                    now,
                ),
            )
        service.strategies.audit("migration", "strategy.import", sid, legacy_id=sid)
    return strategies


def import_operations(service, backup, strategies):
    path = backup / "operations.sqlite3"
    db = service.db
    for row in legacy_rows(path, "pause_intents"):
        if row["sid"] in strategies:
            db.execute(
                """UPDATE desired_state SET revision=1, state='{"entry_enabled":false}'
                   WHERE strategy_id=?""",
                (row["sid"],),
            )
    count = 0
    for row in legacy_rows(path, "operations"):
        sid = row["sid"]
        if sid not in strategies:
            continue
        status = COMMAND_STATES.get(row["state"], "unknown")
        cid = str(uuid5(NAMESPACE_URL, f"quantbot-v1/{sid}/{row['id']}"))
        db.execute(
            """INSERT INTO commands
               (id, strategy_id, instance_id, actor, request_id, action, arguments,
                fingerprint, state, protected, risky, created_at, updated_at, expires_at, result)
               VALUES (?, ?, 'v1', 'migration', ?, ?, ?, '', ?, 1, 1, ?, ?, ?, ?)""",
            (
                cid,
                sid,
                cid,
                row["name"],
                row["args"],
                status,
                row["updated"],
                row["updated"],
                row["expires"],
                row["result"],
            ),
        )
        service.strategies.audit(
            "migration",
            "command.import",
            sid,
            command_id=cid,
            legacy_command_id=row["id"],
            legacy_state=row["state"],
        )
        count += 1
    return count


def import_notices(service, backup, strategies):
    count = 0
    for row in legacy_rows(backup / "web-notices.sqlite3", "web_notices"):
        sid = row["id"].split(":", 1)[0]
        if sid not in strategies:
            candidates = [key for key, value in strategies.items() if value == row["strategy"]]
            sid = candidates[0] if len(candidates) == 1 else None
        category, severity = {
            "trade": ("trade", "info"),
            "alert": ("alert", "critical"),
            "error": ("error", "error"),
            "info": ("log", "info"),
        }.get(row["kind"], ("log", "info"))
        message = row["text"] if sid else f"[{row['strategy']}] {row['text']}"
        service.db.execute(
            """INSERT INTO alerts(strategy_id, category, severity, message, dedup_key, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (sid, category, severity, message, f"legacy:{row['id']}", row["created"]),
        )
        count += 1
    return count


def import_audit(service, backup, strategies):
    count = 0
    for name in reversed(LEGACY_LOGS):
        file = backup / name
        if not file.is_file():
            continue
        with file.open(encoding="utf-8", errors="replace") as source:
            for line in source:
                try:
                    item = json.loads(line)
                    if not isinstance(item, dict) or item.get("strategy") not in strategies:
                        continue
                    occurred = datetime.fromisoformat(item["time"]).timestamp()
                    action = str(item["action"])[:100]
                    detail = {key: item[key] for key in ("op", "ok") if key in item}
                    document = encode(detail)
                except (KeyError, TypeError, ValueError, OverflowError):
                    continue
                service.db.execute(
                    """INSERT INTO audit_log(strategy_id, actor, action, detail, created_at)
                       VALUES (?, 'migration', ?, ?, ?)""",
                    (item["strategy"], f"v1.{action}", document, occurred),
                )
                count += 1
    return count


def import_telegram(service, config):
    telegram = config.get("telegram") or {}
    token, user = telegram.get("token"), telegram.get("owner_id")
    if not isinstance(token, str) or not TG_TOKEN.fullmatch(token) or type(user) is not int:
        return False
    quiet = None
    if isinstance(config.get("quiet_hours"), str):
        match = re.fullmatch(r"\s*(\d{1,2})\s*-\s*(\d{1,2})\s*", config["quiet_hours"])
        if match:
            start, end = (int(value) for value in match.groups())
            if 0 <= start < 24 and 0 <= end <= 24 and start != end % 24:
                quiet = {"start": f"{start:02}:00", "end": f"{end % 24:02}:00"}
    options = TelegramUpdate(
        enabled=True,
        admins=[user],
        bot_token=token,
        timezone=config.get("timezone") or "Asia/Shanghai",
        quiet_hours=quiet,
    )
    TelegramConfig(service).update(options, "migration")
    return True


def migrate(source: Path, destination: Path, backup: Path, mode="live"):
    source = source.resolve()
    destination = destination.resolve()
    backup = backup.resolve()
    if source in destination.parents or backup == source or source in backup.parents:
        raise ValueError("Use separate legacy, backup and v2 data locations")
    with exclusive_database(destination):
        if destination.exists():
            raise ValueError("Migration requires a new v2 database")
        legacy_backup(source, backup)
        config = json.loads((backup / LEGACY_CONFIG).read_text(encoding="utf-8"))
        with TemporaryDirectory(prefix=".migration-", dir=destination.parent) as folder:
            staged = Path(folder) / destination.name
            service = Runtime(staged)
            try:
                now = time.time()
                with service.db.transaction():
                    strategies = import_strategies(service, config, mode, now)
                    commands = import_operations(service, backup, strategies)
                    alerts = import_notices(service, backup, strategies)
                    audit = import_audit(service, backup, strategies)
                    admin = config.get("web_admin") or {}
                    username, password = admin.get("username"), admin.get("password")
                    admin_imported = bool(
                        isinstance(username, str)
                        and 0 < len(username.strip()) <= 100
                        and isinstance(password, str)
                        and OLD_PASSWORD.fullmatch(password)
                    )
                    if admin_imported:
                        service.db.execute(
                            "INSERT INTO settings VALUES ('administrator', ?)",
                            (encode({"username": username.strip(), "password_hash": password}),),
                        )
                telegram = import_telegram(service, config)
                service.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                service.db.close()
            staged.replace(destination)
    return {
        "strategies": len(strategies),
        "commands": commands,
        "alerts": alerts,
        "audit": audit,
        "telegram": telegram,
        "administrator": admin_imported,
        "backup": str(backup),
    }
