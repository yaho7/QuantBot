import { client, resource, type Datum, type Point, type Registry, type Series } from "../shared/api";

export type ThemeStrategyData = {
  strategyId: string;
  observedAt?: number;
  equity?: { value: string; currency: string };
  dailyPnl?: string;
  points: Point[];
  controls: { id: string; title: string; risk: string; value?: unknown }[];
};

// A deliberately narrow, read-only projection. No tokens, sessions, command
// permits, arbitrary API paths or administrator data enter the theme iframe.
export async function readThemeStrategy(strategyId: string, hours: number): Promise<ThemeStrategyData> {
  const base = "/strategies/" + encodeURIComponent(strategyId);
  const [records, registry, catalog] = await Promise.all([
    client.fetchQuery(resource<Datum[]>(base + "/telemetry")),
    client.fetchQuery(resource<Registry>(base + "/controls")),
    client.fetchQuery(resource<{ series: Series[] }>(base + "/series")),
  ]);
  const latest = [...records].sort((a, b) => b.observedAt - a.observedAt);
  const equity = latest.find(row => row.kind === "equity");
  const pnl = latest.find(row => row.kind === "performance" && row.data.accountId === equity?.data.accountId && row.data.currency === equity?.data.currency);
  const series = catalog.series.find(row => row.kind === "equity" && row.instanceId === equity?.instanceId && row.series === JSON.stringify([equity.data.accountId, equity.data.currency]));
  let points: Point[] = [];
  if (series) {
    const to = Math.ceil(series.observedAt / 60_000) * 60_000 + 1;
    const query = new URLSearchParams({ kind: "equity", series: series.series, instanceId: series.instanceId, from: String(to - hours * 3_600_000), to: String(to), points: "500" });
    points = (await client.fetchQuery(resource<{ points: Point[] }>(base + "/history?" + query))).points.slice(-500);
  }
  return {
    strategyId,
    observedAt: equity?.observedAt,
    equity: typeof equity?.data.value === "string" ? { value: equity.data.value, currency: String(equity.data.currency ?? "") } : undefined,
    dailyPnl: typeof pnl?.data.dailyPnl === "string" ? pnl.data.dailyPnl : undefined,
    points,
    controls: registry.controls.filter(control => !control.readOnly).map(control => ({ id: control.id, title: control.title, risk: control.risk ?? "low", value: control.actual?.value })),
  };
}
