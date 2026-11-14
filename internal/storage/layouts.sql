-- name: GetLayout :one
SELECT * FROM layouts WHERE user_id = ? AND key = ?;

-- name: PutLayout :exec
INSERT INTO layouts(user_id,key,revision,widgets) VALUES(?,?,?,?)
ON CONFLICT(user_id,key) DO UPDATE SET revision=excluded.revision,widgets=excluded.widgets;
