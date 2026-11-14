CREATE TABLE rollups (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    series TEXT NOT NULL,
    resolution INTEGER NOT NULL CHECK (resolution IN (60000, 300000, 3600000, 86400000)),
    bucket INTEGER NOT NULL,
    summary TEXT NOT NULL CHECK (json_valid(summary)),
    PRIMARY KEY(strategy_id, instance_id, kind, series, resolution, bucket)
) STRICT, WITHOUT ROWID;

CREATE INDEX rollups_retention ON rollups(resolution, bucket);

CREATE TABLE series_catalog (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    series TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY(strategy_id, instance_id, kind, series)
) STRICT, WITHOUT ROWID;

CREATE INDEX samples_event_feed ON samples(strategy_id, kind, observed_at DESC, report_id DESC);
