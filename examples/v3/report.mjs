// Report the status of a test strategy with the built-in Node.js HTTP client.
import { randomUUID } from "node:crypto";

const endpoint = process.env.QB_AGENT_URL?.replace(/\/$/, "");
const token = process.env.QB_TOKEN;
if (!endpoint || !token) throw new Error("Set QB_AGENT_URL and QB_TOKEN");
const instanceId = process.env.QB_INSTANCE_ID ?? "node-example";

async function call(method, route, bearer, body) {
  const headers = { Authorization: `Bearer ${bearer}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(endpoint + route, {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`QuantBot returned HTTP ${response.status}`);
  return response.json();
}

const bootId = randomUUID();
const { session } = await call("POST", "/session", token, { instanceId, bootId });
await call("PUT", "/heartbeat", session);
console.log(JSON.stringify(await call("POST", "/reports", session, {
  version: 1,
  records: [{
    id: `${bootId}-status`,
    kind: "status",
    observedAt: Date.now(),
    data: { state: "running" },
  }],
})));
