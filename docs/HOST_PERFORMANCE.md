# 主机性能上报 / Host performance reporting

QuantBot can show the resources available where strategy processes actually run,
whether they run on a Mac, a VPS, or in a container. Hardware data is optional and
uses the existing Agent HTTP connection. It never grants execution access or changes
the configured Executor.

## Add and bind

1. In **Hosts → Add host**, create an entry for each computer or shared resource pool.
   Select **Machine** for whole-machine measurements. For a container with its own
   quota, create a **Container quota** entry and measure that CPU/memory pool. Separate
   containers with different limits need separate entries, even on the same machine.
2. Assign exactly one strategy and instance ID to submit *host-wide* metrics to
   each entry. Copy the generated `host_id` and binding key into the local
   environment as `QB_HOST_ID` and `QB_HOST_BINDING_KEY`. Keep the binding key private.
   Processes sharing a resource pool use the same binding credentials, but a
   non-reporter only sends its own process metrics.
3. Use the existing Agent session with `report` scope. Call `PUT /api/agent/host`
   once per process boot, or again if the capacity or budget changes. Do not
   rebind on routine session renewal. The API derives strategy, instance, and
   boot identity from the session. A running boot cannot change its host binding.
   The response includes `hostId`, `hostReporter`, and the capacity `revision`.
   The same binding endpoint may set `process_budget` for the current boot.
   Omit the budget to use the historical estimate; re-binding without it clears it.

For Mac and VPS running **at the same time**, give them distinct `instanceId` values
(e.g. `mac-dev` and `vps-live`) and open a new `bootId` each time a process starts.
Configure one host entry and its key for each environment. They may use the same
strategy if appropriate, but production execution remains assigned to a single
Executor. For a **move** with no simultaneous processes, the new host can use the
same logical `instanceId` with a fresh `bootId` and its own host credentials. The
old session stops being valid under the existing Agent protocol. Updating the
host ID, binding key, and optionally the instance ID in the environment is enough;
the reporting code and routes are the same on both machines.

The binding key is separate from the Agent token. To replace a lost key, use the
host details page to rotate it. Rotation affects future binding requests; existing
bindings can still report. Revoking an Agent token, removing its `report` scope, or
archiving its strategy stops that Agent from using the performance endpoints.

## Schema and curl

Download the strict machine-readable schema at
`GET /api/agent/schemas/performance.json`. The root describes the sample batch;
`#/$defs/binding` describes the host binding. No Sandbox host data is mixed into
production; these optional routes are only on the production Agent endpoint.

Example for a designated reporter, with an existing `QB_AGENT_SESSION`:

```bash
jq -n --arg id "$QB_HOST_ID" --arg key "$QB_HOST_BINDING_KEY" \
  '{host_id:$id,binding_key:$key,capacity:{cpu_cores:4,memory_bytes:8589934592}}' |
  curl -fsS -X PUT "$QB_AGENT_URL/host" \
    -H "Authorization: Bearer $QB_AGENT_SESSION" -H 'Content-Type: application/json' --data-binary @-
```

Here `QB_AGENT_URL` is the full base, e.g. `http://127.0.0.1:23457/api/agent`.
Replace the illustrative capacity with the *measured effective capacity*.
A non-reporter omits `capacity`. A fractional `cpu_cores` such as `1.5` is allowed.
The optional `process_budget` has the same shape as `capacity`.

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
