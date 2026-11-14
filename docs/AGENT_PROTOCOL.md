# Agent protocol

QuantBot speaks JSON over ordinary HTTP. Use HTTPS for remote integrations. Local loopback development can use HTTP. The strategy independently owns broker connectivity, operations and risk policy.

## Strategy identity and credentials

An administrator creates a strategy with a display name, group and mode (`paper` or `live`). QuantBot assigns a stable strategy ID and returns the first Agent credential. Copy the credential at issuance. List responses return metadata, and the server stores a SHA-256 digest of the random credential.

The four scopes are `heartbeat`, `report`, `control`, and `command`. Issue a second credential to rotate, migrate the Agent to it, then revoke the previous credential. Revocation and archive take effect on subsequent authenticated requests even if the Agent session has time remaining. The administrator must explicitly designate the executor instance.

## Agent session

Send the long-lived credential only to `POST /api/agent/session`.

```http
POST /api/agent/session HTTP/1.1
Authorization: Bearer qbt_…
Content-Type: application/json

{"instanceId":"worker-a","bootId":"unique-id-for-this-process"}
```

`instanceId` persists across process restarts. Generate a new unpredictable `bootId` for each process start. Reuse that boot ID when renewing the session. IDs are 1–96 characters and use ASCII letters, digits, dots, underscores, colons or hyphens, beginning with a letter or digit.

The response is HTTP 201 with `strategyId`, `instanceId`, `bootId`, `lastSeen`, `executor`, `expiresAt`, and `session`. Times are UTC Unix seconds. Present the returned session as `Authorization: Bearer qbs_…` on subsequent requests. A session expires after 15 minutes or at credential expiration, whichever occurs first.

A new session replaces the previous session for the same strategy and instance. A new boot retires the previous boot permanently and invalidates its session. A retired boot attempting registration receives HTTP 409. Persist execution receipts independently of session renewal.

## Heartbeat

Call `PUT /api/agent/heartbeat` with the session Bearer token and no body. The response contains the effective identity, executor assignment, session expiry and last-seen time. Use a heartbeat interval shorter than the 45-second presence window, such as 15 seconds. HTTP 401 requires checking the credential and creating a fresh session. An archived strategy cannot reconnect.

## Capability registration

The session response includes the strategy's current `revision`. Submit a complete registry at `PUT /api/agent/capabilities` with that revision. A new strategy starts at revision zero. An identical retry from the same process returns the committed revision. A conflicting write returns HTTP 409. On a new boot, republish before writing state. Capability registration does not write user layout preferences.

Use `metric`, `state`, `parameter`, `action`, `resource` or `event`. Declare a stable `id`, `kind`, `title`, `value_type`, and optional `description`, `group`, `unit`, `precision`, `constraints`, `history` and `presentation`. The first read-only registry may be registered by an Agent with control scope. A registry with writable capabilities requires the designated executor.

```json
{
  "revision": 0,
  "capabilities": [
    {
      "id": "allow-entry",
      "kind": "parameter",
      "title": "Allow new entries",
      "value_type": "boolean",
      "writable": true,
      "risk": "high",
      "confirm": true,
      "timeout_seconds": 30,
      "presentation": {"suggested": true, "surface": ["strategy"], "preferred_renderer": "switch", "default_size": "medium", "order": 10}
    }
  ]
}
```

`PUT /api/agent/state` takes the committed `revision` and `states`. Entries contain `id`, `value`, `observedAt` in UTC Unix milliseconds, optional boolean `available` and optional `reason`. Use availability and reason to report local safety locks. Updates validate and commit atomically. Duplicate observations and stale observations are counted. A changed registry clears old current values. An action may report availability with `value: null`. This endpoint reports observations and never applies parameter changes.

A capability with `stale_after_seconds` cannot be used for a command after that deadline. The optional `alert_suggestion` describes an inactive `stale`, `above` or `below` suggestion. The host can read the capability catalog, resolved renderer and diagnostics at `GET /api/v1/strategies/{id}/capabilities`.

