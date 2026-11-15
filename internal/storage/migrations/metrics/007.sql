ALTER TABLE performance_samples ADD COLUMN host_capacity TEXT CHECK (host_capacity IS NULL OR json_valid(host_capacity));
ALTER TABLE performance_samples ADD COLUMN host_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE performance_samples ADD COLUMN process_run INTEGER NOT NULL DEFAULT 0;
CREATE INDEX performance_latest_host ON performance_samples(host_id, observed_at DESC, received_at DESC) WHERE host_data IS NOT NULL AND host_run > 0;
