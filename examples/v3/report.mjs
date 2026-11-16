// Exercise the declarative Agent API against a dedicated paper strategy.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

async function loadConfig() {
  let config;
  try {
    config = JSON.parse(await readFile("quantbot.json", "utf8"));
  } catch {
    throw new Error("Create a valid local quantbot.json using quantbot.example.json");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("quantbot.json must contain a JSON object");
  let endpoint;
  try {
    if (typeof config.endpoint !== "string" || /[\s?#\\]/.test(config.endpoint) || !/^https?:\/\/[^/@]+(?:\/|$)/.test(config.endpoint)) throw new Error();
    const url = new URL(config.endpoint);
    const path = url.pathname.replace(/\/+$/, "") || "/api/agent";
    if (url.username || url.password || !/^\/api\/agent(?:\/sandbox\/[A-Za-z0-9_-]+)?$/.test(path)) throw new Error();
    endpoint = url.origin + path;
  } catch {
    throw new Error("Set endpoint to a QuantBot HTTP or HTTPS URL in quantbot.json");
  }
  const { secret, instance_name: instance, strategy_id: strategy, heartbeat_seconds: heartbeat = 15 } = config;
  if (typeof secret !== "string" || !/^qbt_[A-Za-z0-9_-]+$/.test(secret)) throw new Error("Paste the Agent Token into secret in quantbot.json");
  if (typeof instance !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(instance)) throw new Error("Set a stable instance_name in quantbot.json");
  if (!Number.isInteger(heartbeat) || heartbeat < 1 || heartbeat > 15) throw new Error("heartbeat_seconds must be an integer from 1 to 15");
  if (config.disconnect_policy !== undefined && config.disconnect_policy !== "continue") throw new Error("The demo supports only disconnect_policy 'continue'");
  if (strategy !== undefined && typeof strategy !== "string") throw new Error("strategy_id must be a string");
  return { endpoint, secret, instance, strategy, heartbeat };
}

const { endpoint, secret, instance, strategy, heartbeat: heartbeatSeconds } = await loadConfig();
const boot = randomUUID();
const control = process.argv.includes("--demo-control");
const capabilities = JSON.parse(await readFile(new URL("./capabilities.json", import.meta.url)));

async function call(method, path, bearer, payload, key) {
  const headers = { Authorization: "Bearer " + bearer };
  if (key) headers["Idempotency-Key"] = key;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(endpoint + path, {
    method,
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const { code } = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`${method} ${path} returned ${response.status} ${code ?? ""}`), { status: response.status, code });
  }
  return response.json();
}

const identity = { instanceId: instance, bootId: boot };
async function connect() {
  const session = await call("POST", "/session", secret, identity);
  if (strategy && session.strategyId !== strategy) throw Object.assign(
    new Error("Session strategy does not match strategy_id in quantbot.json"), { status: 400 },
  );
  return session;
}
let session = await connect();

async function renew() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      session = await connect();
      console.log("session renewed");
      return;
    } catch (error) {
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
    await sleep(Math.min(2 ** attempt, 15) * 1000 + Math.random() * 1000);
  }
  throw new Error("Session renewal unavailable");
}

async function agent(method, path, payload, key) {
  if (session.renewAt !== null && Date.now() >= session.renewAt * 1000) await renew();
  try {
    return await call(method, path, session.session, payload, key);
  } catch (error) {
    if (error.code !== "session_expired") throw error;
    await renew();
    return call(method, path, session.session, payload, key);
  }
}

let heartbeat = await agent("PUT", "/heartbeat");
for (let attempt = 0; !heartbeat.executor && (attempt + 1) * heartbeatSeconds <= 120; attempt++) {
  await sleep(heartbeatSeconds * 1000);
  heartbeat = await agent("PUT", "/heartbeat");
}
if (!heartbeat.executor) throw new Error(`Assign ${instance} as the paper executor`);
if (control) {
  capabilities.push({
    id: "demo-refresh", kind: "action", title: "Refresh demo state",
    value_type: "null", writable: true, timeout_seconds: 30,
    presentation: { suggested: true, surface: ["strategy"] },
  });
}

const { revision } = await agent("PUT", "/capabilities", { revision: session.revision, capabilities });
function sendState(observedAt) {
  const states = [{ id: "broker", value: true, observedAt }];
  if (control) states.push({ id: "demo-refresh", value: null, observedAt });
  return agent("PUT", "/state", { revision, states });
}

const observedAt = Date.now();
console.log(await sendState(observedAt));
for (const [path, capabilityId, value] of [
  ["/reports", "poll-latency", "2.50"],
  ["/events", "sample-event", { message: "Paper demo started" }],
]) {
  const records = [{
    id: boot + "-" + capabilityId, capabilityId, observedAt, value,
    associations: { correlation_id: boot },
  }];
  console.log(await agent("POST", path, { revision, records }));
}

if (control) {
  let completed = false;
  let nextHeartbeat = Date.now() + heartbeatSeconds * 1000;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (Date.now() >= nextHeartbeat) {
      await agent("PUT", "/heartbeat");
      nextHeartbeat = Date.now() + heartbeatSeconds * 1000;
    }
    const offers = await agent("GET", "/commands?wait=2");
    const offer = offers.find((item) => item.controlId === "demo-refresh");
    if (!offer) {
      await sleep(500);
      continue;
    }
    const path = "/commands/" + encodeURIComponent(offer.id);
    const claimKey = "claim-" + offer.id;
    let grant;
    try {
      grant = await agent("POST", path + "/claim", undefined, claimKey);
    } catch (error) {
      if (error.status) throw error;
      grant = await agent("POST", path + "/claim", undefined, claimKey);
    }
    const now = Date.now();
    if (grant.command !== "demo-refresh" || !grant.permit || grant.deadline <= now) {
      throw new Error("Invalid or expired grant");
    }
    await sendState(now);
    const receipt = { permit: grant.permit, status: "succeeded", message: "Refreshed demo state" };
    await agent("POST", path + "/result", receipt);
    console.log((await agent("POST", path + "/result", receipt)).status);
    completed = true;
    break;
  }
  if (!completed) throw new Error("Queue the Refresh demo state command on the paper strategy");
}
