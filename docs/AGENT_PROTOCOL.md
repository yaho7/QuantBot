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
