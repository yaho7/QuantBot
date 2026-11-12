import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { api, strategyApi, type EventRecord, type Fill, type Runtime, type Snapshot } from "./api";

import { marketComponent, seriesComponent, seriesKey, timeRange, type Market, type Point, type SeriesHistory, type Widget } from "./dashboard-types";
import { Accounts, Fills, Orders, Performance, Positions } from "./telemetry-views";
import { Empty, ErrorNotice, Loading, Table, categoryText, money, severityText, when } from "./ui";

const MarketChart = lazy(() => import("./market-chart"));
const TimeSeries = lazy(() => import("./charts").then((module) => ({ default: module.TimeSeries })));
const Distribution = lazy(() => import("./charts").then((module) => ({ default: module.Distribution })));

type Connection = { observed_at: string; broker_connected: boolean; authorization_expires_at?: string | null; message?: string };
type StatusRecord = { observed_at: string; runtime: Runtime };
type FillCount = Point & { side: "buy" | "sell" };
type ComponentData = Snapshot | Array<EventRecord | StatusRecord | Connection | FillCount>;

export default function WidgetData({ widget, strategyId, names }: { widget: Widget; strategyId: string; names: Record<string, string> }) {
  return <Suspense fallback={<Loading />}>{marketComponent(widget.component) ? <MarketData widget={widget} /> :
    seriesComponent(widget.component) ? <HistoryData widget={widget} names={names} /> :
      <StandardData widget={widget} strategyId={strategyId} />}</Suspense>;
}

function MarketData({ widget }: { widget: Widget }) {
  const source = widget.candle;
  const query = useQuery({
    queryKey: ["live", "market", widget],
    enabled: !!source,
    refetchInterval: 10_000,
    queryFn: () => {
      const params = new URLSearchParams(timeRange(widget));
      params.set("symbol", source!.symbol);
      params.set("instance", source!.instance_id);
      params.set("interval_seconds", String(source!.interval_seconds));
      return api<Market>(strategyApi(source!.strategy_id, `market?${params}`));
    },
  });
  if (!source) return <Empty title="请选择标的和 K 线周期" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  if (widget.component === "candles") return <MarketChart market={query.data}
    interval={source.interval_seconds} height={widget.height} showMarkers={widget.markers} />;
  const points = query.data.candles.map((item) => ({ observed_at: item.observed_at, value: item.volume }));
  return <TimeSeries series={[{ name: source.symbol, points }]} chart="bar" unit="成交量" height={widget.height} minimum={1} />;
}

function HistoryData({ widget, names }: { widget: Widget; names: Record<string, string> }) {
  const query = useQuery({
    queryKey: ["live", "metric-history", widget],
    enabled: !!widget.sources.length,
    refetchInterval: 10_000,
    queryFn: () => api<SeriesHistory[]>("history/metrics", "POST", {
      ...timeRange(widget), sources: widget.sources, limit: 1200,
      bucket_seconds: widget.bucket_seconds, aggregation: widget.aggregation,
    }),
  });
  if (!widget.sources.length) return <Empty title="请选择至少一个已上报的指标" />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  const series = query.data.map((item) => ({
    name: [names[item.source.strategy_id], item.source.name, item.source.account_id, item.source.instance_id].filter(Boolean).join(" · "),
    points: item.points, unit: item.source.unit, key: seriesKey(item.source),
  }));
  if (widget.component === "metric_cards") {
    const cards = series.flatMap((item) => {
      const last = item.points.at(-1);
      return last ? [{ ...item, last }] : [];
    });
    if (!cards.length) return <Empty title="所选范围没有观测值" />;
    if (widget.chart === "table") return <Table columns={["指标", "最新值", "观测时间"]}>
      {cards.map((item) => <tr key={item.key}><td>{item.name}</td><td>{money(item.last.value, item.unit)}</td><td>{when(item.last.observed_at)}</td></tr>)}
    </Table>;
    return <div className="value-grid">{cards.map((item) => <div key={item.key}><span>{item.name}</span>
      <strong>{money(item.last.value, item.unit)}</strong><span>{when(item.last.observed_at)}</span></div>)}</div>;
  }
  return <TimeSeries {...{ series }} chart={widget.chart} unit={series[0]?.unit ?? ""} height={widget.height} />;
}

