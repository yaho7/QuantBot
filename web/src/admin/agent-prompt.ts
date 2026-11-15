const repo = "https://github.com/yaho7/QuantBot";
const main = repo + "/blob/main";

export const agentReferences = {
  repository: repo,
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
  connection?: { key?: string; sandboxToken?: string }) {
  const production = connection?.sandboxToken === undefined;
  const credential = production ? "Paste the production Token from the strategy's API dialog into secret locally." :
    "The secret below is a temporary Sandbox Token. Use a separate local working directory so it cannot overwrite production configuration.";
  const configuration = JSON.stringify({
    endpoint,
    key: connection?.key ?? "",
    secret: connection?.sandboxToken ?? "",
    instance_name: strategy ? "agent-" + strategy.id.slice(0, 8) + "-01" : "sandbox-test-01",
    strategy_id: strategy?.id ?? "",
    heartbeat_seconds: 15,
    disconnect_policy: "continue",
  }, null, 2);
  const executor = production ? "Once the administrator appoints this instance as Executor" : "Once the Sandbox designates its first connected instance as Executor";
  const reports = production ? "Send real telemetry" : "Send simulated telemetry";
  const initial = production ? "Initial reporting and host discovery do not require an Executor." : "Initial reporting does not require an Executor.";
  const verification = production ? "Verify in Sandbox or with a dedicated paper strategy, simulated commands, and no broker side effects." : "Use only the shared Sandbox endpoint and temporary token for this trial. Do not connect a real broker.";
  const target = strategy ? `Target strategy: ${JSON.stringify({ id: strategy.id, name: strategy.name, mode: strategy.mode })}\n` : "";
  const references = `QuantBot source: ${agentReferences.repository}
Protocol and payloads: ${agentReferences.protocol}
Setup and verification: ${agentReferences.integration}
OpenAPI: ${agentReferences.openapi}
Examples: Python ${agentReferences.python}; JavaScript ${agentReferences.javascript}; Go ${agentReferences.go}; curl ${agentReferences.curl}
Local configuration template: ${agentReferences.configuration}
Capability declaration example: ${agentReferences.capabilities}
Read the deployed schemas at ${origin}/api/agent/schemas/agent.json and ${origin}/api/agent/schemas/report.json. If GitHub differs from this server, follow the deployed schema and this prompt.`;
  const host = production ? `
Host discovery is automatic from POST /performance with the same report session; no host setup, machine ID, type selection or second credential is required. Read ${origin}/api/agent/schemas/performance.json. Send host_name from the OS plus records containing measured host and/or process metrics. Same names are grouped. Omit missing values, report actual effective capacity when known, and use RFC3339 observed_at. Retrying must reuse IDs and data. Charts show only the latest continuous reporting run, and performance samples are kept for three days.
` : "";

  return `Integrate the existing trading program with QuantBot using the program's existing HTTP client and lifecycle.
${target}Read quantbot.json from the strategy's local working directory at startup. Use the file for the endpoint and credentials. Do not read them from environment variables. Add quantbot.json to .gitignore and keep the file private. ${credential} Never put secrets in code, logs, or Git.

${configuration}

Use secret as the Bearer Token for POST /session; key is a credential identifier, not an authentication header. Map instance_name to a stable API instanceId; choose a different name for each concurrently running instance. If strategy_id is set, verify it against the session response before sending data. An endpoint containing only the origin gets /api/agent appended. Preserve a full Agent or Sandbox endpoint and append relative routes (such as /session). For a remote strategy, use the reachable HTTPS origin.
The default heartbeat_seconds is 15. disconnect_policy "continue" keeps the local strategy, risk checks and exits on their existing schedule while QuantBot is disconnected. Do not accept remote commands during a disconnect or replay outcomes already executed.

${references}

Start with reporting: POST /session using the Agent Token, instance_name and a new bootId per process start. Use the returned session Bearer for other calls. PUT /heartbeat at heartbeat_seconds even when no trade or report occurs; the offline threshold is 45 seconds. Use renewAt from the response (normally ten minutes before the one-hour expiry), serialize renewal with the original Token and the same instanceId and bootId, then atomically switch to the new session. Retry transient failures and 429/5xx with capped exponential backoff and jitter. Refresh once on session_expired or use a session already renewed by another worker. Stop retrying a revoked or expired Agent Token or an archived strategy, and surface insufficient_scope.

${reports} through POST /reports and POST /events with stable IDs and unchanged payloads on retry. Use UTC Unix milliseconds for standard and declared observation times. ${initial} ${executor}, it can register real capabilities with PUT /capabilities and send PUT /state. Declare inputs, risk, rendering and history from real program behavior. Use PUT /resources/{type} for full snapshots or explicit patches, with the required resourceRevision and Idempotency-Key. Supply associations only when the source actually contains them.
${host}
Only the designated Executor may GET /commands and POST /commands/{id}/claim. Persist the claim Idempotency-Key before requesting a permit. On a lost response retry with the same key; reconcile without executing on claim_reconciliation_required. Check the one-time permit, deadline and local risk rules before invoking strategy or broker operations. Record execution in a durable command journal and POST /commands/{id}/result with the real outcome; retry the same receipt exactly. Report actual state separately. Never re-execute an unknown outcome or enable live trading for an integration test. Only declare atomic_parameters when the program can apply the entire plan atomically.

${verification} Keep trading, heartbeats and performance reporting independent.`;
}
