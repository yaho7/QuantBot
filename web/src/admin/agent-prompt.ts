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
} as const;

type StrategyContext = { id: string; name: string; mode: "paper" | "live" };

export function agentPrompt(origin: string, endpoint = origin + "/api/agent", strategy?: StrategyContext) {
  const production = endpoint === origin + "/api/agent";
  const credential = production ? "Read QB_AGENT_TOKEN from the local environment or secret store; the administrator copies the Token separately." : "Read the temporary Sandbox token from QB_AGENT_TOKEN.";
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
Capability declaration example: ${agentReferences.capabilities}
Read the deployed schemas at ${origin}/api/agent/schemas/agent.json and ${origin}/api/agent/schemas/report.json. If GitHub differs from this server, follow the deployed schema and this prompt.`;
  const host = production ? `
Host discovery is automatic from POST /performance with the same report session; no host setup, machine ID, type selection or second credential is required. Read ${origin}/api/agent/schemas/performance.json. Send host_name from the OS plus records containing measured host and/or process metrics. Same names are grouped. Omit missing values, report actual effective capacity when known, and use RFC3339 observed_at. Retrying must reuse IDs and data. Charts show only the latest continuous reporting run, and performance samples are kept for three days.
` : "";

  return `Integrate the existing trading program with QuantBot using the program's existing HTTP client and lifecycle.
${target}Agent base URL (QB_AGENT_URL): ${endpoint}
Append relative routes to that base (for example, /session). If running on a VPS, replace any localhost/loopback URL with the HTTPS address this strategy can actually reach. ${credential} Keep it out of code, logs, and Git.

${references}

Start with reporting: POST /session using the Agent Token, a stable instanceId unique among concurrently running instances, and a new bootId per process start. Use the returned session Bearer for other calls. PUT /heartbeat every 15 seconds even when no trade or report occurs; the offline threshold is 45 seconds. Use renewAt from the response (normally ten minutes before the one-hour expiry), serialize renewal with the original Token and the same instanceId and bootId, then atomically switch to the new session. Retry transient failures and 429/5xx with capped exponential backoff and jitter. Refresh once on session_expired or use a session already renewed by another worker. Stop retrying a revoked or expired Agent Token or an archived strategy, and surface insufficient_scope.

${reports} through POST /reports and POST /events with stable IDs and unchanged payloads on retry. Use UTC Unix milliseconds for standard and declared observation times. ${initial} ${executor}, it can register real capabilities with PUT /capabilities and send PUT /state. Declare inputs, risk, rendering and history from real program behavior. Use PUT /resources/{type} for full snapshots or explicit patches, with the required resourceRevision and Idempotency-Key. Supply associations only when the source actually contains them.
${host}
Only the designated Executor may GET /commands and POST /commands/{id}/claim. Persist the claim Idempotency-Key before requesting a permit. On a lost response retry with the same key; reconcile without executing on claim_reconciliation_required. Check the one-time permit, deadline and local risk rules before invoking strategy or broker operations. Record execution in a durable command journal and POST /commands/{id}/result with the real outcome; retry the same receipt exactly. Report actual state separately. Never re-execute an unknown outcome or enable live trading for an integration test. Only declare atomic_parameters when the program can apply the entire plan atomically.

${verification} Keep trading, heartbeats and performance reporting independent.`;
}
