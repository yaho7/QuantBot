/** The page's API. Every call sends the session cookie set by the login link. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/ui/api/${path}`, {
      method,
      credentials: "same-origin",
      // QuantBot refuses POSTs without this header, which other sites cannot send.
      headers: method === "GET" ? undefined : { "X-QuantBot": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "连不上 QuantBot。隧道断了，或者 QuantBot 没在运行。");
  }
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "需要登录" : `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export interface StrategyView {
  id: string;
  name: string;
  online: boolean;
  connected: boolean;
  paused: boolean | null;
  status: string | null;
  status_age: number | null;
  last_seen: number | null;
  commands: string[];
  pending: number;
}

export interface Notice {
  time: string;
  strategy: string;
  text: string;
  kind: "info" | "trade" | "alert" | "error";
}

export interface AuditRecord {
  time: string;
  action: string;
  user?: string | number;
  strategy?: string;
  strategies?: string[];
  ok?: boolean;
  result?: string;
  args?: Record<string, unknown>;
}

export interface Settings {
  bot_username: string;
  owner_id: number | null;
  owner_name: string;
  quiet_hours: string;
  timezone: string;
  heartbeat_url: string;
  listen: string;
  telegram: boolean;
}

/** What a strategy answered. `ok: false` with a message is a normal answer, not an error. */
export interface Answer<T = unknown> {
  ok: boolean;
  message: string;
  data: T;
}

export type OrderItem = { id: string; text: string };
export type Command =
  | "status" | "pause" | "resume" | "positions" | "orders" | "cancel"
  | "flatten" | "params" | "set_param" | "manual_order" | "chart" | "stop";

export const api = {
  overview: () => request<{ strategies: StrategyView[]; feed: Notice[] }>("GET", "overview"),
  audit: () => request<{ records: AuditRecord[] }>("GET", "audit?limit=200"),
  logout: () => request<{ ok: boolean }>("POST", "logout"),
  pauseAll: () => request<Answer>("POST", "pause-all"),
  settings: () => request<Settings>("GET", "settings"),
  saveSettings: (body: Partial<Record<keyof Settings | "token" | "remove_telegram", unknown>>) =>
    request<Answer>("POST", "settings", body),
  command: <T = unknown>(sid: string, name: Command, args: Record<string, unknown> = {}) =>
    request<Answer<T>>("POST", `strategies/${encodeURIComponent(sid)}/${name}`, args),
};
