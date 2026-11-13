import { strategyApi, strategyPath, workbenchPath, type Detail, type Overview } from "./api";
import DashboardBuilder from "./dashboard-builder";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, money, useData } from "./ui";

export default function Workbench({ strategyId, focus, add }: { strategyId?: string; focus?: string; add: () => void }) {
  const overview = useData<Overview>("overview");
  const active = overview.data?.strategies.filter((item) => !item.archived_at) ?? [];
  return <div className="stack">
    <PageTitle title="工作台" action={<div className="toolbar"><Field label="当前策略">
      <select value={strategyId ?? ""} onChange={(event) => { location.hash = workbenchPath(event.target.value); }}>
        <option value="">全部策略</option>
        {active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {strategyId && !active.some((item) => item.id === strategyId) && <option value={strategyId}>当前策略</option>}
      </select>
    </Field><button type="button" className="button secondary" onClick={add}>添加策略</button></div>} />
    <ErrorNotice error={overview.error} />
    {strategyId ? <StrategyWorkbench key={strategyId} strategyId={strategyId} focus={focus} /> : overview.isPending ? <Loading /> :
      active.length ? <div className="summary-grid">{active.map((item) => <Panel key={item.id} title={item.name}
        action={<StatusBadge status={item.status} />}>
        {overview.data?.accounts.filter((account) => account.strategy_id === item.id).map((account) =>
          <p key={`${account.account_id}/${account.currency}`}>{account.account_id} · {money(account.equity, account.currency)}</p>)}
        <a className="button secondary" href={workbenchPath(item.id)}>打开工作台</a>
      </Panel>)}</div> : <Empty title="还没有策略" action={<a className="button primary" href="#strategies">前往策略</a>} />}
    {!strategyId && !!active.length && <a href="#overview">查看运行总览</a>}
  </div>;
}

function StrategyWorkbench({ strategyId, focus }: { strategyId: string; focus?: string }) {
  const detail = useData<Detail>(strategyApi(strategyId));
  return <>
    <ErrorNotice error={detail.error} />
    {detail.isPending && <Loading />}
    {detail.data && <>
      <div className="toolbar workbench-status"><strong>{detail.data.name}</strong><StatusBadge status={detail.data.status} />
        <a href={strategyPath(strategyId)}>策略详情</a></div>
      <DashboardBuilder strategy={detail.data} workbench focus={focus} />
    </>}
  </>;
}
