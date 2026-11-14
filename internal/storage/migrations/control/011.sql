ALTER TABLE control_definitions ADD COLUMN since_revision INTEGER NOT NULL DEFAULT 1 CHECK(since_revision > 0);
UPDATE control_definitions SET since_revision = (
    SELECT revision FROM control_registries WHERE control_registries.strategy_id = control_definitions.strategy_id
);
