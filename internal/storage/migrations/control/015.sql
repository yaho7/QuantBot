CREATE TABLE performance_hosts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('machine', 'container')),
    key_digest TEXT NOT NULL,
    reporter_strategy TEXT NOT NULL REFERENCES strategies(id),
    reporter_instance TEXT NOT NULL,
    capacity TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(capacity)),
    revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE performance_bindings (
    strategy_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    host_id TEXT NOT NULL REFERENCES performance_hosts(id),
    budget TEXT NOT NULL CHECK(json_valid(budget)),
    PRIMARY KEY(strategy_id, instance_id, boot_id),
    FOREIGN KEY(strategy_id, instance_id, boot_id) REFERENCES agent_boots(strategy_id, instance_id, boot_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX performance_bindings_host ON performance_bindings(host_id);
