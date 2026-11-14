CREATE TABLE notification_channels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('telegram','feishu','wecom','dingtalk')),
    encrypted BLOB NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    events TEXT NOT NULL CHECK (json_valid(events)),
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    finished_at INTEGER,
    UNIQUE (channel_id, event_id)
) STRICT;

CREATE INDEX notification_ready ON notification_deliveries(status, next_at, id);
CREATE INDEX notification_channel_history ON notification_deliveries(channel_id, id DESC);

CREATE TRIGGER notify_trade_events AFTER INSERT ON trade_events
WHEN NEW.kind IN ('alert','risk','fill') AND EXISTS (
    SELECT 1 FROM notification_channels c, json_each(c.events) j
    WHERE c.enabled = 1 AND j.value = NEW.kind
)
BEGIN
    INSERT INTO notification_events(kind, title, body, created_at)
    VALUES (NEW.kind,
        'QuantBot · ' || (SELECT name FROM strategies WHERE id = NEW.strategy_id),
        CASE WHEN NEW.kind = 'fill'
             THEN 'Fill reported for ' || json_extract(NEW.data, '$.symbol')
             ELSE json_extract(NEW.data, '$.severity') || ': ' || json_extract(NEW.data, '$.message') END,
        unixepoch('now') * 1000);
    INSERT INTO notification_deliveries(channel_id,event_id,status,next_at)
    SELECT c.id, last_insert_rowid(), 'queued', unixepoch('now') * 1000
    FROM notification_channels c, json_each(c.events) j
    WHERE c.enabled = 1 AND j.value = NEW.kind;
END;

CREATE TRIGGER notify_command_transitions AFTER INSERT ON command_transitions
WHEN NEW.next IN ('succeeded','failed','unknown') AND EXISTS (
    SELECT 1 FROM notification_channels c, json_each(c.events) j
    WHERE c.enabled = 1 AND j.value = 'command'
)
BEGIN
    INSERT INTO notification_events(kind,title,body,created_at)
    SELECT 'command', 'QuantBot · ' || s.name,
        'Control ' || cmd.control_id || ': ' || NEW.next || ' (' || cmd.id || ')', NEW.at
    FROM commands cmd JOIN strategies s ON s.id = cmd.strategy_id WHERE cmd.id = NEW.command_id;
    INSERT INTO notification_deliveries(channel_id,event_id,status,next_at)
    SELECT c.id, last_insert_rowid(), 'queued', NEW.at
    FROM notification_channels c, json_each(c.events) j
    WHERE c.enabled = 1 AND j.value = 'command';
END;
