# QuantBot HTTP Protocol

The Sandbox uses the same Agent requests, responses, and JSON Schema. For testing, replace `/api/agent` with `/api/sandbox/agent` and use the temporary Bearer secret issued to the administrator. Fields and error semantics are shared. Sandbox command polls wait at most three seconds. See [One-click AI integration test](docs/INTEGRATION.md#one-click-ai-integration-test) for setup and limits.

## Authentication and sessions

Use the full endpoint supplied by the console, for example `https://quantbot.example.com/api/agent`. Strip the trailing slash and append the relative API path, such as `/session`. Preserve explicit ports. Endpoints cannot contain other paths, query strings, fragments, or user credentials. Use HTTPS remotely. HTTP is limited to `localhost`, `127.0.0.1`, or `[::1]`. Verify TLS certificates and reject automatic redirects.

Send the following HTTP headers. The key identifies the credential. The secret is its Bearer token. Each token is bound to one strategy ID. The Web console uses a separate administrator session cookie.

```http
Authorization: Bearer <Secret>
Content-Type: application/json
Accept: application/json
User-Agent: QuantBot-Integration/1.0
```

Clients may append a language or runtime identifier to the User-Agent. Use an identifiable application name.

Give each running instance a stable `instance_id`. Use different IDs for multiple instances of one strategy. One instance can declare `executor: true` to handle controls. Other instances may still send telemetry. The first authorized executor is retained until an administrator switches it after the previous executor goes offline and outstanding trading commands are resolved.

- `session` registers sessions and sends heartbeats.
- `telemetry` sends standard reports, snapshots, events, and metrics.
- `control` reads desired state, reports actual state, and registers controls.
- `commands` polls, claims, and acknowledges one-time commands. It requires `control`.

After opening a session, send the returned `session_id` in `X-Agent-Session`. Send heartbeats at `heartbeat_interval_seconds`. The connection may expire after `offline_after_seconds`. On a session conflict, call `POST /session` again using the same instance ID and capability definitions. Replace an invalid credential with a newly issued token from your local secret configuration.

## Agent API

The following paths are relative to the Agent endpoint.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/monitor/{instance_id}` | telemetry | Report data and refresh presence using the token |
| POST | `/session` | session | Declare version, broker, language, framework, and capabilities |
| PUT | `/heartbeat` | session | Keep the session active and report runtime health and broker state |
| POST | `/reports` | telemetry | Batch 14 types of standard records |
| PUT | `/snapshot` | telemetry | Submit a full current snapshot and derived historical data |
| POST | `/events` | telemetry | Append standard events idempotently |
| POST | `/metrics` | telemetry | Batch historical metrics |
| PUT | `/metric-definitions` | telemetry | Register metric names, units, and descriptions |
| GET | `/control` | control | Read desired, reported, and synchronization state |
| PUT | `/control/reported` | control + executor | Report actual entry permission, local risk lock, and applied revision |
| PUT | `/controls` | control + executor | Register, update, or remove declarative controls |
| PUT | `/controls/state` | control + executor | Report actual values and disabled reasons, individually or in batches |
| GET | `/commands?wait=25&revision=…` | commands + executor | Wait for commands or a new desired state |
| POST | `/commands/{id}/claim` | commands + executor | Claim a one-time permit atomically |
| POST | `/commands/{id}/result` | commands + executor | Report success, failure, or an unknown outcome |

The production JSON body limit is 1 MiB. Validation errors include field locations and error types. A 401 means the credential is invalid, expired, or revoked. A 403 means insufficient permission, a 409 means a session, revision, idempotency, or state conflict, and a 413 means the request is too large. A 422 indicates schema or parameter validation failure. For a 429, honor `Retry-After` in seconds or HTTP date format. Agent responses include `X-QuantBot-Request-ID`. Diagnostics may also include a proxy's `CF-Ray`. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## Standard data and charts

For basic monitoring, use `POST /api/agent/monitor/{instance_id}` with the strategy's Bearer token and `{"records":[...]}`. A session header is unnecessary. Use a stable instance name of at most 56 characters and report every 15 seconds. Reports refresh presence and may be retried after a network outage or service restart. Use the session protocol for remote commands.

`POST /reports` and basic monitoring accept the same records. Each record includes an explicit `type`, integer `schema_version: 1`, and RFC 3339 `observed_at`. The server normalizes timestamps to UTC. Use decimal strings for amounts, prices, quantities, fees, equity, returns, and metric values. Report percentages as percentage points, so `"1.25"` means 1.25%. Use uppercase currency codes.

| Type | Main fields | Storage | Display |
|---|---|---|---|
| status | `runtime` with health, uptime, broker connection, and authorization expiration | Latest state and historical observations | Status cards and history |
| portfolio | `accounts` identified by `account_id` and `currency` | Account snapshots and derived equity series | Account cards and equity |
| position | `strategy_positions` and `broker_positions` with symbol, currency, quantity, and optional market price | Stored separately by ownership | Positions and strategy market exposure by currency |
| order | `open_orders` and `completed_orders` with standard and optional broker status | Snapshots and timestamped markers | Orders and status distribution |
| fill | `id` and `fill` with order, account, side, quantity, price, and time | Unique events and a fill projection | Fill history, counts by side and time, and candle markers |
| equity | `account_id`, `currency`, `value`, and optional `drawdown` | By account, currency, and instance | Equity, drawdown, and strategy comparisons |
| performance | `performance` with returns, drawdown, Sharpe, Sortino, win rate, profit/loss ratio, and profit factor | Latest values and historical series | Performance cards and return or drawdown charts |
| metric | `name`, `value`, and optional `label`, `unit`, and `account_id` | By name, unit, account, instance, and time | Metric cards and time series |
| ohlcv | `symbol`, `interval_seconds`, open, high, low, close, and volume. Observation time is the candle start | By symbol, interval, and instance | Candlesticks and volume |
| signal | `id`, `symbol`, `name`, `direction`, and optional strength and description | Unique events | Timeline and candle markers |
| risk | `id`, `code`, `message`, and optional severity, lock state, and symbol | Unique events and alerts | Risk history, markers, and notifications |
| log | `id`, `severity`, `message`, and optional source | Unique events | Log timeline and table |
| connection | `broker_connected`, optional authorization expiration and message | Snapshots and history | Connection card and timeline |
| alert | `id`, `code`, `severity`, `message`, and optional `dedup_key` | Unique events and alerts | Alert history and notifications |

Versioned JSON Schema defines all required fields, enumerations, ranges, and formats. Query `/api/data-types` for schema URLs and component mappings. Download the combined [report batch schema](docs/schemas/batch.schema.json) from `/api/schemas/batch`.

A snapshot has `type: "snapshot"`, `schema_version: 1`, and `observed_at`. Its runtime, account, position, order, fill, performance, and metric fields share the observation timestamp. A structured event has `type: "event"`, `schema_version: 1`, `id`, and `occurred_at`, plus an optional standard `fill` or `marker`. Extension attributes accept bounded scalar values. Chart mappings use explicit types and fields. [Snapshot schema](docs/schemas/snapshot.schema.json) · [Event schema](docs/schemas/event.schema.json)

Retry events with the same ID, timestamp, and content. Within the retention period, fills are deduplicated by strategy, account, and fill ID. Conflicting duplicates return 409. Validated batches are committed in a transaction. Reports outside retention are counted as ignored. Older valid reports can backfill history while the latest snapshot stays current. Metric definitions can be registered before the first observation. Equity and metric line charts need at least two observations. [Metric definition schema](docs/schemas/metric-definitions.schema.json)

## curl quickstart

Install `curl` and `jq`. Copy a paper-strategy token from the Web console and use the following endpoint for a local example.

```bash
export QB_ENDPOINT=http://127.0.0.1:23456/api/agent
read -rs QB_TOKEN
export QB_TOKEN

SESSION=$(curl -fsS --connect-timeout 5 --max-time 10 -A 'QuantBot-Integration/1.0' -H 'Accept: application/json' "$QB_ENDPOINT/session" \
  -H "Authorization: Bearer $QB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instance_id":"curl-example","language":"HTTP","version":"1.0"}')
QB_SESSION=$(jq -er '.session_id | select(type == "string" and length > 0)' <<<"$SESSION")

curl -fsS --connect-timeout 5 --max-time 10 -A 'QuantBot-Integration/1.0' -H 'Accept: application/json' -X PUT "$QB_ENDPOINT/heartbeat" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' -d '{"health":"healthy"}'

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg now "$STAMP" '{records:[
  {type:"portfolio",schema_version:1,observed_at:$now,accounts:[
    {account_id:"paper",currency:"USD",cash:"750.50",equity:"1001.24"}
  ]},
  {type:"metric",schema_version:1,observed_at:$now,name:"rsi_14",value:"52.15",unit:"index"},
  {type:"log",schema_version:1,observed_at:$now,id:("started-"+$now),severity:"info",message:"HTTP example connected"}
]}' | curl -fsS --connect-timeout 5 --max-time 10 -A 'QuantBot-Integration/1.0' -H 'Accept: application/json' "$QB_ENDPOINT/reports" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' --data-binary @-
```

## Entry permissions and offline recovery

`pause_entry` and `resume_entry` persist the desired `entry_enabled` and `revision`. The agent applies and stores the new state locally before reporting it as shown below. Local risk controls determine `risk_locked`. Resuming entries leaves that lock in effect.

```json
{
  "revision": 4,
  "entry_enabled": false,
  "risk_locked": true,
  "disconnect_policy_applied": "block_entry"
}
```

Keep processing market data, positions, monitoring, heartbeats, and local risk actions. Under `continue`, use existing strategy behavior and the last applied permission when disconnected. Under `block_entry`, block new entries when local connectivity checks detect an outage and continue risk actions. Reconcile entry permissions before replaying telemetry and stored receipts after reconnecting. A control succeeds when the strategy reports the actual applied state.

## One-time commands

A session can declare `refresh`, `set_parameters`, `cancel_order`, `close_position`, `flatten`, `buy`, `sell`, or a custom action ID. Each capability has a `label` and parameter schema. Cancel and close require `order_id` and `position_id` respectively. Manual buys and sells require `symbol` and a positive `quantity`. Report broker and strategy positions separately. Close only positions whose ownership the strategy can verify.

1. Submit a command from Web or Telegram. Use the same caller-generated `request_id` and body when retrying.
2. The originating administrator must confirm high-risk requests before they expire. High-risk live operations are disabled by default. Custom actions, trades, cancellations, position closes, and trading parameter changes are treated as high-risk.
3. Poll `GET /commands?wait=25&revision=<last-seen-revision>`. New commands and revisions can wake the poll early. The response indicates delivery.
4. Persist the command ID before calling `POST /commands/{id}/claim`. The first successful claim returns a one-time `permit`, `start_before`, and `server_time`. If the permit expires, the claim is repeated, or the response is lost, check the command or actual broker records.
5. Check the deadline, local risk state, and idempotency records before execution. Use a broker-supported client idempotency ID when available. Reconcile uncertain submissions with actual trading records.
6. Send `{"permit":"...","status":"succeeded","result":{...}}` to `POST /commands/{id}/result`, or use `failed` or `unknown` with optional `error`. Retry with the same receipt. Commands are bound to the session. After restart, claimed commands without receipts become unknown and unclaimed one-time commands expire.
7. Reconcile unknown results in Operations with evidence. Confirmations, claims, receipts, and reconciliation are audited.

Command states are `confirmation_required`, `pending`, `accepted`, `executing`, `succeeded`, `failed`, `unknown`, `expired`, `superseded`, and `cancelled`. A new entry permission revision can change a previous desired state. The originating administrator can cancel an unclaimed one-time command.

## Dynamic controls

Declare capabilities when connecting, then send the full component list to `PUT /controls`. An `id` is unique within the strategy. The `group` references a group ID. Group and component `order` determine display order. Labels, descriptions, units, and options are plain text. Limits are 12 groups, 40 controls, 20 options per selection, and 12 fields per form.

| Control | Definition | Web | Telegram |
|---|---|---|---|
| button | Invoke a declared command without input | Action button | Inline keyboard |
| toggle | Boolean parameter or entry permission | Switch | On and off buttons |
| select | Labeled `options` whose values are in the capability's enumeration | Dropdown | Option buttons |
| number | Optional `min`, `max`, `step`, and `integer` | Numeric input | Numeric input |
| slider | Range divisible by the step, with optional unit | Slider | Numeric input with range guidance |
| text | Optional `max_length` | Text input | Private reply |
| form | `fields` drawn from capability parameters | Form | Step-by-step entry, back, cancel, and submit |
| readonly | Boolean, text, or numeric `value_type` | Actual value | Status text |

A single-value control can specify the bound `parameter`. It can omit the parameter when the capability has exactly one. `default` initializes editing. Actual values come from the agent. `risk_level` and `confirm` can increase restrictions. Server-side restrictions still apply. The entry switch uses `command: "set_trading_enabled"` and requires both `pause_entry` and `resume_entry`.

```json
{
  "schema_version": 1,
  "revision": 3,
  "groups": [{"id":"params","label":"Strategy parameters","order":1}],
  "controls": [
    {"id":"trading_enabled","type":"toggle","label":"Allow new entries","command":"set_trading_enabled"},
    {"id":"rsi_period","type":"number","group":"params","label":"RSI period","command":"set_rsi","parameter":"period","integer":true,"min":5,"max":30,"step":1},
    {"id":"flatten_positions","type":"button","label":"Close all strategy positions","command":"flatten","risk_level":"high","confirm":true}
  ]
}
```

Retry identical content with the same revision. For updates, increase `revision` and submit the full list. Omitted controls are removed. A new executor must publish a higher revision. Old-revision interactions and unclaimed bound commands become invalid.

Report actual values and disabled reasons to `PUT /controls/state`. Updates are ordered by observation time. Repeating a value and timestamp is idempotent. The entry switch's actual state comes from `/control/reported`. Replace the example timestamp with the actual observation time.

```json
{
  "revision": 3,
  "observed_at": "2026-11-13T02:30:00Z",
  "values": {"rsi_period": 14},
  "disabled": {"flatten_positions": {"disabled":true,"reason":"No positions with verified strategy ownership"}}
}
```

```bash
curl -fsS --connect-timeout 5 --max-time 10 -A 'QuantBot-Integration/1.0' -H 'Accept: application/json' -X PUT "$QB_ENDPOINT/controls" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' --data-binary @controls.json
```

Use **Token and diagnostics** in the Web console to copy an AI integration prompt. The Python standard-library example covers sessions, polling, registration, replay, and receipts. [Control registry schema](docs/schemas/controls.schema.json) · [Control state schema](docs/schemas/control-state.schema.json) · [Python example](examples/http_agent.py)

## Administration API and event stream

`/api/admin` uses administrator sessions for strategies, tokens, commands, Telegram, and settings. History endpoints support bounded ranges and precise decimal aggregation. `POST /api/admin/history/metrics` accepts up to ten sources identified by strategy, instance, metric, account, and unit. Dashboard saves use a revision. Live browser updates use authenticated `GET /api/stream` together with periodic refreshes.

The endpoint is the API URL. The key is the credential ID. The secret is the Bearer token. It is returned on issuance or when an administrator explicitly calls `POST /api/admin/strategies/{strategy_id}/tokens/{token_id}/reveal`. Reveals are audited.

New tokens grant all four scopes by default. Use `PUT /api/admin/strategies/{strategy_id}/tokens/{token_id}/permissions` with `{"scopes":[...]}` to update scopes while preserving the key, secret, and expiration. Changes take effect immediately and are audited. Removing command access expires outstanding commands that have not begun execution. Reconcile already claimed permits with actual results. Session and heartbeat responses expose current `scopes`, so agents can stop or resume the corresponding requests.

`POST /api/admin/strategies/{strategy_id}/tokens/{token_id}/regenerate` preserves scopes and expiration, and revokes the previous token upon successful issuance. Use rotation if you need an overlap for migration.

Interactive documentation is available at `/docs` on the running service. See the [full OpenAPI 3.1 contract](docs/openapi.json).
