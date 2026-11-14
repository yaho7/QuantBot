CREATE TABLE capability_latest_by_revision (
    strategy_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    links TEXT NOT NULL CHECK (json_valid(links)),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (strategy_id, capability_id, revision)
) STRICT, WITHOUT ROWID;
INSERT INTO capability_latest_by_revision SELECT * FROM capability_latest;
DROP TABLE capability_latest;
ALTER TABLE capability_latest_by_revision RENAME TO capability_latest;
CREATE INDEX capability_latest_received_at ON capability_latest(received_at);
