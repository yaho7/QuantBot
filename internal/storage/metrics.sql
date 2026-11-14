-- name: GetMetricDefinition :one
SELECT definition FROM metric_definitions WHERE strategy_id = ? AND name = ?;

-- name: SetMetricDefinition :exec
INSERT INTO metric_definitions (strategy_id, name, definition) VALUES (?, ?, ?)
ON CONFLICT (strategy_id, name) DO UPDATE SET definition = excluded.definition;
