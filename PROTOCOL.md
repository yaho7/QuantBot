# QuantBot HTTP API v2

交互文档位于 `/docs`，OpenAPI 位于 `/openapi.json`。数据注册表位于 `/api/v2/data-types`，各类型的 JSON Schema 位于 `/api/v2/schemas/{type}`。

程序以 Bearer Token 请求 `POST /api/v2/agent/session`。使用返回的 `session_id` 作为后续请求的 `X-Agent-Session`，定期发送 `PUT /api/v2/agent/heartbeat`。通过 `POST /api/v2/agent/reports` 批量发送带固定类型、版本与时区时间戳的标准记录。金融金额和数量使用十进制字符串。

授权执行实例从 `GET /api/v2/agent/control` 取得期望开仓权限，应用并持久化后向 `PUT /api/v2/agent/control/reported` 回报修订版本、实际权限与本地风险锁。一次性操作用 `GET /api/v2/agent/commands?wait=25` 长轮询，并在执行前通过命令的 `claim` 接口取得一次性许可。通过 `result` 接口回报实际执行结果。
