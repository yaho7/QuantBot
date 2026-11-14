CREATE TABLE capability_state_history (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    capability_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    value TEXT NOT NULL CHECK(json_valid(value)),
    available INTEGER NOT NULL CHECK(available IN (0,1)),
    reason TEXT NOT NULL,
    PRIMARY KEY (strategy_id,capability_id,observed_at,revision)
) STRICT, WITHOUT ROWID;
CREATE INDEX capability_state_history_retention ON capability_state_history(received_at);

ALTER TABLE trade_events ADD COLUMN associations TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(associations));
ALTER TABLE trade_events ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
