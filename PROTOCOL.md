# QuantBot 接入协议 v1

策略向 QuantBot 发 HTTP 请求。所有请求都带：

```http
Authorization: Bearer <这个策略的 token>
Content-Type: application/json
```

token 错误返回 `401`。请求体超过 6 MB 返回 `413`。JSON 不对返回 `400`。

## 1. 发事件

`POST /v1/events`

```json
{"type": "fill", "message": "AAPL BUY 10 @ 280.50"}
```

| `type` | 其他字段 | 说明 |
|---|---|---|
| `hello` | `commands`: 支持的内置命令名列表；可选 `actions` | 启动时发一次；QuantBot 说 `need_hello` 时再发 |
| `status` | `text`, `paused` | 状态快照；随时可以发，建议每轮发一次 |
| `fill` | `message` | 成交 |
| `info` | `message` | 普通消息 |
| `summary` | `message`, 可选 `image`（PNG 的 base64） | 每日总结 |
| `alert` | `message` | 要提醒你的事，比如风控触发 |
| `error` | `message` | 报错 |
| `connection` | `name`, `ok`, 可选 `detail` | 连接状态，只有变化时才推送 |
| `expiry` | `name`, `expires_at`（带时区的 ISO 时间） | 授权到期时间，比如 Schwab |

返回 `200 {"ok": true}`。

`metric` 事件包含 `name`、有限数值 `value`，以及可选的 `label` 和 `unit`。服务按收到事件的 Unix 时间秒记录样本，每个指标保存最近 240 个样本。同一秒内以最后一个值为准。

`hello.actions` 可声明网页操作，每项包含 `id`、`label`、可选的 `confirm` 和 `fields`。字段以关键字参数名称为键，描述包含 `type`（`text`、`number`、`boolean` 或 `select`）、可选 `label`、`required`（默认真）和选择项 `options`。调用自定义操作时收到的命令名为 `action:<id>`，响应沿用普通命令的 `message` 和 `data`。

成交、风控告警、错误和总结事件可以带 `event_id`，使用 32 位小写十六进制 ID。
服务端持久保存后返回 `{"ok":true,"event_id":"…"}`。客户端可用原 ID 重试，
QuantBot 按策略和事件 ID 去重。新版 Python 客户端会将这些事件放入本地 SQLite
队列，收到回执后删除；服务端也会在 Telegram 投递失败后重试。Telegram 接收成功
但 HTTP 回执丢失时，外部消息仍有可能重复。

## 2. 取命令

`GET /v1/commands?wait=25`

最多挂 `wait` 秒（1 到 30）。有命令时马上返回：

```json
{
  "commands": [
    {"id": "9f2c…", "name": "set_param", "args": {"name": "rsi_len", "value": 10}}
  ],
  "need_hello": false
}
```

没有命令时，到时间返回 `"commands": []`。每次请求都算一次在线；45 秒没来取，策略就算离线。

`need_hello` 为 `true` 时，说明 QuantBot 刚重启、还不知道你的能力，请再发一次 `hello`。

查询和暂停命令可能重发。请按 `id` 去重，执行过的只回报上次结果。

有副作用的命令（`manual_order`、`cancel`、`flatten`、`resume`、
`set_param`、`stop` 及自定义操作）只发给使用
`GET /v1/commands?wait=25&claims=1` 的客户端，并附带 Unix 秒 `expires_at`。
客户端应在即将执行时先检查失效时间，再调用
`POST /v1/commands/{id}/claim`，请求体为 `{"grant":"<32 位十六进制随机值>"}`。
仅在明确收到 `200 {"ok":true}` 且仍在有效期内时执行。收到 `409`、连接断开
或没有明确答复时，跳过该命令。服务器会持久化执行许可，且每个命令只签发一次。
两端需同步系统时间。离线时只有暂停意图可以等待重新连接。

命令名和参数见 [DESIGN.md](DESIGN.md) 的“能力和菜单”。

## 3. 回报结果

`POST /v1/commands/{id}/result`

```json
{"ok": true, "message": "已平掉 QQQ 10 股", "data": null}
```

| 命令 | `data` |
|---|---|
| `orders` | `[{"id": "…", "text": "卖出 QQQ 10 @ 520 止损"}]` |
| `params` | `{"rsi_len": 14, "symbol": "QQQ"}` |
| `chart` | PNG 的 base64 字符串 |
| `status` | `{"text": "…", "paused": false}` |
| 其他 | 不需要，`message` 写给人看 |

失败时 `ok` 为 `false`，`message` 写原因，比如“分不清哪些仓位属于本策略，拒绝平仓”。

受保护命令的结果还需带领取时使用的 `grant`。确认操作没有生效时回报
`"ok": false`。执行后发生异常且效果不确定时回报
`"ok": false, "unknown": true`。匹配同一许可的重复回报返回 `200`。
其他已结束或未知的命令返回 `404`。

控制台按 CREATED、ACCEPTED、EXECUTING、SUCCEEDED、FAILED 和 UNKNOWN 记录
有副作用的操作。查询 `GET /ui/api/strategies/{sid}/operations` 可查看操作记录。
若仍为 UNKNOWN，应核对券商和策略进程，确认处理函数已结束并查明实际结果后，
用管理员会话向 `POST /ui/api/strategies/{sid}/operations/{id}` 提交
`{"ok": true, "note": "券商订单号和核对结论"}`（确认未生效时用 `false`）。

Web 管理 API 的受保护命令先用同一 POST 路径提交参数和 `"prepare": true`，
取得 `data.ticket`，再携带原参数和 `"ticket": "<票据>"` 确认。票据绑定当前
会话、策略、命令和参数，30 秒内限用一次。

## 最小例子（curl）

`QB_URL` 是 `http://` 加 `quantbot list` 里的监听地址，`QB_TOKEN` 用 `quantbot token <id>` 查看。

```bash
H="Authorization: Bearer $QB_TOKEN"
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"hello","commands":["status","pause","resume"]}' "$QB_URL/v1/events"
curl -s -H "$H" "$QB_URL/v1/commands?wait=25"
```
