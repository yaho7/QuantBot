# QuantBot v2 HTTP 协议

## 认证与会话

程序请求带 `Authorization: Bearer <策略 Token>`。Token 绑定单个 Strategy ID，服务端从凭据确定归属。Web 使用单独的管理员会话 Cookie。远程连接使用 HTTPS。

每个运行实例指定稳定的 `instance_id`。同一个策略的多个程序使用不同 ID。策略需要控制时由一个实例声明 `executor: true`，其他实例仍可上报。服务端将控制资格固定在第一个授权执行实例，管理员可在原实例离线并处理未决交易命令后切换。

- `session` 用于注册会话及心跳。
- `telemetry` 用于发送标准报告、快照、事件及指标。
- `control` 用于读取期望状态、回报实际状态并注册控件。
- `commands` 用于轮询、领取并回报一次性指令，需要 `control`。

建立会话后，请把返回的 `session_id` 放在 `X-Agent-Session` 请求头中。按 `heartbeat_interval_seconds` 发送心跳。连接可能在 `offline_after_seconds` 后失效。收到会话冲突时重新执行 `POST /session`，继续使用原实例 ID 和能力定义。凭据失效时从自己的密钥配置换用已签发的新 Token。

## Agent API

以下路径以 `/api/v2/agent` 开头。

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| POST | `/session` | session | 声明版本、券商、语言、框架和实际控制能力 |
| PUT | `/heartbeat` | session | 维持会话、上报运行健康和券商状态 |
| POST | `/reports` | telemetry | 批量发送 14 种标准记录 |
| PUT | `/snapshot` | telemetry | 提交当前完整快照和派生历史数据 |
| POST | `/events` | telemetry | 幂等追加标准事件 |
| POST | `/metrics` | telemetry | 批量追加历史指标 |
| PUT | `/metric-definitions` | telemetry | 注册指标名称、单位和描述 |
| GET | `/control` | control | 查询期望权限、实际回报和对账状态 |
| PUT | `/control/reported` | control + 执行实例 | 报告实际开仓权限、本地风控锁和已应用修订 |
| PUT | `/controls` | control + 执行实例 | 注册、更新或移除声明式控件 |
| PUT | `/controls/state` | control + 执行实例 | 分批或单项上报控件实际值和禁用原因 |
| GET | `/commands?wait=25&revision=…` | commands + 执行实例 | 等待命令或更新的期望状态 |
| POST | `/commands/{id}/claim` | commands + 执行实例 | 原子领取一次性许可 |
| POST | `/commands/{id}/result` | commands + 执行实例 | 回报实际成功、失败或未知结果 |

JSON 体积上限为 1 MiB。校验错误会返回字段位置和错误类型。401 对应无效、过期或撤销的凭据，403 对应权限不足，409 对应会话、修订、重复请求或状态冲突，413 对应请求过大，422 对应 Schema 或业务参数校验失败，429 对应频率限制。按照 429 的 `Retry-After` 重试。

## 标准数据与图表

`POST /reports` 接受 `{"records":[...]}`。每条记录显式包含 `type`、整数 `schema_version: 1` 和 RFC 3339 `observed_at`。服务端统一为 UTC。交易金额、价格、数量、费用、净值、收益、指标值等使用十进制字符串。百分比按百分数值上报，例如 `"1.25"` 表示 1.25%。币种使用大写代码。

| 类型 | 核心字段及口径 | 持久化方式 | 展示 |
|---|---|---|---|
| status | `runtime`，包含健康、运行秒数、券商连接和授权到期 | 最新状态与历史观测 | 状态卡片、运行历史 |
| portfolio | `accounts`，每项按 `account_id`、`currency` 标识 | 账户快照；净值派生为序列 | 资金卡片、净值 |
| position | `strategy_positions`、`broker_positions`，各项带标的、币种、数量和可选市价 | 两种归属分别保留 | 持仓表、按币种计算策略持仓市值分布 |
| order | `open_orders`、`completed_orders`，带标准状态和可选券商原始状态 | 订单快照及带时间戳的变更标记 | 订单表、状态分布 |
| fill | `id`、`fill`，包含订单、账户、方向、成交数量、成交价和时间 | 唯一事件与成交投影 | 成交记录、按方向及时间统计、K 线标记 |
| equity | `account_id`、`currency`、`value`，可选 `drawdown` | 按账户、币种及实例存储 | 净值、回撤、跨策略对比 |
| performance | `performance`，含收益率、回撤、Sharpe、Sortino、胜率、盈亏比和 Profit Factor | 最新值与历史序列 | 绩效卡、收益及回撤曲线 |
| metric | `name`、`value`，可选 `label`、`unit`、`account_id` | 按名称、单位、账户、实例和时间存储 | 指标卡、通用时间序列 |
| ohlcv | `symbol`、`interval_seconds`、开高低收和成交量，观测时间为该 K 线的开始 | 按标的、周期及实例存储 | K 线与成交量 |
| signal | `id`、`symbol`、`name`、`direction`，可选强度及说明 | 唯一事件 | 信号时间轴、K 线标记 |
| risk | `id`、`code`、`message`，可附等级、锁定状态和标的 | 唯一事件及告警 | 风控历史、标记与推送 |
| log | `id`、`severity`、`message`，可附日志来源 | 唯一事件 | 日志时间轴与表格 |
| connection | `broker_connected`、可选授权到期及说明 | 连接快照与历史 | 连接卡和时间轴 |
| alert | `id`、`code`、`severity`、`message`，可选 `dedup_key` | 唯一事件及告警 | 告警历史及通知 |

