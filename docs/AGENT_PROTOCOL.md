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
