# Agent protocol v1

QuantBot speaks JSON over ordinary HTTP. Use HTTPS for remote integrations. Local loopback development can use HTTP. The strategy independently owns broker connectivity, operations and risk policy.

## Strategy identity and credentials

An administrator creates a strategy with a display name, group and mode (`paper` or `live`). QuantBot assigns a stable strategy ID and returns the first Agent credential. Copy the credential at issuance. List responses return metadata, and the server stores a SHA-256 digest of the random credential.

The four scopes are `heartbeat`, `report`, `control`, and `command`. Issue a second credential to rotate, migrate the Agent to it, then revoke the previous credential. Revocation and archive take effect on subsequent authenticated requests even if the Agent session has time remaining. The administrator must explicitly designate the executor instance.

## Agent session

Send the long-lived credential only to `POST /api/v1/agent/session`.

```http
POST /api/v1/agent/session HTTP/1.1
Authorization: Bearer qbt_…
Content-Type: application/json

{"instanceId":"worker-a","bootId":"unique-id-for-this-process"}
```

`instanceId` persists across process restarts. Generate a new unpredictable `bootId` for each process start. Reuse that boot ID when renewing the session. IDs are 1–96 characters and use ASCII letters, digits, dots, underscores, colons or hyphens, beginning with a letter or digit.

The response is HTTP 201 with `strategyId`, `instanceId`, `bootId`, `lastSeen`, `executor`, `expiresAt`, and `session`. Times are UTC Unix seconds. Present the returned session as `Authorization: Bearer qbs_…` on subsequent requests. A session expires after 15 minutes or at credential expiration, whichever occurs first.

A new session replaces the previous session for the same strategy and instance. A new boot retires the previous boot permanently and invalidates its session. A retired boot attempting registration receives HTTP 409. Persist execution receipts independently of session renewal.

## Heartbeat

Call `PUT /api/v1/agent/heartbeat` with the session Bearer token and no body. The response contains the effective identity, executor assignment, session expiry and last-seen time. Use a heartbeat interval shorter than the 45-second presence window, such as 15 seconds. HTTP 401 requires checking the credential and creating a fresh session. An archived strategy cannot reconnect.

## Dynamic controls

The designated executor with both `control` and `command` scopes publishes a registry with `PUT /api/v1/agent/controls`. First read `GET /api/v1/agent/controls` to obtain the current revision, or use zero for a new strategy. A registry change replaces the full list and increments the revision. An identical retry from the same boot with the current or immediately preceding base revision returns the saved revision. A conflicting update returns HTTP 409. A new boot republishes against the current revision before reporting state.

```json
{
  "version": 1,
  "baseRevision": 0,
  "controls": [
    {
      "id": "allow-entry",
      "kind": "toggle",
      "title": "Allow new entries",
      "risk": "high",
      "confirm": true,
      "timeoutSeconds": 30
    }
  ]
}
```

Kinds are `button`, `toggle`, `slider`, `numberInput`, `textInput`, `select`, `multiSelect`, `status`, `metricDisplay`, and `form`. Numeric values, ranges, and steps are decimal strings. Options are objects with `value` and `label`. Forms contain a `fields` array of input definitions. Button input is JSON null. Use `readOnly` and `disabled` for static constraints.

`PUT /api/v1/agent/controls/state` takes `version: 1`, the committed `revision`, and `states`. Each entry has `id`, `value`, `available`, `observedAt` in UTC Unix milliseconds, and optional `reason`. Use availability and reason to report local safety locks. State batches validate and commit atomically. Replays return duplicate counts, older observations return stale counts, and conflicting values for the same timestamp are rejected. Registry changes clear previous actual state. Actual state and availability come from the Agent.

## Commands

The designated online executor with `command` scope calls `GET /api/v1/agent/commands?wait=25`. The server waits up to the configured window and returns an array, empty at timeout. `wait=0` returns immediately. Disconnecting a poll does not change commands. The response is an offer to process the listed command.

