CREATE TABLE layouts (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    widgets TEXT NOT NULL CHECK(json_valid(widgets)),
    PRIMARY KEY(user_id, key)
) STRICT, WITHOUT ROWID;
