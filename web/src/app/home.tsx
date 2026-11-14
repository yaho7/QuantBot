import { lazy, Suspense, memo, useContext, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
import { useTelemetryValues } from "./strategy";

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
  const [savedView, setView] = useState(localStorage.getItem("qb.view"));
  const view = savedView ?? presentation.cardView ?? "compact";
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
      title={t("overview")}
      actions={
        <Link className="button" to="/controls">
          <SlidersHorizontal size={16} />
          {t("controls")}
        </Link>
      }
    >
      <div className="workbench-sections">
        <section
          className="summary-grid"
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
          className="section"
          style={{ order: sectionOrder("strategies", 1) }}
        >
          <div className="section-heading">
            <h2>
              {t("strategies")}{" "}
              <span className="muted count">{rows.length}</span>
            </h2>
            <div className="view-switch" role="group" aria-label="View">
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
              aria-label="Sort"
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
        <div style={{ order: sectionOrder("strategies", 1) + 0.5 }}>
          <Suspense fallback={<Loading />}>
            <WidgetBoard />
          </Suspense>
        </div>
        <div style={{ order: sectionOrder("activity", 2) }}>
          <RecentActivity />
        </div>
      </div>
    </Page>
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
}: {
  strategy: Strategy;
  view: string;
}) {
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
