# Agent protocol

QuantBot speaks JSON over HTTP or HTTPS. Use HTTPS when sending credentials over a public network. The strategy independently owns broker connectivity, operations and risk policy.

## Strategy identity and credentials

An administrator creates a strategy with a display name, group and mode (`paper` or `live`). QuantBot assigns a stable strategy ID and returns the first Agent credential. Store the Token as `token` in the strategy's private [local `quantbot.json`](INTEGRATION.md#local-agent-configuration). The `key` identifies the credential but does not authenticate requests. List responses return metadata. The server authenticates using a SHA-256 digest and keeps an encrypted copy for administrator reveal.

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

The response is HTTP 201 with `strategyId`, `instanceId`, `bootId`, `lastSeen`, `executor`, `expiresAt`, `renewAt`, and `session`. Times are UTC Unix seconds. Present the returned session as `Authorization: Bearer qbs_…` on subsequent requests. The default TTL is one hour. Configure it with `QB_AGENT_SESSION_TTL` such as `1h`. Session expiry never exceeds the Agent credential’s expiration. The default Agent credential is long lived and can be revoked at any time.

Renew in the background at `renewAt`, normally ten minutes before expiry. For shorter server TTLs the lead is capped at half the TTL. A null `renewAt` means renewal cannot extend the session beyond the credential’s expiration. Call `POST /api/agent/session` again using the original Agent token and the same `instanceId` and current `bootId`. Serialize renewal and atomically replace the client’s session only after success. On renewal with the same token and boot, the preceding session remains valid for up to 60 seconds and never beyond its original expiry. Executor assignment, process start time and command execution are independent of renewal. A new boot retires prior credentials for that instance, and a retired boot receives HTTP 409. A new Agent token invalidates the previous session when it takes over the same instance.

Retry transient network failures, HTTP 429 and 5xx with bounded exponential backoff and jitter. On `session_expired`, refresh once or retry with the newer session already installed by another request. Treat `agent_token_revoked`, `agent_token_expired`, `invalid_agent_token` and `strategy_archived` as permanent. HTTP 403 `insufficient_scope` requires an authorized credential. Revocation, archive and scope changes take effect immediately on both session credentials. Keep the execution journal and receipt retry independent of the session.

## Heartbeat

Call `PUT /api/agent/heartbeat` with the session Bearer token and no body. The response contains the effective identity, executor assignment, session expiry and last-seen time. QuantBot recommends sending a heartbeat every 3 seconds. The server marks an instance offline after 45 seconds without a heartbeat. HTTP 401 includes a code that distinguishes session recovery from credential failure. An archived strategy cannot reconnect.

## Capability registration

The session response includes the strategy's current `revision`. Submit a complete registry at `PUT /api/agent/capabilities` with that revision. A new strategy starts at revision zero. Only the designated executor with control scope can publish or replace a strategy registry, including read-only declarations. Instance-local registries are unsupported. Other instances may send standard telemetry with report scope. An identical retry from the same process returns the committed revision. A conflicting write returns HTTP 409. On a new boot, republish before writing state. Declared state, reports, events and resources are bound to the designated executor that published the current registry. Capability registration does not write user layout preferences.

Use `metric`, `state`, `parameter`, `action`, `resource` or `event`. Declare a stable `id`, `kind`, `title`, `value_type`, and optional `description`, `group`, `unit`, `precision`, `constraints`, `history` and `presentation`.

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

`PUT /api/agent/state` takes the committed `revision` and `states`. Entries contain `id`, `value`, `observedAt` in UTC Unix milliseconds, optional boolean `available` and optional `reason`. Use availability and reason to report local safety locks. Updates validate and commit atomically. Duplicate observations and stale observations are counted. A compatible edit by the same executor process preserves the latest state and reported observations, retaining their original observation time and revision. New capabilities wait for their first observation. Changes to kind, value schema or unit invalidate that capability; changing an action’s dispatch, input schema or plan also invalidates its availability. A new boot must report fresh control state before executing commands. A different executor starts with fresh observations. Deleted capabilities leave the catalog and keep their saved layout slots unavailable until re-registered. An action may report availability with `value: null`. This endpoint reports observations and never applies parameter changes.

A capability with `stale_after_seconds` cannot be used for a command after that deadline. The optional `alert_suggestion` describes an inactive `stale`, `above` or `below` suggestion. The host can read the capability catalog, resolved renderer and diagnostics at `GET /api/strategies/{id}/capabilities`.

Writable parameters can declare a separate `input_schema` for command validation and input generation. Actual observations are validated against `value_schema` or the declared value type and constraints. Parameter commands satisfy the value and input constraints. Writable parameters can link to a declared `action` via `command`. A claim returns both `controlId` and the operation's dispatch `command`. An action that can apply a whole parameter plan declares `atomic_parameters` containing the exact member IDs. The requested input is an object with all member values. QuantBot validates the full plan, requires confirmation and grants one permit and one receipt for the plan. The strategy implements the atomic application.

## Commands

The designated online executor with `command` scope calls `GET /api/agent/commands?wait=25`. The server waits up to the configured window and returns an array, empty at timeout. `wait=0` returns immediately. Disconnecting a poll does not change commands. The response is an offer to process the listed command.

