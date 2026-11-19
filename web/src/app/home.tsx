import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Attention } from "../components/attention-summary";
import { StrategyTable } from "../components/strategy-table";
import { lazy, Suspense, memo, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation, useOutletContext } from "react-router-dom";
import { Link } from "../shared/page-links";
import {
  RiArrowRightUpLine as ArrowUpRight,
  RiArrowRightSLine as ChevronRight,
  RiArrowDownSLine as ChevronDown,
  RiAlarmWarningLine as AlarmWarning,
  RiCheckboxCircleLine as CheckboxCircle,
  RiGridLine as LayoutGrid,
  RiListUnordered as List,
  RiQuestionLine as Question,
  RiEqualizer2Line as SlidersHorizontal,
} from "@remixicon/react";
import {
  resource,
  type Datum,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, Choices, decimalText, ErrorView, Loading } from "../shared/ui";
import { Page } from "./App";
import { History, useTelemetryValues } from "./strategy";

const WidgetBoard = lazy(() => import("../components/widget-board"));
const views = [
  ["cardsView", LayoutGrid],
  ["tableView", List],
] as const;
export function Home() {
  const { t } = useLanguage();
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const directory = useLocation().pathname === "/strategies";
  const attention = useOutletContext<Attention>();
  const [view, setView] = useState(localStorage.getItem("qb.strategyView") === "tableView" ? "tableView" : "cardsView");
  const [filter, setFilter] = useState("all");
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [limit, setLimit] = useState(50);
  const rows = strategies.data ?? [];
  const [featuredId, setFeaturedId] = useState("");
  const equitySources = useQueries({
    queries: !directory ? rows.map((strategy) =>
      resource<Datum[]>("/strategies/" + strategy.id + "/telemetry"),
    ) : [],
  });
  const featured = rows.find((strategy) => strategy.id === featuredId) ??
    rows.find((_, index) => equitySources[index]?.data?.some((item) => item.kind === "equity")) ??
    rows.find((strategy) => strategy.online) ?? rows[0];
  const groups = useMemo(
    () => [...new Set(rows.map((s) => s.group).filter(Boolean))].sort(),
    [rows],
  );
  const selected = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            (!search ||
              row.name.toLowerCase().includes(search.toLowerCase())) &&
            (!group || row.group === group) &&
            (filter === "all" || (filter === "online") === row.online),
        )
        .sort((a, b) =>
          sort === "lastSeen"
            ? b.lastSeen - a.lastSeen
            : a.name.localeCompare(b.name),
        ),
    [rows, search, group, filter, sort],
  );
  if (strategies.error)
    return (
      <ErrorView
        error={strategies.error}
        retry={() => void strategies.refetch()}
      />
    );
  if (!directory) return (
    <Page title={t("overview")}>
      <div className="overview-content grid">
        {strategies.isPending ? <Loading /> : featured ? (
          <PortfolioSnapshot key={featured.id} strategy={featured} picker={(
            <PortfolioPicker strategies={rows} selected={featured} select={setFeaturedId} />
          )} />
        ) : <Card><EmptyStrategies /></Card>}
        {strategies.isSuccess && (
          <div className="overview-operations">
            <StrategyStatus strategies={rows} selected={featured?.id ?? ""} select={setFeaturedId} />
            <OperationsQueue attention={attention} />
          </div>
        )}
        {!!featured && <Suspense fallback={<Loading />}><WidgetBoard /></Suspense>}
      </div>
    </Page>
  );

  return (
    <Page title={t("strategies")}>
      <section className="section portfolio-strategies strategy-directory">
        <div className="filter-bar">
          <Choices label={t("status")} value={filter}
            options={(["all", "online", "offline"] as const).map(value => ({ value, label: t(value) }))}
            select={setFilter} />
          {groups.length > 0 && (
            <label className="inline-filter">
              <span className="sr-only">{t("group")}</span>
              <NativeSelect
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <NativeSelectOption value="">{t("all")}</NativeSelectOption>
                {groups.map((g) => (
                  <NativeSelectOption key={g}>{g}</NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
          <div className="filter-spacer" />
          <NativeSelect
            aria-label={t("sort")}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <NativeSelectOption value="name">{t("name")}</NativeSelectOption>
            <NativeSelectOption value="lastSeen">{t("lastSeen")}</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="directory-toolbar">
          <Input type="search" aria-label={t("search")} placeholder={t("search")} value={search}
            onChange={event => setSearch(event.target.value)} className="strategy-search" />
          <div className="directory-view">
            <span className="muted tabular-nums">{selected.length} / {rows.length}</span>
            <Choices label={t("view")} value={view} options={views.map(([value, Icon]) => ({
              value, label: t(value), icon: <Icon size={16} />,
            }))} select={name => {
              setView(name);
              localStorage.setItem("qb.strategyView", name);
            }} />
          </div>
        </div>
        {strategies.isPending ? <Loading /> : !rows.length ? <EmptyStrategies /> :
         !selected.length ? (
          <div className="empty-state">
            <h2>{t("noMatchingStrategies")}</h2>
            <p>{t("noMatchingStrategiesHint")}</p>
            <Button variant="secondary" onClick={() => {
              setFilter("all"); setGroup(""); setSearch("");
            }}>{t("clearFilters")}</Button>
          </div>
         ) :
         <div className="panel-enter" key={view}>
          {view === "tableView" ? (
            <StrategyTable strategies={selected.slice(0, limit)} />
          ) : (
            <div className="strategy-grid view-compact">
              {selected.slice(0, limit).map(strategy => <StrategyCard key={strategy.id} strategy={strategy} />)}
            </div>
          )}
        </div>}
        {selected.length > limit && (
          <button className="load-more" onClick={() => setLimit(limit + 50)}>
            <ChevronDown />
            +50
          </button>
        )}
      </section>
    </Page>
  );
}

function EmptyStrategies() {
  const { t } = useLanguage();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><LayoutGrid aria-hidden="true" /></EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>{t("empty")}</EmptyTitle>
        <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Link className={buttonVariants()} to="/admin/strategies">{t("create")}</Link></EmptyContent>
    </Empty>
  );
}

function PortfolioPicker({ strategies, selected, select }: {
  strategies: Strategy[];
  selected: Strategy;
  select: (strategyId: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="overview-picker flex items-center gap-2">
      <Select value={selected.id} items={strategies.map(row => ({ value: row.id, label: row.name }))}
        onValueChange={id => { if (id) select(id); }}>
        <SelectTrigger aria-label={t("strategy")} className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {strategies.map(row => <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Link className={buttonVariants({ variant: "outline" })} to={"/strategies/" + selected.id}>
        {t("details")} <ArrowUpRight aria-hidden="true" />
      </Link>
    </div>
  );
}

function PortfolioSnapshot({ strategy, picker }: { strategy: Strategy; picker: ReactNode }) {
  const { t } = useLanguage();
  const { equity, performance, query: recordsQuery } = useTelemetryValues(strategy.id);
  const currency = typeof equity?.data.currency === "string" ? equity.data.currency : "";
  const pnl = performance?.data.dailyPnl;
  const sameAccount = !!equity && performance?.data.accountId === equity.data.accountId &&
    performance?.data.currency === equity.data.currency;
  return (
    <Card aria-labelledby="overview-equity" role="region" className="overview-equity min-w-0">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="portfolio-amount flex flex-col gap-1">
          <h2 id="overview-equity" className="text-lg font-medium">{t("equity")}</h2>
          <div className="overview-figure flex flex-wrap items-baseline gap-2">
                <span className="text-4xl font-medium tabular-nums md:text-5xl">{decimalText(equity?.data.value)}</span>
            {currency && <span className="muted text-sm">{currency}</span>}
          </div>
          {sameAccount && typeof pnl === "string" && (
            <p className={`text-sm tabular-nums ${pnl.startsWith("-") ? "danger" : "success"}`}>
              {t("dailyPnl")} {decimalText(pnl)}
            </p>
          )}
        </div>
        {picker}
      </CardHeader>
      <CardContent className="min-w-0">{equity ? (
        <History strategyId={strategy.id} embedded featured rangeBeforePlot seriesKind="equity"
          seriesKey={JSON.stringify([equity.data.accountId, currency])}
          instanceId={equity.instanceId} />
      ) : (
        <div className="overview-chart-empty grid place-items-center" aria-live="polite">
          {recordsQuery.isPending ? <Loading /> : recordsQuery.error ? <ErrorView error={recordsQuery.error} />
            : <p className="muted text-sm">{t("noEquityHistory")}</p>}
        </div>
      )}</CardContent>
    </Card>
  );
}

function OperationsQueue({ attention }: { attention: Attention }) {
  const { t } = useLanguage();
  const items = [
    { label: t("confirmation"), count: attention.waitingCount, to: "/admin/activity?status=confirmation_required", Icon: CheckboxCircle },
    { label: t("unknown"), count: attention.unknownCount, to: "/admin/activity?status=unknown", Icon: Question },
    { label: t("recentWarnings"), count: attention.recentCount, to: "/admin/alerts", Icon: AlarmWarning },
  ] as const;
  return (
    <Card role="region" aria-labelledby="overview-queue" className="overview-queue min-w-0">
      <CardHeader><h2 id="overview-queue" className="text-lg font-medium">{t("needsAttention")}</h2></CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {items.map(({ label, count, to, Icon }) => (
            <li key={to}>
              <Link to={to} className="overview-queue-link">
                <Icon size={17} aria-hidden="true" />
                <span>{label}</span>
                <Badge tone={count ? "warning" : "neutral"}>{count ?? "–"}</Badge>
                <ChevronRight size={16} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function StrategyStatus({ strategies, selected, select }: {
  strategies: Strategy[];
  selected: string;
  select: (strategyId: string) => void;
}) {
  const { t } = useLanguage();
  const online = strategies.filter(row => row.online).length;
  return (
    <Card role="region" aria-labelledby="overview-strategy-status" className="min-w-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-1">
          <h2 id="overview-strategy-status" className="text-lg font-medium">{t("strategyStatus")}</h2>
          <p className="muted flex flex-wrap gap-x-3 tabular-nums">
            <span>{online} {t("online")}</span>
            <span>{strategies.length - online} {t("offline")}</span>
          </p>
        </div>
        <Link className={buttonVariants({ variant: "ghost" })} to="/strategies">
          {t("allStrategies")} <ArrowUpRight aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ul className="divide-y divide-border">
          {strategies.slice(0, 5).map(row => {
            const status = t(row.online ? "online" : "offline");
            return (
              <li key={row.id}><Button variant="ghost" aria-pressed={row.id === selected} onClick={() => select(row.id)}
                className="h-auto min-h-11 w-full justify-between gap-2 py-2 text-left aria-pressed:bg-muted">
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{row.name}</span>
                  <span className="muted truncate text-xs">{[t(row.mode), row.group].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="overview-status-label flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className={"overview-status-dot" + (row.online ? " is-online" : "")} aria-hidden="true" />
                  {status}
                </span>
              </Button></li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
const StrategyCard = memo(function StrategyCard({ strategy }: { strategy: Strategy }) {
  const { t } = useLanguage();
  const values = useTelemetryValues(strategy.id);
  const error = values.records.some(
    (r) => r.kind === "status" && r.data.state === "error",
  );
  const hasEquity = values.equity?.data.value != null;
  const hasPnl = values.performance?.data.dailyPnl != null;
  return (
    <article className={"strategy-card surface " + (error ? "has-error" : "")}>
      <header>
        <span
          className={"connection-dot " + (strategy.online ? "online" : "")}
        />
        <Link to={"/strategies/" + strategy.id}>
          <h3>{strategy.name}</h3>
        </Link>
        <Badge
          tone={error ? "danger" : strategy.online ? "success" : "neutral"}
        >
          {error ? t("abnormal") : strategy.online ? t("online") : t("offline")}
        </Badge>
      </header>
      <div className="strategy-tags">
        {strategy.group && <Badge>{strategy.group}</Badge>}
        <Badge tone={strategy.mode === "live" ? "warning" : ""}>
          {t(strategy.mode)}
        </Badge>
      </div>
      {hasEquity || hasPnl ? (
        <div className="card-values">
          {hasEquity && (
            <div>
              <span>{t("equity")}</span>
              <strong>
                {decimalText(values.equity?.data.value)}{" "}
                <small>{String(values.equity?.data.currency ?? "")}</small>
              </strong>
            </div>
          )}
          {hasPnl && (
            <div>
              <span>{t("dailyPnl")}</span>
              <strong className={String(values.performance?.data.dailyPnl).startsWith("-") ? "danger" : ""}>
                {decimalText(values.performance?.data.dailyPnl)}
              </strong>
            </div>
          )}
        </div>
      ) : (
        <div className="qb-card-no-financial">
          <span className={"connection-dot " + (strategy.online ? "online" : "")} />
          <span>{t("missing")}</span>
        </div>
      )}
      <footer>
        <span className="muted">
          {strategy.lastSeen
            ? new Date(strategy.lastSeen * 1000).toLocaleTimeString()
            : t("notConnected")}
        </span>
        <Link
          to={"/strategies/" + strategy.id}
          aria-label={strategy.name + " " + t("controls")}
        >
          <SlidersHorizontal size={16} />
          <ArrowUpRight size={15} />
        </Link>
      </footer>
    </article>
  );
});
