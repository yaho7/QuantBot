-- name: GetSetting :one
SELECT value FROM settings WHERE key = ?;

-- name: SetSetting :exec
INSERT INTO settings (key, value) VALUES (?, ?)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- name: AdminExists :one
SELECT EXISTS (SELECT 1 FROM users WHERE id = 1);

-- name: CreateAdmin :execrows
INSERT INTO users (id, username, password_hash, created_at)
VALUES (1, ?, ?, ?) ON CONFLICT DO NOTHING;

-- name: GetAdmin :one
SELECT * FROM users WHERE id = 1;

-- name: ChangeAdminPassword :execrows
UPDATE users SET password_hash = sqlc.arg(new_hash)
WHERE id = 1 AND password_hash = sqlc.arg(old_hash);

-- name: CreateBrowserSession :exec
INSERT INTO browser_sessions (digest, user_id, csrf, created_at, expires_at)
VALUES (?, ?, ?, ?, ?);

-- name: GetBrowserSession :one
SELECT u.id AS user_id, u.username, s.csrf, s.expires_at
FROM browser_sessions s JOIN users u ON u.id = s.user_id
WHERE s.digest = ? AND s.expires_at > ?;

-- name: DeleteBrowserSession :execrows
DELETE FROM browser_sessions WHERE digest = ?;

-- name: DeleteExpiredBrowserSessions :exec
DELETE FROM browser_sessions WHERE expires_at <= ?;

-- name: DeleteBrowserSessions :exec
DELETE FROM browser_sessions WHERE user_id = ?;

-- name: ListBrowserSessions :many
SELECT created_at, expires_at, digest = sqlc.arg(current_digest) AS is_current
FROM browser_sessions WHERE user_id = sqlc.arg(user_id) AND expires_at > sqlc.arg(now)
ORDER BY created_at DESC LIMIT 128;

-- name: LimitBrowserSessions :exec
DELETE FROM browser_sessions AS old WHERE old.user_id = sqlc.arg(user_id) AND old.digest IN (
    SELECT recent.digest FROM browser_sessions AS recent WHERE recent.user_id = sqlc.arg(user_id)
    ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 128
);

-- name: AppendAudit :exec
INSERT INTO audit (at, actor, action, strategy_id, command_id, details)
VALUES (?, ?, ?, ?, ?, ?);

-- name: CreateStrategy :exec
INSERT INTO strategies (id, name, group_name, mode, created_at) VALUES (?, ?, ?, ?, ?);

-- name: ListStrategies :many
SELECT s.*, CAST(COALESCE((SELECT max(i.last_seen) FROM agent_instances i WHERE i.strategy_id = s.id), 0) AS INTEGER) AS last_seen
FROM strategies s
WHERE s.archived_at IS NULL OR sqlc.arg(include_archived) = 1 ORDER BY s.name, s.id;

-- name: GetStrategy :one
SELECT * FROM strategies WHERE id = ?;

-- name: UpdateStrategy :execrows
UPDATE strategies SET name = ?, group_name = ? WHERE id = ? AND archived_at IS NULL;

-- name: ArchiveStrategy :execrows
UPDATE strategies SET archived_at = ?, executor_instance = NULL WHERE id = ? AND archived_at IS NULL;

-- name: SelectExecutor :execrows
UPDATE strategies SET executor_instance = sqlc.narg(instance_id) WHERE id = sqlc.arg(strategy_id)
AND archived_at IS NULL AND (sqlc.narg(instance_id) IS NULL OR EXISTS (
    SELECT 1 FROM agent_instances WHERE strategy_id = sqlc.arg(strategy_id) AND instance_id = sqlc.narg(instance_id)
));

-- name: CreateAgentToken :exec
INSERT INTO agent_tokens (id, strategy_id, digest, label, scopes, created_at, expires_at, sealed_token)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListAgentTokens :many
SELECT id, strategy_id, label, scopes, created_at, expires_at, revoked_at, sealed_token IS NOT NULL AS revealable
FROM agent_tokens WHERE strategy_id = ? ORDER BY created_at DESC, id LIMIT 256;

