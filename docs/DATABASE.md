# Databases and telemetry retention

QuantBot opens two SQLite WAL databases with FULL durability, a single writer and four bounded read connections per database. The data directory is locked by one service process. The control database holds administrator and Agent identity, commands, permits, audit and critical order, fill, alert and risk records. The metrics database holds raw reports, latest state, per-boot snapshots, metric definitions and chart rollups.

A mixed upload may commit to the control database before its metrics transaction is admitted. The client uses the original identifiers to retry. QuantBot acknowledges accepted metric records only after their raw rows, latest values and aggregate updates commit. The metric write queue capacity and transaction batch size count requests. Each request is bounded to 250 records and 512 KiB.

## Rollups

Equity, custom metrics and OHLCV are aggregated by strategy, instance and series at 1m, 5m, 1h and 1d. Each inserted raw sample contributes once in the same transaction. Late data within the seven-day window updates every affected bucket. Time and report ID establish first and last values. High and low retain the extrema. OHLCV sums volume and scalar series sum values using exact decimal arithmetic. Counts, bounds and the last value are available to chart clients.

| Data | Retention |
| --- | --- |
| Raw metrics and snapshots | 14 days |
| Noncritical logs | 7 days |
| 1-minute rollups | 30 days |
| 5-minute rollups | 90 days |
| Hourly rollups | 365 days |
| Daily rollups | 3 years |

The latest-value and series catalogs preserve discovery after raw history expires. Critical reports and audit have separate durable retention. A maintenance worker prunes expired rows in bounded batches and logs when a WAL exceeds 64 MiB.

## Querying history

Use `GET /api/strategies/{id}/series` to discover a strategy's instance, series and kind combinations. Supply these values to `GET /api/strategies/{id}/history` as `instanceId`, `series`, and `kind`. Also pass `from` and exclusive `to` in UTC Unix milliseconds and a `points` budget of 1–2000. The response uses raw samples when the requested window and budget permit. For wider or denser queries, it chooses a retained rollup and can combine adjacent buckets to stay within budget. Aggregate boundaries include the entire aligned source bucket. A response with `resolutionMs: 0` contains raw points.

The authenticated workbench can fetch latest observations via `/api/strategies/{id}/telemetry` and historical events via `/api/strategies/{id}/records?kind=fill`. Event pagination uses the final row's `observedAt` and `id` as `beforeAt` and `beforeId`. The cross-strategy `/api/alerts` feed also takes `beforeStrategyId`.
