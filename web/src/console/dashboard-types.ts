import { t, type Message } from "../i18n";
export type Component = "status" | "status_history" | "accounts" | "positions" | "position_mix" |
  "orders" | "order_status" | "fills" | "fill_count" | "equity" | "drawdown" | "returns" |
  "performance" | "metric_cards" | "metrics" | "candles" | "volume" | "signals" | "risk" |
  "logs" | "connections" | "alerts";
export type Chart = "table" | "cards" | "line" | "area" | "bar" | "scatter" | "pie" | "candlestick" | "timeline";
export type Availability = "ready" | "insufficient" | "stale" | "incompatible";

export interface Series {
  strategy_id: string;
  instance_id: string;
  name: string;
  account_id: string;
  unit: string;
}
export interface SeriesSource extends Series {
  label: string;
  last: string;
  samples: number;
  kind: "gauge" | "counter" | "ratio";
  description: string;
}
export interface CandleSource {
  strategy_id: string;
  instance_id: string;
  symbol: string;
  interval_seconds: number;
}
export interface CandleCatalog extends CandleSource {
  last: string;
  samples: number;
}
export interface Candidate {
  id: Component;
  label: string;
  type: string;
  charts: Chart[];
  recommended_chart: Chart;
  state: Availability;
  last_observed_at: string;
  sources: Array<SeriesSource | CandleCatalog>;
}
export interface ChartCatalog {
  components: Candidate[];
  schema_failures: Array<{ type: string; active: number; count: number; observed_at: string }>;
}
export type Breakpoint = "desktop" | "mobile";
export interface GridPosition { x: number; y: number; w: number; h: number }
interface WorkbenchWidget {
  id: string;
  title: string;
  placement?: Partial<Record<Breakpoint, GridPosition | null>> | null;
}
export interface ControlWidget extends WorkbenchWidget {
  kind: "entry" | "program" | "control" | "capability";
  ref?: string;
}
export type BoardWidget = Widget | ControlWidget;
export interface Widget extends WorkbenchWidget {
  component: Component;
  chart: Chart;
  width: 1 | 2;
  height: number;
  hours: 1 | 6 | 24 | 168 | 720 | 2160 | 8760;
  bucket_seconds: 0 | 60 | 300 | 3600 | 86400 | 604800;
  aggregation: "last" | "mean" | "min" | "max" | "sum";
  sources: Series[];
  candle: CandleSource | null;
  markers: boolean;
  start_at: string | null;
  end_at: string | null;
}
export interface Dashboard {
  revision: number;
  widgets: BoardWidget[];
}
export interface Point { observed_at: string; value: string }
export interface SeriesHistory { source: Series; points: Point[] }
export interface Candle {
  observed_at: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
export interface Marker {
  id: string;
  occurred_at: string;
  kind: "order" | "fill" | "signal" | "risk";
  side?: "buy" | "sell" | null;
  price?: string | null;
  message: string;
}
export interface Market { candles: Candle[]; markers: Marker[] }
export const chartName: Record<Chart, Message> = {
  table: "dashboardTypes.table", cards: "dashboardTypes.cards", line: "dashboardTypes.line", area: "dashboardTypes.area", bar: "dashboardTypes.bar", scatter: "dashboardTypes.scatter",
  pie: "dashboardTypes.pie", candlestick: "dashboardTypes.candlestick", timeline: "dashboardTypes.timeline",
};
export const availabilityLabel: Record<Availability, Message> = {
  ready: "dashboardTypes.available", insufficient: "dashboardTypes.insufficientData", stale: "dashboardTypes.reportingStopped", incompatible: "dashboardTypes.incompatibleProtocol",
};
export const timeOptions: [Widget["hours"], Message][] = [
  [1, "dashboardTypes.lastHour"], [6, "dashboardTypes.last6Hours"], [24, "dashboardTypes.last24Hours"], [168, "dashboardTypes.last7Days"],
  [720, "dashboardTypes.last30Days"], [2160, "dashboardTypes.last90Days"], [8760, "dashboardTypes.lastYear"],
];
export const bucketOptions: [Widget["bucket_seconds"], Message][] = [
  [0, "dashboardTypes.rawObservations"], [60, "dashboardTypes.1Minute"], [300, "dashboardTypes.5Minutes"], [3600, "dashboardTypes.1Hour"], [86400, "dashboardTypes.1Day"], [604800, "dashboardTypes.7Days"],
];
export const marketComponent = (component: Component) => component === "candles" || component === "volume";
export const seriesComponent = (component: Component) => ["equity", "drawdown", "returns", "metrics", "metric_cards"].includes(component);
export const candleSource = (item: SeriesSource | CandleCatalog): item is CandleCatalog => "symbol" in item;
export const metricSource = (item: SeriesSource | CandleCatalog): item is SeriesSource => "name" in item;
export const seriesKey = (item: Series) => JSON.stringify([item.strategy_id, item.instance_id, item.name, item.account_id, item.unit]);
export const candleKey = (item: CandleSource) => JSON.stringify([item.strategy_id, item.instance_id, item.symbol, item.interval_seconds]);
export function seriesSelection({ strategy_id, instance_id, name, account_id, unit }: Series): Series {
  return { strategy_id, instance_id, name, account_id, unit };
}
export function candleSelection({ strategy_id, instance_id, symbol, interval_seconds }: CandleSource): CandleSource {
  return { strategy_id, instance_id, symbol, interval_seconds };
}
export function timeRange(widget: Widget) {
  const now = Date.now();
  return {
    start: widget.start_at ?? new Date(now - widget.hours * 3_600_000).toISOString(),
    end: widget.end_at ?? new Date(now).toISOString(),
  };
}

const componentNames: Record<Component, Message> = {
  status: "components.status",
  status_history: "components.status_history",
  accounts: "components.accounts",
  positions: "components.positions",
  position_mix: "components.position_mix",
  orders: "components.orders",
  order_status: "components.order_status",
  fills: "components.fills",
  fill_count: "components.fill_count",
  equity: "components.equity",
  drawdown: "components.drawdown",
  returns: "components.returns",
  performance: "components.performance",
  metric_cards: "components.metric_cards",
  metrics: "components.metrics",
  candles: "components.candles",
  volume: "components.volume",
  signals: "components.signals",
  risk: "components.risk",
  logs: "components.logs",
  connections: "components.connections",
  alerts: "components.alerts",
};

export function componentName(component: Component) {
  return t(componentNames[component]);
}
