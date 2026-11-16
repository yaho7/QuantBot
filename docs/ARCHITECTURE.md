# QuantBot 3.0 architecture

Release evidence is in the [acceptance matrix](ACCEPTANCE.md). The previous product baseline is commit `9f96182`.

## Runtime

One Go process serves JSON over HTTP, Agent long polling, authenticated browser SSE, and embedded Vite assets. Chi groups routes by browser, administrator, Agent, and Sandbox authority. Business modules call Go functions in the same process. The application does not host strategy code, hold broker credentials, or implement a broker adapter.

At startup, load configuration, take an exclusive process lock in the private data directory, open both databases, apply versioned migrations, verify the secret key, initialize command recovery and telemetry workers, initialize realtime and themes, start notifications and maintenance, then listen. On SIGINT or SIGTERM, close admission, cancel streams and long polls, drain active HTTP and admitted writes, and close databases. Health checks use short deadlines. Administrator pprof routes are opt-in.

## Data model

Use SQLite WAL, FULL durability for acknowledged writes, one writer per database, and independently bounded readers. Migrations are embedded and transactional. Query code uses database/sql and sqlc. Use versioned, exact decimal strings for money and quantities. Chart rendering may convert display values to approximate numbers.

| Database | Tables and key relationships |
| --- | --- |
| control | `users` and `browser_sessions` (session digest, user, expiry, CSRF) |
| control | `strategies`, `agent_tokens` (strategy, digest, scopes, expiry/revocation), `agent_instances` (strategy + instance, boot and presence), `agent_sessions` (digest, token, instance, boot, expiry) |
| control | Capability registry, current observations, resource revisions, replay records and desired state |
| control | `commands` (strategy, control revision, target boot, owner credential, input, deadline, receipt), `command_transitions` (command + sequence), `execution_permits` (unique command, digest), `audit` (actor, strategy, command, action, time) |
| control | `trade_events` (strategy + report ID, kind, time and payload), `layouts` (user + layout key), `themes` (theme ID, active and previous revisions), `settings`, encrypted `notification_channels`, notification delivery progress, `sandboxes` metadata |
| metrics | `samples` (strategy + report ID, kind, series, timestamp, payload), `latest` by strategy and series, `metric_definitions`, `rollups` (strategy + series + resolution + bucket), bounded non-critical logs |

Control and metric commits are independently retryable. A mixed upload receives success only after both commits. Stable report IDs scoped by strategy and kind allow retry after an interrupted response, even if only one database committed. A conflicting payload under an existing ID is rejected. Preserve ordering by event time and ID. Closed buckets use explicit raw, 1m, 5m, 1h, and 1d resolutions. OHLCV uses the first open, last close, extrema, and exact volume sum. Retention must account for accepted late data before deleting inputs.

## Control invariants

Each strategy has at most one designated, current executor. A new boot fences the old session. Revoked credentials lose authority on the next request, including after a poll wakeup. Browser command creation resolves the declared control revision, validates input, checks availability and the executor, and records actor and intent in the same transaction. A revision change invalidates queued intent. The policy applies to every channel.

Track `created → confirmation_required → pending → accepted → executing → succeeded|failed|unknown`, with confirmation skipped only by policy. The other terminal states are `cancelled`, `expired`, and `rejected`. Persist every transition and audit record transactionally. Command submission uses an idempotency key scoped to the initiating actor and strategy. Polling only offers work. Claim accepts the command and issues one permit in a single transaction, binding authority to the token, instance and boot. The server stores only the permit digest. Same-boot renewals preserve this binding. If a claim response is lost, retrying the same key requires reconciliation and cannot grant authority again. Results require the issued secret and are idempotent. Expired or interrupted execution enters unknown. Reconciliation cannot return a command to the queue. Reported actual state remains separate from desired state and execution receipts.

## HTTP and UI contract

Every browser mutation requires a same-origin request and, after login, CSRF protection. Use separate cookie and Bearer authentication contexts. The browser origin and API Endpoint use the request Host and scheme, including the HTTPS scheme forwarded by a TLS terminator. Only explicitly configured proxies can supply a forwarded client IP. Response JSON errors have a stable code and message. JSON decoders reject unknown fields, ambiguous keys, invalid timestamps and unbounded bodies. API documentation and versioned report schemas are published with the service.

