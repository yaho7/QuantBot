CREATE TABLE installed_themes (
    id TEXT PRIMARY KEY NOT NULL,
    revision TEXT NOT NULL,
    previous_revision TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE theme_revisions (
    theme_id TEXT NOT NULL REFERENCES installed_themes(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    revision TEXT NOT NULL,
    bundle TEXT NOT NULL CHECK (json_valid(bundle)),
    configuration TEXT NOT NULL CHECK (json_valid(configuration)),
    PRIMARY KEY (theme_id, revision)
) STRICT, WITHOUT ROWID;

INSERT INTO settings(key,value) VALUES('active_theme','"lumina"') ON CONFLICT DO NOTHING;
