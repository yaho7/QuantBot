import { label, t } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { api, strategyApi, type Detail, type EventRecord, type Fill, type Runtime, type Snapshot } from "./api";

import { marketComponent, seriesComponent, seriesKey, timeRange, type Market, type Point, type SeriesHistory, type Widget } from "./dashboard-types";
import { type ControlRegistryView } from "./dynamic-controls";
import { CommandDialog } from "./operations";
import { useState } from "react";
import { Accounts, Fills, Orders, Performance, Positions } from "./telemetry-views";
import { Empty, ErrorNotice, Loading, Table, categoryText, money, severityText, when } from "./ui";

const MarketChart = lazy(() => import("./market-chart"));
const TimeSeries = lazy(() => import("./charts").then((module) => ({ default: module.TimeSeries })));
const Distribution = lazy(() => import("./charts").then((module) => ({ default: module.Distribution })));

type Connection = { observed_at: string; broker_connected: boolean; authorization_expires_at?: string | null; message?: string };
type StatusRecord = { observed_at: string; runtime: Runtime };
type FillCount = Point & { side: "buy" | "sell" };
type ComponentData = Snapshot | Array<EventRecord | StatusRecord | Connection | FillCount>;

function dataKey({ placement: _placement, width: _width, height: _height, title: _title, id: _id, ...data }: Widget) {
  return data;
}

export default function WidgetData({ widget, strategy, registry, names, compact, chartHeight, editing }: {
  widget: Widget; strategy: Detail; registry?: ControlRegistryView; editing: boolean; names: Record<string, string>; compact: boolean; chartHeight: number;
}) {
  widget = { ...widget, height: chartHeight };
  return <Suspense fallback={<Loading />}>{marketComponent(widget.component) ? <MarketData widget={widget} /> :
    seriesComponent(widget.component) ? <HistoryData {...{ widget, names, compact }} /> :
      <StandardData {...{ widget, strategy, registry, compact, editing }} />}</Suspense>;
}

