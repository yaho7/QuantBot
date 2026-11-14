CREATE TABLE resource_collections (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    capability_id TEXT NOT NULL,
    since_revision INTEGER NOT NULL,
    resource_revision INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (strategy_id, capability_id, since_revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE resource_items (
    strategy_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    since_revision INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    value TEXT NOT NULL CHECK(json_valid(value)),
    links TEXT NOT NULL CHECK(json_valid(links)),
    PRIMARY KEY (strategy_id, capability_id, since_revision, resource_id),
    FOREIGN KEY (strategy_id, capability_id, since_revision)
        REFERENCES resource_collections(strategy_id, capability_id, since_revision) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE resource_updates (
    strategy_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    since_revision INTEGER NOT NULL,
    resource_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    changes TEXT CHECK(changes IS NULL OR json_valid(changes)),
    PRIMARY KEY (strategy_id, capability_id, since_revision, resource_revision),
    UNIQUE (strategy_id, capability_id, since_revision, request_id),
    FOREIGN KEY (strategy_id) REFERENCES strategies(id)
) STRICT, WITHOUT ROWID;
CREATE INDEX resource_updates_retention ON resource_updates(received_at);
CREATE INDEX resource_updates_replay ON resource_updates(strategy_id, capability_id, observed_at DESC, revision DESC, resource_revision DESC);
