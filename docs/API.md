# QuantBot v1 API

The browser API is rooted at `/api/v1`. Agent routes use `/api/agent`. Browser requests use the administrator session cookie. Mutations require the same `Origin` and the `X-CSRF-Token` supplied by `GET /auth/session`. Agent requests use independent Bearer credentials. See [Agent protocol](AGENT_PROTOCOL.md) for reports, controls and command execution.

| Path | Purpose |
| --- | --- |
| `/auth/setup`, `/auth/login`, `/auth/session`, `/auth/logout` | Initialize or authenticate the administrator |
| `/auth/sessions`, `/auth/password` | List sessions and change the password |
| `/strategies`, `/strategies/{id}` | Strategy inventory and Agent instances |
| `/strategies/{id}/controls` | Declared capabilities, desired intent and observed state |
| `/strategies/{id}/series`, `/history`, `/telemetry`, `/records` | Discover and query monitoring data under the strategy path |
| `/strategies/{id}/capabilities`, `/capability-data`, `/capabilities/{capability}/history` | Declared capabilities, latest data, health diagnostics and replay under the strategy path |
| `GET /strategies/{id}/related?field=order_id&value=...` | Find up to 50 records with the same explicit association field and value within a strategy. |
| `GET /layouts/{key}`, `PUT /layouts/{key}` | Read or save the administrator’s layout. Use `workbench` or `strategy-{id}`. Writes use the current layout revision. |
| `/alerts` | Cross-strategy alert feed |
| `POST /strategies/{id}/commands` | Submit a control action with an `Idempotency-Key` |
| `GET /commands`, `GET /commands/{id}` | List commands or view one command and its transitions |
| `POST /commands/{id}/confirm`, `/cancel`, `/reconcile` | Apply an authorized state transition |
| `/admin/strategies` and per-strategy `/executor` and `/tokens` | Manage strategies and credentials |
| `/admin/notifications` and per-channel `/test` and `/deliveries` | Encrypted channel configuration, test messages and delivery status |
| `/theme`, `/admin/themes` and per-theme settings and rollback | Versioned theme installation and active workbench presentation |
| `/admin/audit` | Read recent audit events |
| `/events` | Subscribe to strategy/topic invalidations |

## Browser events

Open an authenticated `EventSource('/api/v1/events')` and listen for the `change` event. Each event contains a `changes` array of `{strategyId, topic}` objects or `{"reset":true}`.

The five topics are `status`, `telemetry`, `controls`, `commands` and `alerts`. The browser invalidates only the affected query keys. Command changes also invalidate the desired state shown with the control. A reset asks the browser to refresh active queries after connecting or falling behind.

The service publishes invalidations after commit, coalesces updates every 125 ms, and applies fixed subscriber and backlog limits. SSE carries strategy IDs and topics. The authenticated query routes return data. Session validity is rechecked at each 15-second heartbeat.

## Suggested components

A declaration with `presentation.suggested` and an applicable surface provides a default widget. The browser uses the backend’s resolved renderer, the default size and the declared order. Administrators can add a declared capability manually or edit, move, resize and remove suggested widgets. Saved preferences take precedence. A saved widget whose capability disappears keeps its slot and shows an unavailable state. Restoring the capability with the same ID restores the saved widget. A hidden widget stays hidden until it is added again or the layout is reset.

In declared widgets and standard event feeds, select a reported association to view matching resource, event and metric observations. The view matches the selected field and ID exactly.
