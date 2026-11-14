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

-- name: GetRollup :one
SELECT summary FROM rollups WHERE strategy_id = ? AND instance_id = ? AND kind = ?
AND series = ? AND resolution = ? AND bucket = ?;

-- name: PutRollup :exec
INSERT INTO rollups(strategy_id, instance_id, kind, series, resolution, bucket, summary)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(strategy_id, instance_id, kind, series, resolution, bucket) DO UPDATE SET summary = excluded.summary;

-- name: ListRollups :many
SELECT bucket, summary FROM rollups WHERE strategy_id = ? AND instance_id = ? AND kind = ?
AND series = ? AND resolution = ? AND bucket >= sqlc.arg(start_at) AND bucket < sqlc.arg(end_at)
ORDER BY bucket LIMIT sqlc.arg(maximum);

-- name: ListRawSeries :many
SELECT observed_at, report_id, data FROM samples WHERE strategy_id = ? AND instance_id = ? AND kind = ?
AND series = ? AND observed_at >= sqlc.arg(start_at) AND observed_at < sqlc.arg(end_at)
ORDER BY observed_at, report_id LIMIT sqlc.arg(maximum);

-- name: TouchSeries :exec
INSERT INTO series_catalog(strategy_id, instance_id, kind, series, observed_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(strategy_id, instance_id, kind, series) DO UPDATE SET observed_at = excluded.observed_at
WHERE excluded.observed_at > series_catalog.observed_at;

-- name: ListSeries :many
SELECT * FROM series_catalog WHERE strategy_id = ? ORDER BY kind, series, instance_id LIMIT 1000;

-- name: PruneSamples :execrows
DELETE FROM samples WHERE (strategy_id, kind, report_id) IN (
    SELECT old.strategy_id, old.kind, old.report_id FROM samples AS old WHERE old.observed_at < sqlc.arg(cutoff)
    ORDER BY old.observed_at LIMIT 2000
);

-- name: PruneLogs :execrows
DELETE FROM samples WHERE (strategy_id, kind, report_id) IN (
    SELECT old.strategy_id, old.kind, old.report_id FROM samples AS old WHERE old.kind = 'log' AND old.observed_at < sqlc.arg(cutoff)
    ORDER BY old.observed_at LIMIT 2000
);

-- name: PruneRollups :execrows
DELETE FROM rollups WHERE (strategy_id, instance_id, kind, series, resolution, bucket) IN (
    SELECT old.strategy_id, old.instance_id, old.kind, old.series, old.resolution, old.bucket FROM rollups AS old
    WHERE old.resolution = sqlc.arg(resolution) AND old.bucket < sqlc.arg(cutoff)
    ORDER BY old.bucket LIMIT 2000
);

-- name: PruneSnapshots :execrows
DELETE FROM snapshots WHERE (strategy_id, instance_id, boot_id) IN (
    SELECT old.strategy_id, old.instance_id, old.boot_id FROM snapshots AS old WHERE old.observed_at < sqlc.arg(cutoff)
    ORDER BY old.observed_at LIMIT 2000
);

-- name: ListSampleEvents :many
SELECT * FROM samples WHERE strategy_id = ? AND kind = ?
AND (observed_at, report_id) < (sqlc.arg(before_at), CAST(sqlc.arg(before_id) AS TEXT))
ORDER BY observed_at DESC, report_id DESC LIMIT sqlc.arg(page_size);
