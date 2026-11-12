/** The page's API. Every call sends the session cookie set by the login link. */
import { tr, type Language } from "@/lib/i18n";

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
    throw new ApiError(0, tr("连不上 QuantBot。网络或隧道断了，或者 QuantBot 没在运行。"));
  }
  const payload: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const fields = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const detail = [fields.message, fields.error].find((value) => typeof value === "string" && value.trim());
    const recovery = res.status === 401 ? tr("登录已过期，请重新登录。")
      : [502, 503, 504].includes(res.status) ? tr("QuantBot 暂时不可用，请检查服务或隧道后重试。")
      : res.status >= 500 ? tr("后台处理失败，请在设置中查看服务日志。")
      : res.status === 403 ? tr("请求被拒绝，请刷新页面后重试。")
      : tr("请求失败（HTTP {0}）。", res.status);
    throw new ApiError(res.status, typeof detail === "string" ? `${recovery} ${detail}` : recovery);
  }
  if (payload === undefined) throw new ApiError(res.status, tr("QuantBot 返回了无法读取的响应，请刷新页面后重试。"));
  return payload as T;
}

export interface StrategyAction {
  id: string;
  label: string;
  confirm: boolean;
  fields: Record<string, { label: string; type: "text" | "number" | "boolean" | "select"; required: boolean; options: string[] }>;
}

export interface StrategyMetric {
  id: string;
  label: string;
  unit: string;
  value: number;
}

export interface StrategyView {
  id: string;
  name: string;
  online: boolean;
  stopped: boolean;
  connected: boolean;
  paused: boolean | null;
  status: string | null;
  status_age: number | null;
  last_seen: number | null;
  commands: string[];
  actions?: StrategyAction[];
  metrics?: StrategyMetric[];
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
  language: Language;
}