function MarketData({ widget }: { widget: Widget }) {
  const source = widget.candle;
  const query = useQuery({
    queryKey: ["live", "market", dataKey(widget)],
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
  if (!source) return <Empty title={t("widgetData.selectASymbolAndCandlestickInterval")} />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  if (widget.component === "candles") return <MarketChart market={query.data}
    interval={source.interval_seconds} height={widget.height} showMarkers={widget.markers} />;
  const points = query.data.candles.map((item) => ({ observed_at: item.observed_at, value: item.volume }));
  return <TimeSeries series={[{ name: source.symbol, points }]} chart="bar" unit={t("widgetData.volume")} height={widget.height} minimum={1} />;
}

function HistoryData({ widget, names, compact }: { widget: Widget; names: Record<string, string>; compact: boolean }) {
  const query = useQuery({
    queryKey: ["live", "metric-history", dataKey(widget)],
    enabled: !!widget.sources.length,
    refetchInterval: 10_000,
    queryFn: () => api<SeriesHistory[]>("history/metrics", "POST", {
      ...timeRange(widget), sources: widget.sources, limit: 1200,
      bucket_seconds: widget.bucket_seconds, aggregation: widget.aggregation,
    }),
  });
  if (!widget.sources.length) return <Empty title={t("widgetData.selectAtLeastOneReportedMetric")} />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  const series = query.data.map((item) => ({
    name: [names[item.source.strategy_id], item.source.name, item.source.account_id, item.source.instance_id].filter(Boolean).join(" · "),
    points: item.points, unit: item.source.unit, key: seriesKey(item.source),
  }));
  if (compact) return <div className="widget-metrics">{series.map((item) =>
    <strong key={item.key} title={item.name}>{money(item.points.at(-1)?.value, item.unit)}</strong>)}</div>;
  if (widget.component === "metric_cards") {
    const cards = series.flatMap((item) => {
      const last = item.points.at(-1);
      return last ? [{ ...item, last }] : [];
    });
    if (!cards.length) return <Empty title={t("widgetData.noObservationsInThisRange")} />;
    if (widget.chart === "table") return <Table columns={[t("widgetData.metric"), t("widgetData.latestValue"), t("widgetData.observationTime")]}>
      {cards.map((item) => <tr key={item.key}><td>{item.name}</td><td>{money(item.last.value, item.unit)}</td><td>{when(item.last.observed_at)}</td></tr>)}
    </Table>;
    return <div className="value-grid">{cards.map((item) => <div key={item.key}><span>{item.name}</span>
      <strong>{money(item.last.value, item.unit)}</strong><span>{when(item.last.observed_at)}</span></div>)}</div>;
  }
  return <TimeSeries {...{ series }} chart={widget.chart} unit={series[0]?.unit ?? ""} height={widget.height} />;
}

function StandardData({ widget, strategy, registry, compact, editing }: {
  widget: Widget; strategy: Detail; registry?: ControlRegistryView; compact: boolean; editing: boolean;
}) {
  const strategyId = strategy.id;
  const query = useQuery({
    queryKey: ["live", "component", strategyId, dataKey(widget)],
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
        <div><span>{t("widgetData.runtimeStatus")}</span><strong>{health(data.runtime.health)}</strong></div>
        <div><span>{t("strategy.uptime")}</span><strong>{data.runtime.uptime_seconds == null ? "—" : t("strategy.sec", { seconds: data.runtime.uptime_seconds })}</strong></div>
        <div><span>{t("widgetData.observationTime")}</span><strong>{when(data.observed_at)}</strong></div>
      </div> : <Empty />;
    case "accounts":
      if (compact) return <div className="widget-metrics">{data.accounts?.map((item) =>
        <strong key={`${item.account_id}/${item.currency}`} title={item.account_id}>{money(item.equity, item.currency)}</strong>)}</div>;
      if (widget.chart === "table") return <Accounts rows={data.accounts ?? []} />;
      return data.accounts?.length ? <div className="value-grid">{data.accounts.map((item) =>
        <div key={`${item.account_id}/${item.currency}`}><span>{item.account_id} · {item.currency}</span>
          <strong>{money(item.equity, item.currency)}</strong><span>{t("telemetryViews.availableCash")}{" "}{money(item.cash, item.currency)}</span></div>)}</div> : <Empty />;
    case "positions":
      return <div className="stack"><h3>{t("strategy.strategyPositions")}</h3><Positions rows={data.strategy_positions ?? []} />
        <h3>{t("strategy.brokerAccountPositions")}</h3><Positions rows={data.broker_positions ?? []} /></div>;
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
      if (!groups.size) return <Empty title={t("widgetData.waitingForNonzeroPositionsAndMarketPrices")} />;
      return <div className="stack">{[...groups].map(([currency, symbols]) =>
        <section key={currency}><h3>{t("widgetData.strategyMarketExposure")}{" "}{currency}</h3>
          <Distribution data={[...symbols].map(([name, value]) => ({ name, value }))} chart={widget.chart}
            height={widget.height} label={t("widgetData.marketValue", { currency: currency })} /></section>)}</div>;
    }
    case "orders":
      if (compact) return <strong>{data.open_orders?.length ?? 0} {t("widgetData.openOrders")}</strong>;
      return <div className="stack"><h3>{t("strategy.openOrders")}</h3><OpenOrders rows={data.open_orders ?? []} {...{ strategy, registry, editing }} />
        <h3>{t("strategy.completedOrders")}</h3><Orders rows={data.completed_orders ?? []} /></div>;
    case "order_status": {
      const counts = new Map<string, number>();
      for (const order of [...(data.open_orders ?? []), ...(data.completed_orders ?? [])]) {
        counts.set(order.status, (counts.get(order.status) ?? 0) + 1);
      }
      return <Distribution data={[...counts].map(([name, value]) => ({ name, value }))}
        chart={widget.chart} height={widget.height} label={t("widgetData.ordersByStatus")} />;
    }
    case "performance":
      if (widget.chart === "table") return <Table columns={[t("widgetData.metric"), t("widgetData.value")]} empty={!Object.values(data.performance ?? {}).some((value) => value != null)}>
        {Object.entries(data.performance ?? {}).filter(([, value]) => value != null).map(([name, value]) =>
          <tr key={name}><td>{name}</td><td>{money(value)}</td></tr>)}</Table>;
      return <Performance values={data.performance} />;
    default:
      return <Empty />;
  }
}

function OpenOrders({ rows, strategy, registry, editing }: {
  rows: NonNullable<Snapshot["open_orders"]>; strategy: Detail; registry?: ControlRegistryView; editing: boolean;
}) {
  const [selected, setSelected] = useState<(typeof rows)[number]>();
  const capability = strategy.capabilities.find((item) => item.id === "cancel_order" &&
    item.parameters.order_id && !registry?.controls.some((control) => control.command === item.id));
  const actionable = !editing && !!registry && !!capability && !strategy.archived_at && strategy.executor_online &&
    (strategy.mode !== "live" || strategy.live_trading_enabled);
  return <>
    <Orders rows={rows} action={actionable ? (row) => <button type="button" className="button quiet"
      onClick={() => setSelected(row)}>{t("widgetData.cancelOrder")}</button> : undefined} />
    {selected && capability && actionable && <CommandDialog capability={capability} strategy={strategy}
      initial={{ order_id: selected.order_id, ...(capability.parameters.account_id ? { account_id: selected.account_id } : {}) }}
      context={t("widgetData.accountOrderedFilled", { symbol: selected.symbol, account: selected.account_id, quantity: selected.quantity, filled: selected.filled_quantity ?? "—" })}
      close={() => setSelected(undefined)} />}
  </>;
}

function health(value?: string) {
  return { healthy: t("widgetData.healthy"), degraded: t("widgetData.degraded"), error: t("ui.unhealthy") }[value ?? ""] ?? t("dynamicControls.notReported");
}

function HistoryComponent({ widget, rows }: { widget: Widget; rows: Array<EventRecord | StatusRecord | Connection | FillCount> }) {
  if (!rows.length) return <Empty title={t("widgetData.noDataInThisTimeRange")} />;
  if (widget.component === "connections") {
    const records = rows.filter((item): item is Connection => "broker_connected" in item);
    if (widget.chart === "cards") {
      const latest = records[0];
      return latest ? <div className="value-grid"><div><span>{t("strategy.brokerConnection")}</span><strong>{latest.broker_connected ? t("settings.connected") : t("widgetData.disconnected")}</strong></div>
        <div><span>{t("strategy.authorizationExpires")}</span><strong>{when(latest.authorization_expires_at)}</strong></div></div> : <Empty />;
    }
    return <ul className="activity-list">{records.map((item, i) => <li key={i}><time>{when(item.observed_at)}</time>
      <div><strong>{item.broker_connected ? t("widgetData.brokerConnected") : t("widgetData.brokerDisconnected")}</strong><small>{item.message}</small></div></li>)}</ul>;
  }
  if (widget.component === "status_history") {
    const records = rows.filter((item): item is StatusRecord => "runtime" in item);
    return <ul className="activity-list">{records.map((item, i) => <li key={i}><time>{when(item.observed_at)}</time>
      <div><strong>{health(item.runtime.health)}</strong><small>{t("strategy.uptime")}{" "}{item.runtime.uptime_seconds ?? "—"} {t("widgetData.sec")}</small></div></li>)}</ul>;
  }
  if (widget.component === "fill_count") {
    const counts = rows.filter((item): item is FillCount => "side" in item);
    const series = (["buy", "sell"] as const).map((side) => ({
      name: side === "buy" ? t("widgetData.buyFills") : t("widgetData.sellFills"),
      points: counts.filter((item) => item.side === side),
    }));
    return <TimeSeries {...{ series }} chart={widget.chart} height={widget.height} unit={t("widgetData.fills")} minimum={widget.chart === "line" ? 2 : 1} />;
  }
  const events = rows.filter((item): item is EventRecord => "category" in item);
  if (widget.component === "fills") {
    const fills: Fill[] = events.flatMap((item) => item.fill ? [item.fill] : []);
    return <Fills rows={fills} />;
  }
  if (widget.chart === "table") return <Table columns={[t("marketChart.time"), t("settings.category"), t("settings.severity"), t("marketChart.content")]} empty={!events.length}>
    {events.map((event, i) => <tr key={`${event.id}/${i}`}><td>{when(event.occurred_at)}</td><td>{label(categoryText[event.category], event.category)}</td>
      <td>{label(severityText[event.severity])}</td><td className="wrap">{event.message}</td></tr>)}
  </Table>;
  return <ul className="activity-list">{events.map((event, i) => <li key={`${event.id}/${i}`}>
    <time>{when(event.occurred_at)}</time><div><strong>{label(severityText[event.severity])} · {label(categoryText[event.category], event.category)}</strong>
      <small>{event.message}</small></div></li>)}</ul>;
}
