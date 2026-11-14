import { queryOptions, QueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
let csrf = "";
export function setCSRF(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET") headers.set("X-CSRF-Token", csrf);
  if (key) headers.set("Idempotency-Key", key);
  const result = await fetch("/api/v1" + path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!result.ok) {
    const error = await result.json().catch(() => ({}));
    throw new ApiError(
      result.status,
      error.code ?? "request_failed",
      error.message ?? String(result.status),
    );
  }
  return result.status === 204 ? (undefined as T) : result.json();
}
export const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) =>
        count < 2 && !(error instanceof ApiError && error.status < 500),
      refetchOnWindowFocus: true,
    },
  },
});
export function resource<T>(path: string) {
  return queryOptions({ queryKey: [path], queryFn: () => api<T>(path) });
}
export type Session = {
  userId: number;
  username: string;
  csrf: string;
  expiresAt: number;
};
export type Strategy = {
  id: string;
  name: string;
  group: string;
  mode: "live" | "paper";
  online: boolean;
  createdAt: number;
  archivedAt: number | null;
  lastSeen: number;
  executorInstance?: string;
  instances?: {
    instanceId: string;
    bootId: string;
    startedAt: number;
    lastSeen: number;
    online: boolean;
  }[];
};
export type Datum = {
  id: string;
  kind: string;
  observedAt: number;
  instanceId: string;
  strategyId: string;
  data: Record<string, unknown>;
};
export type Command = {
  id: string;
  strategyId: string;
  controlId: string;
  revision: number;
  input: unknown;
  status: string;
  deadline: number;
  createdAt: number;
  updatedAt: number;
  receipt?: { status: string; message?: string };
  transitions?: { status: string; actor: string; reason: string; at: number }[];
};
export type Definition = {
  id: string;
  kind: string;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  readOnly: boolean;
  disabled: boolean;
  min?: string;
  max?: string;
  step?: string;
  options?: { value: string; label: string }[];
  fields?: Definition[];
  size?: string;
  risk?: string;
  confirm: boolean;
  maxLength?: number;
  timeoutSeconds?: number;
  resultLabels?: Record<string, string>;
};
export type Control = Definition & {
  actual: {
    value: unknown;
    available: boolean;
    reason?: string;
    observedAt: number;
  } | null;
  desired: {
    commandId: string;
    status: string;
    value: unknown;
    updatedAt: number;
  } | null;
};
export type Registry = {
  revision: number;
  current: boolean;
  controls: Control[];
};
export type Point = {
  at: number;
  count: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
};
export type Series = {
  kind: string;
  series: string;
  instanceId: string;
  observedAt: number;
};
export type Diagnostics = {
  version: string;
  uptimeSeconds: number;
  onlineAgents: number;
  samples: number;
  queueDepth: number;
  peakRssBytes: number;
  heapBytes: number;
  cpuSeconds: number;
  goroutines: number;
  writeFailures: number;
  sseSubscribers: number;
  walBytes: Record<string, number>;
};
export const activeStates = [
  "created",
  "confirmation_required",
  "pending",
  "accepted",
  "executing",
  "unknown",
];
