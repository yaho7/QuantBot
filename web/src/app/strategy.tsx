import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
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
          <Link to={"/admin/integration?strategy=" + id}>
            {t("integration")}
          </Link>
        </>
      }
    >
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
        {health &&
          catalog.data?.capabilities.some(
            (entry) => entry.kind === "state" && entry.group === "health",
          ) && (
            <span role="status">
              {t("health")}{" "}
              <Badge tone={health.status === "healthy" ? "success" : "warning"}>
                {t(health.status)}
              </Badge>
              {!!healthIssues?.length && " · " + healthIssues.join(", ")}
            </span>
          )}
      </div>
      <section className="summary-grid detail-summary">
        {[
          {
            label: t("equity"),
            value: decimalText(equity?.data.value),
            unit: shown(equity?.data.currency ?? ""),
          },
          {
            label: t("dailyPnl"),
            value: decimalText(performance?.data.dailyPnl),
            unit: "",
          },
          {
            label: t("drawdown"),
            value: decimalText(equity?.data.drawdown),
            unit: "",
          },
        ].map((item) => (
          <div className="summary-card" key={item.label}>
            <span className="muted">{item.label}</span>
            <strong>
              {item.value} <small>{item.unit}</small>
            </strong>
          </div>
        ))}
      </section>
      <section className="section">
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
      <section className="section">
        <div className="section-heading">
          <h2>{t("charts")}</h2>
        </div>
        <History strategyId={id} />
      </section>
      <section className="section">
        {telemetry.error && <ErrorView error={telemetry.error} />}
        <DataTable title={t("equity")} rows={accounts} fields="standard" />
        <div className="two-columns">
          <DataTable title={t("positions")} rows={positions} fields="standard" />
          <DataTable title={t("orders")} rows={orders} fields="standard" />
        </div>
      </section>
      <section className="section">
        <h2>{t("events")}</h2>
        <RecordFeed id={id} />
      </section>
      <section className="section">
        <h2>{t("activity")}</h2>
        <ActivityPage strategyId={id} />
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
}: {
  strategyId: string;
  embedded?: boolean;
}) {
  const query = useQuery(
    resource<{ series: Series[] }>("/strategies/" + strategyId + "/series"),
  );
  const [selected, setSelected] = useState(0);
  const [range, setRange] = useState(24);
  const { t } = useLanguage();
  const display = useDisplay();
  const options = query.data?.series ?? [];
  const series = options[selected] ?? options[0];
  const window = useMemo(
    () => ({ from: Date.now() - range * 3600000, to: Date.now() + 1 }),
    [range, series?.series],
  );
  const path =
    "/strategies/" +
    strategyId +
    "/history?" +
    new URLSearchParams({
      instanceId: series?.instanceId ?? "",
      kind: series?.kind ?? "",
      series: series?.series ?? "",
      from: String(window.from),
      to: String(window.to),
      points: "500",
    });
  const history = useQuery({
    ...resource<{ resolutionMs: number; points: Point[] }>(path),
    enabled: !!series,
  });
  return (
    <div className={(embedded ? "" : "surface ") + "chart-card"}>
      <div className="filter-bar">
        <select
          aria-label={t("series")}
          value={selected}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {options.map((s, i) => (
            <option value={i} key={s.kind + s.series + s.instanceId}>
              {[display.kind(s.kind), display.series(s.kind, s.series), s.instanceId].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>
        <select
          aria-label={t("timeRange")}
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
        >
          <option value={1}>{display.unit(1, "hour")}</option>
          <option value={24}>{display.unit(24, "hour")}</option>
          <option value={168}>{display.unit(7, "day")}</option>
          <option value={720}>{display.unit(30, "day")}</option>
        </select>
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
          />{" "}
        </Suspense>
      ) : (
        <p className="empty-inline chart-empty">{t("missing")}</p>
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
