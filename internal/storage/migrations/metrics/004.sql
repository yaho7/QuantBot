DROP TABLE snapshots;

CREATE TABLE capability_samples (
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
    PRIMARY KEY (strategy_id, revision, capability_id, record_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX capability_samples_replay ON capability_samples(strategy_id, capability_id, observed_at DESC, record_id DESC, revision DESC);
CREATE INDEX capability_samples_retain ON capability_samples(received_at);

CREATE TABLE capability_latest (
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
    PRIMARY KEY (strategy_id, capability_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE capability_receipts (
    strategy_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    capability_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY(strategy_id, revision, capability_id, record_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX capability_receipts_retain ON capability_receipts(received_at);

ALTER TABLE samples ADD COLUMN associations TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(associations));
ALTER TABLE samples ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
