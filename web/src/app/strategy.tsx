import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Table, proportional } from "@astryxdesign/core/Table";
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
  Choices,
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
  const [panel, setPanel] = useState<
    "trading" | "events" | "activity" | "hosts"
  >("trading");
  const catalog = useQuery({
    ...resource<CapabilityCatalog>("/strategies/" + id + "/capabilities"),
    refetchInterval: 5000,
  });
  const layout = useQuery(layoutResource(id));
  // Only controls actually visible in the board should be excluded from quick controls.
  // Hidden capabilities must never silently disappear from the strategy page.
  const visibleControlIds = layout.data?.revision
    ? layout.data.widgets
        .filter((widget) => !widget.hidden)
        .map((widget) => widget.controlId)
    : (catalog.data?.capabilities ?? [])
        .filter(
          (capability) =>
            capability.presentation?.suggested &&
            capability.presentation.surface?.includes("strategy"),
        )
        .map((capability) => capability.id);
  const widgetControls = new Set(
    visibleControlIds.filter((id): id is string => !!id),
  );
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
          <a
            className="inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2"
            href="#strategy-controls"
          >
            {t("controls")}
          </a>
        </>
      }
    >
      <VStack gap={3} className="strategy-intro">
        <HStack
          gap={3}
          wrap="wrap"
          vAlign="center"
          className="detail-meta text-secondary   muted text-secondary"
        >
          {strategy.group && <Text>{strategy.group}</Text>}
          <Text>
            {t("lastSeen")} · {timestamp(strategy.lastSeen, true)}
          </Text>
          {runtime && (
            <Text>
              {t("uptime")} ·{" "}
              {display.unit(
                Math.max(0, Math.floor((Date.now() / 1000 - runtime) / 60)),
                "minute",
              )}
            </Text>
          )}
          {strategy.online &&
            health &&
            health.status !== "healthy" &&
            catalog.data?.capabilities.some(
              (entry) => entry.kind === "state" && entry.group === "health",
            ) && (
              <Text role="status">
                {t("health")} <Badge tone="warning">{t(health.status)}</Badge>
                {!!healthIssues?.length && " · " + healthIssues.join(", ")}
              </Text>
            )}
        </HStack>
        <Card padding={5}>
          <VStack gap={4}>
            <VStack gap={3} className="portfolio-amount tabular-nums">
              <Text className="muted text-secondary">{t("equity")}</Text>
              <Text
                type="large"
                className="text-3xl"
                weight="semibold"
                hasTabularNumbers
              >
                {decimalText(equity?.data.value)}{" "}
                <Text type="supporting">
                  {display.value(equity?.data.currency ?? "")}
                </Text>
              </Text>
              <HStack
                gap={3}
                wrap="wrap"
                vAlign="center"
                className="portfolio-secondary text-secondary"
              >
                {equity &&
                  performance?.data.accountId === equity.data.accountId &&
                  performance?.data.currency === equity.data.currency &&
                  typeof performance?.data.dailyPnl === "string" && (
                    <Text
                      className={
                        performance.data.dailyPnl.startsWith("-")
                          ? "danger text-error"
                          : "success text-success"
                      }
                    >
                      {t("dailyPnl")} {decimalText(performance.data.dailyPnl)}
                    </Text>
                  )}
                {equity?.data.drawdown != null && (
                  <Text className="muted text-secondary">
                    {t("drawdown")} {decimalText(equity.data.drawdown)}
                  </Text>
                )}
              </HStack>
            </VStack>
            <History strategyId={id} embedded featured />
          </VStack>
        </Card>
      </VStack>
      <VStack
        as="section"
        gap={4}
        className="qb-quick-controls"
        id="strategy-controls"
      >
        <HStack
          gap={3}
          wrap="wrap"
          vAlign="center"
          hAlign="between"
          className="section-heading"
        >
          <Heading level={2}>{t("controls")}</Heading>
        </HStack>
        {layout.isSuccess && catalog.isSuccess && (
          <ControlPanel strategyId={id} exclude={widgetControls} />
        )}
        {(layout.error || catalog.error) && (
          <ErrorView error={(layout.error || catalog.error)!} />
        )}
      </VStack>
      <Suspense fallback={<Loading />}>
        <WidgetBoard key={id} strategyId={id} />
      </Suspense>
      <VStack
        as="section"
        gap={4}
        className="section flex flex-col gap-4 min-w-0   portfolio-records"
      >
        <Choices
          label={t("strategyPanels")}
          value={panel}
          select={setPanel}
          options={(["trading", "events", "activity", "hosts"] as const).map(
            (value) => ({ value, label: t(value) }),
          )}
        />
        <VStack gap={3} className="panel-enter" key={panel}>
          {panel === "trading" ? (
            <>
              {telemetry.isPending ? (
                <Loading />
              ) : telemetry.error ? (
                <ErrorView error={telemetry.error} />
              ) : !accounts.length && !positions.length && !orders.length ? (
                <Text
                  as="p"
                  className="empty-inline text-secondary text-center p-6"
                >
                  {t("noEvents")}
                </Text>
              ) : (
                <>
                  {!!accounts.length && (
                    <DataTable
                      title={t("accountDetails")}
                      rows={accounts}
                      fields="standard"
                    />
                  )}
                  {(!!positions.length || !!orders.length) && (
                    <VStack
                      gap={3}
                      className={
                        "portfolio-record-grid grid grid-cols-1 lg:grid-cols-2 gap-4" +
                        "   grid"
                      }
                    >
                      {!!positions.length && (
                        <DataTable
                          title={t("positions")}
                          rows={positions}
                          fields="standard"
                        />
                      )}
                      {!!orders.length && (
                        <DataTable
                          title={t("orders")}
                          rows={orders}
                          fields="standard"
                        />
                      )}
                    </VStack>
                  )}
                </>
              )}
            </>
          ) : panel === "events" ? (
            <RecordFeed id={id} />
          ) : panel === "hosts" ? (
            <StrategyPerformance strategyId={id} />
          ) : (
            <ActivityPage strategyId={id} />
          )}
        </VStack>
      </VStack>
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
          <VStack
            as="section"
            gap={4}
            className="section flex flex-col gap-4 min-w-0"
            key={strategy.id}
          >
            <HStack
              gap={3}
              wrap="wrap"
              vAlign="center"
              hAlign="between"
              className="section-heading"
            >
              <Heading level={2}>
                <Link to={"/strategies/" + strategy.id}>{strategy.name}</Link>
              </Heading>
              <Badge>{t(strategy.online ? "online" : "offline")}</Badge>
            </HStack>
            <ControlPanel strategyId={strategy.id} />
          </VStack>
        ))
      )}
      {!query.data?.length && (
        <Text as="p" className="empty-inline text-secondary text-center p-6">
          {t("empty")}
        </Text>
      )}
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
  const options = (query.data?.series ?? []).filter(
    (item) =>
      (!seriesKind || item.kind === seriesKind) &&
      (!seriesKey || item.series === seriesKey) &&
      (!instanceId || item.instanceId === instanceId),
  );
  const keyFor = (item: Series) =>
    JSON.stringify([item.kind, item.series, item.instanceId]);
  const series =
    options.find((item) => keyFor(item) === selected) ??
    options.find((item) => item.kind === "equity") ??
    options[0];
  const seriesIdentity = series ? keyFor(series) : "";
  const rangeEnd =
    Math.ceil(
      (series?.observedAt || query.dataUpdatedAt || Date.now()) / 60_000,
    ) *
      60_000 +
    1;
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
    <VStack
      gap={3}
      className={
        (embedded
          ? ""
          : "surface bg-surface border border-border rounded-lg   ") +
        "chart-card min-w-0" +
        (featured ? "   portfolio-chart min-w-0" : "")
      }
    >
      <HStack gap={3} wrap="wrap" vAlign="center" className="filter-bar">
        {(!seriesKind || options.length > 1) && (
          <Selector
            label={t("series")}
            isLabelHidden
            value={String(seriesIdentity)}
            onChange={(e) => setSelected(e)}
            options={[
              ...options.map((s) => ({
                value: String(keyFor(s)),
                label: String(
                  [
                    display.kind(s.kind),
                    display.series(s.kind, s.series),
                    s.instanceId,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              })),
            ]}
          />
        )}
        {!featured && (
          <Selector
            label={t("timeRange")}
            isLabelHidden
            value={String(range)}
            onChange={(e) => setRange(Number(e))}
            options={[
              ...periods.map((period) => ({
                value: String(period),
                label: String(periodLabel(period)),
              })),
            ]}
          />
        )}
      </HStack>
      {query.error || history.error ? (
        <ErrorView error={(query.error || history.error)!} />
      ) : query.isPending || (!!series && history.isPending) ? (
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
        <Text
          as="p"
          className="empty-inline text-secondary text-center p-6   chart-empty min-h-64 flex items-center justify-center"
        >
          {t("missing")}
        </Text>
      )}
      {featured && (
        <Choices
          label={t("choosePeriod")}
          value={String(range)}
          size="sm"
          options={periods.map((period) => ({
            value: String(period),
            label: periodLabel(period),
          }))}
          select={(period) => setRange(Number(period))}
        />
      )}
      {history.data && history.data.resolutionMs > 0 && (
        <Text type="supporting" className="muted text-secondary">
          {display.unit(history.data.resolutionMs / 60000, "minute")} ·{" "}
          {t("samples")} {history.data.points.length}
        </Text>
      )}
    </VStack>
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
    <VStack
      as="section"
      gap={4}
      className="data-section flex flex-col gap-3 min-w-0"
    >
      {title && <Heading level={2}>{title}</Heading>}
      <Table
        data={rows}
        density="balanced"
        hasHover
        columns={keys.map((key) => ({
          key,
          header:
            fields === "standard" ||
            (fields === "annotations" &&
              ["Observed at", "Resource ID", "Related IDs"].includes(key))
              ? display.field(key)
              : key,
          width: proportional(1, { minWidth: 120 }),
          renderCell: (row) =>
            renderCell?.(key, row[key]) ??
            (fields === "standard"
              ? display.tableValue(key, row[key])
              : display.value(row[key])),
        }))}
        emptyState={
          <Text as="p" className="empty-inline text-secondary text-center p-6">
            {t("missing")}
          </Text>
        }
      />
    </VStack>
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
      <Choices
        label={t("events")}
        value={kind}
        select={setKind}
        options={["log", "fill", "signal", "risk", "alert"].map((value) => ({
          value,
          label: display.kind(value),
        }))}
      />
      <VStack
        gap={3}
        className="surface bg-surface border border-border rounded-lg"
      >
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorView error={query.error} />
        ) : query.data.length ? (
          query.data.map((row) => (
            <HStack
              gap={3}
              wrap="wrap"
              vAlign="center"
              className="event-line"
              key={row.id}
            >
              <time>
                <Text type="supporting">{timestamp(row.observedAt)}</Text>
              </time>
              <Text>
                {typeof row.data.message === "string" && row.data.message
                  ? row.data.message
                  : Object.entries(row.data)
                      .map(
                        ([key, value]) =>
                          display.field(key) +
                          "：" +
                          display.tableValue(key, value),
                      )
                      .join(" · ")}
                <RelatedRecords
                  strategyId={id}
                  associations={row.associations}
                />
              </Text>
            </HStack>
          ))
        ) : (
          <Text as="p" className="empty-inline text-secondary text-center p-6">
            {t("noEvents")}
          </Text>
        )}
      </VStack>
    </>
  );
}
