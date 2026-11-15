# 主机性能上报 / Host performance reporting

QuantBot can show the resources available where strategy processes actually run,
whether they run on a Mac, a VPS, or in a container. Hardware data is optional and
uses the existing Agent HTTP connection. It never grants execution access or changes
the configured Executor.

## Let the strategy discover the host

1. Create a strategy to obtain its Agent Token. Establish an Agent session as usual.
2. From the strategy's integration code, call `PUT /api/agent/host` with the
   session Bearer (`report` scope). Send the actual host name, resource scope, and a
   locally generated UUIDv4 (32 lower-case hexadecimal digits, no hyphens).
   Persist that UUID privately per resource pool outside the project checkout.
   Host names and IP addresses are display data and do not decide identity.
   Several strategies on the same resource pool can read the same local ID file.
   Use separate state directories for different container pools, and never copy
   the ID to a different machine or bake it into an image. The browser never
   receives this ID.
3. If you can measure the effective CPU and memory capacity, send it as
   `capacity`. Add an optional `process_budget` in the same shape to propose
   a per-instance CPU/memory budget. The response includes `hostId`,
   `hostReporter`, and the capacity `revision`. Every bound process can report
   its own metrics. Only the currently elected reporter sends host-wide samples.

QuantBot discovers entries and determines the reporter automatically. Re-register
on each boot or when host metadata, effective capacity, or a declared budget
changes. A candidate that can measure capacity may re-register periodically if
another process is the reporter; a stale, moved, revoked, or archived reporter can
then be replaced. If `POST /performance` replies `not_host_reporter`, refresh
registration and submit process-only data until selected. Routine session renewal
with the same boot does not invalidate the binding. Omitting a previously
registered `process_budget` clears it.

For Mac and VPS running at the same time, use different stable `instanceId`
values. Use a new `bootId` on each process launch. For a move with no concurrent
processes, the new process can use the same logical `instanceId` with a new
`bootId`. The VPS generates its own machine ID. The reporting code and routes are
the same. The existing Executor assignment still governs trading commands.

## Schema and curl

Download the strict schema at `GET /api/agent/schemas/performance.json`. The root
describes a sample batch; `#/$defs/binding` describes discovery. These optional
routes are only on the production Agent endpoint, so Sandbox activity is isolated.

Example registration, with an existing `QB_AGENT_SESSION` and a stable UUID
loaded from local private state by the integration code:

```bash
jq -n --arg id "$LOCAL_MACHINE_ID" --arg name "$(hostname)"   '{machine_id:$id,name:$name,scope:"machine",capacity:{cpu_cores:4,memory_bytes:8589934592}}' |
  curl -fsS -X PUT "$QB_AGENT_URL/host"     -H "Authorization: Bearer $QB_AGENT_SESSION" -H 'Content-Type: application/json' --data-binary @-
```

Here `QB_AGENT_URL` is the full base, e.g. `http://127.0.0.1:23457/api/agent`.
Replace the illustrative capacity with the measured effective capacity, or omit it
if unavailable. Fractional CPU quotas are allowed. For a container with its own
quota use `scope: "container"` and measure that resource pool.

Send `POST /api/agent/performance` with a persisted JSON batch:

```bash
curl -fsS -X POST "$QB_AGENT_URL/performance" \
  -H "Authorization: Bearer $QB_AGENT_SESSION" -H 'Content-Type: application/json' \
  --data-binary @performance-batch.json
```

```json
{
  "records": [{
    "record_id": "perf-20261115-180000-001",
    "observed_at": "2026-11-15T18:00:00+08:00",
    "sample_duration_ms": 15000,
    "host": {
      "cpu_usage_percent": 42.5,
      "memory_available_bytes": 2684354560,
      "swap_used_bytes": 0,
      "disk_available_bytes": 107374182400
    },
    "process": {
      "cpu_cores_used": 0.65,
      "rss_bytes": 536870912,
      "thread_count": 12
    }
  }]
}
```

Use your actual observation time and values. The host sample's CPU is a percentage
of the registered CPU pool, 0–100. For a strategy process, divide the change in
its CPU time by elapsed wall time to get cores used; `0.65` means about 65% of one
core. Use resident memory (RSS) for the process, and available memory for the same
host/quota scope as the host capacity. For a container, report CPU and free memory
within that quota, even when the machine has more resources. Use the available
space on the disk used by the strategy. An unavailable metric should be omitted;
zero is an actual measurement. Report an explicit `swap_pressure` boolean when
your monitoring system can measure it.

Samples may contain host metrics, process metrics, or both; a non-reporter omits
`host`. Clocks, batches, and reporting schedules are independent. The server
neither requires a particular cadence nor limits the number of hosts per strategy.
About 15 seconds is a useful default for live visibility. The newest sample is
selected by observation time; data older than 60 seconds is marked stale. Keep
clocks synchronized: timestamps more than two minutes in the future are rejected.
Raw samples are pruned after seven days; older samples do not offer retained
history even if the request was accepted.

Batches hold 1–250 records with a 256 KiB limit and are written atomically to
`metrics.db` before ACK. The response is `{"inserted":1,"duplicate":0}`.
Retry transient network failures, 429 or 503 with backoff and the exact same
batch. Reusing a record ID with different contents in the same process returns
409 and does not partially write the batch. IDs are scoped to strategy, instance,
and boot. Reuse the same IDs and boot on session renewal. The bounded concurrent
writer applies backpressure to protect storage; it does not assign time slots or
quota hosts. The [Python helper](../examples/v3/host_performance.py) shows how to
plug real measurements into an existing session client with no new dependency.

## Capacity estimates

In a host's **Capacity estimate**, select a bound reference instance. QuantBot
uses the declared per-instance CPU and memory budget when available. Otherwise it
requires fresh process data and at least 30 distinct minutes with both CPU and RSS
measurements from the current boot over the past 24 hours. It takes the 95th
percentile of the per-minute peaks. A declared budget is useful just after a move
or restart, before there is enough recent history.

The estimate uses the lowest observed CPU and memory headroom in the last minute
and deducts a configurable reserve (20% of total effective capacity by default).
The smaller CPU/memory count is shown with its limiting resource. Missing or stale
inputs, reported swap pressure, or rising swap usage make the estimate unavailable.
Counts apply to similar instances under similar load and do not schedule work.
Disk space and alert suggestions are advisory. To see strategy process metrics in
the workbench, add a **Host and process performance** widget.
