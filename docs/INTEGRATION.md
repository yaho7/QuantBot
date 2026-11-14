# QuantBot Agent integration

Create a dedicated paper strategy in **Administration → Strategies**. Copy the Agent credential when it is issued. The **Integration** page shows the Agent URL and offers a copyable AI prompt. Inject credentials through a local secret store or a protected environment variable on the strategy host.

Read the [Agent protocol](AGENT_PROTOCOL.md), [declaration and batch schemas](../internal/server/schemas/agent.json), and [standard report record schema](../internal/telemetry/schemas/report.json).

## Try the protocol on a paper strategy

From the repository root, set the endpoint and credential. Run one client per test strategy so each owns its capability registry.

```bash
export QB_AGENT_URL=http://127.0.0.1:23456/api/agent
read -rs QB_TOKEN
export QB_TOKEN
python3 examples/v3/report.py
node examples/v3/report.mjs
go run ./examples/v3
bash examples/v3/report.sh
```

Start the example, then designate its connected instance in **Administration → Integration**. Each example opens a session, waits for executor assignment, registers a broker health state, a chartable metric, and an event, then sends independent updates with observation times. It prints the state and ingestion acknowledgments. The curl example uses curl, jq and OpenSSL. The Node.js example uses the built-in Fetch API.

To exercise a control command, run any example with `QB_DEMO_CONTROL=1`. The default instance IDs are `python-example`, `js-example`, `go-example` and `curl-example`. Set `QB_INSTANCE_ID` to override them. Once **Refresh demo state** appears in the paper strategy, activate it. The example claims one permit, refreshes the reported state, and submits the same receipt twice to demonstrate idempotency. The examples perform only a simulated state refresh. Use a durable execution journal for a trading integration.

## AI integration prompt

```text
Integrate this trading program with QuantBot using the Agent base URL
https://quantbot.example.com/api/agent and the QB_AGENT_TOKEN environment variable.
Read /api/agent/schemas/agent.json and /api/agent/schemas/report.json on that host.
Use the existing HTTP client and startup lifecycle with bounded I/O and retries.

Use POST /api/agent/session with a stable instanceId and a new bootId per process.
Use its short-lived session Bearer and PUT /api/agent/heartbeat every 15 seconds.
Use PUT /api/agent/capabilities at startup and when the declaration changes.
Only the designated executor can publish the strategy registry. Declare real metrics, states,
parameters, actions, resources and events. Use
presentation only for display suggestions. Use health for health-state grouping.
Send actual values via PUT /api/agent/state, historical points via
POST /api/agent/reports, events via POST /api/agent/events and resource batches via
PUT /api/agent/resources/{type}. Use epoch milliseconds for observation time.
Reuse record IDs, observation times and contents on retry. Include explicit
association IDs only when present in the source system.

For the designated executor, use GET /api/agent/commands and
POST /api/agent/commands/{id}/claim. Require the unique permit, a valid deadline,
and local safety checks before invoking the actual strategy or broker operation.
Persist a local journal keyed by command ID. Record the actual outcome via
POST /api/agent/commands/{id}/result and retry the saved receipt unchanged.
Report observed state separately. Keep risk checks and exit paths active.
Declare atomic_parameters only when the strategy can apply the whole plan in
one atomic operation. Trial the integration with a dedicated paper strategy
and simulated operations before enabling production credentials.
```