| Authority | Routes under `/api` | Contract |
| --- | --- | --- |
| Public browser | `GET/POST /auth/setup`, `POST /auth/login` | One-time first admin and rate-limited login |
| Browser | `GET /auth/session`, `POST /auth/logout` | HttpOnly login cookie, expiry and CSRF |
| Browser | `/strategies`, `/strategies/{id}/history`, `/events`, `/layouts/{key}` | Monitoring, point-budget history, SSE, persisted presentation layout |
| Browser | `POST /strategies/{id}/commands`, `/commands/{id}/{action}` | Control input, confirmation/cancellation/reconciliation with current state and audit |
| Admin | `/admin/{strategies,audit,themes,notifications,diagnostics}` | Management, effective settings, storage and diagnostics |
| Agent credential | `POST /agent/session` | Scoped credential + stable instance ID and per-process boot ID → short-lived session |
| Agent session | `PUT /agent/{heartbeat,capabilities,state,resources/{type}}`, `POST /agent/{reports,events}` | Independent declarations and observations with strict schemas |
| Agent session | `GET /agent/commands`, `POST /agent/commands/{id}/{claim,result}` | Bounded long poll, unique permit and receipt |
| Sandbox | `/agent/sandbox/{id}/*` | Same Agent protocol with expiring credentials and a separate bounded runtime |

The workbench owns `/`, `/strategies`, `/strategies/:id`, `/controls`, `/activity`, and `/alerts`. The strategy detail places controls before charts and holdings. The separate admin shell owns `/admin/{dashboard,strategies,integration,notifications,themes,storage,audit,security,settings}`. The mobile admin sidebar is a drawer. Theme packages affect only the workbench. Full frontend themes use an opaque-origin sandbox and a narrow, versioned host bridge. The host owns all credentialed requests and the trusted control dialog. Declarative themes configure allowlisted tokens and layout. Immutable installation revisions allow atomic activation and rollback. Classic is always available.

SSE broadcasts compact strategy/topic invalidations only after commit. Bound both subscribers and the event buffer. Slow consumers receive a refresh signal or reconnect. The browser invalidates affected query keys. Agent long polling periodically rereads committed state and treats notifications as a wakeup.

## Reference and licensing review

| Fixed reference | Sources examined and adopted design | License and reuse |
| --- | --- | --- |
| [Komari backend](https://github.com/komari-monitor/komari/tree/62af91037924057b961dff7b93beacd3f76a81e8) | `internal/server` startup and reverse cleanup, `database/dbcore` WAL tuning, `internal/metricstore` queue/rollups/retention, `web/router` auth groups and WebSocket routing, `database/models/theme.go` and `web/api/admin/theme.go` manifest and archive validation, Dockerfile | MIT, © 2025 Komari Moniter, with additional notices for separately sourced code. Independently implement the QuantBot model. Add commit-aware acknowledgements and atomic theme activation. |
| [Komari Web](https://github.com/komari-monitor/komari-web/tree/05c3bad5dedf42796aae3cc0a528f474a0860fc0) | `src/pages/admin/_layout.tsx`, `AdminPanelBar.tsx`, `menuConfig.json`, settings and dashboard pages, `DashboardBoard.tsx`, `layout.ts`, `placement.ts`. Grouped sidebar, mobile navigation, natural sizing and snapping, loading feedback. | Independent code license was not established in the pinned tree. Interaction reference only. |
| [LuminaPlus](https://github.com/shanyang242/Komari-Theme-LuminaPlus/tree/f479ff0bb298b1e9d2a27f0641ed6775c1c05180) | Shell and node components, Home/Instance, `useViewMode.ts`, tokens/surface/home CSS, dev mock API, manifest. Four densities, summary and filters, aligned responsive grids, floating tools, scoped chart updates. | MIT, © 2026 Shanyang242. Upstream Lumina and inherited media have separate provenance. Use independently implemented surfaces, layouts and components. |

No upstream code or assets were copied during this review. Record file-level source, modifications, and attribution here if implementation adopts any. Keep license text and notices for distributed runtime dependencies.

| Dependency family | Purpose | License to check against lockfile |
| --- | --- | --- |
| Chi, go-sqlite3, sqlc, Go x/crypto | Routing, embedded SQLite, generated typed SQL, password hashing | MIT, MIT with SQLite public domain, MIT, BSD-3-Clause |
| React, Vite, Tailwind CSS, React Router, TanStack Query | UI, build, styling, routes, query cache | MIT |
| Astryx Core and Neutral 0.7.16, StyleX 0.19 | Accessible controls and responsive layout. QuantBot maps the theme to its existing palettes; dashboard, detail and settings templates guide layout only. | MIT; [Astryx notice](licenses/astryx.txt). |
| TypeScript, Lucide, uPlot, Lightweight Charts | Type checking, icons, time series and financial charts | Apache-2.0, ISC with inherited MIT attribution, MIT, Apache-2.0 with NOTICE. Redistributed runtime notices are in [licenses](licenses); candlestick charts display the TradingView link. |
| santhosh-tekuri/jsonschema v6 | Compile the same JSON Schema distributed to Agent developers and used for server-side validation | Apache-2.0 |
| tx7do/go-utils/notify | Telegram delivery plus signed Feishu/Lark, WeCom and DingTalk webhooks | MIT. QuantBot validates send destinations and platform receipts. |
| dnd-kit, Sonner, Zod, Playwright | Accessible reordering, notifications, validation, browser testing | MIT, MIT, MIT, Apache-2.0 |
