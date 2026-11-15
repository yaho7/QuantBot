import { StrategyTable } from "../components/strategy-table";
import { lazy, Suspense, memo, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Link } from "../shared/page-links";
import {
  ArrowUpRight,
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  resource,
  type Datum,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, decimalText, ErrorView, Loading } from "../shared/ui";
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
    <Page title={t("overview")} actions={featured && (
      <PortfolioPicker strategies={rows} selected={featured} select={setFeaturedId} />
    )}>
      <div className="overview-content">
        {strategies.isPending ? <Loading /> : featured ? (
          <section className="portfolio-hero surface">
            <PortfolioSnapshot key={featured.id} strategyId={featured.id} />
          </section>
        ) : <EmptyStrategies />}
        {!!featured && <Suspense fallback={<Loading />}><WidgetBoard /></Suspense>}
      </div>
    </Page>
  );

  return (
    <Page title={t("strategies")}>
      <section className="section portfolio-strategies strategy-directory">
        <div className="section-heading">
          <span className="muted">{rows.length} · {t("strategies")}</span>
            <div className="view-switch" role="group" aria-label={t("view")}>
            {views.map(([name, Icon]) => (
              <button
                key={name}
                aria-label={t(name)}
                aria-pressed={view === name}
                onClick={() => {
                  setView(name);
                  localStorage.setItem("qb.strategyView", name);
                }}
              >
                <Icon size={17} /> {t(name)}
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
        {strategies.isPending ? <Loading /> : !rows.length ? <EmptyStrategies /> :
         !selected.length ? <p className="empty-inline">{t("noMatchingStrategies")}</p> :
         view === "tableView" ? (
          <StrategyTable strategies={selected.slice(0, limit)} />
        ) : (
          <div className="strategy-grid view-compact">
            {selected.slice(0, limit).map((strategy) => (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
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
    </Page>
  );
}

function EmptyStrategies() {
  const { t } = useLanguage();
  return <div className="empty-state surface">
    <LayoutGrid size={30} />
    <h2>{t("empty")}</h2>
    <p>{t("emptyDescription")}</p>
    <Link className="button primary" to="/admin/strategies">{t("create")}</Link>
  </div>;
}

function PortfolioPicker({ strategies, selected, select }: {
  strategies: Strategy[];
  selected: Strategy;
  select: (strategyId: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <>
      <select aria-label={t("strategy")} value={selected.id} onChange={event => select(event.target.value)}>
        {strategies.map(strategy => (
          <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
        ))}
      </select>
      <Link className="icon-button button" to={"/strategies/" + selected.id}
        aria-label={t("details")} title={t("details")}>
        <ArrowUpRight size={16} />
      </Link>
    </>
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
const StrategyCard = memo(function StrategyCard({ strategy }: { strategy: Strategy }) {
  const { t } = useLanguage();
  const values = useTelemetryValues(strategy.id);
  const error = values.records.some(
    (r) => r.kind === "status" && r.data.state === "error",
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
        {(
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
