import { strategyApi, strategyPath, workbenchPath, type Detail, type Strategy } from "./api";
import DashboardBuilder from "./dashboard-builder";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, useData } from "./ui";

export default function Workbench({ strategyId }: { strategyId?: string }) {
  const strategies = useData<Strategy[]>("strategies");
  const active = strategies.data?.filter((item) => !item.archived_at) ?? [];
  return <div className="stack">
    <PageTitle title="工作台" action={<Field label="当前策略">
      <select value={strategyId ?? ""} onChange={(event) => { location.hash = workbenchPath(event.target.value); }}>
        <option value="">全部策略</option>
        {active.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        {strategyId && !active.some((item) => item.id === strategyId) && <option value={strategyId}>当前策略</option>}
      </select>
    </Field>} />
    <ErrorNotice error={strategies.error} />
    {strategyId ? <StrategyWorkbench key={strategyId} strategyId={strategyId} /> : strategies.isPending ? <Loading /> :
      active.length ? <div className="summary-grid">{active.map((item) => <Panel key={item.id} title={item.name}
        action={<StatusBadge status={item.status} />}>
        <a className="button secondary" href={workbenchPath(item.id)}>打开工作台</a>
      </Panel>)}</div> : <Empty title="还没有策略" action={<a className="button primary" href="#strategies">前往策略</a>} />}
  </div>;
}

function StrategyWorkbench({ strategyId }: { strategyId: string }) {
  const detail = useData<Detail>(strategyApi(strategyId));
  return <>
    <ErrorNotice error={detail.error} />
    {detail.isPending && <Loading />}
    {detail.data && <>
      <div className="toolbar"><strong>{detail.data.name}</strong><StatusBadge status={detail.data.status} />
        <a href={strategyPath(strategyId)}>策略详情</a></div>
      <DashboardBuilder strategy={detail.data} workbench />
    </>}
  </>;
}
