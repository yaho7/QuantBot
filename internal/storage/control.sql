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
INSERT INTO agent_tokens (id, strategy_id, digest, label, scopes, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: ListAgentTokens :many
SELECT id, strategy_id, label, scopes, created_at, expires_at, revoked_at
FROM agent_tokens WHERE strategy_id = ? ORDER BY created_at DESC, id LIMIT 256;

-- name: GetLiveAgentToken :one
SELECT t.* FROM agent_tokens t JOIN strategies s ON s.id = t.strategy_id
WHERE t.digest = sqlc.arg(digest) AND t.revoked_at IS NULL AND s.archived_at IS NULL
AND (t.expires_at IS NULL OR t.expires_at > sqlc.arg(now));

-- name: RevokeAgentToken :execrows
UPDATE agent_tokens SET revoked_at = sqlc.arg(now)
WHERE id = sqlc.arg(token_id) AND strategy_id = sqlc.arg(strategy_id) AND revoked_at IS NULL;

-- name: RevokeStrategyTokens :exec
UPDATE agent_tokens SET revoked_at = ? WHERE strategy_id = ? AND revoked_at IS NULL;

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
INSERT INTO agent_sessions(digest, strategy_id, instance_id, boot_id, token_id, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(strategy_id, instance_id) DO UPDATE SET
    digest = excluded.digest, boot_id = excluded.boot_id,
    token_id = excluded.token_id, expires_at = excluded.expires_at;

-- name: GetLiveAgentSession :one
SELECT a.strategy_id, a.instance_id, a.boot_id, a.token_id, a.expires_at,
    t.scopes, s.executor_instance, i.last_seen
FROM agent_sessions a
JOIN agent_tokens t ON t.id = a.token_id
JOIN strategies s ON s.id = a.strategy_id
JOIN agent_instances i ON i.strategy_id = a.strategy_id AND i.instance_id = a.instance_id AND i.boot_id = a.boot_id
WHERE a.digest = sqlc.arg(digest) AND a.expires_at > sqlc.arg(now) AND t.revoked_at IS NULL
AND (t.expires_at IS NULL OR t.expires_at > sqlc.arg(now)) AND s.archived_at IS NULL;

-- name: UpdateAgentHeartbeat :execrows
UPDATE agent_instances SET last_seen = sqlc.arg(now)
WHERE strategy_id = sqlc.arg(strategy_id) AND instance_id = sqlc.arg(instance_id) AND boot_id = sqlc.arg(boot_id);
