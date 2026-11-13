export type Mode = "live" | "paper" | "backtest";
export type Scope = "session" | "telemetry" | "control" | "commands";
export type Status = "online" | "offline" | "abnormal";
export type Severity = "debug" | "info" | "warning" | "error" | "critical";
export type Disconnect = "continue" | "block_entry";
export type Scalar = string | boolean | number | null;
export type AlertPolicy = { enabled: boolean; minimum: Severity; categories: string[] };

export interface StrategySettings {
  name: string;
  mode: Mode;
  description: string;
  group: string;
  tags: string[];
  disconnect_policy: Disconnect;
  retention_days: number;
  live_trading_enabled: boolean;
  alerts: AlertPolicy;
}
export interface Strategy extends StrategySettings {
  id: string;
  status: Status;
  executor_id: string | null;
  created_at: string;
  last_seen: string | null;
  archived_at: string | null;
}
export interface Account {
  account_id: string;
  currency: string;
  balance: string | null;
  cash: string | null;
  equity: string | null;
  buying_power: string | null;
  realized_pnl: string | null;
  unrealized_pnl: string | null;
  daily_pnl: string | null;
}
export interface Position {
  position_id: string;
  account_id: string;
  symbol: string;
  currency: string;
  quantity: string;
  cost: string | null;
  market_price: string | null;
  unrealized_pnl: string | null;
}
export interface Order {
  order_id: string;
  account_id: string;
  symbol: string;
  currency: string;
  quantity: string;
  filled_quantity: string | null;
  side: string;
  status: string;
  price: string | null;
  fee: string | null;
  fee_currency?: string | null;
}
export interface Fill {
  fill_id: string;
  order_id: string;
  account_id: string;
  symbol: string;
  currency: string;
  side: string;
  quantity: string;
  price: string;
  fee: string | null;
  fee_currency?: string | null;
  occurred_at: string;
}
export interface Runtime {
  health?: string;
  uptime_seconds?: number | null;
  broker_connected?: boolean | null;
  authorization_expires_at?: string | null;
}
export interface Snapshot {
  observed_at: string;
  section_observed_at?: Partial<Record<"status" | "portfolio" | "position" | "order" | "performance" | "fill" | "metric", string>>;
  runtime?: Runtime;
  accounts?: Account[];
  strategy_positions?: Position[];
  broker_positions?: Position[];
  open_orders?: Order[];
  completed_orders?: Order[];
  fills?: Fill[];
  performance?: Record<string, string | null>;
  metrics?: { name: string; label: string | null; value: string; unit: string | null }[];
  attributes?: Record<string, Scalar>;
}
export interface Instance {
  instance_id: string;
  online: boolean;
  last_seen: string;
  runtime: Runtime;
  token_id: string;
  declarations: {
    executor: boolean;
    version: string | null;
    language: string | null;
    framework: string | null;
    broker: string | null;
  };
}
export interface Control {
  desired: { revision: number; entry_enabled?: boolean; disconnect_policy: Disconnect; updated_at: string };
  reported: { revision: number; entry_enabled: boolean; risk_locked?: boolean; disconnect_policy_applied: Disconnect; updated_at: string } | null;
  reported_current: boolean;
  in_sync: boolean;
  effective_entry_enabled: boolean | null;
}
export interface Parameter {
  label: string;
  type: "string" | "integer" | "decimal" | "boolean" | "choice";
  required: boolean;
  default: Scalar;
  minimum: string | null;
  maximum: string | null;
  choices: string[];
}
export interface Capability {
  id: string;
  label: string;
  confirm: boolean;
  high_risk: boolean;
  parameters: Record<string, Parameter>;
}
export interface Detail extends Strategy {
  snapshot: Snapshot | null;
  snapshot_instance_id: string | null;
  control: Control;
  instances: Instance[];
  capabilities: Capability[];
  executor_online: boolean;
}
export interface TokenOptions {
  scopes: Scope[];
  expires_at: string | null;
}
export interface Token extends TokenOptions {
  id: string;
  strategy_id: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
export interface Credential extends Token { token: string }
export interface Alert {
  id: number;
  strategy_id: string | null;
  category: string;
  severity: Severity;
  message: string;
  created_at: string;
}
export interface EventRecord {
  id: string;
  strategy_id: string;
  instance_id?: string;
  category: string;
  severity: Severity;
  message: string;
  occurred_at: string;
  fill?: Fill | null;
}
export type CommandState = "confirmation_required" | "pending" | "accepted" | "executing" | "succeeded" | "failed" | "unknown" | "expired" | "superseded" | "cancelled";
export interface Command {
  id: string;
  strategy_id: string;
  actor: string;
  action: string;
  arguments: Record<string, Scalar>;
  state: CommandState;
  protected: number;
  risky: number;
  control_id: string | null;
  control_revision: number | null;
  revision: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  result: unknown;
  error: string | null;
}
export interface Overview {
  counts: Record<Status, number>;
  strategies: Strategy[];
  accounts: (Account & { observed_at: string; strategy_id: string })[];
  recent_fills: EventRecord[];
  alerts: Alert[];
  commands: Command[];
}
export interface TelegramSettings {
  enabled: boolean;
  admins: number[];
  notify: boolean;
  minimum: Severity;
  categories: string[];
  quiet_hours: { start: string; end: string } | null;
  timezone: string;
  min_interval_seconds: number;
  has_token: boolean;
  token_source: "environment" | "database" | null;
  connection_status: "disabled" | "error" | "connected";
}
export interface System {
  version: string;
  public_url: string | null;
  storage: string;
  schema_version: number;
  counts: Record<string, number>;
  telegram_status: string;
}
export interface DataType {
  type: string;
  schema_version: number;
  storage: string;
  schema: string;
  components: string[];
  timestamp: string;
}
export interface Catalog {
  components: Array<{ id: string; label: string; state: string }>;
  schema_failures: Array<{ type: string; observed_at: string; count: number; active: number }>;
}

export const MIN_PASSWORD_LENGTH = 8;
export const sessionKey = ["live", "session"] as const;

export async function readSession() {
  try { return await api<{ actor: string }>("session"); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, detail: string) { super(detail); }
}

export async function api<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
  const url = path.startsWith("/") ? path : `/api/admin/${path}`;
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(payload === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { detail?: string; errors?: { location: string[] }[] };
    const fields = error.errors?.map((item) => item.location.slice(1).join(".")).filter(Boolean);
    throw new ApiError(response.status, `${error.detail ?? `HTTP ${response.status}`}${fields?.length ? ` · ${fields.join(", ")}` : ""}`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export const strategyPath = (id: string, tab = "") => `#strategy/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
export const strategyApi = (id: string, suffix = "") => `strategies/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`;
