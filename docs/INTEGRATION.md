# QuantBot 跨语言接入

在 QuantBot 控制台创建策略，复制 Endpoint 与 AI 接入提示词。点击眼睛查看 Secret，只把它填进策略机器上的配置。Key 用于在控制台识别凭据。

AI 应先读 [README](../README.md)、[HTTP 协议](../PROTOCOL.md)、[OpenAPI](openapi.json)、[JSON Schema](schemas) 和 [参考示例](../examples)，再检查目标项目的语言、HTTP 能力、启动流程、现有数据源和风控入口。通信代码随主程序启动，可运行在独立线程或异步任务中。策略无需部署额外服务或开放端口。

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

按照 [HTTP 协议](../PROTOCOL.md) 设置 Bearer Secret、JSON 请求头和 `User-Agent: QuantBot-Integration/1.0`。复制的 Endpoint 已含 `/api/agent`。附加接口相对路径时保持 HTTPS、端口和证书验证，拒绝重定向。按接口检查响应字段。可参考 [连接与错误排查](TROUBLESHOOTING.md)。

## 监控与控制

基础监控通过 `POST /monitor/{instance_id}` 上报。完整接入建立会话，使用 `X-Agent-Session`，按服务端给出的间隔发送心跳并读取授权范围。按缓存和实际事件采样。状态及资金快照可合并，成交、风控和重要回执保存到有界持久化队列。重传使用相同 ID、时间戳和内容。使用 14 类标准数据结构，只上报已有数据。

只声明策略实际支持的能力。参数展示优先使用只读控件。暂停新开仓应在真实开仓入口生效并持久化，退出和风控持续运行。恢复开仓仍由本地风控判断。断线期间沿用本地已应用的断线策略，重连先对账再处理命令。

影响交易的远程动作需要用户明确授权，通过原有风控和交易入口执行。先写入本地命令 ID，再领取一次性 Permit，核对有效期和风控后执行。先持久化真实结果再回执。中断导致结果不明时对照原交易记录处理，保留同一命令 ID。

## 验收

用模拟策略运行 [Python 标准库参考实现](../examples/http_agent.py) 或 [curl 请求](../PROTOCOL.md#curl-接入)。在 **Token 与诊断** 确认实例在线和报告类型，然后测试断线与重连。对需要控制的接入，验证暂停、恢复、风险锁保持、动态控件实际值，以及重复指令只执行一次。使用模拟或回测数据。
