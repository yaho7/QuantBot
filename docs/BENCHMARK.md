# Reproducible backend benchmark

Build the native service and HTTP workload driver with Go 1.26 and CGO enabled.

```sh
go build -o /tmp/quantbot ./cmd/quantbot
go build -o /tmp/qb-bench ./cmd/qb-bench
/tmp/qb-bench -binary /tmp/quantbot -agents 1000 -cycles 10 -parallel 128
```

The driver starts an isolated service, creates strategies and sessions over HTTP, simulates reporting Agents and checks acknowledged counts against persisted samples. It cleans up the process and data directory on exit. It uses GOMAXPROCS=2. Every 23rd report is replayed unchanged to verify duplicate handling. Other flags include `-points`, `-streams`, `-controls`, `-history` and `-idle`.

## Local run on 2026-11-14

Darwin arm64, Mac18,5, 12 CPU cores and 16 GiB RAM. This local run uses two Go execution threads. CPU is cumulative process time divided by elapsed time, so 100% is one core. Peak RSS includes initialization and password hashing. The driver samples authenticated diagnostics every 20 ms, which adds measurement overhead. Queue peaks are sampled. Workload timings exclude strategy/session provisioning and SSE setup.

| Workload | Records | Elapsed s | Writes/s | Report P95 ms | Peak RSS MiB | Retries |
| --- | --- | --- | --- | --- | --- | --- |
| idle | 0 | 3.001 | 0 | 0.00 | 85.5 | 0 |
| agents-10 | 1000 | 2.694 | 371 | 36.98 | 142.1 | 0 |
| agents-100 | 3000 | 0.979 | 3065 | 82.56 | 155.8 | 0 |
| agents-1000 | 10000 | 2.847 | 3513 | 82.05 | 125.9 | 0 |
| high-frequency | 100000 | 3.861 | 25898 | 252.33 | 158.0 | 0 |
| mixed-control | 30000 | 1.894 | 15843 | 59.82 | 158.6 | 0 |
| sse-500 | 3000 | 0.685 | 4379 | 25.93 | 164.3 | 0 |

All seven workloads completed with matching sent and persisted record counts, zero rejected records and zero workload errors. The mixed-control run completes 100 command lifecycles alongside 30,000 telemetry records. The SSE workload holds 500 subscribers alongside 100 reporting Agents. Exact P50/P95/P99, CPU, WAL sizes, sampled queue depths and counters are recorded in the adjacent JSON artifacts.

The requested 2 vCPU/2 GB VPS comparison, long-duration soak, SQLite driver comparison and theme-switch benchmark remain pending. The service currently uses mattn/go-sqlite3 with CGO. A release claim requires the remaining measurements and deployment checks.
