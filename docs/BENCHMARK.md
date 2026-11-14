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

## SQLite driver comparison

Two temporary builds used the same HTTP workload and schema from `387fd27`. The alternate build selected `modernc.org/sqlite v1.62.0` with CGO disabled and mapped its connection settings and error codes. Both runs used WAL, FULL durability, immediate writer transactions, one writer, four readers and GOMAXPROCS=2. No alternate driver is required to build QuantBot.

```sh
/tmp/qb-bench -binary /tmp/quantbot -agents 100 -cycles 5 -points 200 -parallel 50 -history 50
```

The table reports medians from three alternating runs per driver on the same Darwin arm64 host. Every run persisted all 100,000 unique records and correctly acknowledged 4,200 replays.

| SQLite driver | Writes/s | Report P95 ms | History P95 ms | Peak RSS MiB |
| --- | --- | --- | --- | --- |
| mattn/go-sqlite3 v1.14.53 | 27,941 | 430.04 | 0.18 | 159.7 |
| modernc.org/sqlite v1.62.0 | 22,838 | 513.88 | 0.21 | 170.9 |

Keep mattn/go-sqlite3 for the higher measured throughput and lower measured memory on this workload. Raw results are in [benchmarks/sqlite](benchmarks/sqlite). [mattn/go-sqlite3](https://github.com/mattn/go-sqlite3) · [modernc.org/sqlite](https://pkg.go.dev/modernc.org/sqlite@v1.62.0)

The requested 2 vCPU/2 GB VPS comparison, long-duration soak and theme-switch benchmark remain pending.
