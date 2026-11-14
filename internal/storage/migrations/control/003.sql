CREATE TABLE strategies (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    executor_instance TEXT
) STRICT;

CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    digest TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    scopes INTEGER NOT NULL CHECK (scopes BETWEEN 1 AND 15),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
) STRICT;
CREATE INDEX agent_tokens_strategy ON agent_tokens(strategy_id, created_at);

CREATE TABLE agent_instances (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (strategy_id, instance_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_boots (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    PRIMARY KEY (strategy_id, instance_id, boot_id),
    FOREIGN KEY (strategy_id, instance_id) REFERENCES agent_instances(strategy_id, instance_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_sessions (
    digest TEXT PRIMARY KEY NOT NULL,
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    token_id TEXT NOT NULL REFERENCES agent_tokens(id),
    expires_at INTEGER NOT NULL,
    UNIQUE (strategy_id, instance_id),
    FOREIGN KEY (strategy_id, instance_id, boot_id) REFERENCES agent_boots(strategy_id, instance_id, boot_id)
) STRICT;
