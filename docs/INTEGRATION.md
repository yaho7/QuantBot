# QuantBot 跨语言接入

在 QuantBot 控制台创建策略，在「Token 与诊断」点击「复制 AI 接入提示词」，再将提示词交给 Codex 或 Cursor。提示词带有可直接使用的 Sandbox 配置。

AI 应先读 [README](../README.md)、[HTTP 协议](../PROTOCOL.md)、[OpenAPI](openapi.json)、[JSON Schema](schemas) 和 [参考示例](../examples)，再检查目标项目的语言、HTTP 能力、启动流程、现有数据源和风控入口。通信代码随主程序启动，可运行在独立线程或异步任务中。策略无需部署额外服务或开放端口。

## AI 一键接入测试

1. 登录管理员账号，在策略的「Token 与诊断」点击「复制 AI 接入提示词」。QuantBot 会为该策略创建或复用一个 Sandbox，复制测试 Endpoint、临时 Secret、Key ID、策略 ID 和到期时间。
2. 让 AI 在量化项目中创建自动读取的 `quantbot.json`，将它加入 `.gitignore`。测试 Endpoint 以 `/api/sandbox/agent` 结尾。把 `secret` 用作 Bearer Token，再按正式 Agent API 拼接路径。用模拟行情、订单、账户和本地控制状态测试。程序必须按 Endpoint 将 Sandbox 指令路由到模拟处理，并隔离本地状态和命令回执。
3. 在「AI 一键接入测试」查看请求记录、Schema 校验、注册控件和模拟指令回执。接入通过需要会话、心跳、遥测、控件注册、开仓状态同步和一次成功的模拟命令回执。Sandbox 会为声明对应能力的执行实例排入模拟暂停和刷新，也可在页面重复发起模拟操作。
4. 测试通过后，复制「正式配置说明」。在策略本机的 `quantbot.json` 替换 `endpoint` 和 `secret`，保留 `instance_name`，再重启并查看正式工作台。正式 Secret 由管理员从策略凭据面板获取。

测试会话默认 60 分钟有效，可提前关闭或从当前时间续期 60 分钟。到期前 5 分钟出现提醒。临时凭据与正式 Token 不能混用。测试请求在专用工作线程执行，每个会话使用独立的内存数据库，服务重启后需要重新复制。到期或关闭后清理测试数据，短时保留诊断摘要。单请求上限 64 KiB，单 Key 每分钟最多 120 个请求，全局每分钟最多 600 个请求。最多同时运行 8 个 Sandbox，每个 Key 最多 2 个并发请求，全局最多 6 个。单会话数据库上限约 4 MiB。收到 429 时遵循 `Retry-After`。

## 配置

`quantbot.example.json` 可采用以下结构：

```json
{
  "endpoint": "https://quantbot.example.com/api/agent",
  "secret": "",
  "instance_name": "strategy-001"
}
```

量化程序可首次启动时创建本地 `quantbot.json`。仅在文件不存在时创建，避免覆盖用户配置。真实配置加入 `.gitignore`，示例配置保留空 Secret。缺少配置时跳过通信任务，已有的开仓权限和风控状态按本地规则处理。官方演示脚本用 `QB_ENDPOINT` 和 `QB_TOKEN`，便于在测试机器运行。

## 客户端选择

| 语言 | 推荐实现 |
| --- | --- |
| Python | `urllib.request` 或项目已有 HTTP 客户端 |
| JavaScript / TypeScript | Node.js 原生 `fetch` 或现有网络层 |
| Go | `net/http` |
| C# | `HttpClient` |
| Java | `java.net.http.HttpClient` |
| C++ | 项目已有 HTTP 客户端或系统网络 API |

按照 [HTTP 协议](../PROTOCOL.md) 设置 Bearer Secret、JSON 请求头和 `User-Agent: QuantBot-Integration/1.0`。复制的 Endpoint 已含 `/api/agent` 或 `/api/sandbox/agent`。附加接口相对路径时保持 HTTPS、端口和证书验证，拒绝重定向。按接口检查响应字段。可参考 [连接与错误排查](TROUBLESHOOTING.md)。

## 监控与控制

基础监控通过 `POST /monitor/{instance_id}` 上报。完整接入建立会话，使用 `X-Agent-Session`，按服务端给出的间隔发送心跳并读取授权范围。按缓存和实际事件采样。状态及资金快照可合并，成交、风控和重要回执保存到有界持久化队列。重传使用相同 ID、时间戳和内容。使用 14 类标准数据结构，只上报已有数据。

只声明策略实际支持的能力。参数展示优先使用只读控件。暂停新开仓应在真实开仓入口生效并持久化，退出和风控持续运行。恢复开仓仍由本地风控判断。断线期间沿用本地已应用的断线策略，重连先对账再处理命令。

影响交易的远程动作需要用户明确授权，通过原有风控和交易入口执行。先写入本地命令 ID，再领取一次性 Permit，核对有效期和风控后执行。先持久化真实结果再回执。中断导致结果不明时对照原交易记录处理，保留同一命令 ID。

## 验收

用模拟策略运行 [Python 标准库参考实现](../examples/http_agent.py) 或 [curl 请求](../PROTOCOL.md#curl-接入)。在 **Token 与诊断** 确认实例在线和报告类型，然后测试断线与重连。对需要控制的接入，验证暂停、恢复、风险锁保持、动态控件实际值，以及重复指令只执行一次。使用模拟或回测数据。

[Node.js 示例](../examples/http_monitor.mjs) 和 [Go 示例](../examples/http_monitor.go) 各发送一条标准状态报告。它们演示请求校验和脱敏错误诊断。持续监控、退避、状态对账和控制可参考 Python 示例及协议。以下命令只需选择与你项目匹配的一种运行时。

```bash
export QB_ENDPOINT=http://127.0.0.1:23456/api/agent
read -rs QB_TOKEN
export QB_TOKEN
node examples/http_monitor.mjs
go run examples/http_monitor.go
```

开发验收使用 `QB_REQUIRE_LANGUAGE_TESTS=1 uv run pytest tests/integration/test_language_contract.py`。测试用同一套模拟策略流程验证 Python、Node.js、Go 的 HTTP 传输，包括会话、状态、只读控件、暂停和恢复、一次性领取、回执及服务重启。
