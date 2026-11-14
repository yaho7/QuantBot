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
