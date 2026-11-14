import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { strategyApi, strategyPath, workbenchPath, type Detail, type Overview, type Strategy } from "./api";
import DashboardBuilder from "./dashboard-builder";
import { ActionPopover, Empty, ErrorNotice, Loading, PageTitle, Panel, StatusBadge, money, useData } from "./ui";

const selectionKey = "quantbot.workbench.strategy";

export default function Workbench({ strategyId, focus }: { strategyId?: string; focus?: string }) {
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
  const picker = (name?: string) => <StrategyPicker strategy={selected} name={name} choices={active} select={(id) => {
    remember(id);
    try { localStorage.setItem(selectionKey, id); } catch { /* Storage may be disabled. */ }
  }} />;
  return <div className="workbench-page">
    <PageTitle title={t("app.workbench")} />
    <ErrorNotice error={overview.error} />
    {selected ? <StrategyWorkbench key={selected} strategyId={selected} focus={focus} picker={picker} /> : overview.isPending ? <Loading /> :
      active.length ? <><div className="workbench-identity">{picker()}</div><div className="summary-grid workbench-strategies">{active.map((item) => <Panel key={item.id} title={item.name}
        action={<StatusBadge status={item.status} />}>
        <div className="strategy-card-body">
          {overview.data?.accounts.filter((account) => account.strategy_id === item.id).map((account) =>
            <p key={`${account.account_id}/${account.currency}`}>{account.account_id} · {money(account.equity, account.currency)}</p>)}
          <a className="button quiet" href={workbenchPath(item.id)}>{t("strategy.openWorkbench")} <ArrowUpRight size={15} /></a>
        </div>
      </Panel>)}</div></> : <Empty title={t("workbench.noStrategiesYet")} action={<a className="button primary" href="#strategies">{t("workbench.goToStrategies")}</a>} />}
    {!selected && !!active.length && <a className="text-link" href="#overview">{t("workbench.viewOverview")}</a>}
  </div>;
}

function StrategyPicker({ strategy, name, choices, select }: {
  strategy?: string; name?: string; choices: Strategy[]; select: (id: string) => void;
}) {
  const options = [{ id: "all", name: t("workbench.allStrategies") }, ...choices];
  const current = strategy ?? "all";
  return <ActionPopover className="button quiet strategy-picker" label={t("workbench.currentStrategy")}
    trigger={<><span dir="auto">{name ?? t("workbench.allStrategies")}</span><ChevronDown size={15} aria-hidden="true" /></>}>
    {(close) => options.map((item) => <a key={item.id} href={workbenchPath(item.id)} onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      select(item.id);
      close();
    }}
      aria-current={current === item.id ? "true" : undefined}>
      <span dir="auto">{item.name}</span>{current === item.id && <Check size={15} aria-hidden="true" />}
    </a>)}
  </ActionPopover>;
}

function StrategyWorkbench({ strategyId, focus, picker }: { strategyId: string; focus?: string; picker: (name?: string) => ReactNode }) {
  const detail = useData<Detail>(strategyApi(strategyId));
  return <>
    <ErrorNotice error={detail.error} />
    {detail.isPending && <Loading />}
    {!detail.data && !detail.isPending && <div className="workbench-identity">{picker(t("workbench.currentStrategy"))}</div>}
    {detail.data && <DashboardBuilder strategy={detail.data} focus={focus} workbenchContext={
      <div className="workbench-identity">
        {picker(detail.data.name)}
        <StatusBadge status={detail.data.status} />
        <a className="icon-button" href={strategyPath(strategyId)} aria-label={t("strategy.strategyDetails")}
          title={t("strategy.strategyDetails")}><ArrowUpRight size={17} aria-hidden="true" /></a>
      </div>
    } />}
  </>;
}
