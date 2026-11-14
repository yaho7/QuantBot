-- name: GetMetricDefinition :one
SELECT definition FROM metric_definitions WHERE strategy_id = ? AND name = ?;

-- name: SetMetricDefinition :exec
INSERT INTO metric_definitions (strategy_id, name, definition) VALUES (?, ?, ?)
ON CONFLICT (strategy_id, name) DO UPDATE SET definition = excluded.definition;

-- name: InsertSample :execrows
INSERT INTO samples (strategy_id, report_id, instance_id, kind, series, observed_at, data, fingerprint, associations, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (strategy_id, kind, report_id) DO NOTHING;

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

-- name: ListSampleEvents :many
SELECT * FROM samples WHERE strategy_id = ? AND kind = ?
AND (observed_at, report_id) < (sqlc.arg(before_at), CAST(sqlc.arg(before_id) AS TEXT))
ORDER BY observed_at DESC, report_id DESC LIMIT sqlc.arg(page_size);

-- name: InsertCapabilitySample :execrows
INSERT INTO capability_samples (strategy_id, record_id, capability_id, revision, instance_id, boot_id, observed_at, received_at, value, links, fingerprint)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING;

-- name: PutCapabilityLatest :execrows
INSERT INTO capability_latest (strategy_id, record_id, capability_id, revision, instance_id, boot_id, observed_at, received_at, value, links, fingerprint)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(strategy_id,capability_id,revision) DO UPDATE SET
record_id=excluded.record_id, instance_id=excluded.instance_id, boot_id=excluded.boot_id,
observed_at=excluded.observed_at, received_at=excluded.received_at, value=excluded.value, links=excluded.links, fingerprint=excluded.fingerprint
WHERE (excluded.observed_at, excluded.record_id) > (capability_latest.observed_at, capability_latest.record_id);

-- name: ReplayCapabilityData :many
SELECT * FROM capability_samples WHERE strategy_id=? AND capability_id=?
AND observed_at >= sqlc.arg(from_at) AND observed_at < sqlc.arg(to_at)
AND (
  observed_at < sqlc.arg(cursor_at) OR observed_at=sqlc.arg(cursor_at)
  AND (record_id < sqlc.arg(cursor_id) OR record_id=sqlc.arg(cursor_id) AND revision < sqlc.arg(cursor_revision))
)
ORDER BY observed_at DESC, record_id DESC, revision DESC LIMIT sqlc.arg(page_size);

-- name: PruneCapabilitySamples :execrows
DELETE FROM capability_samples WHERE (strategy_id,revision,capability_id,record_id) IN (
    SELECT s.strategy_id,s.revision,s.capability_id,s.record_id FROM capability_samples s
    WHERE s.received_at < sqlc.arg(cutoff) ORDER BY s.received_at LIMIT 2000
);

-- name: InsertCapabilityReceipt :execrows
INSERT INTO capability_receipts(strategy_id, revision, capability_id, record_id, received_at, fingerprint)
VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING;

-- name: CapabilityReceiptDigest :one
SELECT fingerprint FROM capability_receipts WHERE strategy_id=? AND revision=? AND capability_id=? AND record_id=?;

-- name: ListCapabilityLatest :many
SELECT latest.* FROM json_each(CAST(sqlc.arg(capability_revisions) AS TEXT)) AS capability
JOIN capability_latest latest ON latest.strategy_id = sqlc.arg(strategy_id) AND latest.capability_id = capability.key
AND latest.revision = (
    SELECT candidate.revision FROM capability_latest candidate
    WHERE candidate.strategy_id = latest.strategy_id AND candidate.capability_id = latest.capability_id
    AND candidate.revision BETWEEN CAST(json_extract(capability.value, '$[0]') AS INTEGER) AND CAST(json_extract(capability.value, '$[1]') AS INTEGER)
    ORDER BY candidate.observed_at DESC, candidate.revision DESC, candidate.record_id DESC LIMIT 1
)
ORDER BY latest.capability_id;

-- name: PruneCapabilityReceipts :execrows
DELETE FROM capability_receipts WHERE (strategy_id,revision,capability_id,record_id) IN (
    SELECT s.strategy_id,s.revision,s.capability_id,s.record_id FROM capability_receipts s
    WHERE s.received_at < sqlc.arg(cutoff) ORDER BY s.received_at LIMIT 2000
);

-- name: FindAssociatedSamples :many
WITH matching AS (
    SELECT report_id, kind, series, observed_at, received_at, data AS value, associations, 0 AS revision
    FROM samples AS s WHERE s.strategy_id = @strategy_id AND json_extract(s.associations, @json_path) = @association
    ORDER BY observed_at DESC, report_id DESC LIMIT 50
), declared AS (
    SELECT record_id AS report_id, '' AS kind, capability_id AS series, observed_at, received_at, value, links AS associations, revision
    FROM capability_samples AS cs WHERE cs.strategy_id = @strategy_id AND json_extract(cs.links, @json_path) = @association
    UNION
    SELECT record_id, '', capability_id, observed_at, received_at, value, links, revision
    FROM capability_latest AS cl WHERE cl.strategy_id = @strategy_id AND json_extract(cl.links, @json_path) = @association
    ORDER BY observed_at DESC, report_id DESC LIMIT 50
)
SELECT * FROM matching
UNION ALL
SELECT * FROM declared
ORDER BY observed_at DESC, report_id DESC LIMIT 50;