1. Call `POST /api/v1/agent/commands/{id}/accept` with the current session. A successful response binds the command to that session. A repeated acceptance for the same current session is safe.
2. Verify local readiness, then call `POST /api/v1/agent/commands/{id}/claim` with the same session. One request can succeed. The response includes `permit` and the execution `deadline` as Unix milliseconds. Execute only if the response contains the grant and the deadline remains valid.
3. Journal the execution outcome and call `POST /api/v1/agent/commands/{id}/result` with `permit`, `status` (`succeeded`, `failed`, or `unknown`), optional `message`, and optional JSON `data`. Retry the same receipt after a transport failure. If needed, renew the session with the same boot and a valid command-scoped credential to replay the receipt.
4. Report actual state independently using `PUT /api/v1/agent/controls/state`.

Use `POST /api/v1/agent/commands/{id}/reject` with a JSON `reason` when declining a command before receiving a permit. Run the local trading and risk checks immediately before broker actions. See [control security](CONTROL_SECURITY.md).

## Telemetry

Send `POST /api/v1/agent/reports` with a current `report` session and JSON `{"version":1,"records":[…]}`. Each record has `id`, `kind`, `observedAt` (UTC Unix milliseconds) and `data`. A batch holds 1–250 records, up to 512 KiB. The service publishes the schema at `GET /api/v1/schemas/report-v1.json`. The schema defines status, connection, portfolio, equity, position, order, fill, performance, metric, OHLCV, signal, risk, alert and log. Monetary and quantity fields are decimal strings. A candle timestamp must align to its UTC interval. Metrics support seven days of backfill, and reports may be at most two minutes ahead of server time.

```json
{
  "version": 1,
  "records": [
    {
      "id": "worker-a-equity-001",
      "kind": "equity",
      "observedAt": 1794643200000,
      "data": {"accountId":"paper-1","currency":"USD","value":"10000.01"}
    }
  ]
}
```

Replace the example timestamp with the observation time. Use stable unique IDs within each strategy and kind. A byte-equivalent canonical replay increments `duplicate`. Reusing an ID with different content increments `rejected`. Fills are also deduplicated by strategy, account and broker fill ID. A completed response gives `inserted`, `duplicate` and `rejected`, with zero-based indices for rejected records. If no record was accepted, the service returns HTTP 422. Invalid envelopes return HTTP 400, unsupported content types return HTTP 415 and oversized bodies return HTTP 413.

An HTTP 429 queue limit, HTTP 503 storage busy, HTTP 507 storage full, or missing response can occur after part of a mixed batch commits. Retry the original batch with unchanged IDs after the condition clears. A successful response is sent after all accepted records commit. A metric job already queued can still commit after client disconnect or shutdown.

Send `PUT /api/v1/agent/snapshot` with version 1, a snapshot `observedAt`, and 1–32 distinct state records (status, connection, portfolio, position or performance). The snapshot is an atomic per-boot view and is separate from the report history. Retrying the same snapshot is safe. The same timestamp with different content or an older snapshot receives HTTP 422.

`PUT /api/v1/agent/metric-definitions` accepts `{"version":1,"metrics":[{"name":"spread","label":"Spread","kind":"gauge"}]}`. Kinds are gauge, counter and ratio. Optional unit and description are presentation metadata. Update the named definitions using the same endpoint.

## Runnable status reports

Create a paper strategy and set `QB_AGENT_URL` to its QuantBot server's `/api/v1/agent` URL and `QB_TOKEN` to the newly issued credential. Each command creates a short-lived session, sends a heartbeat and submits one durable test status record. Set `QB_INSTANCE_ID` to override the language-specific example instance.

```sh
python3 examples/v3/report.py
node examples/v3/report.mjs
go run ./examples/v3
bash examples/v3/report.sh
```

The curl example uses jq for JSON and OpenSSL for a unique boot ID. A successful run prints one inserted record. For an integration that performs operations, see the command lifecycle and permit requirements above.
