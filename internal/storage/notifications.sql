-- name: ListNotificationChannels :many
SELECT id, name, provider, enabled, events, updated_at
FROM notification_channels ORDER BY name, id LIMIT 32;

-- name: NotificationChannelCount :one
SELECT count(*) FROM notification_channels;

-- name: GetNotificationChannel :one
SELECT * FROM notification_channels WHERE id = ?;

-- name: PutNotificationChannel :exec
INSERT INTO notification_channels(id,name,provider,encrypted,enabled,events,updated_at)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, encrypted=excluded.encrypted,
enabled=excluded.enabled, events=excluded.events, updated_at=excluded.updated_at;

-- name: DeleteNotificationChannel :execrows
DELETE FROM notification_channels WHERE id = ?;

-- name: PauseNotificationDeliveries :exec
UPDATE notification_deliveries SET status='failed', last_error='channel_disabled', finished_at=sqlc.arg(now)
WHERE channel_id=sqlc.arg(channel_id) AND status='queued';

-- name: AddNotificationTestEvent :one
INSERT INTO notification_events(kind,title,body,created_at) VALUES('test',?,?,?) RETURNING id;

-- name: AddNotificationTestDelivery :one
INSERT INTO notification_deliveries(channel_id,event_id,status,next_at)
VALUES(?,?,'queued',?) RETURNING id;

-- name: ListNotificationDeliveries :many
SELECT d.id, d.channel_id, e.kind, d.status, d.attempts, d.next_at, d.last_error, d.provider_id, d.finished_at
FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id
WHERE d.channel_id = ? ORDER BY d.id DESC LIMIT 100;

-- name: NextNotificationDeliveries :many
SELECT d.id, d.channel_id, d.attempts, e.title, e.body, c.provider, c.encrypted
FROM notification_deliveries d
JOIN notification_events e ON e.id=d.event_id
JOIN notification_channels c ON c.id=d.channel_id
WHERE d.status='queued' AND d.next_at <= sqlc.arg(now) AND (c.enabled=1 OR e.kind='test')
ORDER BY d.next_at, d.id LIMIT 32;

-- name: CompleteNotificationDelivery :exec
UPDATE notification_deliveries SET status=sqlc.arg(status), attempts=attempts+1, next_at=sqlc.arg(next_at),
last_error=sqlc.arg(last_error), provider_id=sqlc.arg(provider_id), finished_at=sqlc.narg(finished_at)
WHERE id=sqlc.arg(id) AND status='queued';

-- name: PruneNotificationEvents :exec
DELETE FROM notification_events WHERE id IN (
    SELECT e.id FROM notification_events e WHERE e.created_at < sqlc.arg(cutoff) ORDER BY e.id LIMIT 2000
);
