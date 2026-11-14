CREATE TABLE trade_events (
    strategy_id TEXT NOT NULL REFERENCES strategies(id),
    report_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('order', 'fill', 'risk', 'alert')),
    series TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (strategy_id, kind, report_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX trade_events_history ON trade_events(strategy_id, kind, observed_at DESC, report_id DESC);
CREATE INDEX trade_events_latest ON trade_events(strategy_id, kind, instance_id, series, observed_at DESC, report_id DESC);
CREATE INDEX trade_events_feed ON trade_events(kind, observed_at DESC, report_id DESC, strategy_id);
CREATE UNIQUE INDEX trade_events_fill ON trade_events(strategy_id, series) WHERE kind = 'fill';