完整必填字段、枚举、范围和格式由版本化 JSON Schema 给出。查询 `/api/v2/data-types` 得到每类的 Schema 地址和组件映射。通过 `/api/v2/schemas/batch` 下载包含全部 14 种记录的联合 Schema。 [批量上报 Schema](docs/schemas/batch.schema.json)

快照采用 `type: "snapshot"`、`schema_version: 1`、`observed_at`。一个快照可以同时包含运行状态、账户、持仓、订单、成交、绩效和指标。其标准字段共享快照的观察时间。结构化事件采用 `type: "event"`、`schema_version: 1`、`id` 和 `occurred_at`，可携带标准 `fill` 或 `marker`。扩展属性仅允许有限的标量值，图表按显式标准类型和受控字段匹配。 [快照 Schema](docs/schemas/snapshot.schema.json) · [事件 Schema](docs/schemas/event.schema.json)

策略重传时使用同一事件 ID、时间戳和内容。冲突的重复 ID 会返回 409。批量校验通过后以事务写入。留存期外的历史批次返回忽略数量，较旧的有效观测可补入历史而不覆盖更新的快照。指标定义可以先注册，仪表盘在收到真实点后才发现对应组件。净值和指标折线至少需要两个可用点。 [指标元数据 Schema](docs/schemas/metric-definitions.schema.json)

## curl 接入

需要 `curl` 和 `jq`。从 Web 复制模拟策略 Token，在本机演示时用以下地址。

```bash
export QB_URL=http://127.0.0.1:23456
read -rs QB_TOKEN
export QB_TOKEN

SESSION=$(curl -fsS "$QB_URL/api/v2/agent/session" \
  -H "Authorization: Bearer $QB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instance_id":"curl-example","language":"HTTP","version":"1.0"}')
QB_SESSION=$(jq -r .session_id <<<"$SESSION")

curl -fsS -X PUT "$QB_URL/api/v2/agent/heartbeat" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' -d '{"health":"healthy"}'

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg now "$STAMP" '{records:[
  {type:"portfolio",schema_version:1,observed_at:$now,accounts:[
    {account_id:"paper",currency:"USD",cash:"750.50",equity:"1001.24"}
  ]},
  {type:"metric",schema_version:1,observed_at:$now,name:"rsi_14",value:"52.15",unit:"index"},
  {type:"log",schema_version:1,observed_at:$now,id:("started-"+$now),severity:"info",message:"HTTP example connected"}
]}' | curl -fsS "$QB_URL/api/v2/agent/reports" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' --data-binary @-
```

## 开仓权限与离线恢复

`pause_entry` 和 `resume_entry` 更新持久化的期望 `entry_enabled` 及 `revision`。程序在本地应用并持久化后回报如下。 `risk_locked` 由本地风控决定，恢复开仓权限不修改该锁。

```json
{
  "revision": 4,
  "entry_enabled": false,
  "risk_locked": true,
  "disconnect_policy_applied": "block_entry"
}
```

程序保持行情处理、持仓管理、监控、心跳及本地风险处置。 `continue` 表示失联后遵循原有策略行为及已应用的权限； `block_entry` 表示按本地失联判定阻止新开仓，风险处置继续。重连后先对账权限，再重传遥测和持久化回执。平台展示上报值与同步状态，控制成功以实际回报为依据。

## 一次性命令

会话能力可声明 `refresh`、`set_parameters`、`cancel_order`、`close_position`、`flatten`、`buy`、`sell` 或业务自定义 ID。每项能力声明 `label` 和参数 Schema。撤单、平仓分别要求 `order_id`、`position_id`，手动买卖要求 `symbol` 和正数 `quantity`。券商账户持仓和策略归属持仓分别上报，策略收到平仓请求后只处理可确认归属的持仓。

1. Web 或 Telegram 提交命令。 `request_id` 是调用方幂等键，重复时使用原值和原请求体。
2. 高风险命令由原发起管理员在有效期内确认。默认关闭实盘高风险操作，自定义动作、下单、撤单、平仓和改参按高风险处理。
3. 客户端以 `GET /commands?wait=25&revision=<已读期望修订>` 主动等待。新指令或新修订可提前唤醒轮询。轮询响应代表投递。
4. 客户端先持久化待领取的命令 ID，再调用 `POST /commands/{id}/claim`。只有首次成功返回一次性 `permit`、`start_before` 和 `server_time`。过期、重复领取或丢失许可响应时，查询命令记录或券商实际状态。
5. 开始业务操作前校验时限、本地风控和幂等记录。对真实交易可使用券商支持的客户端幂等 ID；发送结果不确定时保留未知状态并核对实际记录。
6. 用 `POST /commands/{id}/result` 提交 `{"permit":"...","status":"succeeded","result":{...}}`，或用 `failed`、`unknown` 和可选 `error`。网络错误时重发相同回执。单次指令绑定会话，重启后已领取但未完成的命令标记未知，未领取的一次性命令到期。
7. 管理员在操作记录提供核对依据后处理未知结果。确认、领取、实际回执和核对均可查询审计。

