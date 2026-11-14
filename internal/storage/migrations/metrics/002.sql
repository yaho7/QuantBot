CREATE TABLE samples (
    strategy_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    series TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (strategy_id, kind, report_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX samples_history ON samples(strategy_id, kind, series, instance_id, observed_at, report_id);
CREATE INDEX samples_retention ON samples(observed_at);

CREATE TABLE latest_samples (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    series TEXT NOT NULL,
    report_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    PRIMARY KEY (strategy_id, instance_id, kind, series)
) STRICT, WITHOUT ROWID;

CREATE INDEX latest_samples_time ON latest_samples(strategy_id, kind, observed_at DESC, report_id DESC);

CREATE TABLE snapshots (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    records TEXT NOT NULL CHECK (json_valid(records)),
    PRIMARY KEY (strategy_id, instance_id, boot_id)
) STRICT, WITHOUT ROWID;