-- name: GetStrategyToken :one
SELECT t.* FROM agent_tokens t JOIN strategies s ON s.id = t.strategy_id
WHERE t.id = sqlc.arg(token_id) AND t.strategy_id = sqlc.arg(strategy_id) AND s.archived_at IS NULL;

-- name: FindAgentToken :one
SELECT t.id, t.strategy_id, t.digest, t.label, t.scopes, t.created_at, t.expires_at, t.revoked_at, s.archived_at
FROM agent_tokens t JOIN strategies s ON s.id = t.strategy_id
WHERE t.digest = ?;

-- name: UpdateAgentTokenScopes :execrows
UPDATE agent_tokens SET scopes = sqlc.arg(scopes) WHERE id = sqlc.arg(token_id)
AND strategy_id = sqlc.arg(strategy_id) AND revoked_at IS NULL;

-- name: RevokeAgentToken :execrows
UPDATE agent_tokens SET revoked_at = sqlc.arg(now), sealed_token = NULL
WHERE id = sqlc.arg(token_id) AND strategy_id = sqlc.arg(strategy_id) AND revoked_at IS NULL;

-- name: RevokeStrategyTokens :exec
UPDATE agent_tokens SET revoked_at = ?, sealed_token = NULL WHERE strategy_id = ? AND revoked_at IS NULL;

-- name: GetAgentInstance :one
SELECT * FROM agent_instances WHERE strategy_id = ? AND instance_id = ?;

-- name: ListAgentInstances :many
SELECT * FROM agent_instances WHERE strategy_id = ? ORDER BY last_seen DESC LIMIT 256;

-- name: CountAgentInstances :one
SELECT count(*) FROM agent_instances WHERE strategy_id = ?;

-- name: UpsertAgentInstance :exec
INSERT INTO agent_instances(strategy_id, instance_id, boot_id, started_at, last_seen)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(strategy_id, instance_id) DO UPDATE SET boot_id = excluded.boot_id,
    started_at = CASE WHEN agent_instances.boot_id = excluded.boot_id THEN agent_instances.started_at ELSE excluded.started_at END,
    last_seen = excluded.last_seen;