Writable parameters can declare a separate `input_schema` for command validation and input generation. Actual observations are validated against `value_schema` or the declared value type and constraints. Parameter commands satisfy the value and input constraints. Writable parameters can link to a declared `action` via `command`. A claim returns both `controlId` and the operation's dispatch `command`. An action that can apply a whole parameter plan declares `atomic_parameters` containing the exact member IDs. The requested input is an object with all member values. QuantBot validates the full plan, requires confirmation and grants one permit and one receipt for the plan. The strategy implements the atomic application.

## Commands

The designated online executor with `command` scope calls `GET /api/agent/commands?wait=25`. The server waits up to the configured window and returns an array, empty at timeout. `wait=0` returns immediately. Disconnecting a poll does not change commands. The response is an offer to process the listed command.

1. Verify local readiness, then call `POST /api/agent/commands/{id}/claim` with the current session. The server records acceptance and issues the unique permit in one transaction. Execute only if you receive the grant and its Unix millisecond `deadline` remains valid.
2. Journal the execution outcome and call `POST /api/agent/commands/{id}/result` with `permit`, `status` (`succeeded`, `failed`, or `unknown`), optional `message`, and optional JSON `data`. Retry the same receipt after a transport failure.
3. Report actual state independently and run local trading and risk checks immediately before any broker action. See [control security](CONTROL_SECURITY.md).

## Telemetry

Send `POST /api/agent/reports` with a current `report` session and JSON `{"records":[…]}`. Each record has `id`, `kind`, `observedAt` (UTC Unix milliseconds) and `data`. A batch holds 1–250 records, up to 512 KiB. The service publishes the schema at `GET /api/agent/schemas/report.json`. The schema defines status, connection, portfolio, equity, position, order, fill, performance, metric, OHLCV, signal, risk, alert and log. Monetary and quantity fields are decimal strings. A candle timestamp must align to its UTC interval. Metrics support seven days of backfill, and reports may be at most two minutes ahead of server time.

```json
{
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

## Declared data and replay

For capability data, include the current `revision` and a `records` array. Each record includes a stable `id`, the `capabilityId`, UTC Unix milliseconds `observedAt`, and the declared `value`. Use `POST /api/agent/reports` for history-enabled metrics, parameter observations and states, `POST /api/agent/events` for declared events, and `PUT /api/agent/resources/{type}` for declared resources. The resource URL type is its capability ID. Do not combine standard and declared records in a single request. Standard events such as fills, signals and alerts may also be submitted to `/api/agent/events` in the standard report schema.

An optional `associations` object carries explicit `account_id`, `symbol`, `signal_id`, `decision_id`, `order_id`, `command_id`, or `correlation_id`. Clients match only explicitly submitted IDs. A matching ID alone does not establish causality.

Declared record IDs deduplicate within the combination of strategy, capability and revision. Conflicting duplicates are rejected, and expired revisions return HTTP 409. Current resource and event data are available in `/api/v1/strategies/{id}/capability-data`. A capability with `history: true` retains observations for 30 days with the original observation time, receive time, revision and identity. Query `/api/v1/strategies/{id}/capabilities/{capability}/history` for report, resource and event history. Add `source=state` for observations received through the state endpoint. Replay enumerates only saved observations, including those from previous revisions.

## Request schemas and examples

Fetch `GET /api/agent/schemas/agent.json` and use the corresponding JSON Schema definition.

| Request | Definition |
| --- | --- |
| `POST /api/agent/session` | `#/$defs/session` |
| `PUT /api/agent/heartbeat` | Empty body |
| `PUT /api/agent/capabilities` | `#/$defs/capabilities` |
| `PUT /api/agent/state` | `#/$defs/state` |
| `POST /api/agent/reports` | `#/$defs/reports` |
| `POST /api/agent/events` | `#/$defs/events` |
| `PUT /api/agent/resources/{type}` | `#/$defs/resources` |
| `GET /api/agent/commands` | Optional integer query parameter `wait`, 0–25 seconds |
| `POST /api/agent/commands/{id}/claim` | Empty body |
| `POST /api/agent/commands/{id}/result` | `#/$defs/result` |

The server validates each `value` against the strategy's current declaration and applies server-time checks, permissions and cross-field rules. For example, a `decimal` uses a decimal string, and an `object` accepts only its declared properties. The batch acknowledgment identifies malformed records by index.

See [paper strategy examples and the AI prompt](INTEGRATION.md).
