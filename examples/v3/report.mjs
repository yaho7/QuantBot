// Exercise the declarative Agent API against a dedicated paper strategy.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const { QB_AGENT_URL, QB_TOKEN, QB_INSTANCE_ID = "js-example", QB_DEMO_CONTROL } = process.env;
if (!QB_AGENT_URL || !QB_TOKEN) throw new Error("Set QB_AGENT_URL and QB_TOKEN");
const endpoint = QB_AGENT_URL.replace(/\/+$/, "");
const boot = randomUUID();
const control = QB_DEMO_CONTROL === "1";
const capabilities = JSON.parse(await readFile(new URL("./capabilities.json", import.meta.url)));

async function call(method, path, bearer, payload) {
  const headers = { Authorization: "Bearer " + bearer };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(endpoint + path, {
    method,
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  return response.json();
}

const { session: bearer, revision: current } = await call("POST", "/session", QB_TOKEN, {
  instanceId: QB_INSTANCE_ID, bootId: boot,
});
let heartbeat = await call("PUT", "/heartbeat", bearer);
for (let attempt = 0; !heartbeat.executor && attempt < 120; attempt++) {
  await sleep(1000);
  heartbeat = await call("PUT", "/heartbeat", bearer);
}
if (!heartbeat.executor) throw new Error(`Assign ${QB_INSTANCE_ID} as the paper executor`);
if (control) {
  capabilities.push({
    id: "demo-refresh", kind: "action", title: "Refresh demo state",
    value_type: "null", writable: true, timeout_seconds: 30,
    presentation: { suggested: true, surface: ["strategy"] },
  });
}

const { revision } = await call("PUT", "/capabilities", bearer, { revision: current, capabilities });
function sendState(observedAt) {
  const states = [{ id: "broker", value: true, observedAt }];
  if (control) states.push({ id: "demo-refresh", value: null, observedAt });
  return call("PUT", "/state", bearer, { revision, states });
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
  console.log(await call("POST", path, bearer, { revision, records }));
}

if (control) {
  let completed = false;
  for (let attempt = 0; attempt < 32; attempt++) {
    await call("PUT", "/heartbeat", bearer);
    const offers = await call("GET", "/commands?wait=2", bearer);
    const offer = offers.find((item) => item.controlId === "demo-refresh");
    if (!offer) {
      await sleep(500);
      continue;
    }
    const path = "/commands/" + encodeURIComponent(offer.id);
    const grant = await call("POST", path + "/claim", bearer);
    const now = Date.now();
    if (grant.command !== "demo-refresh" || !grant.permit || grant.deadline <= now) {
      throw new Error("Invalid or expired grant");
    }
    await sendState(now);
    const receipt = { permit: grant.permit, status: "succeeded", message: "Refreshed demo state" };
    await call("POST", path + "/result", bearer, receipt);
    console.log((await call("POST", path + "/result", bearer, receipt)).status);
    completed = true;
    break;
  }
  if (!completed) throw new Error("Queue the Refresh demo state command on the paper strategy");
}