-- name: RememberAgentBoot :execrows
INSERT INTO agent_boots(strategy_id, instance_id, boot_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING;

-- name: UpsertAgentSession :exec
INSERT INTO agent_sessions(digest, strategy_id, instance_id, boot_id, token_id, expires_at, previous_expires_at)
VALUES (?, ?, ?, ?, ?, ?, sqlc.arg(overlap_until))
ON CONFLICT(strategy_id, instance_id) DO UPDATE SET
    previous_digest = CASE WHEN agent_sessions.boot_id = excluded.boot_id AND agent_sessions.token_id = excluded.token_id THEN agent_sessions.digest END,
    previous_expires_at = CASE WHEN agent_sessions.boot_id = excluded.boot_id AND agent_sessions.token_id = excluded.token_id
        THEN min(agent_sessions.expires_at, excluded.previous_expires_at) ELSE 0 END,
    digest = excluded.digest, boot_id = excluded.boot_id,
    token_id = excluded.token_id, expires_at = excluded.expires_at;

-- name: FindAgentSession :one
SELECT a.strategy_id, a.instance_id, a.boot_id, a.token_id,
    CAST(CASE WHEN a.digest = sqlc.arg(digest) THEN a.expires_at ELSE a.previous_expires_at END AS INTEGER) AS expires_at,
    t.scopes, t.expires_at AS token_expires_at, t.revoked_at, s.archived_at, s.executor_instance, i.last_seen
FROM agent_sessions a
JOIN agent_tokens t ON t.id = a.token_id
JOIN strategies s ON s.id = a.strategy_id
JOIN agent_instances i ON i.strategy_id = a.strategy_id AND i.instance_id = a.instance_id AND i.boot_id = a.boot_id
WHERE a.digest = sqlc.arg(digest) OR a.previous_digest = sqlc.arg(digest);

-- name: UpdateAgentHeartbeat :execrows
UPDATE agent_instances SET last_seen = sqlc.arg(now)
WHERE strategy_id = sqlc.arg(strategy_id) AND instance_id = sqlc.arg(instance_id) AND boot_id = sqlc.arg(boot_id);

-- name: GetControlRegistry :one
SELECT * FROM control_registries WHERE strategy_id = ?;

-- name: PutControlRegistry :exec
INSERT INTO control_registries (strategy_id, revision, instance_id, boot_id, updated_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (strategy_id) DO UPDATE SET revision = excluded.revision, instance_id = excluded.instance_id,
    boot_id = excluded.boot_id, updated_at = excluded.updated_at;

-- name: ListControlDefinitions :many
SELECT * FROM control_definitions WHERE strategy_id = ? ORDER BY control_id;

-- name: GetControlDefinition :one
SELECT * FROM control_definitions WHERE strategy_id = ? AND control_id = ?;

-- name: DeleteControlDefinition :exec
DELETE FROM control_definitions WHERE strategy_id = ? AND control_id = ?;

-- name: PutControlDefinition :exec
INSERT INTO control_definitions (strategy_id, control_id, definition, since_revision) VALUES (?, ?, ?, ?)
ON CONFLICT (strategy_id, control_id) DO UPDATE SET definition = excluded.definition, since_revision = excluded.since_revision;

-- name: GetControlState :one
SELECT * FROM control_states WHERE strategy_id = ? AND control_id = ?;

-- name: ListControlStates :many
SELECT * FROM control_states WHERE strategy_id = ? ORDER BY control_id;

-- name: PutControlState :exec
INSERT INTO control_states (strategy_id, control_id, value, available, reason, observed_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (strategy_id, control_id) DO UPDATE SET value = excluded.value,
    available = excluded.available, reason = excluded.reason, observed_at = excluded.observed_at;

-- name: GetActiveExecutor :one
SELECT a.digest, a.strategy_id, a.instance_id, a.boot_id, a.token_id, a.expires_at, i.last_seen
FROM strategies s
JOIN agent_instances i ON i.strategy_id = s.id AND i.instance_id = s.executor_instance
JOIN agent_sessions a ON a.strategy_id = i.strategy_id AND a.instance_id = i.instance_id AND a.boot_id = i.boot_id
JOIN agent_tokens t ON t.id = a.token_id
WHERE s.id = sqlc.arg(strategy_id) AND s.archived_at IS NULL
AND a.expires_at > sqlc.arg(now) AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > sqlc.arg(now))
AND i.last_seen > sqlc.arg(seen_after) AND (t.scopes & sqlc.arg(scope)) = sqlc.arg(scope);

-- name: GetCommand :one
SELECT * FROM commands WHERE id = ?;

-- name: GetCommandByKey :one
SELECT * FROM commands WHERE actor = ? AND strategy_id = ? AND request_key = ?;

-- name: GetActiveControlCommand :one
SELECT id FROM commands WHERE strategy_id = ? AND control_id = ?
AND status IN ('created','confirmation_required','pending','accepted','executing','unknown');

-- name: InsertCommand :exec
INSERT INTO commands (
    id, strategy_id, control_id, revision, input, actor, request_key, instance_id, boot_id,
    status, created_at, updated_at, deadline, timeout_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?);

-- name: TransitionCommand :execrows
UPDATE commands SET status = sqlc.arg(next), updated_at = sqlc.arg(updated_at),
    accepted_by = sqlc.narg(accepted_by), deadline = sqlc.arg(deadline), receipt = sqlc.narg(receipt)
WHERE id = sqlc.arg(id) AND status = sqlc.arg(previous);

-- name: AppendCommandTransition :exec
INSERT INTO command_transitions (command_id, previous, next, actor, reason, at)
VALUES (?, ?, ?, ?, ?, ?);

-- name: ListCommandTransitions :many
SELECT * FROM command_transitions WHERE command_id = ? ORDER BY sequence;

-- name: PutDesiredState :exec
INSERT INTO desired_states (strategy_id, control_id, command_id, revision, value) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (strategy_id, control_id) DO UPDATE SET
command_id = excluded.command_id, revision = excluded.revision, value = excluded.value;

-- name: ListDesiredStates :many
SELECT d.*, c.status, c.updated_at FROM desired_states d JOIN commands c ON c.id = d.command_id
WHERE d.strategy_id = ? AND d.revision = ? ORDER BY d.control_id;

-- name: InsertExecutionPermit :exec
INSERT INTO execution_permits (command_id, digest, issued_at, claim_key_digest) VALUES (?, ?, ?, ?);

-- name: GetExecutionPermit :one
SELECT digest, claim_key_digest FROM execution_permits WHERE command_id = ?;

-- name: ListPendingCommands :many
SELECT * FROM commands
WHERE strategy_id = sqlc.arg(strategy_id) AND instance_id = sqlc.arg(instance_id) AND boot_id = sqlc.arg(boot_id)
AND status = 'pending' AND deadline > sqlc.arg(now) AND revision = sqlc.arg(revision)
ORDER BY created_at, id LIMIT 32;

-- name: ListCommands :many
SELECT * FROM commands
WHERE (sqlc.arg(strategy_id) = '' OR strategy_id = sqlc.arg(strategy_id))
AND (sqlc.arg(status) = '' OR status = sqlc.arg(status))
AND (created_at < sqlc.arg(before_at) OR (created_at = sqlc.arg(before_at) AND id < sqlc.arg(before_id)))
ORDER BY created_at DESC, id DESC LIMIT sqlc.arg(page_size);

-- name: GetStaleCommands :many
SELECT c.* FROM commands c
JOIN strategies s ON s.id = c.strategy_id
LEFT JOIN control_registries r ON r.strategy_id = c.strategy_id
LEFT JOIN agent_instances i ON i.strategy_id = c.strategy_id AND i.instance_id = c.instance_id
LEFT JOIN agent_sessions a ON a.strategy_id = c.strategy_id AND a.instance_id = c.instance_id
LEFT JOIN agent_tokens t ON t.id = a.token_id
WHERE c.status IN ('confirmation_required','pending','accepted','executing') AND (
    c.deadline <= sqlc.arg(now_ms)
    OR (c.status = 'executing' AND sqlc.arg(restart) = 1)
    OR s.archived_at IS NOT NULL OR s.executor_instance IS NOT c.instance_id
    OR r.revision IS NOT c.revision OR i.boot_id IS NOT c.boot_id
    OR i.last_seen <= sqlc.arg(seen_after)
    OR a.digest IS NULL OR a.expires_at <= sqlc.arg(now) OR t.revoked_at IS NOT NULL
    OR t.expires_at <= sqlc.arg(now) OR (t.scopes & 8) = 0
    OR (c.status IN ('accepted','executing') AND a.token_id IS NOT c.accepted_by)
)
ORDER BY c.deadline LIMIT 128;

-- name: ListAudit :many
SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100;

-- name: InsertTradeEvent :execrows
INSERT INTO trade_events (strategy_id, report_id, instance_id, kind, series, observed_at, data, fingerprint, associations, received_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING;

-- name: TradeEventFingerprint :one
SELECT fingerprint FROM trade_events WHERE strategy_id = ? AND kind = ? AND report_id = ?;

-- name: ListTradeEvents :many
SELECT * FROM trade_events
WHERE kind = sqlc.arg(kind) AND (sqlc.arg(strategy_id) = '' OR strategy_id = sqlc.arg(strategy_id))
AND (observed_at, report_id, strategy_id) < (sqlc.arg(before_at), CAST(sqlc.arg(before_id) AS TEXT), CAST(sqlc.arg(before_strategy) AS TEXT))
ORDER BY observed_at DESC, report_id DESC, strategy_id DESC LIMIT sqlc.arg(page_size);

-- name: LatestOrders :many
SELECT e.* FROM trade_events e
WHERE e.strategy_id = ? AND e.kind = 'order' AND NOT EXISTS (
    SELECT 1 FROM trade_events newer
    WHERE newer.strategy_id = e.strategy_id AND newer.kind = e.kind
    AND newer.instance_id = e.instance_id AND newer.series = e.series
    AND (newer.observed_at, newer.report_id) > (e.observed_at, e.report_id)
) ORDER BY e.observed_at DESC, e.report_id DESC LIMIT 1000;

-- name: FillFingerprint :one
SELECT fingerprint FROM trade_events WHERE strategy_id = ? AND series = ? AND kind = 'fill';

-- name: CountConflictingPlanCommands :one
SELECT count(*) FROM commands
WHERE strategy_id=sqlc.arg(strategy_id) AND id<>sqlc.arg(command_id)
AND status IN ('created','confirmation_required','pending','accepted','executing','unknown')
AND (CAST(sqlc.arg(is_plan) AS BOOLEAN) OR id GLOB 'plan-*');

-- name: RecordCapabilityState :execrows
INSERT INTO capability_state_history (strategy_id,capability_id,revision,instance_id,boot_id,observed_at,received_at,value,available,reason)
VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING;

-- name: ReadCapabilityStateHistory :one
SELECT * FROM capability_state_history WHERE strategy_id=? AND capability_id=? AND observed_at=? AND revision=?;

-- name: ReplayCapabilityState :many
SELECT * FROM capability_state_history WHERE strategy_id=? AND capability_id=?
AND observed_at>=sqlc.arg(from_at) AND observed_at<sqlc.arg(to_at)
AND (observed_at<sqlc.arg(cursor_at) OR observed_at=sqlc.arg(cursor_at) AND revision<sqlc.arg(cursor_revision))
ORDER BY observed_at DESC,revision DESC LIMIT sqlc.arg(page_size);

-- name: PruneCapabilityStates :execrows
DELETE FROM capability_state_history WHERE (strategy_id,capability_id,observed_at,revision) IN (
 SELECT h.strategy_id,h.capability_id,h.observed_at,h.revision FROM capability_state_history h
 WHERE h.received_at<sqlc.arg(cutoff) ORDER BY h.received_at LIMIT 2000
);

-- name: FindAssociatedTrades :many
SELECT * FROM trade_events
WHERE strategy_id = @strategy_id AND json_extract(associations, @json_path) = @association
ORDER BY observed_at DESC, report_id DESC LIMIT 50;

-- name: DeleteObsoleteResourceCollections :execrows
DELETE FROM resource_collections WHERE resource_collections.strategy_id = ? AND NOT EXISTS (
    SELECT 1 FROM control_definitions d WHERE d.strategy_id = resource_collections.strategy_id
    AND d.control_id = resource_collections.capability_id AND d.since_revision = resource_collections.since_revision
);

-- name: PruneResourceUpdates :execrows
DELETE FROM resource_updates WHERE (strategy_id, capability_id, since_revision, resource_revision) IN (
    SELECT old.strategy_id, old.capability_id, old.since_revision, old.resource_revision FROM resource_updates AS old
    WHERE old.received_at < sqlc.arg(cutoff) ORDER BY old.received_at LIMIT 2000
);

-- name: FindAssociatedResources :many
SELECT i.* FROM resource_items i JOIN control_definitions d
ON d.strategy_id = i.strategy_id AND d.control_id = i.capability_id AND d.since_revision = i.since_revision
WHERE i.strategy_id = sqlc.arg(strategy_id) AND json_extract(i.links, sqlc.arg(json_path)) = sqlc.arg(association)
ORDER BY i.observed_at DESC, i.resource_id DESC LIMIT 50;
