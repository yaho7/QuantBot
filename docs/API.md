# QuantBot browser API

The browser API is rooted at `/api`. Agent routes use `/api/agent`. Browser requests use the administrator session cookie. Mutations require the same `Origin` and the `X-CSRF-Token` supplied by `GET /auth/session`. Agent requests use independent Bearer credentials. See [Agent protocol](AGENT_PROTOCOL.md) for reports, controls and command execution.

| Path | Purpose |
| --- | --- |
| `/auth/setup`, `/auth/login`, `/auth/session`, `/auth/logout` | Initialize or authenticate the administrator |
| `/auth/sessions`, `/auth/password` | List sessions and change the password |
| `/strategies`, `/strategies/{id}` | Strategy inventory and Agent instances |
| `/strategies/{id}/controls` | Declared capabilities, desired intent and observed state |
| `/strategies/{id}/series`, `/history`, `/telemetry`, `/records` | Discover and query monitoring data under the strategy path |
| `/strategies/{id}/capabilities`, `/capability-data`, `/capabilities/{capability}/history` | Declared capabilities, latest data, health diagnostics and replay under the strategy path |
| `/strategies/{id}/resources/{capability}`, `/resources/{capability}/history` under the strategy path | Current resource collection and replayable snapshot/patch operations. |
| `GET /strategies/{id}/related?field=order_id&value=...` | Find up to 50 records with the same explicit association field and value within a strategy. |
| `GET /layouts/{key}`, `PUT /layouts/{key}` | Read or save the administrator’s layout. Use `workbench` or `strategy-{id}`. Writes use the current layout revision. |
| `GET /hosts`, `GET /hosts/{id}` | Auto-discovered hosts, latest measured capacity and current-run history; details include reporting processes |
| `GET /hosts/{id}/capacity?strategyId=…&instanceId=…&reservePercent=20` | Advisory estimate for more instances of the selected process |
| `GET /strategies/{id}/performance`, `GET /strategies/{id}/performance/{instanceId}/history` | Bound process snapshots and recent performance samples |
| `/alerts` | Cross-strategy alert feed |
| `POST /strategies/{id}/commands` | Submit a control action with an `Idempotency-Key` |
| `GET /commands`, `GET /commands/{id}` | List commands or view one command and its transitions |
| `POST /commands/{id}/confirm`, `/cancel`, `/reconcile` | Apply an authorized state transition |
| `/admin/strategies` and per-strategy `/executor` and `/tokens` | Manage strategies and credentials. `PUT /admin/strategies/{id}/tokens/{token}` replaces the token scopes and applies them to existing sessions immediately. |
| `GET /admin/strategies/{id}/sandbox`, `POST`, `PUT`, `DELETE` | Inspect trial status, issue a temporary key, extend the trial, or revoke it. Child controls and commands use the isolated test databases. |
| `/admin/notifications` and per-channel `/test` and `/deliveries` | Encrypted channel configuration, test messages and delivery status |
| `/theme`, `/admin/themes` and per-theme settings and rollback | Versioned theme installation and active workbench presentation |
| `/admin/audit` | Read recent audit events |
| `/admin/diagnostics` | Database and WAL sizes, process counters and effective Agent/telemetry settings |
| `/events` | Subscribe to strategy/topic invalidations |

## Browser events

Open an authenticated `EventSource('/api/events')` and listen for the `change` event. Each event contains a `changes` array of `{strategyId, topic}` objects or `{"reset":true}`.

The five topics are `status`, `telemetry`, `controls`, `commands` and `alerts`. The browser invalidates only the affected query keys. Command changes also invalidate the desired state shown with the control. A reset asks the browser to refresh active queries after connecting or falling behind.

The service publishes invalidations after commit, coalesces updates every 125 ms, and applies fixed subscriber and backlog limits. SSE carries strategy IDs and topics. The authenticated query routes return data. Session validity is rechecked at each 15-second heartbeat.

## Suggested components

On an unconfigured workbench or strategy page, declarations with `presentation.suggested: true` and a matching `surface` populate the default layout. Their resolved renderer, size and order come from the capability definition. Capabilities with `suggested: false` are available for manual placement in the component picker. Control actions remain accessible through the separate Controls screen.

Saving a layout, including an empty one, switches that surface to the saved selection. Subsequent capabilities are available in the component picker. They do not reorder or appear in a saved layout automatically. Administrators can add, move, resize and hide widgets. A saved widget whose capability disappears keeps its slot and displays an unavailable state. Restoring the capability with the same ID restores its saved slot. A hidden widget stays hidden until manually restored or the user resets the layout. Layouts belong to the administrator and surface and are independent of the active theme.

In declared widgets and standard event feeds, select a reported association to view matching resource, event and metric observations. The view matches the selected field and ID exactly.
