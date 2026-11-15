CREATE TABLE performance_samples (
    host_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    host_data TEXT CHECK(host_data IS NULL OR json_valid(host_data)),
    process_data TEXT CHECK(process_data IS NULL OR json_valid(process_data)),
    PRIMARY KEY(strategy_id, instance_id, boot_id, record_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX performance_host_time ON performance_samples(host_id, revision, observed_at DESC, received_at DESC) WHERE host_data IS NOT NULL;
CREATE INDEX performance_process_time ON performance_samples(strategy_id, instance_id, boot_id, observed_at DESC, received_at DESC) WHERE process_data IS NOT NULL;
CREATE INDEX performance_retention ON performance_samples(observed_at);
