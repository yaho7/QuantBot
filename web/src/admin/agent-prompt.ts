const repo = "https://github.com/yaho7/QuantBot";
const main = repo + "/blob/main";

export const agentReferences = {
  repository: repo,
  readme: main + "/README.md",
  troubleshooting: main + "/docs/TROUBLESHOOTING.md",
  performance: main + "/docs/HOST_PERFORMANCE.md",
  protocol: main + "/docs/AGENT_PROTOCOL.md",
  integration: main + "/docs/INTEGRATION.md",
  openapi: main + "/docs/openapi.json",
  python: main + "/examples/v3/report.py",
  javascript: main + "/examples/v3/report.mjs",
  go: main + "/examples/v3/report.go",
  curl: main + "/examples/v3/report.sh",
  capabilities: main + "/examples/v3/capabilities.json",
  configuration: main + "/examples/v3/quantbot.example.json",
} as const;

type StrategyContext = { id: string; name: string; mode: "paper" | "live" };

export function agentPrompt(origin: string, endpoint: string, strategy?: StrategyContext,
  connection?: { key?: string; sandboxToken?: string; lang?: string; expiresAt?: number; productionEndpoint?: string }) {
  const production = connection?.sandboxToken === undefined;
  const credential = production ? "Paste the production Token from the strategy's API dialog into secret locally." :
    "The secret below is a temporary Sandbox Token. Use a separate local working directory so it cannot overwrite production configuration.";
  const configuration = JSON.stringify({
    endpoint,
    key: connection?.key ?? "",
    secret: connection?.sandboxToken ?? "",
    instance_name: production && strategy ? "agent-" + strategy.id.slice(0, 8) + "-01" : "sandbox-test-01",
    strategy_id: production ? strategy?.id ?? "" : "",
    heartbeat_seconds: 15,
    disconnect_policy: "continue",
  }, null, 2);
  const sandboxDetails = !production && connection?.expiresAt ? new Date(connection.expiresAt * 1000).toISOString() : "";
  const executor = production ? "Once the administrator appoints this instance as Executor" : "Once the Sandbox designates its first connected instance as Executor";
  const reports = production ? "Send real telemetry" : "Send simulated telemetry";
  const initial = production ? "Initial reporting and host discovery do not require an Executor." : "Initial reporting does not require an Executor.";
  const verification = production ? "Verify in Sandbox or with a dedicated paper strategy, simulated commands, and no broker side effects." : "Use only the shared Sandbox endpoint and temporary token for this trial. Do not connect a real broker.";
  const target = strategy ? `Target strategy: ${JSON.stringify({ id: strategy.id, name: strategy.name, mode: strategy.mode })}\n` : "";
  const references = `QuantBot source: ${agentReferences.repository}
README: ${agentReferences.readme}
Protocol and payloads: ${agentReferences.protocol}
Troubleshooting: ${agentReferences.troubleshooting}
Setup and verification: ${agentReferences.integration}
OpenAPI: ${agentReferences.openapi}
Examples: Python ${agentReferences.python}; JavaScript ${agentReferences.javascript}; Go ${agentReferences.go}; curl ${agentReferences.curl}
Local configuration template: ${agentReferences.configuration}
Capability declaration example: ${agentReferences.capabilities}
Host reporting: ${agentReferences.performance}
Read the deployed schemas at ${origin}/api/agent/schemas/agent.json and ${origin}/api/agent/schemas/report.json. If GitHub differs from this server, follow the deployed schema and this prompt.`;
  const host = production ? `
Host discovery is automatic from POST /performance with the same report session; no host setup, machine ID, type selection or second credential is required. Read ${origin}/api/agent/schemas/performance.json. Send host_name from the OS plus records containing measured host and/or process metrics. Same names are grouped. Omit missing values, report actual effective capacity when known, and use RFC3339 observed_at. Retrying must reuse IDs and data. Charts show only the latest continuous reporting run, and performance samples are kept for three days.
` : "";

  if (connection?.lang === "zh") {
    return `请直接修改当前量化程序，完整接入 QuantBot 的监控、分析和安全远程控制。先检查语言、主程序生命周期、行情和券商缓存、策略状态、开仓判断及本地风控入口。复用现有 HTTP 客户端，不改交易算法、下单参数或启动方式。不要只做心跳和基础上报。

${strategy ? "目标策略：" + JSON.stringify({ id: strategy.id, name: strategy.name, mode: strategy.mode }) + "\n" : ""}${production
  ? "正式接入：请用户在策略 API 弹窗复制 Token，在本机填写 secret。用沙盒或模拟策略先验证，再切换正式配置。"
  : "沙盒测试：下方是临时配置，有效期至 " + sandboxDetails + "。正式地址：" + (connection?.productionEndpoint ?? origin + "/api/agent") + "。不要覆盖已有正式配置。" }

一、本地配置和接入资料
在策略工作目录读取 quantbot.json。另建 secret 为空的 quantbot.example.json，把实际文件加入 .gitignore。不要从环境变量读取凭证，禁止把 Token 写进源码、日志或 Git。

${configuration}

secret 用于 POST /session 的 Bearer；key 只是凭证 ID。instance_name 映射为稳定的 instanceId，多台机器同时运行时名称要不同；如果填写了 strategy_id，验证它与会话返回值一致。endpoint 只有域名时追加 /api/agent；完整的 Agent 或沙盒地址直接追加 /session 等相对路径。远程使用可访问的 HTTPS 地址。

${references}

二、完整数据监控
- 运行与健康：在线心跳、运行阶段、运行时长、行情新鲜度、券商连接、风控锁、错误和异常。
- 账户与交易：余额、可用资金、购买力、净值、持仓、订单、成交、信号与手续费。区分策略所属与券商账户全量持仓。用协议中的 account_id、symbol、signal_id、decision_id、order_id、command_id、correlation_id 做有依据的关联。
- 绩效与行情：已有净值与损益、收益率、回撤、行情 OHLCV、日志和内部指标。金额与数量按 Schema 使用十进制字符串；历史图表、回放和 K 线必须来自实际记录。
- 只读上报可从 POST /reports 开始。由执行器注册真实 metric、state、parameter、action、resource、event。按需填写 history、presentation（surface、preferred_renderer、suggested、default_size、order），以及 health 分组、stale_after_seconds、alert_suggestion。告警建议默认不启用。通过 PUT /state 更新实际值、POST /events 上报事件；资源集合通过 PUT /resources/{type} 明确 snapshot 或 patch、resourceRevision 和 Idempotency-Key。不要编造数据、关联或交易结果。
${production ? "- 主机容量：同一会话 POST /performance，使用操作系统主机名和真实 CPU、内存、进程数据。不配额外 Token。规范：" + origin + "/api/agent/schemas/performance.json\n" : ""}
三、高级控制（接入重点）
1. 优先做暂停和恢复新开仓、刷新信息、运行状态和风控锁。暂停只影响新开仓，不中止止损、减仓和退出；恢复不能解除本地风控锁。重启和重连先核对最后实际生效的状态。
2. 动态参数按实际能力声明开关、滑块、数值或选项，提供单位、输入 Schema、范围和步长，区分平台发来的期望值与策略实际生效值，只上报实际。只有策略能整体原子应用时才声明 atomic_parameters。
3. 低风险和只读功能可以直接接入。新增或改动会影响交易结果的动态参数、撤单、指定或全部平仓、手动买卖，先说明调用的现有入口、归属校验、风险和确认步骤，等用户同意再改这部分。只注册已实现且验证的操作。
4. 只有指定执行器可 GET /commands 和 POST /commands/{id}/claim。先持久化命令 ID 和 Idempotency-Key；收到唯一 permit、未超时且通过本地风控再执行。丢包只能用同键重试，claim_reconciliation_required 或结果未知时先核对记录。真实结果用 POST /commands/{id}/result 回报，重传沿用同一回执。PUT /state 只上报实际，不直接执行参数变更。

四、会话、掉线和验收
- 会话用新的 bootId 启动，同进程用原 Token、相同 instanceId 和 bootId 按 renewAt 后台续期并原子替换凭证。默认 15 秒心跳，45 秒判离线，每次上报不用重发能力定义。
- 用后台任务处理网络，设置超时，不跟随重定向，遵守 Retry-After 和带抖动的指数退避。session_expired 只刷新一次；Token 撤销、过期或权限不足要分别报告。稳定记录 ID 和观察时间，重要事件和回执先保存再重试。缺少配置或断线时保留本地逻辑和风控，不接收远程指令。
- ${production ? "先用沙盒或专用模拟策略验收。" : "识别 /api/agent/sandbox/{id}，在连接真实券商之前进入模拟模式。沙盒与正式环境的状态、凭证和命令日志必须隔离。"} 验证会话、心跳、能力登记、实际状态、历史上报、事件、资源同步，以及从沙盒弹窗下发模拟命令后轮询、领取和回执。验证开仓权限、参数约束、重连和幂等。测试不得真实交易。
- 交付时列出改动文件、支持的监控与高级控制、运行方式、如何在 QuantBot 检查接入、哪些能力需要授权或当前程序不支持。正式切换由用户更新 endpoint 和 secret。`;
  }

  return `Integrate the existing trading program fully with QuantBot monitoring, analysis and remote control. Inspect its lifecycle, cached market and broker data, entry gate, local risk rules, and execution entry points first. Reuse its HTTP client and keep its trading logic and launch command.
${target}Read quantbot.json from the strategy's local working directory at startup. Use the file for the endpoint and credentials. Do not read them from environment variables. Add quantbot.json to .gitignore and keep the file private. ${credential} Never put secrets in code, logs, or Git.

${configuration}

Use secret as the Bearer Token for POST /session; key is a credential identifier, not an authentication header. Map instance_name to a stable API instanceId; choose a different name for each concurrently running instance. If strategy_id is set, verify it against the session response before sending data. An endpoint containing only the origin gets /api/agent appended. Preserve a full Agent or Sandbox endpoint and append relative routes (such as /session). For a remote strategy, use the reachable HTTPS origin.
The default heartbeat_seconds is 15. disconnect_policy "continue" keeps the local strategy, risk checks and exits on their existing schedule while QuantBot is disconnected. Do not accept remote commands during a disconnect or replay outcomes already executed.

${references}

Start with reporting: POST /session using the Agent Token, instance_name and a new bootId per process start. Use the returned session Bearer for other calls. PUT /heartbeat at heartbeat_seconds even when no trade or report occurs; the offline threshold is 45 seconds. Use renewAt from the response (normally ten minutes before the one-hour expiry), serialize renewal with the original Token and the same instanceId and bootId, then atomically switch to the new session. Retry transient failures and 429/5xx with capped exponential backoff and jitter. Refresh once on session_expired or use a session already renewed by another worker. Stop retrying a revoked or expired Agent Token or an archived strategy, and surface insufficient_scope.

${reports} through POST /reports and POST /events with stable IDs and unchanged payloads on retry. Use UTC Unix milliseconds for observations and decimal strings where the schema requires them. Include available status, broker and market connectivity, balances, buying power, equity, P&L, drawdown, positions, orders, fills, fees, signals, OHLCV, logs and internal metrics. Distinguish strategy-owned positions from account-wide data. Link records only with actual account_id, symbol, signal_id, decision_id, order_id, command_id or correlation_id.
${initial} ${executor}, register real metric, state, parameter, action, resource and event capabilities. Use presentation suggestions for dashboard surfaces/renderers, history for charts/replay, health grouping for health diagnostics, and stale_after_seconds and alert_suggestion where supported. Alert suggestions start inactive. Use PUT /state for observed values and PUT /resources/{type} for explicit snapshots or patches, with resourceRevision and Idempotency-Key.
Advanced control is a priority: support a safe pause/resume for new entries, refresh, and read-only risk state when available. A pause must not stop protective exits, and resume must not bypass a local risk lock. Use typed, bounded switches, sliders, inputs or options for supported parameters; report applied values separately. Before changing how live parameters, cancellation, liquidation or manual orders work, explain the existing execution route, position ownership, safeguards and required approval. Implement proven existing operations and report unsupported ones.
${host}
Only the designated Executor may GET /commands and POST /commands/{id}/claim. Persist the claim Idempotency-Key before requesting a permit. On a lost response retry with the same key; reconcile without executing on claim_reconciliation_required. Check the one-time permit, deadline and local risk rules before invoking strategy or broker operations. Record execution in a durable command journal and POST /commands/{id}/result with the real outcome; retry the same receipt exactly. Report actual state separately. Never re-execute an unknown outcome or enable live trading for an integration test. Only declare atomic_parameters when the program can apply the entire plan atomically.

${verification}${sandboxDetails ? " The Sandbox credential expires at " + sandboxDetails + ". Production endpoint: " + (connection?.productionEndpoint ?? origin + "/api/agent") + "." : ""} In Sandbox, use the console to queue a simulated action; verify session, heartbeat, registration, state, reports, events, resources, command polling, claim and result. Test reconnect and duplicate delivery without broker effects. Keep trading, heartbeats and performance reporting independent. Report changed files, how to run, enabled advanced controls, where to verify them, and any capability requiring approval.`;
}
