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
export const chartName: Record<Chart, string> = {
  table: "表格", cards: "数据卡片", line: "折线", area: "面积", bar: "柱状", scatter: "散点",
  pie: "饼图", candlestick: "K 线", timeline: "时间轴",
};
export const availabilityLabel: Record<Availability, string> = {
  ready: "可用", insufficient: "数据不足", stale: "停止上报", incompatible: "协议不兼容",
};
export const timeOptions: [Widget["hours"], string][] = [
  [1, "最近 1 小时"], [6, "最近 6 小时"], [24, "最近 24 小时"], [168, "最近 7 天"],
  [720, "最近 30 天"], [2160, "最近 90 天"], [8760, "最近 1 年"],
];
export const bucketOptions: [Widget["bucket_seconds"], string][] = [
  [0, "原始观测"], [60, "1 分钟"], [300, "5 分钟"], [3600, "1 小时"], [86400, "1 天"], [604800, "7 天"],
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
