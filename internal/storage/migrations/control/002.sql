CREATE TABLE users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE browser_sessions (
    digest TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);

CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    strategy_id TEXT,
    command_id TEXT,
    details TEXT NOT NULL CHECK (json_valid(details))
) STRICT;
CREATE INDEX audit_at ON audit(at, id);
