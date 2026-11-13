import sqlite3
from contextlib import closing

import pytest

from quantbot.core.db import Database, backup_sqlite
from quantbot.core.runtime import Runtime


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
