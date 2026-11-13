// One monitoring report. Run as a background task in the strategy's own process.
import { pathToFileURL } from "node:url";

const endpoint = process.env.QB_ENDPOINT?.trim() ?? "";
const secret = process.env.QB_TOKEN ?? "";
const instance = process.env.QB_INSTANCE_ID ?? "node-http-example";

export async function request(method, path, payload, session) {
  if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?\/api\/agent\/?$/i.test(endpoint)) {
    throw new Error("Set QB_ENDPOINT to the complete /api/agent URL");
  }
  const url = new URL(endpoint);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("HTTPS required outside loopback");
  }
  if (!/^[!-~]{1,128}$/.test(secret) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,55}$/.test(instance)) {
    throw new Error("Set QB_TOKEN and a valid stable instance name");
  }
  if (!/^\/(?:session|heartbeat|reports|control(?:\/reported)?|controls(?:\/state)?|monitor\/[A-Za-z0-9_.-]+|commands(?:\/[0-9a-f-]{36}\/(?:claim|result))?)$/.test(path)) {
    throw new Error("Set QB_ request path to a known Agent API resource");
  }
  let response;
  try {
    response = await fetch(endpoint.replace(/\/$/, "") + path, {
      method, redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${secret}`, "Content-Type": "application/json",
        Accept: "application/json", "User-Agent": "QuantBot-Integration/1.0",
        ...(session ? { "X-Agent-Session": session } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (error) {
    const code = error.cause?.code ?? "";
    throw new Error(error.name === "TimeoutError" ? "timeout" :
      /^(CERT_|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED)/.test(code) ? "tls" :
      ["ENOTFOUND", "EAI_AGAIN"].includes(code) ? "dns" : "network");
  }
  const type = response.headers.get("content-type")?.split(";")[0];
  const id = response.headers.get("x-quantbot-request-id");
  const ray = response.headers.get("cf-ray");
  // Read a bounded error prefix, then release the stream.
  const reader = response.body?.getReader();
  let body = "";
  if (reader) {
    const decoder = new TextDecoder();
    while (body.length < 16_384) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value.subarray(0, 16_384 - body.length), { stream: true });
    }
    await reader.cancel();
  }
  const originError = /^[a-f0-9]{32}$/.test(id ?? "") && type === "application/json";
  const status = response.status;
  const upstreamCode = response.headers.get("cf-error-code");
  let category = status >= 300 && status < 400 ? "redirect_rejected" :
    status === 429 ? "rate_limited" : status >= 500 ? "gateway_unavailable" :
    originError ? ({ 401: "authentication_failed", 403: "permission_denied", 409: "state_conflict",
      413: "batch_too_large", 422: "schema_mismatch" })[status] ?? "quantbot_error" :
    status === 403 && (upstreamCode === "1010" || /error(?:\s+code)?:?\s*1010\b/i.test(body)) ?
      "cloudflare_1010" : "upstream_http_error";
  if (response.ok) {
    try {
      const data = JSON.parse(body);
      const counts = [data.inserted, data.duplicates, data.ignored];
      if (type === "application/json" && data && typeof data === "object" && !Array.isArray(data)) {
        if (!path.startsWith("/monitor/") || (counts.every((value) => Number.isInteger(value) && value >= 0) &&
            counts.reduce((sum, value) => sum + value) === 1)) return data;
      }
    } catch { /* Report the safe diagnostic below. */ }
    category = "invalid_response";
  }
  const retryAfter = response.headers.get("retry-after");
  const retryDate = retryAfter && Date.parse(retryAfter);
  throw new Error(JSON.stringify({
    method, path, http: status, error_class: category,
    response_type: /^[a-z0-9.+/-]{1,64}$/.test(type ?? "") ? type : undefined,
    request_id: originError ? id : undefined,
    cf_ray: /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray ?? "") ? ray : undefined,
    retry_after: /^\d{1,9}$/.test(retryAfter ?? "") ? Number(retryAfter) :
      Number.isFinite(retryDate) ? Math.max(0, Math.ceil((retryDate - Date.now()) / 1000)) : undefined,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await request("POST", `/monitor/${instance}`, { records: [{
      type: "status", schema_version: 1, observed_at: new Date().toISOString(),
      runtime: { health: "healthy" },
    }] });
  } catch (error) {
    const message = error.message;
    console.error(/^(\{|Set QB_|HTTPS required|timeout$|tls$|dns$|network$)/.test(message)
      ? message : "QuantBot response could not be read");
    process.exitCode = 1;
  }
}
