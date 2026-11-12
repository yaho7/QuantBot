import hashlib
import json
import sqlite3
import time
from contextlib import closing

import pytest

from quantbot.v2.migration import backup_sqlite, migrate
from quantbot.v2.runtime import Runtime

from .test_control_plane import ADMIN, AGENT, client


def make_legacy(folder):
    folder.mkdir()
    salt = bytes(16)
    key = hashlib.scrypt(
        b"test-legacy-password",
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    password = f"scrypt$16384$8$1${salt.hex()}${key.hex()}"
    old_token = "old-strategy-fixture-only"
    config = {
        "web_admin": {"username": "legacy-admin", "password": password},
        "telegram": {"owner_id": 301, "token": "123456:" + "y" * 33},
        "quiet_hours": "23-07",
        "timezone": "Asia/Shanghai",
        "strategies": [{"id": "spcx", "name": "旧策略 SPCX", "token": old_token}],
    }
    (folder / "quantbot.json").write_text(json.dumps(config))
    now = time.time()
    with closing(sqlite3.connect(folder / "operations.sqlite3")) as db, db:
        db.executescript("""
            CREATE TABLE operations (
                id TEXT, sid TEXT, name TEXT, args TEXT, expires REAL,
                state TEXT, grant TEXT, result TEXT, updated REAL
            );
            CREATE TABLE pause_intents (sid TEXT, id TEXT);
            INSERT INTO pause_intents VALUES ('spcx', 'pause-1');
        """)
        db.execute(
            """INSERT INTO operations VALUES ('old-op', 'spcx', 'flatten', '{}', ?,
               'EXECUTING', 'old-grant', NULL, ?)""",
            (now + 100, now),
        )
    with closing(sqlite3.connect(folder / "web-notices.sqlite3")) as db, db:
        db.execute("CREATE TABLE web_notices(id, created, strategy, text, kind, seen)")
        db.execute(
            "INSERT INTO web_notices VALUES (?, ?, ?, ?, ?, ?)",
            ("spcx:legacy-alert", now, "旧策略 SPCX", "Legacy alert", "alert", 0),
        )
    return old_token


def test_migration_keeps_identifiers_settings_and_unknown_trade_safe(tmp_path):
    old = tmp_path / "legacy"
    old_token = make_legacy(old)
    original = (old / "quantbot.json").read_bytes()
    target = tmp_path / "new" / "quantbot-v2.sqlite3"
    backup = tmp_path / "backup"
    result = migrate(old, target, backup)
    assert result["strategies"] == result["commands"] == result["alerts"] == 1
    assert result["administrator"] and result["telegram"]
    assert (old / "quantbot.json").read_bytes() == original
    assert (backup / "quantbot.json").read_bytes() == original
    assert (backup.stat().st_mode & 0o777) == 0o700
    assert old_token.encode() not in target.read_bytes()
    assert b"old-grant" not in target.read_bytes()
    with client(target, time.time) as http:
        assert (
            http.post(
                ADMIN + "/login",
                json={
                    "username": "legacy-admin",
                    "password": "test-legacy-password",
                },
            ).status_code
            == 200
        )
        sid = http.get(ADMIN + "/strategies").json()[0]
        assert sid["id"] == "spcx" and sid["mode"] == "live" and not sid["live_trading_enabled"]
        detail = http.get(f"{ADMIN}/strategies/spcx").json()
        assert detail["control"]["desired"]["entry_enabled"] is False
        command = http.get(ADMIN + "/commands").json()[0]
        assert command["state"] == "unknown" and command["risky"]
        bot = http.get(ADMIN + "/telegram").json()
        assert bot["quiet_hours"] == {"start": "23:00", "end": "07:00"}
        assert bot["admins"] == [301] and bot["has_token"]
        assert (
            http.post(
                AGENT + "/session",
                headers={"Authorization": f"Bearer {old_token}"},
                json={"instance_id": "test"},
            ).status_code
            == 401
        )
        assert http.get(ADMIN + "/alerts").json()[0]["message"] == "Legacy alert"
    with pytest.raises(ValueError, match="new v2 database"):
        migrate(old, target, tmp_path / "second-backup")


def test_backup_copies_committed_wal_and_never_overwrites(tmp_path):
    db_path = tmp_path / "db.sqlite3"
    destination = tmp_path / "backup" / "data.sqlite3"
    service = Runtime(db_path)
    try:
        service.db.execute("INSERT INTO settings VALUES ('fixture', 'wrote')")
        backup_sqlite(db_path, destination)
        with closing(sqlite3.connect(destination)) as db:
            assert db.execute("SELECT value FROM settings WHERE name='fixture'").fetchone() == (
                "wrote",
            )
        assert (destination.stat().st_mode & 0o777) == 0o600
        with pytest.raises(FileExistsError):
            backup_sqlite(db_path, destination)
    finally:
        service.db.close()
