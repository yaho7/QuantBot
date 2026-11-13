import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from quantbot.__main__ import database_path, run
from quantbot.core.api import make_app
from quantbot.core.db import Database, backup_sqlite
from quantbot.core.runtime import Runtime

from .test_control_plane import ADMIN, Clock, client, create, log_in


def test_upgrade_reuses_the_existing_database_and_key(tmp_path, monkeypatch):
    original = tmp_path / "quantbot-v2.sqlite3"
    current = tmp_path / "quantbot.sqlite3"
    assert database_path(tmp_path) == current
    clock = Clock()
    with client(original, clock) as http:
        log_in(http)
        sid, credential = create(http)

    selected = database_path(tmp_path)
    assert selected == original
    with TestClient(
        make_app(selected, clock=clock, telegram_network=False), base_url="https://testserver"
    ) as http:
        assert http.get(ADMIN + "/setup").json()["required"] is False
        log_in(http)
        assert http.get(f"{ADMIN}/strategies/{sid}").status_code == 200
        reveal = http.post(f"{ADMIN}/strategies/{sid}/tokens/{credential['id']}/reveal")
        assert reveal.json()["token"] == credential["token"]
    assert not current.exists()

    backup = tmp_path / "backup.sqlite3"
    monkeypatch.setattr(
        "sys.argv", ["quantbot", "--data-dir", str(tmp_path), "backup", str(backup)]
    )
    assert run() == 0
    with closing(sqlite3.connect(backup)) as db:
        assert db.execute("SELECT id FROM strategies").fetchone() == (sid,)


def test_existing_current_database_takes_precedence_without_overwriting_previous(tmp_path, caplog):
    previous = tmp_path / "quantbot-v2.sqlite3"
    current = tmp_path / "quantbot.sqlite3"
    previous.write_bytes(b"original")
    current.write_bytes(b"current")
    assert database_path(tmp_path) == current
    assert previous.read_bytes() == b"original"
    assert "Found two databases" in caplog.text


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


@pytest.mark.parametrize(
    ("version", "error"),
    [(0, "Unrecognized database layout"), (2, "Unsupported QuantBot database schema 2")],
)
def test_unsupported_schema_is_left_intact(tmp_path, version, error):
    path = tmp_path / "unrecognized.sqlite3"
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("CREATE TABLE marker (value TEXT)")
        db.execute("INSERT INTO marker VALUES ('original')")
        if version:
            db.execute("PRAGMA user_version=2")
    before = path.stat().st_mtime_ns

    with pytest.raises(RuntimeError, match=error):
        Database(path)

    assert path.stat().st_mtime_ns == before
    with closing(sqlite3.connect(path)) as db:
        assert db.execute("PRAGMA user_version").fetchone() == (version,)
        assert db.execute("SELECT value FROM marker").fetchone() == ("original",)
