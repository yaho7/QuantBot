import { lazy, Suspense, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Link } from "../shared/page-links";
import {
  resource,
  layoutResource,
  type CapabilityCatalog,
  type Datum,
  type Strategy,
  type Series,
  type Point,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { useDisplay } from "../shared/display";
import {
  Badge,
  decimalText,
  ErrorView,
  Loading,
  timestamp,
} from "../shared/ui";
const Chart = lazy(() => import("../components/chart"));
const WidgetBoard = lazy(() => import("../components/widget-board"));
import { Page } from "./App";
import { ControlPanel } from "./control";
import { ActivityPage } from "./activity";
import { StrategyPerformance } from "../components/host-performance";
import { RelatedRecords } from "../components/related-records";

export function useTelemetryValues(id: string) {
  const query = useQuery(resource<Datum[]>("/strategies/" + id + "/telemetry"));
  const records = query.data ?? [];
  return {
    query,
    records,
    equity: records.find((r) => r.kind === "equity"),
    performance: records.find((r) => r.kind === "performance"),
  };
}
export function StrategyDetail() {
  const { id = "" } = useParams();
  const query = useQuery(resource<Strategy>("/strategies/" + id));
  const { t } = useLanguage();
  const display = useDisplay();
  const [panel, setPanel] = useState<"trading" | "events" | "activity" | "hosts">("trading");
  const catalog = useQuery({
    ...resource<CapabilityCatalog>("/strategies/" + id + "/capabilities"),
    refetchInterval: 5000,
  });
  const layout = useQuery(layoutResource(id));
  const widgetControls = new Set(
    (layout.data?.widgets ?? []).flatMap((widget) =>
      widget.controlId ? [widget.controlId] : [],
    ),
  );
  for (const capability of catalog.data?.capabilities ?? []) {
    if (
      capability.presentation?.suggested &&
      capability.presentation.surface?.includes("strategy")
    )
      widgetControls.add(capability.id);
  }
  const { health } = catalog.data ?? {};
  const healthIssues = health?.issues.map(
    (issue) =>
      catalog.data?.capabilities.find((entry) => entry.id === issue)?.title ??
      issue,
  );
  const {
    query: telemetry,
    records,
    equity,
    performance,
  } = useTelemetryValues(id);
  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorView error={query.error} retry={() => void query.refetch()} />;
  const strategy = query.data;
  const accounts = records
    .filter((r) => r.kind === "portfolio")
    .flatMap((row) => (row.data.accounts ?? []) as Record<string, unknown>[]);
  const positions = records
    .filter((r) => r.kind === "position")
    .flatMap((row) => (row.data.positions ?? []) as Record<string, unknown>[]);
  const orders = records
    .filter((r) => r.kind === "order")
    .map((row) => row.data);
  const reportedRuntime = records.find((row) => row.kind === "status")?.data
    .startedAt;
  const runtime =
    typeof reportedRuntime === "number"
      ? reportedRuntime / 1000
      : strategy.instances?.find(
          (instance) => instance.instanceId === strategy.executorInstance,
        )?.startedAt;
  return (
    <Page
      title={strategy.name}
      actions={
        <>
          <Badge tone={strategy.online ? "success" : ""}>
            {t(strategy.online ? "online" : "offline")}
          </Badge>
          <Badge tone={strategy.mode === "live" ? "warning" : ""}>
            {t(strategy.mode)}
          </Badge>
          <a className="button" href="#strategy-controls">{t("controls")}</a>
        </>
      }
    >
      <div className="strategy-intro">
        <div className="detail-meta muted">
          {strategy.group && <span>{strategy.group}</span>}
          <span>
            {t("lastSeen")} · {timestamp(strategy.lastSeen, true)}
          </span>
          {runtime && (
            <span>
              {t("uptime")} · {display.unit(Math.max(0, Math.floor((Date.now() / 1000 - runtime) / 60)), "minute")}
            </span>
          )}
          {strategy.online && health && health.status !== "healthy" &&
            catalog.data?.capabilities.some(
              (entry) => entry.kind === "state" && entry.group === "health",
            ) && (
              <span role="status">
                {t("health")}{" "}
                <Badge tone="warning">
                  {t(health.status)}
                </Badge>
                {!!healthIssues?.length && " · " + healthIssues.join(", ")}
              </span>
            )}
        </div>
        <section className="portfolio-hero surface">
          <div className="portfolio-amount">
            <span className="muted">{t("equity")}</span>
            <strong>{decimalText(equity?.data.value)} <small>{display.value(equity?.data.currency ?? "")}</small></strong>
            <div className="portfolio-secondary">
              {equity && performance?.data.accountId === equity.data.accountId &&
                performance?.data.currency === equity.data.currency && typeof performance?.data.dailyPnl === "string" && (
                  <span className={performance.data.dailyPnl.startsWith("-") ? "danger" : "success"}>
                    {t("dailyPnl")} {decimalText(performance.data.dailyPnl)}
                  </span>
                )}
              {equity?.data.drawdown != null && (
                <span className="muted">{t("drawdown")} {decimalText(equity.data.drawdown)}</span>
              )}
            </div>
          </div>
          <History strategyId={id} embedded featured />
        </section>
      </div>
      <section className="section" id="strategy-controls">
        <div className="section-heading">
          <h2>{t("controls")}</h2>
        </div>
        {layout.isSuccess && catalog.isSuccess && (
          <ControlPanel strategyId={id} exclude={widgetControls} />
        )}
        {(layout.error || catalog.error) && (
          <ErrorView error={(layout.error || catalog.error)!} />
        )}
      </section>
      <Suspense fallback={<Loading />}>
        <WidgetBoard key={id} strategyId={id} />
      </Suspense>
      <section className="section portfolio-records">
        <div className="segmented" role="group" aria-label={t("strategyPanels")}>
          {(["trading", "events", "activity", "hosts"] as const).map((item) => (
            <button key={item} aria-pressed={panel === item} onClick={() => setPanel(item)}>
              {t(item)}
            </button>
          ))}
        </div>
        <div className="panel-enter" key={panel}>
          {panel === "trading" ? (
            <>
              {telemetry.isPending ? <Loading /> : telemetry.error ? <ErrorView error={telemetry.error} /> :
               !accounts.length && !positions.length && !orders.length ? <p className="empty-inline">{t("noEvents")}</p> : <>
                {!!accounts.length && <DataTable title={t("accountDetails")} rows={accounts} fields="standard" />}
                {(!!positions.length || !!orders.length) && <div className="portfolio-record-grid">
                  {!!positions.length && <DataTable title={t("positions")} rows={positions} fields="standard" />}
                  {!!orders.length && <DataTable title={t("orders")} rows={orders} fields="standard" />}
                </div>}
              </>}
            </>
          ) : panel === "events" ? <RecordFeed id={id} /> :
            panel === "hosts" ? <StrategyPerformance strategyId={id} /> : <ActivityPage strategyId={id} />}
        </div>
      </section>
    </Page>
  );
}
export function AllControls() {
  const { t } = useLanguage();
  const query = useQuery(resource<Strategy[]>("/strategies"));
  return (
    <Page title={t("controls")}>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        query.data.map((strategy) => (
          <section className="section" key={strategy.id}>
            <div className="section-heading">
              <h2>
                <Link to={"/strategies/" + strategy.id}>{strategy.name}</Link>
              </h2>
              <Badge>{t(strategy.online ? "online" : "offline")}</Badge>
            </div>
            <ControlPanel strategyId={strategy.id} />
          </section>
        ))
      )}
      {!query.data?.length && <p className="empty-inline">{t("empty")}</p>}
    </Page>
  );
}
export function History({
  strategyId,
  embedded = false,
  featured = false,
  seriesKind,
  seriesKey,
  instanceId,
}: {
  strategyId: string;
  embedded?: boolean;
  featured?: boolean;
  seriesKind?: string;
  seriesKey?: string;
  instanceId?: string;
}) {
  const query = useQuery(
    resource<{ series: Series[] }>("/strategies/" + strategyId + "/series"),
  );
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState(24);
  const { t } = useLanguage();
  const display = useDisplay();
  const options = (query.data?.series ?? []).filter((item) =>
    (!seriesKind || item.kind === seriesKind) &&
    (!seriesKey || item.series === seriesKey) &&
    (!instanceId || item.instanceId === instanceId),
  );
  const keyFor = (item: Series) => JSON.stringify([item.kind, item.series, item.instanceId]);
  const series = options.find((item) => keyFor(item) === selected) ??
    options.find((item) => item.kind === "equity") ?? options[0];
  const seriesIdentity = series ? keyFor(series) : "";
  const rangeEnd = Math.ceil((series?.observedAt || query.dataUpdatedAt || Date.now()) / 60_000) * 60_000 + 1;
  const periods = [1, 24, 168, 720];
  const periodLabel = (hours: number) =>
    hours < 168 ? display.unit(hours, "hour") : display.unit(hours / 24, "day");
  const path =
    "/strategies/" +
    strategyId +
    "/history?" +
    new URLSearchParams({
      instanceId: series?.instanceId ?? "",
      kind: series?.kind ?? "",
      series: series?.series ?? "",
      from: String(rangeEnd - range * 3600000),
      to: String(rangeEnd),
      points: "500",
    });
  const history = useQuery({
    ...resource<{ resolutionMs: number; points: Point[] }>(path),
    enabled: !!series,
  });
  return (
    <div className={(embedded ? "" : "surface ") + "chart-card" + (featured ? " portfolio-chart" : "")}>
      <div className="filter-bar">
        {(!seriesKind || options.length > 1) && <select
          aria-label={t("series")}
          value={seriesIdentity}
          onChange={(e) => setSelected(e.target.value)}
        >
          {options.map((s) => (
            <option value={keyFor(s)} key={keyFor(s)}>
              {[display.kind(s.kind), display.series(s.kind, s.series), s.instanceId].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>}
        {!featured && <select
          aria-label={t("timeRange")}
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
        >
          {periods.map((period) => <option value={period} key={period}>{periodLabel(period)}</option>)}
        </select>}
      </div>
      {query.error || history.error ? (
        <ErrorView error={(query.error || history.error)!} />
      ) : query.isPending || history.isFetching ? (
        <Loading />
      ) : history.data?.points.length ? (
        <Suspense fallback={<Loading />}>
          {" "}
          <Chart
            points={history.data.points}
            candle={series?.kind === "ohlcv"}
            featured={featured}
          />{" "}
        </Suspense>
      ) : (
        <p className="empty-inline chart-empty">{t("missing")}</p>
      )}
      {featured && (
        <div className="segmented portfolio-periods" role="group" aria-label={t("choosePeriod")}>
          {periods.map((period) => (
            <button key={period} aria-pressed={range === period} onClick={() => setRange(period)}>
              {periodLabel(period)}
            </button>
          ))}
        </div>
      )}
      {history.data && history.data.resolutionMs > 0 && (
        <small className="muted">
          {display.unit(history.data.resolutionMs / 60000, "minute")} · {t("samples")} {history.data.points.length}
        </small>
      )}
    </div>
  );
}
export function DataTable({
  title,
  rows,
  fields,
  maxColumns = 10,
  renderCell,
}: {
  title: string;
  rows: Record<string, unknown>[];
  fields?: "standard" | "annotations";
  maxColumns?: number;
  renderCell?: (key: string, value: unknown) => ReactNode;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(
    0,
    maxColumns,
  );
  return (
    <section className="data-section">
      {title && <h2>{title}</h2>}
      <div className="surface table-scroll">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                {keys.map((key) => (
                  <th key={key}>
                    {fields === "standard" || (fields === "annotations" && ["Observed at", "Resource ID", "Related IDs"].includes(key))
                      ? display.field(key)
                      : key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {keys.map((key) => (
                    <td key={key}>
                      {renderCell?.(key, row[key]) ??
                        (fields === "standard" ? display.tableValue(key, row[key]) : display.value(row[key]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-inline">{t("missing")}</p>
        )}
      </div>
    </section>
  );
}
function RecordFeed({ id }: { id: string }) {
  const [kind, setKind] = useState("log");
  const { t } = useLanguage();
  const display = useDisplay();
  const query = useQuery(
    resource<Datum[]>("/strategies/" + id + "/records?kind=" + kind),
  );
  return (
    <>
      <div className="segmented">
        {["log", "fill", "signal", "risk", "alert"].map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {display.kind(k)}
          </button>
        ))}
      </div>
      <div className="surface">
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorView error={query.error} />
        ) : query.data.length ? (
          query.data.map((row) => (
            <div className="event-line" key={row.id}>
              <time>{timestamp(row.observedAt)}</time>
              <span>
                {typeof row.data.message === "string" && row.data.message
                  ? row.data.message
                  : Object.entries(row.data)
                      .map(([key, value]) => display.field(key) + "：" + display.tableValue(key, value))
                      .join(" · ")}
                <RelatedRecords
                  strategyId={id}
                  associations={row.associations}
                />
              </span>
            </div>
          ))
        ) : (
          <p className="empty-inline">{t("noEvents")}</p>
        )}
      </div>
    </>
  );
}
