import { label, t } from "../i18n";
import { Activity, ArrowDownLeft, ArrowUpRight, CircleAlert, CircleOff, Plus, Radio, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { strategyPath, type Overview, type Strategy } from "./api";
import { CommandBadge, Empty, ErrorNotice, Loading, PageTitle, Panel, StatusBadge, Table, TextLink, categoryText, modeText, money, observed, relative, useData, when } from "./ui";

export function StrategyTable({ rows }: { rows: Strategy[] }) {
  return <div className="strategy-table"><Table columns={[t("onboarding.strategyName"), t("onboarding.tradingMode"), t("onboarding.group"), t("onboarding.connection"), t("overview.lastSeen"), ""]} empty={!rows.length}>
    {rows.map((s) => <tr key={s.id}><td><a className="strategy-name" href={strategyPath(s.id)}>
      <span className="strategy-icon"><Activity size={17} /></span><span>{s.name}
        {!!s.tags.length && <small>{s.tags.join(" · ")}</small>}</span></a></td>
      <td><span className="mode">{label(modeText[s.mode])}</span></td><td>{s.group || "—"}</td>
      <td><StatusBadge status={s.status} /></td><td className="subtle mono">{relative(s.last_seen)}</td>
      <td><a className="icon-button" aria-label={t("overview.open", { name: s.name })} href={strategyPath(s.id)}><ArrowUpRight size={16} /></a></td></tr>)}
  </Table></div>;
}

export function OverviewPage({ add }: { add: () => void }) {
  const query = useData<Overview>("overview");
  const data = query.data;
  const counts = data?.counts;
  const strategies = new Map(data?.strategies.map((strategy) => [strategy.id, strategy]));
  return <>
    <PageTitle title={t("overview.overview")} sub={t("overview.strategyConnectionsTradingActivityAndControlReceipts")}
      action={<button className="button primary" onClick={add}><Plus size={18} /> {t("onboarding.addStrategy")}</button>} />
    <ErrorNotice error={query.error} />
    {!data ? <Loading /> : <>
      <div className="summary-grid no-account-total">
        {([
          [t("overview.onlineStrategies"), counts?.online, Radio, "green"],
          [t("overview.offlineStrategies"), counts?.offline, CircleOff, "neutral"],
          [t("overview.unhealthyStrategies"), counts?.abnormal, CircleAlert, "orange"],
        ] as const).map(([label, count, Icon, tone]) =>
          <section className="panel stat" key={label}><div><span>{label}</span><span className={`stat-icon ${tone}`}><Icon size={19} /></span></div>
            <strong>{count}</strong></section>)}
      </div>
      {!!data.accounts.length && <section className="account-overview" aria-label={t("overview.accountFunds")}>
        <h2>{t("overview.accountFunds")}</h2>
        <div className="account-grid">
        {data.accounts.map((account) => {
          const strategy = strategies.get(account.strategy_id);
          return <section className="panel stat equity-stat" key={`${account.strategy_id}/${account.account_id}/${account.currency}`}>
            <div><a href={strategyPath(account.strategy_id, "funds")}>{strategy?.name ?? account.strategy_id}</a><span>{account.account_id}</span></div>
            <strong>{money(account.equity, account.currency)}</strong>
            <small>{t("overview.dailyPL")}{" "}<span className={account.daily_pnl == null || Number(account.daily_pnl) === 0 ? undefined : account.daily_pnl.startsWith("-") ? "pnl-loss" : "pnl-gain"}>{money(account.daily_pnl, account.currency)}</span></small>
            <small>{observed(account.observed_at, strategy?.status === "offline")}</small>
          </section>;
        })}
        </div>
      </section>}
      <Panel title={t("overview.strategyStatus")} hint={t("overview.strategies", { total: data.strategies.length })} action={<TextLink href="#strategies">{t("overview.manageStrategies")}</TextLink>}>
        {data.strategies.length ? <StrategyTable rows={data.strategies.slice(0, 10)} /> :
          <Empty title={t("overview.noConnectedStrategies")} text={t("overview.createAStrategyAndGenerateAToken")}
            action={<button className="button secondary" onClick={add}><Plus size={15} /> {t("overview.createStrategy")}</button>} />}
      </Panel>
      <div className="activity-grid">
        <Panel title={t("overview.recentFills")}>
          {!data.recent_fills.length ? <Empty title={t("overview.noFillsReported")} /> : <ul className="activity-list">{data.recent_fills.map((item) => <li key={`${item.strategy_id}/${item.id}`}>
            <span className="activity-icon"><ArrowDownLeft size={15} /></span><div><a href={strategyPath(item.strategy_id, "orders")}>{item.fill?.symbol} · {item.fill?.side === "buy" ? t("overview.buy") : t("overview.sell")}</a>
              <small>{item.fill?.quantity} @ {item.fill?.price} {item.fill?.currency}</small></div><time>{when(item.occurred_at)}</time>
          </li>)}</ul>}
        </Panel>
        <Panel title={t("overview.recentAlerts")} action={<TextLink href="#telegram">{t("app.notifications")}</TextLink>}>
          {!data.alerts.length ? <Empty title={t("overview.noAlerts")} /> : <ul className="activity-list">{data.alerts.map((item) => <li key={item.id}>
            <span className={`activity-icon ${["error", "critical", "warning"].includes(item.severity) ? "warn" : ""}`}><CircleAlert size={15} /></span>
            <div><strong>{label(categoryText[item.category], item.category)}</strong><small>{item.message}</small></div>
            <time>{when(item.created_at)}</time>
          </li>)}</ul>}
        </Panel>
        <Panel title={t("overview.recentInstructions")} action={<TextLink href="#operations">{t("app.operations")}</TextLink>}>
          {!data.commands.length ? <Empty title={t("overview.noRemoteCommands")} /> : <ul className="activity-list">{data.commands.map((item) => <li key={item.id}>
            <div><a href={`#operations/${item.id}`} className="mono">{item.action}</a><small>{when(item.created_at)}</small></div>
            <CommandBadge state={item.state} />
          </li>)}</ul>}
        </Panel>
      </div>
    </>}
  </>;
}

export function StrategiesPage({ add }: { add: () => void }) {
  const [archived, setArchived] = useState(false);
  const [term, setTerm] = useState("");
  const [group, setGroup] = useState("");
  const query = useData<Strategy[]>(archived ? "strategies/archived" : "strategies");
  const strategies = query.data;
  const groups = useMemo(() => [...new Set(strategies?.map((s) => s.group).filter(Boolean))].sort(), [strategies]);
  const result = strategies?.filter((s) =>
    (!group || s.group === group) && [s.name, s.id, s.group, ...s.tags].join(" ").toLowerCase().includes(term.trim().toLowerCase()));
  return <>
    <PageTitle title={t("app.strategies")} sub={t("overview.manageStrategyIdentityGroupsAndApiIntegration")} action={<button className="button primary" onClick={add}><Plus size={18} /> {t("onboarding.addStrategy")}</button>} />
    <Panel>
      <div className="toolbar"><div className="search"><Search size={16} /><input aria-label={t("overview.searchStrategies")} placeholder={t("overview.searchNamesTagsOrStrategyIds")} value={term} onChange={(e) => setTerm(e.target.value)} /></div>
        <select aria-label={t("overview.filterGroups")} value={group} onChange={(e) => setGroup(e.target.value)}><option value="">{t("overview.allGroups")}</option>
          {groups.map((item) => <option key={item}>{item}</option>)}</select>
        <label className="checkbox"><input type="checkbox" checked={archived} onChange={(e) => { setGroup(""); setArchived(e.target.checked); }} /> {t("overview.archived")}</label>
      </div>
      <ErrorNotice error={query.error} />{query.isPending ? <Loading /> :
        !result?.length ? <Empty title={term || group ? t("overview.noMatchingStrategies") : archived ? t("overview.noArchivedStrategies") : t("overview.noStrategies")} /> :
          <StrategyTable rows={result} />}
    </Panel>
  </>;
}
