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
    throw new ApiError(0, "连不上 QuantBot。网络或隧道断了，或者 QuantBot 没在运行。");
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
  public_url: string;
  telegram: boolean;
  admin_username: string;
}

export interface UpdateResult {
  available: boolean;
  behind: number;
  checked_at: string;
  commits: { sha: string; message: string; date: string | null }[];
  error: string | null;
}

export interface UpdateStatus {
  version: string;
  result: UpdateResult | null;
  uv: boolean;
  service: boolean;
  updated: boolean;
}

export interface SourceFile {
  content: string;
  revision: string;
}

export interface GitHubStatus {
  bound: boolean;
  repo?: string;
  branch?: string;
  client_id?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  error?: string;
}

export interface GitHubAuthorization {
  url: string;
  code: string;
  state: string;
  interval: number;
}

export type StrategyConfigAction = "add" | "rename" | "remove" | "credentials" | "rotate";

export interface StrategyConfigResult {
  id: string;
  name: string;
  token?: string;
  url?: string;
}

export interface ServiceDiagnostics {
  installed: boolean;
  text: string;
}

interface DirectoryEntry {
  name: string;
  kind: "directory" | "file";
}

/** What a strategy answered. `ok: false` with a message is a normal answer, not an error. */
export interface Answer<T = unknown> {
  ok: boolean;
  message: string;
  data: T;
}

async function answerData<T>(method: string, path: string, body?: unknown): Promise<T> {
  const answer = await request<Answer<T>>(method, path, body);
  if (!answer.ok) throw new Error(answer.message);
  return answer.data;
}

export type OrderItem = { id: string; text: string };
export type Command =
  | "status" | "pause" | "resume" | "positions" | "orders" | "cancel"
  | "flatten" | "params" | "set_param" | "manual_order" | "chart" | "stop";

export const api = {
  overview: () => request<{ strategies: StrategyView[]; feed: Notice[]; editor_enabled: boolean }>("GET", "overview"),
  audit: () => request<{ records: AuditRecord[] }>("GET", "audit?limit=200"),
  login: (username: string, password: string) =>
    request<Answer>("POST", "login", { username, password }),
  logout: () => request<{ ok: boolean }>("POST", "logout"),
  changePassword: (body: { username: string; current: string; password: string; confirm: string }) =>
    request<Answer>("POST", "password", body),
  webLink: () => request<Answer<{ url: string }>>("POST", "web-link"),
  strategyConfig: (action: StrategyConfigAction, id: string, name?: string) =>
    request<Answer<StrategyConfigResult>>("POST", `strategy-config/${action}`, { id, name }),
  pauseAll: () => request<Answer>("POST", "pause-all"),
  prompt: (id: string, name: string) =>
    request<{ text: string }>("GET", `prompt?${new URLSearchParams({ id, name })}`),
  settings: () => request<Settings>("GET", "settings"),
  updateStatus: () => request<UpdateStatus>("GET", "update"),
  checkUpdate: () => request<Answer<UpdateResult | null>>("POST", "update/check"),
  installUpdate: () => request<Answer>("POST", "update"),
  service: (kind: "status" | "logs") =>
    answerData<ServiceDiagnostics>("GET", `service/${kind}`),
  restartService: () => request<Answer>("POST", "service/restart"),
  editorTree: (path: string) =>
    answerData<{ entries: DirectoryEntry[] }>("GET", `editor/tree?${new URLSearchParams({ path })}`),
  editorFile: (path: string) =>
    answerData<SourceFile>("GET", `editor/file?${new URLSearchParams({ path })}`),
  saveEditorFile: (file: SourceFile & { path: string }) =>
    answerData<SourceFile>("POST", "editor/file", file),
  githubStatus: () => answerData<GitHubStatus>("GET", "editor/github"),
  githubBind: (form: { repo: string; branch: string; client_id: string }) =>
    answerData<GitHubAuthorization>("POST", "editor/github/bind", form),
  githubAuthorize: (state: string) =>
    answerData<{ status?: GitHubStatus; interval?: number }>("POST", "editor/github/authorize", { state }),
  githubSync: (action: "check" | "pull" | "push" | "unbind") =>
    answerData<{ status: GitHubStatus }>("POST", `editor/github/${action}`),
  saveSettings: (body: Partial<Record<keyof Settings | "token" | "remove_telegram", unknown>>) =>
    request<Answer>("POST", "settings", body),
  command: <T = unknown>(sid: string, name: Command, args: Record<string, unknown> = {}) =>
    request<Answer<T>>("POST", `strategies/${encodeURIComponent(sid)}/${name}`, args),
};
