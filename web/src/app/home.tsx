import { lazy, Suspense, memo, useContext, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  SlidersHorizontal,
  Square,
  AlignJustify,
} from "lucide-react";
import {
  resource,
  type Command,
  type Datum,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, decimalText, ErrorView, Loading } from "../shared/ui";
import { ThemeContext } from "../themes/catalog";
import { Page } from "./App";
import { History, useTelemetryValues } from "./strategy";

const WidgetBoard = lazy(() => import("../components/widget-board"));
const views = [
  ["large", Square],
  ["compact", LayoutGrid],
  ["mini", AlignJustify],
  ["list", List],
] as const;
export function Home() {
  const { t } = useLanguage();
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const commands = useQuery(
    resource<Command[]>("/commands?status=confirmation_required"),
  );
  const presentation = useContext(ThemeContext);
  const portfolio = useLocation().pathname === "/" && presentation.portfolio;
  const [savedView, setView] = useState(localStorage.getItem("qb.view"));
  const view = savedView ?? (portfolio ? "list" : presentation.cardView ?? "compact");
  const sectionOrder = (name: string, fallback: number) => {
    const index = presentation.sections?.indexOf(name) ?? -1;
    return index >= 0 ? index : (presentation.sections?.length ?? 0) + fallback;
  };
  const [filter, setFilter] = useState("all");
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [limit, setLimit] = useState(50);
  const rows = strategies.data ?? [];
  const [featuredId, setFeaturedId] = useState("");
  const equitySources = useQueries({
    queries: portfolio ? rows.map((strategy) =>
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
  const summary = [
    {
      label: t("online"),
      value: rows.filter((row) => row.online).length,
      tone: "success",
    },
    {
      label: t("offline"),
      value: rows.filter((row) => !row.online).length,
      tone: "neutral",
    },
    {
      label: t("confirmation"),
      value: commands.data?.length ?? 0,
      tone: "warning",
    },
  ];
  if (strategies.error)
    return (
      <ErrorView
        error={strategies.error}
        retry={() => void strategies.refetch()}
      />
    );
  return (
    <Page
      title={portfolio ? "" : t("overview")}
      actions={
        <Link className="button" to="/controls">
          <SlidersHorizontal size={16} />
          {t("controls")}
        </Link>
      }
    >
      <div className={"workbench-sections" + (portfolio && featured ? " portfolio-dashboard" : "")}>
        {portfolio && featured && (
          <PortfolioOverview strategies={rows} selected={featured} select={setFeaturedId} />
        )}
        <section
          className="summary-grid portfolio-summary"
          style={{ order: sectionOrder("overview", 0) }}
        >
          {summary.map((item) => (
            <div className="summary-card" key={item.label}>
              <span className="muted">{item.label}</span>
              <strong className={item.tone}>
                {strategies.isPending ? "—" : item.value}
                <span className={"connection-dot " + item.tone} />
              </strong>
            </div>
          ))}
          <AbnormalCount strategies={rows} />
        </section>
        <section
          className="section portfolio-strategies"
          style={{ order: sectionOrder("strategies", 1) }}
        >
          <div className="section-heading">
            <h2>
              {t("strategies")}{" "}
              <span className="muted count">{rows.length}</span>
            </h2>
            <div className="view-switch" role="group" aria-label={t("view")}>
              {views.map(([name, Icon]) => (
                <button
                  key={name}
                  aria-label={t(name)}
                  aria-pressed={view === name}
                  onClick={() => {
                    setView(name);
                    localStorage.setItem("qb.view", name);
                  }}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
          </div>
          <div className="filter-bar">
            <div className="segmented">
              {(["all", "online", "offline"] as const).map((item) => (
                <button
                  key={item}
                  aria-pressed={filter === item}
                  onClick={() => setFilter(item)}
                >
                  {t(item)}
                </button>
              ))}
            </div>
            {groups.length > 0 && (
              <label className="inline-filter">
                <span className="sr-only">{t("group")}</span>
                <select
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">{t("all")}</option>
                  {groups.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="filter-spacer" />
            <label className="search-field">
              <Search size={16} />
              <input
                placeholder={t("search")}
                aria-label={t("search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label={t("sort")}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="name">{t("name")}</option>
              <option value="lastSeen">{t("lastSeen")}</option>
            </select>
          </div>
          {strategies.isPending ? (
            <Loading />
          ) : !rows.length ? (
            <div className="empty-state surface">
              <LayoutGrid size={30} />
              <h2>{t("empty")}</h2>
              <p>{t("emptyDescription")}</p>
              <Link className="button primary" to="/admin/strategies">
                {t("create")}
              </Link>
            </div>
          ) : (
            <div className={"strategy-grid view-" + view}>
              {selected.slice(0, limit).map((strategy) => (
                <StrategyCard
                  key={strategy.id}
                  strategy={strategy}
                  view={view}
                  portfolio={portfolio}
                />
              ))}
            </div>
          )}
          {selected.length > limit && (
            <button className="load-more" onClick={() => setLimit(limit + 50)}>
              <ChevronDown />
              +50
            </button>
          )}
        </section>
        <div className="portfolio-widgets" style={{ order: sectionOrder("strategies", 1) + 0.5 }}>
          <Suspense fallback={<Loading />}>
            <WidgetBoard />
          </Suspense>
        </div>
        <div className="portfolio-activity" style={{ order: sectionOrder("activity", 2) }}>
          {portfolio && featured && <HoldingsPreview strategyId={featured.id} />}
          <RecentActivity />
        </div>
      </div>
    </Page>
  );
}

function PortfolioOverview({ strategies, selected, select }: {
  strategies: Strategy[];
  selected: Strategy;
  select: (strategyId: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <section className="portfolio-hero surface">
      <header className="portfolio-toolbar">
        <nav className="portfolio-tabs" aria-label={t("workbench")}>
          <Link to="/" aria-current="page"><LayoutGrid size={14} />{t("overview")}</Link>
          <Link to="/strategies"><Square size={14} />{t("strategies")}</Link>
          <Link to="/controls"><SlidersHorizontal size={14} />{t("controls")}</Link>
        </nav>
        <div className="actions">
          <select
            aria-label={t("strategy")}
            value={selected.id}
            onChange={(event) => select(event.target.value)}
          >
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
            ))}
          </select>
          <Link className="icon-button button" to={"/strategies/" + selected.id}
            aria-label={t("details")} title={t("details")}>
            <ArrowUpRight size={16} />
          </Link>
        </div>
      </header>
      <PortfolioSnapshot key={selected.id} strategyId={selected.id} />
    </section>
  );
}

function HoldingsPreview({ strategyId }: { strategyId: string }) {
  const { t } = useLanguage();
  const { records, query } = useTelemetryValues(strategyId);
  const positions = records
    .filter((row) => row.kind === "position")
    .flatMap((row) => {
      const items = (row.data.positions ?? []) as Record<string, unknown>[];
      return items.map((item) => ({ item, source: row.data.source, instance: row.instanceId }));
    });
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{t("positions")}</h2>
        <Link className="text-button" to={"/strategies/" + strategyId}>
          {t("details")} <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="surface">
        {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} /> :
          positions.length ? positions.slice(0, 6).map(({ item, source, instance }, index) => (
            <div className="portfolio-holding" key={JSON.stringify([instance, source, item.accountId, item.positionId, index])}>
              <span>
                <strong>{String(item.symbol ?? item.positionId ?? "—")}</strong>
                <small className="muted">{String(item.accountId ?? "")}</small>
              </span>
              <span>
                <strong>{decimalText(item.quantity)}</strong>
                <small className="muted">{t("holdingQuantity")}</small>
              </span>
            </div>
          )) : <p className="empty-inline">{t("missing")}</p>}
      </div>
    </section>
  );
}

function PortfolioSnapshot({ strategyId }: { strategyId: string }) {
  const { t } = useLanguage();
  const { equity, performance } = useTelemetryValues(strategyId);
  const currency = typeof equity?.data.currency === "string" ? equity.data.currency : "";
  const pnl = performance?.data.dailyPnl;
  const sameAccount = !!equity && performance?.data.accountId === equity.data.accountId &&
    performance?.data.currency === equity.data.currency;
  return (
    <>
      <div className="portfolio-amount">
        <span className="muted">{t("equity")}</span>
        <strong>{decimalText(equity?.data.value)} <small>{currency}</small></strong>
        {sameAccount && typeof pnl === "string" && (
          <span className={pnl.startsWith("-") ? "danger" : "success"}>
            {t("dailyPnl")} {decimalText(pnl)}
          </span>
        )}
      </div>
      {equity && (
        <History strategyId={strategyId} embedded featured seriesKind="equity"
          seriesKey={JSON.stringify([equity.data.accountId, currency])}
          instanceId={equity.instanceId} />
      )}
    </>
  );
}
function AbnormalCount({ strategies }: { strategies: Strategy[] }) {
  const { t } = useLanguage();
  const snapshots = useQueries({
    queries: strategies.map((strategy) =>
      resource<Datum[]>("/strategies/" + strategy.id + "/telemetry"),
    ),
  });
  const count = snapshots.filter(
    (query, index) =>
      strategies[index]?.online &&
      query.data?.some(
        (record) => record.kind === "status" && record.data.state === "error",
      ),
  ).length;
  return (
    <div className="summary-card">
      <span className="muted">{t("abnormal")}</span>
      <strong className="danger">
        {count}
        <span className="connection-dot danger" />
      </strong>
    </div>
  );
}
const StrategyCard = memo(function StrategyCard({
  strategy,
  view,
  portfolio = false,
}: {
  strategy: Strategy;
  view: string;
  portfolio?: boolean;
}) {
  const { t } = useLanguage();
  const values = useTelemetryValues(strategy.id);
  const error = values.records.some(
    (r) => r.kind === "status" && r.data.state === "error",
  );
  if (portfolio && view === "list") return (
    <Link className="portfolio-strategy-row" to={"/strategies/" + strategy.id}>
      <span className="portfolio-strategy-identity">
        <strong>{strategy.name}</strong>
        <span className="muted">
          <span className={"connection-dot " + (strategy.online ? "online" : "")} />
          {error ? t("abnormal") : t(strategy.online ? "online" : "offline")}
          {" · "}{strategy.group || t(strategy.mode)}
        </span>
      </span>
      <span className="portfolio-strategy-value">
        <strong>{hasEquity ? decimalText(values.equity?.data.value) : "—"}{" "}
          <small>{String(values.equity?.data.currency ?? "")}</small>
        </strong>
        <span className={String(values.performance?.data.dailyPnl).startsWith("-") ? "danger" : "muted"}>
          {hasPnl ? t("dailyPnl") + " " + decimalText(values.performance?.data.dailyPnl) : t("missing")}
        </span>
      </span>
      <ArrowUpRight size={16} className="muted" />
    </Link>
  );
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
      <div className="card-values">
        <div>
          <span>{t("equity")}</span>
          <strong>
            {decimalText(values.equity?.data.value)}{" "}
            <small>{String(values.equity?.data.currency ?? "")}</small>
          </strong>
        </div>
        {view !== "mini" && (
          <div>
            <span>{t("dailyPnl")}</span>
            <strong
              className={
                String(values.performance?.data.dailyPnl ?? "").startsWith("-")
                  ? "danger"
                  : ""
              }
            >
              {decimalText(values.performance?.data.dailyPnl)}
            </strong>
          </div>
        )}
      </div>
      {view === "large" && (
        <dl className="compact-dl">
          <dt>{t("drawdown")}</dt>
          <dd>{decimalText(values.equity?.data.drawdown)}</dd>
          <dt>{t("executor")}</dt>
          <dd>{strategy.executorInstance ?? t("noExecutor")}</dd>
        </dl>
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
function RecentActivity() {
  const { t } = useLanguage();
  const query = useQuery(resource<Command[]>("/commands"));
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{t("recent")}</h2>
        <Link className="text-button" to="/activity">
          {t("all")} <ArrowUpRight size={15} />
        </Link>
      </div>
      <div className="surface">
        {(query.data ?? []).slice(0, 5).map((cmd) => (
          <Link
            className="activity-line"
            key={cmd.id}
            to={"/strategies/" + cmd.strategyId}
          >
            <span>{cmd.controlId}</span>
            <Badge tone={cmd.status === "unknown" ? "danger" : ""}>
              {t(cmd.status as "pending")}
            </Badge>
            <time>{new Date(cmd.updatedAt).toLocaleString()}</time>
          </Link>
        ))}
        {!query.data?.length && <p className="empty-inline">{t("noEvents")}</p>}
      </div>
    </section>
  );
}
