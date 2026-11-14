-- name: GetMetricDefinition :one
SELECT definition FROM metric_definitions WHERE strategy_id = ? AND name = ?;

-- name: SetMetricDefinition :exec
INSERT INTO metric_definitions (strategy_id, name, definition) VALUES (?, ?, ?)
ON CONFLICT (strategy_id, name) DO UPDATE SET definition = excluded.definition;

-- name: InsertSample :execrows
INSERT INTO samples (strategy_id, report_id, instance_id, kind, series, observed_at, data, fingerprint)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (strategy_id, kind, report_id) DO NOTHING;

-- name: SampleFingerprint :one
SELECT fingerprint FROM samples WHERE strategy_id = ? AND kind = ? AND report_id = ?;

-- name: PutLatestSample :exec
INSERT INTO latest_samples (strategy_id, instance_id, kind, series, report_id, observed_at, data)
VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (strategy_id, instance_id, kind, series)
DO UPDATE SET report_id = excluded.report_id, observed_at = excluded.observed_at, data = excluded.data
WHERE (excluded.observed_at, excluded.report_id) > (latest_samples.observed_at, latest_samples.report_id);

-- name: ListLatestSamples :many
SELECT * FROM latest_samples WHERE strategy_id = ? AND kind = ?
ORDER BY observed_at DESC, report_id DESC LIMIT 1000;

-- name: GetSnapshot :one
SELECT * FROM snapshots WHERE strategy_id = ? AND instance_id = ? AND boot_id = ?;

-- name: PutSnapshot :exec
INSERT INTO snapshots (strategy_id, instance_id, boot_id, observed_at, records)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (strategy_id, instance_id, boot_id) DO UPDATE SET
    observed_at = excluded.observed_at, records = excluded.records;

-- name: ListSnapshots :many
SELECT * FROM snapshots WHERE strategy_id = ? ORDER BY observed_at DESC LIMIT 256;

-- name: ListMetricDefinitions :many
SELECT * FROM metric_definitions WHERE strategy_id = ? ORDER BY name LIMIT 1000;
