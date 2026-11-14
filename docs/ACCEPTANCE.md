# QuantBot 3.0 acceptance matrix

Requirements are in [AGENTS.md](../AGENTS.md). Update the evidence column after running the relevant verification. Prior-version tests establish behavior to preserve and do not count as verification of 3.0.

| Product capability observed in 2.2 | QuantBot 3.0 acceptance scenario | 3.0 evidence |
| --- | --- | --- |
| First-run setup, password changes, sessions, reverse proxy | Initialize once, log in, verify CSRF, limits, session revocation, trusted HTTPS proxy and remote HTTP rejection | Go handler integration and native HTTP setup/login-session/logout smoke. Race and vet passed. Browser and reverse-proxy deployment QA pending. |
| Stable strategy identity, groups, management, archive and scoped credentials | Create strategy, issue scopes, rotate/revoke credential while polling, archive and retain history | Go HTTP handler test covers initial token, one-time reveal, scoped issuance, revocation and archive. Poll revocation verification pending. |
| Agent lifecycle, online state, single executor | Exercise duplicate instance, boot change, network delay, disconnect and persisted reconnect | Go HTTP handler test covers boot fencing, executor designation, heartbeat and scope denial. Timeout, restart and delay verification pending. |
| Fourteen reports and history, account/strategy comparison, candles and trade markers | Validate every report, decimal precision, duplicate/conflict behavior, mixed DB retries, all rollup resolutions, OHLCV and history budgets | Pending |
| Dynamic buttons, inputs, forms and status | Register and exercise declared inputs, groups, availability, read-only controls, revisions and actual-state updates | Pending |
| Desired entry state and local risk | Compare desired and actual state, simulate risk lock and offline behavior, verify pause never triggers liquidation | Pending |
| Confirmation, single permit, audit, history | Simulate protected command through web and Agent. Race duplicate claims, lose receipt, restart, reconcile unknown and verify complete audit | Pending |
| Live workbench, localized interface, saved charts and positions | Live SSE invalidates relevant query only, strategy/controls/activity/alerts display persisted data, layouts drag, resize, remove, undo, cancel and save | Pending |
| Separate administration workflow | Independent sidebar and mobile drawer, real dashboard, strategy, integration, themes, notifications, storage, audit, security and settings flows | Pending |
| New installable themes | Upload and configure both package types, inspect ZIP attack cases, verify restricted iframe, switch, update, rollback, delete, force Classic fallback | Pending |
| AI prompt and bounded Sandbox | Run all Agent endpoints with temporary credentials, verify renewal, revocation, expiry, global limits and isolation, then connect production | Pending |
| Telegram notifications and operations | Verify delivery, retry, and authorization with test transport. Any chat control uses shared control policy and audit. | Pending |
| Backups, native and container installs | Serve, version, doctor, backup and restore on clean data. Build and smoke-test Docker for amd64 and arm64. | Pending |

## Release verification

- Go unit and race suites plus real HTTP integration. Run Python, JavaScript, Go and curl examples against a test service. Inject database contention, SQLITE_FULL, Agent retry and restart.
- Frontend type and unit tests. Playwright at 390, 430, 768, 1280 and 1600 pixels, in light and dark, for login, home, strategy detail, controls, layout editing, admin, theme management and Sandbox. Review screenshots and verify interaction, keyboard behavior, sizing, clipping and overflow.
- Reproducible load benchmark for idle, 10/100/1000 Agents, high-rate telemetry, mixed control, concurrent SSE, SQLite/history queries and theme switching. Record resource use, latency percentiles, throughput, queue depth, write rate, WAL size, retries and losses. Distinguish local results from the requested 2 vCPU/2 GB comparison environment.
- Complete the 20-step release walkthrough in the task brief on fresh data. Replace the old packaging only after the new workflow builds and passes its smoke tests.

## Checkpoint

Stage A design and upstream reference review are recorded in [ARCHITECTURE.md](ARCHITECTURE.md). The Go service foundation now opens two independent SQLite WAL databases, applies migrations and verifies the encryption key. Verified on Darwin arm64 with Go test, race, vet, and a binary smoke run through `version`, `serve`, `/healthz` and SIGTERM. Browser authentication is implemented with Argon2id, persisted HttpOnly sessions, CSRF, bounded login attempts and explicitly trusted proxies. Strategy creation, scoped credentials, Agent sessions and boot fencing pass the Go test, race and vet suites. Next implement dynamic control definitions and state, the durable command state machine, and Agent long polling. Continue against the root AGENTS.md, with no legacy compatibility or data migration.
