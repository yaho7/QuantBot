# QuantBot architecture

```text
Strategy ── Bearer token ── Agent API
                                  │
React ── Admin cookie ── Admin API ┼── Strategies, reports, controls, alerts ── SQLite
                                  │
Telegram ── Authorized private chat┘
```

## Repository layout

| Path | Responsibility |
|---|---|
| `src/quantbot/__main__.py` | Startup, administrator setup, backups |
| `src/quantbot/core/api.py`, `management.py`, `responses.py` | HTTP routes, sessions, settings, contracts |
| `src/quantbot/core/auth.py`, `strategies.py` | Credentials, instances, presence, entry-state reconciliation |
| `src/quantbot/core/models.py`, `report_models.py`, `schemas.py` | Versioned reports and request models |
| `src/quantbot/core/telemetry.py`, `registry.py`, `dashboard_models.py` | Snapshots, events, history, catalog, layouts |
| `src/quantbot/core/control_models.py`, `control_registry.py`, `commands.py` | Control definitions, actual values, commands, permits, receipts |
| `src/quantbot/core/telegram_*.py` | Authorized Telegram interactions and notifications |
| `src/quantbot/core/db.py`, `runtime.py`, `sandbox.py` | SQLite, transactions, locking, cleanup, isolated integration tests |
| `web/src/console/`, `src/quantbot/web/` | React source and bundled console |
| `tests/integration/`, `web/tests/` | HTTP, storage, simulated Telegram, and browser regression tests |
| `examples/`, `docs/`, `deploy/` | HTTP examples, protocol, and deployment |

## Design decisions

- Strategy credentials use high-entropy random values. SQLite stores an authentication digest and an encrypted copy for administrative reveal. The decryption key resides in a separate `quantbot.key`. Web login uses scrypt, independent session digests, and an HttpOnly cookie. Telegram authorization uses private chat administrator IDs.
- The executor is bound to a strategy, instance, session, and credential scopes. A SQLite write transaction grants at most one permit per command. Claimed commands lacking a receipt after restart become unknown. The strategy handles execution idempotency and reconciliation with broker records.
- Desired entry permission is persisted and actual state is reported by the agent. Risk lock and presence are displayed separately. A state change completes on the actual report. Offline behavior is implemented by the strategy.
- Controls have revisions, actual values, and disabled reasons. Web and Telegram render the same definitions. Server-side risk policy, permissions, confirmation, and executor checks still apply.
- Telemetry is stored by type, instance, and time. Event IDs are deduplicated within the strategy. Monetary and quantity fields preserve decimal precision. Components are discovered from valid reports. Layouts retain chart configuration, sources, time ranges, and positions.
- SQLite uses WAL and a process lock. Notification progress, layouts, commands, and state survive restart. Strategy retention applies to historical data. Operations and audit records have separate storage.
- Sandbox sessions reuse Agent routes and validation on bounded in-memory databases. Their credentials and simulated commands are isolated from production. The console localizes its labels while displaying agent-provided data as submitted.
- The service binds to loopback by default. A trusted proxy terminates remote HTTPS. Payload limits, strict schemas, rate limits, and plain-text rendering protect the control plane.

References include [Komari](https://github.com/komari-monitor/komari), [Komari Agent](https://github.com/komari-monitor/komari-agent), [AWS IoT Device Shadow](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html), [AWS IoT Jobs](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs.html), [Sentry Projects](https://docs.sentry.io/product/projects/), and [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/).
