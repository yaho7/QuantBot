# QuantBot integration guide

Create a strategy in the console. Under **Token and diagnostics**, select **Copy AI integration prompt** and give it to Codex, Cursor, or another coding tool. The prompt includes a ready-to-use Sandbox configuration.

Read the [HTTP protocol](../PROTOCOL.md), [OpenAPI](openapi.json), [JSON Schema](schemas), and [examples](../examples). Inspect the project's language, HTTP client, startup lifecycle, data sources, and risk controls. Run the client alongside the trading program in a background thread or task. The strategy needs no inbound port or additional service.

## One-click AI integration test

1. Sign in as an administrator and copy the integration prompt. QuantBot creates or reuses the strategy's Sandbox and includes its endpoint, temporary Bearer secret, key ID, strategy ID, and expiration.
2. Create a startup-loaded `quantbot.json` and add it to `.gitignore`. The test endpoint ends in `/api/sandbox/agent`. Append the standard relative Agent paths and use `secret` as the Bearer token. Detect the Sandbox endpoint before connecting to a broker. Use simulated data and separate local entry state, command deduplication, and receipts.
3. Review request history, schema validation, registered controls, and simulated receipts in the console. Passing requires a session, heartbeat, telemetry report, registered control, entry-state synchronization, and a successful simulated command receipt. The Sandbox queues simulated pause and refresh for executors that declare those capabilities. You can also run simulated operations from the page.
4. After passing, copy the production setup instructions. Replace `endpoint` and `secret` on the strategy host, retain `instance_name`, restart the program, and check the production workbench. Retrieve the production secret from the strategy's credential panel.

A test session lasts 60 minutes by default. It can be closed early or extended by 60 minutes from the current time. The console warns five minutes before expiration. Sandbox and production credentials are separate. Each Sandbox uses its own bounded in-memory database and runs on a dedicated worker thread. Copy a new configuration after a server restart. Test data is cleared on expiration or closure, with a short-lived diagnostics summary retained.

Limits are 64 KiB per request, 120 requests per minute per key, 600 per minute globally, eight active sessions, two concurrent requests per key, six globally, and about 4 MiB of storage per session. Honor `Retry-After` on 429 responses.

## Configuration

```json
{
  "endpoint": "https://quantbot.example.com/api/agent",
  "secret": "",
  "instance_name": "strategy-001"
}
```

Keep an empty secret in `quantbot.example.json`. Create the local configuration only if absent. If configuration is missing, skip communication and continue applying the strategy's local entry and risk rules. The bundled examples accept `QB_ENDPOINT` and `QB_TOKEN`.

## HTTP clients

| Language | Client |
| --- | --- |
| Python | `urllib.request` or the existing HTTP client |
| JavaScript / TypeScript | Node.js `fetch` or the existing networking layer |
| Go | `net/http` |
| C# | `HttpClient` |
| Java | `java.net.http.HttpClient` |
| C++ | The project's HTTP library or OS networking API |

Send the Bearer secret, JSON headers, and `User-Agent: QuantBot-Integration/1.0`. Append relative paths to `/api/agent` or `/api/sandbox/agent`. Preserve the port, verify TLS, reject redirects, and validate response fields. See [Troubleshooting](TROUBLESHOOTING.md).

## Monitoring and control

Basic monitoring uses `POST /monitor/{instance_id}`. For full integration, establish a session, send `X-Agent-Session`, and honor the returned heartbeat interval and scopes. Coalesce status and account snapshots. Persist fills, risk events, and important receipts in a bounded queue. Reuse IDs, timestamps, and content on retry. Report only data the strategy has.

Declare supported capabilities and prefer read-only controls for display. Apply pause at the actual entry gate and persist the state. Keep exits and risk checks active. Resume remains subject to local risk checks. Follow the last applied disconnect policy and reconcile after reconnecting.

Trading actions require explicit user authorization and must use the program's existing risk and execution paths. Persist command IDs before claiming a one-time permit. Check the deadline and local risk state, persist results before sending receipts, and reconcile unknown outcomes against actual trade records.

## Verification

Use simulated or backtest data with the [Python example](../examples/http_agent.py) or [curl quickstart](../PROTOCOL.md#curl-quickstart). Check the instance and report types in **Token and diagnostics**. Test reconnects, pause and resume, the local risk lock, actual dynamic control values, and command idempotency.

The [Node.js](../examples/http_monitor.mjs) and [Go](../examples/http_monitor.go) examples send a standard status report and show redacted diagnostics. The Python example covers monitoring, backoff, synchronization, and control.

```bash
export QB_ENDPOINT=http://127.0.0.1:23456/api/agent
read -rs QB_TOKEN
export QB_TOKEN
node examples/http_monitor.mjs
go run examples/http_monitor.go
```

Run `QB_REQUIRE_LANGUAGE_TESTS=1 uv run pytest tests/integration/test_language_contract.py` to verify the simulated HTTP contract with Python, Node.js, and Go.