export interface UpdateResult {
  available: boolean;
  latest?: string | null;
  checked_at: string;
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

export type FileAction = "file" | "folder" | "move" | "copy" | "delete";

export interface GitHubStatus {
  configured: boolean;
  available: boolean;
  account: string;
}

export interface LocalGitStatus {
  repository: boolean;
  branch: string;
  remote: boolean;
  repo?: string;
  ahead?: number;
  behind?: number;
  files: { path: string; status: string }[];
}

export type GitAction = "init" | "stage" | "unstage" | "check" | "pull" | "push" | "switch";

export interface WorkspaceProgramStatus {
  command: string;
  running: boolean;
  exit_code: number | null;
  logs: string;
  log_error?: string;
  strategy_id: string;
}

export type Quickstart = { needs_setup: true } | { id: string; project: string; file: string };

export interface WorkspaceProject {
  id: string;
  path: string;
  name: string;
  managed: boolean;
  default: boolean;
}

type WorkspaceDirectories = { supported: false }
  | { supported: true; base: string; folders: string[]; selectable: boolean; can_create: boolean };

export interface GitHubAuthorization {
  url: string;
  code: string;
  state: string;
}

export interface GitHubRepository {
  name: string;
  private: boolean;
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
export type Operation = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  state: "CREATED" | "ACCEPTED" | "EXECUTING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  updated: number;
  result: { message?: string } | null;
};
export type Command =
  | "status" | "pause" | "resume" | "positions" | "orders" | "cancel"
  | "flatten" | "params" | "set_param" | "manual_order" | "chart" | "stop";

export const api = {
  overview: () => request<{ strategies: StrategyView[]; feed: Notice[]; editor_enabled: boolean; workspace_managed: boolean }>("GET", "overview"),
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
  timezones: () => request<string[]>("GET", "timezones"),
  updateStatus: () => request<UpdateStatus>("GET", "update"),
  updateImpact: () => request<{ programs: { name: string; impact: "demo" | "independent" | "stops" | "unknown" }[] }>("GET", "update/impact"),
  checkUpdate: () => request<Answer<UpdateResult | null>>("POST", "update/check"),
  installUpdate: () => request<Answer>("POST", "update"),
  service: (kind: "status" | "logs") =>
    answerData<ServiceDiagnostics>("GET", `service/${kind}`),
  restartService: () => request<Answer>("POST", "service/restart"),
  githubStatus: () => answerData<GitHubStatus>("GET", "editor/github"),
  workspaceProjects: () => answerData<{ projects: WorkspaceProject[] }>("GET", "workspaces"),
  removeWorkspace: (id: string) =>
    answerData<{ projects: WorkspaceProject[] }>("POST", `workspaces/${encodeURIComponent(id)}/remove`),
  workspaceDirectories: (path: string) =>
    answerData<WorkspaceDirectories>("GET", `workspace/directories?${new URLSearchParams({ path })}`),
  createWorkspaceFolder: (path: string, name: string) =>
    answerData<{ path: string }>("POST", "workspace/folder", { path, name }),
  initializeWorkspace: (path: string) =>
    answerData<{ path: string; id: string }>("POST", "workspace/init", { path }),
  quickstart: (project?: string) =>
    answerData<Quickstart>("POST", project ? `quickstart?workspace=${encodeURIComponent(project)}` : "quickstart"),
  githubBind: () => answerData<GitHubAuthorization>("POST", "editor/github/bind"),
  githubAuthorize: (state: string) =>
    answerData<{ ready: boolean }>("POST", "editor/github/authorize", { state }),
  githubCancel: (state: string) => answerData<null>("POST", "editor/github/cancel", { state }),
  githubLogout: () => answerData<null>("POST", "editor/github/logout"),
  githubRepositories: () =>
    answerData<{ repositories: GitHubRepository[] }>("POST", "editor/github/repositories"),
  saveSettings: (body: Partial<Record<keyof Settings | "token" | "remove_telegram", unknown>>) =>
    request<Answer>("POST", "settings", body),
  strategyMetric: (sid: string, name: string) =>
    answerData<StrategyMetric & { points: { time: number; value: number }[] }>(
      "GET", `strategies/${encodeURIComponent(sid)}/metrics?${new URLSearchParams({ name })}`,
    ),
  strategyAction: (sid: string, action: string, args: Record<string, unknown>, ticket?: string) =>
    request<Answer>("POST", `strategies/${encodeURIComponent(sid)}/actions/${encodeURIComponent(action)}`,
      { args, ticket }),
  prepareAction: (sid: string, action: string, args: Record<string, unknown>) =>
    answerData<{ ticket: string }>("POST", `strategies/${encodeURIComponent(sid)}/actions/${encodeURIComponent(action)}`,
      { args, prepare: true }),
  prepareCommand: (sid: string, name: Command, args: Record<string, unknown> = {}) =>
    answerData<{ ticket: string }>("POST", `strategies/${encodeURIComponent(sid)}/${name}`, { ...args, prepare: true }),
  command: <T = unknown>(sid: string, name: Command, args: Record<string, unknown> = {}, ticket?: string) =>
    request<Answer<T>>("POST", `strategies/${encodeURIComponent(sid)}/${name}`, { ...args, ticket }),
  operations: (sid: string) =>
    request<{ operations: Operation[] }>("GET", `strategies/${encodeURIComponent(sid)}/operations`),
  reconcile: (sid: string, id: string, ok: boolean, note: string) =>
    answerData<null>("POST", `strategies/${encodeURIComponent(sid)}/operations/${encodeURIComponent(id)}`, { ok, note }),
};


export function workspaceApi(project: string) {
  const data = <T,>(method: string, path: string, body?: unknown) => {
    const scope = new URLSearchParams({ workspace: project });
    return answerData<T>(method, `${path}${path.includes("?") ? "&" : "?"}${scope}`, body);
  };
  return {
    editorTree: (path: string) =>
      data<{ entries: DirectoryEntry[] }>("GET", `editor/tree?${new URLSearchParams({ path })}`),
    editorFile: (path: string) =>
      data<SourceFile>("GET", `editor/file?${new URLSearchParams({ path })}`),
    saveEditorFile: (file: SourceFile & { path: string }) =>
      data<SourceFile>("POST", "editor/file", file),
    changeEditorPath: (action: FileAction, path: string, destination?: string) =>
      data<{ path: string }>("POST", `editor/files/${action}`, { path, destination }),
    searchWorkspace: (q: string, content: boolean, ignored: boolean) =>
      data<{ path: string; line?: number; text?: string }[]>(
        "GET", `editor/search?${new URLSearchParams({ q, mode: content ? "content" : "name", ignored: String(ignored) })}`,
      ),
    gitStatus: () => data<LocalGitStatus>("GET", "editor/git"),
    gitCommit: (paths: string[], message: string) =>
      data<{ revision: string }>("POST", "editor/git/commit", { paths, message }),
    workspaceProgram: () => data<WorkspaceProgramStatus>("GET", "workspace/program"),
    changeWorkspaceProgram: (action: "configure" | "start" | "stop", command?: string) =>
      data<WorkspaceProgramStatus>("POST", `workspace/program/${action}`, command === undefined ? undefined : { command }),
    bindWorkspaceStrategy: (action: "bind" | "rotate" | "unbind", id?: string) =>
      data<WorkspaceProgramStatus>("POST", `workspace/program/${action}`, { id }),
    githubSelect: (repo: string, folder?: string) =>
      data<LocalGitStatus & { project: string }>("POST", "editor/github/select", { repo, folder }),
    gitBranches: () => data<{ current: string; branches: string[] }>("GET", "editor/git/branches"),
    gitDiff: (path: string, staged: boolean) =>
      data<{ before: string; after: string }>(
        "GET", `editor/git/diff?${new URLSearchParams({ path, staged: String(staged) })}`,
      ),
    gitAction: (action: GitAction, body?: { paths?: string[]; branch?: string }) =>
      data<LocalGitStatus>("POST", `editor/git/${action}`, body),
  };
}
