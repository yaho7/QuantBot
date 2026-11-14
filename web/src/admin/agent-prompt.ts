export function agentPrompt(origin: string) {
  return `Integrate this trading program with QuantBot. Use ${origin}/api/agent and read the Agent credential from QB_AGENT_TOKEN. Read ${origin}/api/agent/schemas/agent.json and ${origin}/api/agent/schemas/report.json. Use the existing HTTP client and strategy lifecycle.

POST /api/agent/session with a stable instanceId and a new bootId per process. Use the session Bearer for subsequent requests and PUT /api/agent/heartbeat every 15 seconds. Only the designated executor can use PUT /api/agent/capabilities on startup and definition changes. Declare real metrics, states, parameters, actions, resources and events. Treat presentation as a suggestion and use group health for health states.

Use PUT /api/agent/state, POST /api/agent/reports, POST /api/agent/events and PUT /api/agent/resources/{type} as appropriate. Use UTC Unix milliseconds, stable record IDs and unchanged contents on retry. Report only explicit association IDs.

Only a designated executor may GET /api/agent/commands and POST /api/agent/commands/{id}/claim. Require the one-time permit, an unexpired deadline and local safety checks before execution. Durably record the command ID, grant and real outcome. POST the outcome to /api/agent/commands/{id}/result and retry the saved receipt unchanged. Report actual state separately. Keep risk checks and exits active. Declare atomic_parameters only when the whole plan can be applied atomically. Verify with a dedicated paper strategy and simulated operations.`;
}