function StandardData({ widget, strategyId }: { widget: Widget; strategyId: string }) {
  const query = useQuery({
    queryKey: ["live", "component", strategyId, widget],
    refetchInterval: 10_000,
    queryFn: () => {
      const query = new URLSearchParams(timeRange(widget));
      if (widget.component === "fill_count") query.set("bucket_seconds", String(widget.bucket_seconds || 3600));
      return api<ComponentData>(strategyApi(strategyId, `components/${widget.component}?${query}`));
    },
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  if (Array.isArray(query.data)) return <HistoryComponent widget={widget} rows={query.data} />;
  const data = query.data;
  switch (widget.component) {
    case "status":
      return data.runtime ? <div className="value-grid">
        <div><span>运行状态</span><strong>{health(data.runtime.health)}</strong></div>
        <div><span>运行时长</span><strong>{data.runtime.uptime_seconds == null ? "—" : `${data.runtime.uptime_seconds} 秒`}</strong></div>
        <div><span>观测时间</span><strong>{when(data.observed_at)}</strong></div>
      </div> : <Empty />;
    case "accounts":
      if (widget.chart === "table") return <Accounts rows={data.accounts ?? []} />;
      return data.accounts?.length ? <div className="value-grid">{data.accounts.map((item) =>
        <div key={`${item.account_id}/${item.currency}`}><span>{item.account_id} · {item.currency}</span>
          <strong>{money(item.equity, item.currency)}</strong><span>可用现金 {money(item.cash, item.currency)}</span></div>)}</div> : <Empty />;
    case "positions":
      return <div className="stack"><h3>策略归属持仓</h3><Positions rows={data.strategy_positions ?? []} />
        <h3>券商账户持仓</h3><Positions rows={data.broker_positions ?? []} /></div>;
    case "position_mix": {
      const groups = new Map<string, Map<string, number>>();
      for (const position of data.strategy_positions ?? []) {
        if (position.market_price == null) continue;
        const value = Math.abs(Number(position.quantity) * Number(position.market_price));
        if (!Number.isFinite(value) || value === 0) continue;
        const group = groups.get(position.currency) ?? new Map<string, number>();
        group.set(position.symbol, (group.get(position.symbol) ?? 0) + value);
        groups.set(position.currency, group);
      }
      if (!groups.size) return <Empty title="等待非零持仓与市价" />;
      return <div className="stack">{[...groups].map(([currency, symbols]) =>
        <section key={currency}><h3>策略持仓市值敞口 · {currency}</h3>
          <Distribution data={[...symbols].map(([name, value]) => ({ name, value }))} chart={widget.chart}
            height={widget.height} label={`持仓市值 ${currency}`} /></section>)}</div>;
    }
    case "orders":
      return <div className="stack"><h3>未完成订单</h3><Orders rows={data.open_orders ?? []} />
        <h3>已完成订单</h3><Orders rows={data.completed_orders ?? []} /></div>;
    case "order_status": {
      const counts = new Map<string, number>();
      for (const order of [...(data.open_orders ?? []), ...(data.completed_orders ?? [])]) {
        counts.set(order.status, (counts.get(order.status) ?? 0) + 1);
      }
      return <Distribution data={[...counts].map(([name, value]) => ({ name, value }))}
        chart={widget.chart} height={widget.height} label="订单状态数量" />;
    }
    case "performance":
      if (widget.chart === "table") return <Table columns={["指标", "值"]} empty={!Object.values(data.performance ?? {}).some((value) => value != null)}>
        {Object.entries(data.performance ?? {}).filter(([, value]) => value != null).map(([name, value]) =>
          <tr key={name}><td>{name}</td><td>{money(value)}</td></tr>)}</Table>;
      return <Performance values={data.performance} />;
    default:
      return <Empty />;
  }
}

function health(value?: string) {
  return { healthy: "正常", degraded: "降级", error: "异常" }[value ?? ""] ?? "未上报";
}

function HistoryComponent({ widget, rows }: { widget: Widget; rows: Array<EventRecord | StatusRecord | Connection | FillCount> }) {
  if (!rows.length) return <Empty title="所选时间范围暂无数据" />;
  if (widget.component === "connections") {
    const records = rows.filter((item): item is Connection => "broker_connected" in item);
    if (widget.chart === "cards") {
      const latest = records[0];
      return latest ? <div className="value-grid"><div><span>券商连接</span><strong>{latest.broker_connected ? "已连接" : "已断开"}</strong></div>
        <div><span>授权到期</span><strong>{when(latest.authorization_expires_at)}</strong></div></div> : <Empty />;
    }
    return <ul className="activity-list">{records.map((item, i) => <li key={i}><time>{when(item.observed_at)}</time>
      <div><strong>{item.broker_connected ? "券商已连接" : "券商已断开"}</strong><small>{item.message}</small></div></li>)}</ul>;
  }
  if (widget.component === "status_history") {
    const records = rows.filter((item): item is StatusRecord => "runtime" in item);
    return <ul className="activity-list">{records.map((item, i) => <li key={i}><time>{when(item.observed_at)}</time>
      <div><strong>{health(item.runtime.health)}</strong><small>运行时长 {item.runtime.uptime_seconds ?? "—"} 秒</small></div></li>)}</ul>;
  }
  if (widget.component === "fill_count") {
    const counts = rows.filter((item): item is FillCount => "side" in item);
    const series = (["buy", "sell"] as const).map((side) => ({
      name: side === "buy" ? "买入成交" : "卖出成交",
      points: counts.filter((item) => item.side === side),
    }));
    return <TimeSeries {...{ series }} chart={widget.chart} height={widget.height} unit="笔" minimum={widget.chart === "line" ? 2 : 1} />;
  }
  const events = rows.filter((item): item is EventRecord => "category" in item);
  if (widget.component === "fills") {
    const fills: Fill[] = events.flatMap((item) => item.fill ? [item.fill] : []);
    return <Fills rows={fills} />;
  }
  if (widget.chart === "table") return <Table columns={["时间", "类别", "等级", "内容"]} empty={!events.length}>
    {events.map((event, i) => <tr key={`${event.id}/${i}`}><td>{when(event.occurred_at)}</td><td>{categoryText[event.category] ?? event.category}</td>
      <td>{severityText[event.severity]}</td><td className="wrap">{event.message}</td></tr>)}
  </Table>;
  return <ul className="activity-list">{events.map((event, i) => <li key={`${event.id}/${i}`}>
    <time>{when(event.occurred_at)}</time><div><strong>{severityText[event.severity]} · {categoryText[event.category] ?? event.category}</strong>
      <small>{event.message}</small></div></li>)}</ul>;
}
