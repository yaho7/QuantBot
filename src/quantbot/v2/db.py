"""SQLite storage and transaction boundary for the control plane."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 6

SCHEMA = """
CREATE TABLE strategies (
    id TEXT PRIMARY KEY,
    settings TEXT NOT NULL,
    created_at REAL NOT NULL,
    executor_id TEXT,
    presence TEXT NOT NULL DEFAULT 'offline',
    archived_at REAL
);
CREATE TABLE strategy_tokens (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    digest TEXT UNIQUE NOT NULL,
    scopes TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL,
    revoked_at REAL,
    last_used_at REAL
);
CREATE INDEX tokens_strategy ON strategy_tokens(strategy_id);
CREATE TABLE agent_instances (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    token_id TEXT NOT NULL REFERENCES strategy_tokens(id),
    session_id TEXT UNIQUE NOT NULL,
    boot_id TEXT NOT NULL,
    declarations TEXT NOT NULL,
    runtime TEXT NOT NULL,
    last_seen REAL NOT NULL,
    runtime_observations TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (strategy_id, instance_id)
);
CREATE TABLE snapshots (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    observed_at REAL NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (strategy_id, instance_id)
);
CREATE TABLE metric_samples (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    observed_at REAL NOT NULL,
    value TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (strategy_id, instance_id, name, account_id, unit, observed_at)
);
CREATE INDEX metric_time ON metric_samples(strategy_id, observed_at DESC);
CREATE TABLE strategy_events (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    occurred_at REAL NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (strategy_id, id)
);
CREATE INDEX event_time ON strategy_events(strategy_id, occurred_at DESC);
CREATE INDEX global_event_time ON strategy_events(occurred_at DESC);
CREATE INDEX strategy_fill_identity ON strategy_events(
    strategy_id,
    json_extract(payload, '$.fill.account_id'),
    json_extract(payload, '$.fill.fill_id')
) WHERE json_type(payload, '$.fill')='object';
CREATE TABLE desired_state (
    strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE reported_state (
    strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    session_id TEXT,
    actor TEXT NOT NULL,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    arguments TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    protected INTEGER NOT NULL,
    risky INTEGER NOT NULL,
    revision INTEGER,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    result TEXT,
    error TEXT,
    control_id TEXT,
    control_revision INTEGER,
    UNIQUE (actor, request_id)
);
CREATE INDEX commands_strategy ON commands(strategy_id, state, created_at);
CREATE TABLE command_executions (
    command_id TEXT PRIMARY KEY REFERENCES commands(id),
    instance_id TEXT NOT NULL,
    permit_hash TEXT NOT NULL,
    claimed_at REAL NOT NULL,
    receipt TEXT
);
CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT REFERENCES strategies(id),
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    dedup_key TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX alerts_time ON alerts(created_at DESC);
CREATE INDEX alerts_dedup ON alerts(strategy_id, dedup_key, created_at DESC);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    strategy_id TEXT REFERENCES strategies(id),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE admin_sessions (
    digest TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE login_links (
    digest TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE telegram_cursors (
    user_id INTEGER PRIMARY KEY,
    alert_id INTEGER NOT NULL,
    last_sent REAL NOT NULL DEFAULT 0,
    retry_at REAL NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE typed_reports (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    type TEXT NOT NULL,
    series TEXT NOT NULL,
    observed_at REAL NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(strategy_id, instance_id, type, series, observed_at)
);
CREATE INDEX typed_report_time ON typed_reports(strategy_id, type, observed_at DESC);
CREATE TABLE report_event_ids (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    id TEXT NOT NULL,
    observed_at REAL NOT NULL,
    PRIMARY KEY(strategy_id, id)
);
CREATE TABLE schema_failures (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    type TEXT NOT NULL,
    observed_at REAL NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(strategy_id, type)
);
CREATE TABLE metric_definitions (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY(strategy_id, instance_id, name, account_id, unit)
);
CREATE TABLE dashboards (
    strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
    revision INTEGER NOT NULL,
    widgets TEXT NOT NULL
);
CREATE TABLE control_registries (
    strategy_id TEXT PRIMARY KEY REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE control_values (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    control_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observed_at REAL NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (strategy_id, control_id, kind)
);
"""


def timestamp(value: float | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def record(row: sqlite3.Row, *, documents=(), times=(), omit=()) -> dict:
    data = {key: row[key] for key in row.keys() if key not in omit}
    for key in documents:
        if data[key] is not None:
            data[key] = json.loads(data[key])
    for key in times:
        data[key] = timestamp(data[key])
    return data


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            path.touch(mode=0o600, exist_ok=False)
        except FileExistsError:
            pass
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        try:
            version = self.conn.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, SCHEMA_VERSION}:
                raise RuntimeError(f"Unsupported QuantBot database schema {version}")
            if version == 0 and self.conn.execute("SELECT 1 FROM sqlite_schema LIMIT 1").fetchone():
                raise RuntimeError(
                    "Unrecognized database layout. Use a fresh QuantBot data directory."
                )
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.execute("PRAGMA busy_timeout=3000")
            if version == 0:
                self.conn.executescript(
                    f"BEGIN IMMEDIATE;\n{SCHEMA}\nPRAGMA user_version={SCHEMA_VERSION};\nCOMMIT;"
                )
        except BaseException:
            self.conn.close()
            raise

    def execute(self, sql: str, args=()) -> sqlite3.Cursor:
        return self.conn.execute(sql, args)

    def one(self, sql: str, args=()) -> sqlite3.Row | None:
        return self.execute(sql, args).fetchone()

    def all(self, sql: str, args=()) -> list[sqlite3.Row]:
        return self.execute(sql, args).fetchall()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.commit()
        except BaseException:
            self.conn.rollback()
            raise

    def close(self):
        self.conn.close()


def backup_sqlite(source: Path, destination: Path):
    if not source.is_file():
        raise ValueError(f"Database does not exist: {source}")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.touch(mode=0o600, exist_ok=False)
    try:
        source_uri = source.resolve().as_uri() + "?mode=ro"
        with (
            closing(sqlite3.connect(source_uri, uri=True)) as old,
            closing(sqlite3.connect(destination)) as new,
        ):
            old.backup(new)
            if new.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Backup database integrity check failed")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
