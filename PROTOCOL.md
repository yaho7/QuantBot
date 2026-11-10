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
| `hello` | `commands`: 支持的命令名列表 | 启动时发一次；QuantBot 说 `need_hello` 时再发 |
| `status` | `text`, `paused` | 状态快照；随时可以发，建议每轮发一次 |
| `fill` | `message` | 成交 |
| `info` | `message` | 普通消息 |
| `summary` | `message`, 可选 `image`（PNG 的 base64） | 每日总结 |
| `alert` | `message` | 要提醒你的事，比如风控触发 |
| `error` | `message` | 报错 |
| `connection` | `name`, `ok`, 可选 `detail` | 连接状态，只有变化时才推送 |
| `expiry` | `name`, `expires_at`（带时区的 ISO 时间） | 授权到期时间，比如 Schwab |

返回 `200 {"ok": true}`。

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

**同一个命令可能收到两次**：结果没回报的命令，20 秒后会重发。请按 `id` 去重，执行过的只回报上次的结果。

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

同一个 id 第二次回报会被忽略，返回 `200`。不认识或已过期的 id 返回 `404`。

## 最小例子（curl）

```bash
H="Authorization: Bearer $QB_TOKEN"
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"hello","commands":["status","pause","resume"]}' http://127.0.0.1:8080/v1/events
curl -s -H "$H" 'http://127.0.0.1:8080/v1/commands?wait=25'
```
