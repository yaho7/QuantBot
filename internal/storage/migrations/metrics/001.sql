CREATE TABLE metric_definitions (
    strategy_id TEXT NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    PRIMARY KEY (strategy_id, name)
) STRICT, WITHOUT ROWID;
