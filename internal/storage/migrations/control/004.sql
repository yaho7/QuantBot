CREATE TABLE control_registries (
    strategy_id TEXT PRIMARY KEY NOT NULL REFERENCES strategies(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE control_definitions (
    strategy_id TEXT NOT NULL REFERENCES control_registries(strategy_id),
    control_id TEXT NOT NULL,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    PRIMARY KEY (strategy_id, control_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE control_states (
    strategy_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    reason TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (strategy_id, control_id),
    FOREIGN KEY (strategy_id, control_id) REFERENCES control_definitions(strategy_id, control_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
