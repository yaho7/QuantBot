CREATE TABLE commands (
    id TEXT PRIMARY KEY NOT NULL,
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    control_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    input TEXT NOT NULL CHECK (json_valid(input)),
    actor TEXT NOT NULL,
    request_key TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    accepted_by TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'created','confirmation_required','pending','accepted','executing',
        'succeeded','failed','unknown','cancelled','expired','rejected'
    )),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL,
    receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
    UNIQUE (actor, strategy_id, request_key)
) STRICT;

CREATE INDEX commands_poll ON commands (strategy_id, instance_id, boot_id, status, created_at);
CREATE INDEX commands_history ON commands (strategy_id, created_at DESC, id);
CREATE INDEX commands_expiry ON commands (status, deadline);
CREATE UNIQUE INDEX commands_active_control ON commands (strategy_id, control_id)
WHERE status IN ('created','confirmation_required','pending','accepted','executing','unknown');

CREATE TABLE execution_permits (
    command_id TEXT PRIMARY KEY NOT NULL REFERENCES commands(id),
    digest TEXT NOT NULL,
    issued_at INTEGER NOT NULL
) STRICT;

CREATE TABLE command_transitions (
    sequence INTEGER PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES commands(id),
    previous TEXT,
    next TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
) STRICT;
CREATE INDEX command_transitions_command ON command_transitions(command_id, sequence);

CREATE TABLE desired_states (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    control_id TEXT NOT NULL,
    command_id TEXT NOT NULL REFERENCES commands(id),
    revision INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    PRIMARY KEY (strategy_id, control_id)
) STRICT, WITHOUT ROWID;