服务端状态包括 `confirmation_required`、`pending`、`accepted`、`executing`、`succeeded`、`failed`、`unknown`、`expired`、`superseded` 和 `cancelled`。已改变期望状态的请求可以通过新的开仓权限修订纠正。未领取的一次性命令可由发起人取消。

## 动态控制组件

程序连接时先声明基础能力，再通过 `PUT /controls` 提交完整组件列表。 `id` 在策略内唯一。 `group` 引用分组 ID，服务端依据组及组件的 `order` 排列。控件标签、说明、单位和选项均按纯文本显示。组最多 12 个、控件最多 40 个、下拉选项最多 20 项、表单最多 12 个字段。

| 控件 | 定义 | Web | Telegram |
|---|---|---|---|
| button | 无用户输入，调用已声明指令 | 执行按钮 | Inline Keyboard |
| toggle | 布尔参数，或绑定开仓权限 | 开关 | 开启与关闭按钮 |
| select | `options` 的标签和值，值属于能力枚举 | 下拉菜单 | 选项按钮 |
| number | 可设 `min`、`max`、`step`、`integer` | 数值输入 | 数值输入 |
| slider | 必须给定可整除的范围和步长，可选单位 | 滑块 | 数值输入与范围说明 |
| text | 可配置 `max_length` | 文本输入 | 私聊回复 |
| form | 由基础能力参数组成的 `fields` | 多参数表单 | 分步填写、回退、取消与提交 |
| readonly | `value_type`，可为布尔、文本或数字 | 只读实际值 | 状态文本 |

单值控件可用 `parameter` 指定绑定参数；能力只有一个参数时可以省略。 `default` 作为编辑初值，实际值由程序上报。 `risk_level` 与 `confirm` 可提高限制，危险指令的服务端限制继续生效。标准开仓开关使用 `command: "set_trading_enabled"`，依赖同时声明 `pause_entry` 和 `resume_entry`。

```json
{
  "schema_version": 1,
  "revision": 3,
  "groups": [{"id":"params","label":"策略参数","order":1}],
  "controls": [
    {"id":"trading_enabled","type":"toggle","label":"允许新开仓","command":"set_trading_enabled"},
    {"id":"rsi_period","type":"number","group":"params","label":"RSI 周期","command":"set_rsi","parameter":"period","integer":true,"min":5,"max":30,"step":1},
    {"id":"flatten_positions","type":"button","label":"全部平仓","command":"flatten","risk_level":"high","confirm":true}
  ]
}
```

同修订与相同内容可安全重试。更新时递增 `revision` 并发送完整列表，省略的控件会移除。换执行实例后新实例需要发布更高修订。旧修订的交互和未领取的绑定命令失效。

实际值和禁用原因通过 `PUT /controls/state` 上报。每项按观测时间校验顺序，重发同一值和时间戳是幂等的。开仓开关实际状态以 `/control/reported` 为准。以下示例的观测时间应替换为本次实际观测时间。

```json
{
  "revision": 3,
  "observed_at": "2026-11-13T02:30:00Z",
  "values": {"rsi_period": 14},
  "disabled": {"flatten_positions": {"disabled":true,"reason":"当前没有可确认归属的持仓"}}
}
```

```bash
curl -fsS -X PUT "$QB_URL/api/v2/agent/controls" \
  -H "Authorization: Bearer $QB_TOKEN" -H "X-Agent-Session: $QB_SESSION" \
  -H 'Content-Type: application/json' --data-binary @controls.json
```

在 Web **API 接入** 中可复制完整规范及 AI 接入指令。 Python 标准库示例包含全部会话、长轮询、版本注册、断线补传和回执流程。 [控制注册 Schema](docs/schemas/controls.schema.json) · [控件状态 Schema](docs/schemas/control-state.schema.json) · [Python HTTP 示例](examples/http_agent.py)

## 管理 API 与事件流

`/api/v2/admin` 使用管理员会话，供 Web 管理策略、Token、命令、Telegram 和系统设置。历史接口支持按范围查询标准数据与精确十进制聚合。 `POST /api/v2/admin/history/metrics` 可按策略、实例、指标、账户和单位选择最多十个数据源。布局保存使用仪表盘修订号。实时更新使用经管理员认证的 `GET /api/v2/stream`，浏览器同时定期刷新。

运行中的交互文档位于 `/docs`。查看 [完整 OpenAPI 3.1 规范](docs/openapi.json)。
