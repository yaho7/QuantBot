import { Activity, ArrowDownLeft, ArrowUpRight, CircleAlert, CircleOff, Plus, Radio, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { strategyPath, type Overview, type Strategy } from "./api";
import { CommandBadge, Empty, ErrorNotice, Loading, PageTitle, Panel, StatusBadge, Table, TextLink, categoryText, modeText, money, observed, relative, useData, when } from "./ui";

export function StrategyTable({ rows }: { rows: Strategy[] }) {
  return <div className="strategy-table"><Table columns={["策略名称", "交易模式", "分组", "连接", "最近心跳", ""]} empty={!rows.length}>
    {rows.map((s) => <tr key={s.id}><td><a className="strategy-name" href={strategyPath(s.id)}>
      <span className="strategy-icon"><Activity size={17} /></span><span>{s.name}
        {!!s.tags.length && <small>{s.tags.join(" · ")}</small>}</span></a></td>
      <td><span className="mode">{modeText[s.mode]}</span></td><td>{s.group || "—"}</td>
      <td><StatusBadge status={s.status} /></td><td className="subtle mono">{relative(s.last_seen)}</td>
      <td><a className="icon-button" aria-label={`打开 ${s.name}`} href={strategyPath(s.id)}><ArrowUpRight size={16} /></a></td></tr>)}
  </Table></div>;
}

export function OverviewPage({ add }: { add: () => void }) {
  const query = useData<Overview>("overview");
  const data = query.data;
  const counts = data?.counts;
  const strategies = new Map(data?.strategies.map((strategy) => [strategy.id, strategy]));
  return <>
    <PageTitle title="运行总览" sub="集中查看策略连接、交易动态与控制回执。"
      action={<button className="button primary" onClick={add}><Plus size={18} /> 添加策略</button>} />
    <ErrorNotice error={query.error} />
    {!data ? <Loading /> : <>
      <div className="summary-grid no-account-total">
        {([
          ["在线策略", counts?.online, Radio, "green"],
          ["离线策略", counts?.offline, CircleOff, "neutral"],
          ["异常策略", counts?.abnormal, CircleAlert, "orange"],
        ] as const).map(([label, count, Icon, tone]) =>
          <section className="panel stat" key={label}><div><span>{label}</span><span className={`stat-icon ${tone}`}><Icon size={19} /></span></div>
            <strong>{count}</strong></section>)}
      </div>
      {!!data.accounts.length && <div className="summary-grid">
        {data.accounts.map((account) => {
          const strategy = strategies.get(account.strategy_id);
          return <section className="panel stat equity-stat" key={`${account.strategy_id}/${account.account_id}/${account.currency}`}>
            <div><a href={strategyPath(account.strategy_id, "funds")}>{strategy?.name ?? account.strategy_id}</a><span>{account.account_id}</span></div>
            <strong>{money(account.equity, account.currency)}</strong>
            <small>当日盈亏 {money(account.daily_pnl, account.currency)}</small>
            <small>{observed(account.observed_at, strategy?.status === "offline")}</small>
          </section>;
        })}
      </div>}
      <Panel title="策略运行状态" hint={`共 ${data.strategies.length} 个策略`} action={<TextLink href="#strategies">管理策略</TextLink>}>
        {data.strategies.length ? <StrategyTable rows={data.strategies.slice(0, 10)} /> :
          <Empty title="还没有接入策略" text="创建策略并生成 Token，程序发起 HTTP 连接后会自动显示在线。"
            action={<button className="button secondary" onClick={add}><Plus size={15} /> 创建策略</button>} />}
      </Panel>
      <div className="activity-grid">
        <Panel title="最近成交">
          {!data.recent_fills.length ? <Empty title="暂无成交上报" /> : <ul className="activity-list">{data.recent_fills.map((item) => <li key={`${item.strategy_id}/${item.id}`}>
            <span className="activity-icon"><ArrowDownLeft size={15} /></span><div><a href={strategyPath(item.strategy_id, "orders")}>{item.fill?.symbol} · {item.fill?.side === "buy" ? "买入" : "卖出"}</a>
              <small>{item.fill?.quantity} @ {item.fill?.price} {item.fill?.currency}</small></div><time>{when(item.occurred_at)}</time>
          </li>)}</ul>}
        </Panel>
        <Panel title="最近告警" action={<TextLink href="#telegram">通知</TextLink>}>
          {!data.alerts.length ? <Empty title="暂无告警" /> : <ul className="activity-list">{data.alerts.map((item) => <li key={item.id}>
            <span className={`activity-icon ${["error", "critical", "warning"].includes(item.severity) ? "warn" : ""}`}><CircleAlert size={15} /></span>
            <div><strong>{categoryText[item.category] ?? item.category}</strong><small>{item.message}</small></div>
            <time>{when(item.created_at)}</time>
          </li>)}</ul>}
        </Panel>
        <Panel title="最近指令" action={<TextLink href="#operations">操作记录</TextLink>}>
          {!data.commands.length ? <Empty title="暂无远程指令" /> : <ul className="activity-list">{data.commands.map((item) => <li key={item.id}>
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
    <PageTitle title="策略" sub="管理策略身份、分组与 API 接入。" action={<button className="button primary" onClick={add}><Plus size={18} /> 添加策略</button>} />
    <Panel>
      <div className="toolbar"><div className="search"><Search size={16} /><input aria-label="搜索策略" placeholder="搜索名称、标签或策略 ID" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
        <select aria-label="筛选分组" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">全部分组</option>
          {groups.map((item) => <option key={item}>{item}</option>)}</select>
        <label className="checkbox"><input type="checkbox" checked={archived} onChange={(e) => { setGroup(""); setArchived(e.target.checked); }} /> 已归档</label>
      </div>
      <ErrorNotice error={query.error} />{query.isPending ? <Loading /> :
        !result?.length ? <Empty title={term || group ? "未找到匹配策略" : archived ? "没有已归档的策略" : "暂无策略"} /> :
          <StrategyTable rows={result} />}
    </Panel>
  </>;
}
