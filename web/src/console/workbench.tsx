import { t } from "../i18n";
import { strategyApi, strategyPath, workbenchPath, type Detail, type Overview } from "./api";
import DashboardBuilder from "./dashboard-builder";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, money, useData } from "./ui";

export default function Workbench({ strategyId, focus, add }: { strategyId?: string; focus?: string; add: () => void }) {
  const overview = useData<Overview>("overview");
  const active = overview.data?.strategies.filter((item) => !item.archived_at) ?? [];
  return <div className="stack">
    <PageTitle title={t("app.workbench")} action={<div className="toolbar"><Field label={t("workbench.currentStrategy")}>
      <select value={strategyId ?? ""} onChange={(event) => { location.hash = workbenchPath(event.target.value); }}>
        <option value="">{t("workbench.allStrategies")}</option>
        {active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {strategyId && !active.some((item) => item.id === strategyId) && <option value={strategyId}>{t("workbench.currentStrategy")}</option>}
      </select>
    </Field><button type="button" className="button secondary" onClick={add}>{t("onboarding.addStrategy")}</button></div>} />
    <ErrorNotice error={overview.error} />
    {strategyId ? <StrategyWorkbench key={strategyId} strategyId={strategyId} focus={focus} /> : overview.isPending ? <Loading /> :
      active.length ? <div className="summary-grid">{active.map((item) => <Panel key={item.id} title={item.name}
        action={<StatusBadge status={item.status} />}>
        {overview.data?.accounts.filter((account) => account.strategy_id === item.id).map((account) =>
          <p key={`${account.account_id}/${account.currency}`}>{account.account_id} · {money(account.equity, account.currency)}</p>)}
        <a className="button secondary" href={workbenchPath(item.id)}>{t("strategy.openWorkbench")}</a>
      </Panel>)}</div> : <Empty title={t("workbench.noStrategiesYet")} action={<a className="button primary" href="#strategies">{t("workbench.goToStrategies")}</a>} />}
    {!strategyId && !!active.length && <a href="#overview">{t("workbench.viewOverview")}</a>}
  </div>;
}

function StrategyWorkbench({ strategyId, focus }: { strategyId: string; focus?: string }) {
  const detail = useData<Detail>(strategyApi(strategyId));
  return <>
    <ErrorNotice error={detail.error} />
    {detail.isPending && <Loading />}
    {detail.data && <>
      <div className="toolbar workbench-status"><strong>{detail.data.name}</strong><StatusBadge status={detail.data.status} />
        <a href={strategyPath(strategyId)}>{t("strategy.strategyDetails")}</a></div>
      <DashboardBuilder strategy={detail.data} workbench focus={focus} />
    </>}
  </>;
}
