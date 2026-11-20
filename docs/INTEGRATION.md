# QuantBot Agent integration

Create a strategy in **Administration → Strategies**. The connection dialog shows
the **Endpoint**, **Key** (credential ID), and **Token** (Bearer secret). Reopen it
from the strategy row to view or replace the Token. Replacing a Token immediately
invalidates its old sessions; update the strategy's configuration with the new
Token. The separate **Copy AI integration prompt** action includes the current
Agent URL, target strategy, deployed schemas and GitHub links to protocol and
examples. Copy the production Token separately into the private local file described below.

Read the [Agent protocol](AGENT_PROTOCOL.md), [declaration and batch schemas](../internal/server/schemas/agent.json), and [standard report record schema](../internal/telemetry/schemas/report.json).

## Validate in Sandbox

The strategy connection dialog opens on **Sandbox test**. Switch to **Production** to view the permanent credentials. Creating a strategy
automatically starts the shared test environment when needed. You can also start
it manually. Opening an already active test reuses the current run and key.
Copy the test prompt for the temporary token, `/api/agent/sandbox/{id}` base URL,
expiry, a ready-to-save JSON configuration, and protocol links. Save it as
`quantbot.json` in a separate local test directory. Append the usual relative
Agent routes. Use simulated strategy and broker operations. Sandbox state and credentials are separate from
production.

The first connected instance becomes the Sandbox executor. Register a simulated
no-input button and publish its availability. The server automatically queues a single test command.
The checklist verifies session, heartbeat, capabilities, state, reports, events,
resources, polling, claim and a successful result. Afterward, use the production
prompt and Token to connect the actual strategy.

A run lasts 60 minutes unless extended or closed. Expiration, closure or a server
restart discards the isolated in-memory databases. The environment allows up to
64 KiB per request, 120 requests per minute and three concurrent Agent requests.
Honor `Retry-After` on HTTP 429.

## Local Agent configuration

Save [`examples/v3/quantbot.example.json`](../examples/v3/quantbot.example.json) as
`quantbot.json` in the strategy process's working directory. Fill in `endpoint`,
`key`, and `token` with the corresponding values from the strategy's API dialog.

```json
{
  "endpoint": "https://quantbot.example.com/api/agent",
  "key": "",
  "token": "",
  "instance_name": "paper-example-001",
  "strategy_id": "",
  "heartbeat_seconds": 15,
  "disconnect_policy": "continue"
}
```

- `endpoint` is a plain HTTP or HTTPS URL. An origin gets `/api/agent` appended.
  A complete Agent or Sandbox endpoint is used as written.
- `key` stores the optional credential ID. `token` holds the required Agent Token
  used as Bearer for the session exchange. Keep the returned session in memory.
- `instance_name`: stable process identity mapped to `instanceId`. Give concurrently
  running instances different names. `strategy_id`: optional check against the
  session's strategy ID; leave it empty for the shared Sandbox.
- `heartbeat_seconds`: defaults to 15. The examples accept shorter intervals
  from 1 to 15 seconds. The server still marks an instance offline after 45 seconds.
- `disconnect_policy: "continue"`: the strategy keeps its local logic, risk
  checks and exits running while disconnected. Remote control waits for a
  valid session. The demos do not connect to a broker.

Read the file at startup. For a regenerated Token, update the local `key` and
`token`, and reload them or restart the Agent client. The examples also accept
`secret` from earlier configurations when `token` is absent. Restrict file
permissions to the strategy user, and exclude `quantbot.json` from Git and Docker build contexts.

## Try the protocol on a paper strategy

Run from the repository root. Create a paper strategy, copy its connection
values, and fill in the local file. The sample file contains no usable credentials.

```bash
install -m 600 examples/v3/quantbot.example.json quantbot.json
# Edit quantbot.json, then choose one example:
python3 examples/v3/report.py
node examples/v3/report.mjs
go run ./examples/v3
bash examples/v3/report.sh
```

After connecting, select the instance as Executor in
**Administration → Strategies → API → Executor**. Each example registers
capabilities, updates state, and sends a report and an event. The shell example
uses curl, jq and OpenSSL; the Node.js example uses the built-in Fetch API.

For the simulated **Refresh demo state** command, add `--demo-control` to any
example command, then trigger the action from the paper strategy or from the
Sandbox. Each client claims one permit and submits the same receipt twice to
show idempotent receipt handling. Run one example at a time per strategy.

## AI integration prompt

```text
Integrate this trading program with QuantBot using a local quantbot.json file.
Read endpoint, key, token, and instance_name at startup. Use token as the Bearer
credential and keep key as a credential ID for reference. Use a plain URL for endpoint.
Add quantbot.json to .gitignore. Preserve the strategy's local operation on disconnect.
Read /api/agent/schemas/agent.json and /api/agent/schemas/report.json on that host.
Use the existing HTTP client and startup lifecycle with bounded I/O and retries.

Use POST /api/agent/session with a stable instanceId and a new bootId per process.
Use its short-lived session Bearer and PUT /api/agent/heartbeat every 15 seconds.
The offline threshold is 45 seconds. Use renewAt to renew in the background,
normally ten minutes before the one-hour session expires. Use the original
Agent token, same instanceId and same bootId. Serialize refreshes, then atomically
replace the session. Use exponential backoff and jitter for transient failures.
Handle session_expired by refreshing once or using a newer stored session.
Treat Agent token revocation, expiration, archive and scope errors separately.
Keep heartbeats, renewal and command execution independent.
Use PUT /api/agent/capabilities at startup and when the declaration changes.
Only the designated executor can publish the strategy registry. Declare real metrics, states,
parameters, actions, resources and events. Use
presentation only for display suggestions. Use health for health-state grouping.
Send actual values via PUT /api/agent/state, historical points via
POST /api/agent/reports, events via POST /api/agent/events and resource batches via
PUT /api/agent/resources/{type}. Use mode snapshot only for the full collection,
or mode patch with upsert/delete and the last resourceRevision. Send a stable
Idempotency-Key. Use epoch milliseconds for observation time.
Reuse record IDs, observation times and contents on retry. Include explicit
association IDs only when present in the source system.

For the designated executor, use GET /api/agent/commands and
POST /api/agent/commands/{id}/claim using a durable Idempotency-Key. On a lost
response, reuse the key and reconcile on claim_reconciliation_required. Require the unique permit, a valid deadline,
and local safety checks before invoking the actual strategy or broker operation.
Persist a local journal keyed by command ID. Record the actual outcome via
POST /api/agent/commands/{id}/result and retry the saved receipt unchanged.
Report observed state separately. Keep risk checks and exit paths active.
Declare atomic_parameters only when the strategy can apply the whole plan in
one atomic operation. Trial the integration with a dedicated paper strategy
and simulated operations before enabling production credentials.
```

A Go strategy can embed the [session client](../agent/session.go) using its existing HTTP client. Start `Client.Run(ctx)` in a background task and use `Client.Do` for Agent calls. After a transport failure, use the endpoint’s idempotency rules and the local execution journal.

## Optional host monitoring

See [host performance](HOST_PERFORMANCE.md) to discover Mac and VPS hosts directly from reports,
send measured CPU/memory/disk data, and estimate remaining capacity. Use
independent schedules. If the same strategy runs on both machines simultaneously,
set a distinct stable `instance_name` in each machine’s local `quantbot.json`.

The Sandbox automatically queues one simulated action after an available action
control is registered and its state is reported. The Agent polls, claims and
returns the receipt normally; no browser click is needed. Repeated reports or
reconnects do not queue the probe again. This uses only the isolated Sandbox
store and never creates a production command.
