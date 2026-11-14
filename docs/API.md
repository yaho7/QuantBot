# QuantBot v1 API

The API is rooted at `/api/v1`. Browser requests use the administrator session cookie. Mutations require the same `Origin` and the `X-CSRF-Token` supplied by `GET /auth/session`. Agent requests use independent Bearer credentials. See [Agent protocol](AGENT_PROTOCOL.md) for reports, controls and command execution.

| Path | Purpose |
| --- | --- |
| `/auth/setup`, `/auth/login`, `/auth/session`, `/auth/logout` | Initialize or authenticate the administrator |
| `/auth/sessions`, `/auth/password` | List sessions and change the password |
| `/strategies`, `/strategies/{id}` | Strategy inventory and Agent instances |
| `/strategies/{id}/controls` | Declared capabilities, desired intent and observed state |
| `/strategies/{id}/series`, `/history`, `/telemetry`, `/records` | Discover and query monitoring data under the strategy path |
| `/alerts` | Cross-strategy alert feed |
| `POST /strategies/{id}/commands` | Submit a control action with an `Idempotency-Key` |
| `GET /commands`, `GET /commands/{id}` | List commands or view one command and its transitions |
| `POST /commands/{id}/confirm`, `/cancel`, `/reconcile` | Apply an authorized state transition |
| `/admin/strategies` and per-strategy `/executor` and `/tokens` | Manage strategies and credentials |
| `/admin/notifications` and per-channel `/test` and `/deliveries` | Encrypted channel configuration, test messages and delivery status |
| `/admin/audit` | Read recent audit events |
| `/events` | Subscribe to strategy/topic invalidations |

## Browser events

Open an authenticated `EventSource('/api/v1/events')` and listen for the `change` event. Each event contains a `changes` array of `{strategyId, topic}` objects or `{"reset":true}`.

The five topics are `status`, `telemetry`, `controls`, `commands` and `alerts`. The browser invalidates only the affected query keys. Command changes also invalidate the desired state shown with the control. A reset asks the browser to refresh active queries after connecting or falling behind.

The service publishes invalidations after commit, coalesces updates every 125 ms, and applies fixed subscriber and backlog limits. SSE carries strategy IDs and topics. The authenticated query routes return data. Session validity is rechecked at each 15-second heartbeat.
