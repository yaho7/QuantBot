-- name: ListThemes :many
SELECT installed_themes.*, theme_revisions.bundle, theme_revisions.configuration
FROM installed_themes JOIN theme_revisions
ON theme_revisions.theme_id=installed_themes.id AND theme_revisions.revision=installed_themes.revision
ORDER BY installed_themes.id;

-- name: GetTheme :one
SELECT installed_themes.*, theme_revisions.bundle, theme_revisions.configuration
FROM installed_themes JOIN theme_revisions
ON theme_revisions.theme_id=installed_themes.id AND theme_revisions.revision=installed_themes.revision
WHERE installed_themes.id=?;

-- name: GetThemeRevision :one
SELECT * FROM theme_revisions WHERE theme_id=? AND revision=?;

-- name: StoreTheme :exec
INSERT INTO installed_themes(id,revision,previous_revision,updated_at) VALUES(?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
revision=excluded.revision, previous_revision=excluded.previous_revision, updated_at=excluded.updated_at;

-- name: StoreThemeRevision :exec
INSERT INTO theme_revisions(theme_id,revision,bundle,configuration) VALUES(?,?,?,?);

-- name: DeleteThemeRevision :exec
DELETE FROM theme_revisions WHERE theme_id=? AND revision=?;

-- name: StoreThemeConfiguration :exec
UPDATE theme_revisions SET configuration=sqlc.arg(configuration)
WHERE theme_id=sqlc.arg(theme_id) AND revision=sqlc.arg(revision);

-- name: DeleteTheme :execrows
DELETE FROM installed_themes WHERE id=?;