1. Verify local readiness, then call `POST /api/agent/commands/{id}/claim` with the current session and a stable `Idempotency-Key` saved locally for this claim. The server records acceptance and issues the unique permit in one transaction. Execute only if you receive the grant and its Unix millisecond `deadline` remains valid.
2. Persist the command ID, claim key, and permit before performing the operation. Use the local journal or broker idempotency to prevent repeat execution. Journal the execution outcome and call `POST /api/agent/commands/{id}/result` with `permit`, `status` (`succeeded`, `failed`, or `unknown`), optional `message`, and optional JSON `data`. Retry the same receipt after a transport failure.
3. Report actual state independently and run local trading and risk checks immediately before any broker action. See [control security](CONTROL_SECURITY.md).

If the claim response is lost, retry only the same key and process identity. If the first request did not commit, the retry can claim normally. If a permit was already issued, the server returns HTTP 409 with `code: claim_reconciliation_required`, `commandId` and the current `status`. An executing command moves to `unknown`. The permit is issued once and omitted from all retries. Use the durable client journal and broker records to reconcile. A saved receipt with the original permit remains valid. A different key returns a conflict and cannot create a replacement permit.

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

For capability data, include the current `revision` and a `records` array. Each record includes a stable `id`, the `capabilityId`, UTC Unix milliseconds `observedAt`, and the declared `value`. Use `POST /api/agent/reports` for history-enabled metrics, parameter observations and states, `POST /api/agent/events` for declared events. Declared resources use the collection protocol below. Do not combine standard and declared records in a single request. Standard events such as fills, signals and alerts may also be submitted to `/api/agent/events` in the standard report schema.

An optional `associations` object carries explicit `account_id`, `symbol`, `signal_id`, `decision_id`, `order_id`, `command_id`, or `correlation_id`. Clients match only explicitly submitted IDs. A matching ID alone does not establish causality.

Declared record IDs deduplicate within the combination of strategy, capability and revision. Conflicting duplicates are rejected, and expired revisions return HTTP 409. Current metric and event data are available in `/api/strategies/{id}/capability-data`. A capability with `history: true` retains observations for 30 days with the original observation time, receive time, revision and identity. Query `/api/strategies/{id}/capabilities/{capability}/history` for report and event history. Add `source=state` for observations received through the state endpoint. Replay enumerates only saved observations, including those from previous revisions.

## Resource collections

`PUT /api/agent/resources/{type}` replaces or updates one collection. `{type}` is the declared capability ID. Each item’s `value` follows that capability’s value schema. Provide the current capability `revision`, the last acknowledged `resourceRevision` (initially zero), UTC milliseconds `observedAt`, and a stable `Idempotency-Key` header unique to the update within the collection. The initial write must be a snapshot.

```json
{"revision":7,"resourceRevision":0,"mode":"snapshot","observedAt":1794643200000,"items":[
  {"id":"paper:AAPL","value":{"symbol":"AAPL"}},
  {"id":"paper:MSFT","value":{"symbol":"MSFT"}}
]}
```

A snapshot is authoritative. Omitted IDs are removed and an empty `items` clears the collection. Use it only when the strategy has the complete source view. A patch uses `upsert` and/or `delete`; omitted IDs keep their current values. Deleting a missing ID is harmless. An ID cannot appear in both lists. An optional per-item `observedAt` overrides the batch time for that item.

```json
{"revision":7,"resourceRevision":1,"mode":"patch","observedAt":1794643201000,
 "upsert":[{"id":"paper:AAPL","value":{"symbol":"AAPL"}}],
 "delete":["paper:MSFT"]}
```

The server checks the full update before committing it atomically. Success returns the new `resourceRevision`. Retrying the same key and payload returns the original acknowledgment with `duplicate: true`, even after later updates in the same compatible collection. Revision or payload conflicts return HTTP 409. A validation failure leaves the collection and its revision unchanged. An incompatible capability change starts a fresh collection. The request allows up to 250 total IDs.

The browser reads `GET /api/strategies/{id}/resources/{capability}`. A zero revision means the first snapshot has yet to arrive. History-enabled resources persist snapshot and patch changes with observed and received time and revisions at `GET /api/strategies/{id}/resources/{capability}/history`. Replay patches in resource revision order after a snapshot for the same `sinceRevision`. Once a collection’s earlier history expires, a later patch alone cannot establish its full historical state.

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
| `POST /api/agent/commands/{id}/claim` | Empty body and required `Idempotency-Key` header |
| `POST /api/agent/commands/{id}/result` | `#/$defs/result` |

The server validates each `value` against the strategy's current declaration and applies server-time checks, permissions and cross-field rules. For example, a `decimal` uses a decimal string, and an `object` accepts only its declared properties. The batch acknowledgment identifies malformed records by index.

See [paper strategy examples and the AI prompt](INTEGRATION.md).

## Optional host and process performance

Use `POST /api/agent/performance` with the current Agent session and its
`report` scope. Include the actual `host_name` and measured host or process
records. QuantBot automatically displays the host from this report and groups
observations by name. This is separate from the financial `performance` report
kind. See [host performance](HOST_PERFORMANCE.md) for the schema, curl example,
freshness and curve behavior.
