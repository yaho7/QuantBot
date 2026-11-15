# 主机性能上报 / Host performance reporting

Create a strategy and use its Agent Token to open a session. A successful
`POST /api/agent/performance` using that session (`report` scope) automatically
populates the Hosts page. The Host page has no manual registry, machine type
selection, separate machine identifier, or extra credential.

Hosts are grouped by `host_name` after trimming and comparing without regard to
case. The newest observation supplies the current figures. Use different system
host names if you want a Mac and VPS listed separately. Each process is still
identified by its authenticated strategy, instance and boot. Concurrent instances
of one strategy use distinct `instanceId` values; opening a new boot with the same
instance ID is how a process can move to another host. Host reporting does not
affect the Executor assignment or trading commands.

## Report one batch

Download the deployed JSON Schema at
`GET /api/agent/schemas/performance.json`. Use the actual host name from the OS.
Report only measurements you have. Omit `capacity` if it is unknown; otherwise
send the effective number of CPU cores (fractional quotas are allowed) and
memory bytes for the resources you measured. Each record can contain host
measurements, its own process measurements, or both. An omitted value is unknown,
and a reported zero remains zero. No additional setup call is needed.

```bash
endpoint="$(jq -er '.endpoint | sub("/+$"; "")' quantbot.json)"
case "${endpoint#*://}" in */*) ;; *) endpoint="$endpoint/api/agent" ;; esac
curl -fsS -X POST "$endpoint/performance" \
  -H "Authorization: Bearer $agent_session" -H 'Content-Type: application/json' \
  --data-binary @performance-batch.json
```

Use your local [`quantbot.json`](INTEGRATION.md#local-agent-configuration) and set
`agent_session` in the snippet to the current session returned by `POST /session`.
The example JSON below is illustrative;
replace the observation time and all measured values when producing a sample.

```json
{
  "host_name": "quant-vps",
  "capacity": {"cpu_cores": 4, "memory_bytes": 8589934592},
  "records": [{
    "record_id": "sample-20261115-180000-001",
    "observed_at": "2026-11-15T18:00:00+08:00",
    "sample_duration_ms": 15000,
    "host": {
      "cpu_usage_percent": 42.5,
      "memory_available_bytes": 2684354560,
      "disk_available_bytes": 107374182400
    },
    "process": {
      "cpu_cores_used": 0.65,
      "rss_bytes": 536870912
    }
  }]
}
```

Host CPU is 0–100% of the measured pool. Process CPU is the change in process CPU
seconds divided by the elapsed wall seconds: `0.65` means 65% of one core. For
container measurements, report actual CPU and memory limits when known, rather
than the physical computer's resources.

Machines report independently, with no fixed timing requirement. A batch may
contain 1–250 records (up to 256 KiB); the response includes `hostId`,
`inserted` and `duplicate`. On network failure, 429 or 503, retry with backoff and
the same IDs, times and values. Reusing a record ID with different sample data
within a boot returns 409. The schema is separate from the financial
`performance` report type. The [Python example helper](../examples/v3/host_performance.py)
can call the performance API through an existing session client.

## Freshness, curves and capacity

About 15 seconds is a useful sampling interval. Data older than 60 seconds is
shown as stale. When samples resume after a gap exceeding 60 seconds, QuantBot
starts a new curve. A process restart also starts a new process curve; a host
keeps its curve when another strategy is still reporting the same host without a
gap. Late samples do not reconnect a previous run. The details page plots up to
one hour of the current run. Raw performance records age out after three days.

The capacity estimate uses current CPU and available memory with a configurable
reserve. The reference instance can provide an optional
`process_budget: {"cpu_cores":0.65,"memory_bytes":536870912}`. Otherwise QuantBot
uses its latest fresh CPU and RSS readings and marks the result as a reference.
Stale or missing inputs and reported swap pressure suppress the estimate. The
result is advisory; it does not schedule or move any strategy.
