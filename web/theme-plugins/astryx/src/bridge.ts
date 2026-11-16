export type Context = { language: string; appearance: "light" | "dark"; palette: string };
const origin = new URL(location.href).origin;
const contexts = new Set<(context: Context) => void>();
let serial = 0;
const pending = new Map<string, { type: string; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();

window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== origin || event.data?.version !== 1) return;
  const message = event.data;
  if (message.type === "quantbot:ready" || message.type === "quantbot:context") {
    for (const listener of contexts) listener(message);
    return;
  }
  const request = pending.get(message.requestId);
  if (!request || request.type !== message.type) return;
  clearTimeout(request.timer);
  pending.delete(message.requestId);
  if (message.error) request.reject(new Error("Data unavailable"));
  else request.resolve(message.data ?? message.items);
});

export function send(type: string, payload: Record<string, unknown> = {}) {
  parent.postMessage({ version: 1, type, ...payload }, origin);
}
export function request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const requestId = "astryx-" + ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Data unavailable")); }, 8000);
    pending.set(requestId, { type, resolve: value => resolve(value as T), reject, timer });
    send(type, { ...payload, requestId });
  });
}
export function connect(listener: (context: Context) => void) {
  contexts.add(listener);
  send("quantbot:ready");
  return () => { contexts.delete(listener); };
}
