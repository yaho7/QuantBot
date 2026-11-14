import { ArrowUpRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { strategyApi, strategyPath, workbenchPath, type Detail, type Overview } from "./api";
import DashboardBuilder from "./dashboard-builder";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, money, useData } from "./ui";

const selectionKey = "quantbot.workbench.strategy";

export default function Workbench({ strategyId, focus, add }: { strategyId?: string; focus?: string; add: () => void }) {
  const overview = useData<Overview>("overview");
  const active = overview.data?.strategies.filter((item) => !item.archived_at) ?? [];
  const [remembered, remember] = useState(() => {
    try { return localStorage.getItem(selectionKey); }
    catch { return null; }
  });
  const fallback = active.find((item) => item.id === remembered)?.id ?? (active.length === 1 ? active[0]?.id : undefined);
  const selected = strategyId === "all" ? undefined : strategyId ?? (remembered === "all" ? undefined : fallback);
  useEffect(() => {
    if (!strategyId || strategyId === remembered || (strategyId !== "all" && !active.some((item) => item.id === strategyId))) return;
    remember(strategyId);
    try { localStorage.setItem(selectionKey, strategyId); } catch { /* Storage may be disabled. */ }
  }, [active, remembered, strategyId]);
  return <div className="workbench-page">
    <PageTitle title={t("app.workbench")} action={<div className="workbench-tools">
        <Field label={t("workbench.currentStrategy")}>
          <select value={selected ?? ""} onChange={(event) => { location.hash = workbenchPath(event.target.value || "all"); }}>
            <option value="">{t("workbench.allStrategies")}</option>
            {active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            {selected && !active.some((item) => item.id === selected) && <option value={selected}>{t("workbench.currentStrategy")}</option>}
          </select>
        </Field>
        <button type="button" className="button secondary" onClick={add}><Plus size={16} /> {t("onboarding.addStrategy")}</button>
      </div>} />
    <ErrorNotice error={overview.error} />
    {selected ? <StrategyWorkbench key={selected} strategyId={selected} focus={focus} /> : overview.isPending ? <Loading /> :
      active.length ? <div className="summary-grid workbench-strategies">{active.map((item) => <Panel key={item.id} title={item.name}
        action={<StatusBadge status={item.status} />}>
        <div className="strategy-card-body">
          {overview.data?.accounts.filter((account) => account.strategy_id === item.id).map((account) =>
            <p key={`${account.account_id}/${account.currency}`}>{account.account_id} · {money(account.equity, account.currency)}</p>)}
          <a className="button quiet" href={workbenchPath(item.id)}>{t("strategy.openWorkbench")} <ArrowUpRight size={15} /></a>
        </div>
      </Panel>)}</div> : <Empty title={t("workbench.noStrategiesYet")} action={<a className="button primary" href="#strategies">{t("workbench.goToStrategies")}</a>} />}
    {!selected && !!active.length && <a className="text-link" href="#overview">{t("workbench.viewOverview")}</a>}
  </div>;
}

function StrategyWorkbench({ strategyId, focus }: { strategyId: string; focus?: string }) {
  const detail = useData<Detail>(strategyApi(strategyId));
  return <>
    <ErrorNotice error={detail.error} />
    {detail.isPending && <Loading />}
    {detail.data && <DashboardBuilder strategy={detail.data} focus={focus} workbenchContext={<>
      <div className="workbench-identity">
        <h2 dir="auto" title={detail.data.name}>{detail.data.name}</h2>
        <StatusBadge status={detail.data.status} />
      </div>
      <a className="text-link" href={strategyPath(strategyId)}>{t("strategy.strategyDetails")} <ArrowUpRight size={15} aria-hidden="true" /></a>
    </>} />}
  </>;
}
