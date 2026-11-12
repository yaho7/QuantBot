import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, ChartNoAxesCombined, CloudOff, Shield } from "lucide-react";
import { useState } from "react";
import { api, strategyApi, strategyPath, type Account, type Catalog, type Detail, type EventRecord, type Fill, type Order, type Position, type StrategySettings } from "./api";
import { StrategyFields, TokenPanel } from "./onboarding";
import { ControlPanel } from "./operations";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, Table, TextLink, categoryText, modeText, money, relative, severityText, useData, when } from "./ui";

const tabs = [
  ["", "概览"], ["charts", "仪表盘"], ["funds", "资金与绩效"], ["positions", "持仓"],
  ["orders", "订单与成交"], ["events", "事件与日志"], ["control", "远程控制"], ["api", "Token 与诊断"], ["settings", "配置"],
];
const performanceNames: Record<string, string> = {
  cumulative_return: "累计收益率", daily_return: "当日收益率", max_drawdown: "最大回撤",
  sharpe_ratio: "Sharpe Ratio", sortino_ratio: "Sortino Ratio", win_rate: "胜率",
  profit_loss_ratio: "盈亏比", profit_factor: "Profit Factor",
};

export function StrategyPage({ strategyId, tab = "" }: { strategyId: string; tab?: string }) {
  const [instance, setInstance] = useState("");
  const query = useData<Detail>(strategyApi(strategyId) + (instance ? `?instance=${encodeURIComponent(instance)}` : ""));
  const strategy = query.data;
  if (!strategy) return <><a className="text-link" href="#strategies"><ArrowLeft size={16} /> 策略</a>
    <ErrorNotice error={query.error} />{query.isPending && <Loading />}</>;
  const snapshot = strategy.snapshot;
  return <>
    <a className="back-link" href="#strategies"><ArrowLeft size={15} /> 策略列表</a>
    <PageTitle title={strategy.name} sub={[modeText[strategy.mode], strategy.group, strategy.description].filter(Boolean).join(" · ")}
      action={<StatusBadge status={strategy.status} />} />
    {strategy.archived_at && <div className="notice warn">策略已归档。历史数据与配置仍可查看。</div>}
    <nav className="tabs" aria-label="策略详情">
      {tabs.map(([key, label]) => <a key={key} href={strategyPath(strategyId, key)} aria-current={tab === key ? "page" : undefined}>{label}</a>)}
    </nav>
    <ErrorNotice error={query.error} />
    {!tab && <StrategyOverview strategy={strategy} />}
    {tab === "charts" && <ChartCatalog strategyId={strategyId} />}
    {tab === "funds" && <div className="stack"><Panel title="账户资金" action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Accounts rows={snapshot?.accounts ?? []} /></Panel><Panel title="绩效指标"><Performance values={snapshot?.performance} /></Panel></div>}
    {tab === "positions" && <div className="stack"><Panel title="策略归属持仓" action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Positions rows={snapshot?.strategy_positions ?? []} /></Panel>
      <Panel title="券商账户持仓"><Positions rows={snapshot?.broker_positions ?? []} /></Panel></div>}
    {tab === "orders" && <div className="stack"><Panel title="未完成订单" action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Orders rows={snapshot?.open_orders ?? []} /></Panel>
      <Panel title="已完成订单"><Orders rows={snapshot?.completed_orders ?? []} /></Panel>
      <Panel title="成交记录"><Fills rows={snapshot?.fills ?? []} /></Panel></div>}
    {tab === "events" && <Events strategyId={strategyId} />}
    {tab === "control" && <ControlPanel strategy={strategy} />}
    {tab === "api" && <TokenPanel strategy={strategy} />}
    {tab === "settings" && <StrategyConfig strategy={strategy} />}
  </>;
}

function InstanceFilter({ strategy, instance, setInstance }: { strategy: Detail; instance: string; setInstance: (value: string) => void }) {
  return strategy.instances.length > 1 ? <select aria-label="上报实例" value={instance} onChange={(e) => setInstance(e.target.value)}>
    <option value="">默认实例</option>{strategy.instances.map((item) => <option key={item.instance_id}>{item.instance_id}</option>)}</select> : null;
}

function StrategyOverview({ strategy }: { strategy: Detail }) {
  const latest = strategy.instances.find((item) => item.instance_id === strategy.executor_id) ?? strategy.instances[0];
  return <div className="stack">
    <div className="summary-grid strategy-summary">
      <Panel><div className="small-stat"><Activity size={20} /><span>程序连接</span><StatusBadge status={strategy.status} /></div></Panel>
      <Panel><div className="small-stat"><ArrowRight size={20} /><span>有效开仓权限</span><strong>{strategy.control.effective_entry_enabled == null ?
        "未知" : strategy.control.effective_entry_enabled ? "允许" : "禁止"}</strong></div></Panel>
      <Panel><div className="small-stat"><Shield size={20} /><span>本地风控锁</span><strong>{strategy.control.reported_current && strategy.control.reported?.risk_locked != null ?
        strategy.control.reported.risk_locked ? "已锁定" : "未锁定" : "未知"}</strong></div></Panel>
      <Panel><div className="small-stat"><CloudOff size={20} /><span>最近心跳</span><strong>{relative(strategy.last_seen)}</strong></div></Panel>
    </div>
    <Panel title="最新运行数据" hint={strategy.snapshot ? `观测于 ${when(strategy.snapshot.observed_at)}` : undefined}
      action={<TextLink href={strategyPath(strategy.id, "api")}>连接诊断</TextLink>}>
      {!latest ? <Empty title="等待程序连接" text="使用策略 Token 建立 HTTP 会话并上报第一条数据。"
        action={<a className="button secondary" href={strategyPath(strategy.id, "api")}>查看接入信息</a>} /> :
        <dl className="detail-list">
          <dt>实例</dt><dd>{latest.instance_id}</dd><dt>程序版本</dt><dd>{latest.declarations.version ?? "—"}</dd>
          <dt>框架</dt><dd>{[latest.declarations.language, latest.declarations.framework].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>券商连接</dt><dd>{latest.runtime.broker_connected == null ? "未上报" : latest.runtime.broker_connected ? "已连接" : "未连接"}</dd>
          <dt>运行时长</dt><dd>{latest.runtime.uptime_seconds == null ? "—" : `${latest.runtime.uptime_seconds.toLocaleString()} 秒`}</dd>
          <dt>授权到期</dt><dd>{when(latest.runtime.authorization_expires_at)}</dd>
        </dl>}
    </Panel>
    <Panel title="自定义指标" action={<TextLink href={strategyPath(strategy.id, "charts")}>仪表盘</TextLink>}>
      {strategy.snapshot?.metrics?.length ? <div className="value-grid">{strategy.snapshot.metrics.map((item, i) => <div key={`${item.name}-${i}`}>
        <span>{item.label ?? item.name}</span><strong>{money(item.value, item.unit)}</strong></div>)}</div> :
        <Empty title="暂无快照指标" text="标准指标的历史数据可在仪表盘查看。" />}
    </Panel>
  </div>;
}

function ChartCatalog({ strategyId }: { strategyId: string }) {
  const query = useData<Catalog>(strategyApi(strategyId, "components"));
  return <Panel title="已识别的标准数据">
    <ErrorNotice error={query.error} />{query.isPending ? <Loading /> :
      !query.data?.components.length ? <Empty title="等待标准数据上报" /> :
      <div className="value-grid">{query.data.components.map((item) => <div key={item.id}><ChartNoAxesCombined size={18} />
        <strong>{item.label}</strong><span>{{ ready: "可用", insufficient: "数据不足", stale: "停止上报", incompatible: "协议不兼容" }[item.state] ?? item.state}</span>
      </div>)}</div>}
  </Panel>;
}

export function Accounts({ rows }: { rows: Account[] }) {
  return <Table columns={["账户", "币种", "余额", "可用现金", "净值", "购买力", "已实现", "未实现", "当日盈亏"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.currency}`}><td>{row.account_id}</td><td>{row.currency}</td>
      {[row.balance, row.cash, row.equity, row.buying_power, row.realized_pnl, row.unrealized_pnl, row.daily_pnl]
        .map((value, i) => <td className="mono" key={i}>{money(value)}</td>)}</tr>)}
  </Table>;
}
export function Performance({ values }: { values?: Record<string, string | null> }) {
  const metrics = Object.entries(values ?? {}).filter((entry) => entry[1] != null);
  return metrics.length ? <div className="value-grid">{metrics.map(([name, value]) => <div key={name}><span>{performanceNames[name] ?? name}</span>
    <strong>{money(value, ["daily_return", "cumulative_return", "max_drawdown", "win_rate"].includes(name) ? "%" : undefined)}</strong></div>)}</div> : <Empty />;
}
export function Positions({ rows }: { rows: Position[] }) {
  return <Table columns={["标的", "账户", "数量", "成本", "市价", "未实现盈亏"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.position_id}`}><td><strong>{row.symbol}</strong></td><td>{row.account_id}</td>
      <td className="mono">{money(row.quantity)}</td><td className="mono">{money(row.cost, row.currency)}</td>
      <td className="mono">{money(row.market_price, row.currency)}</td><td className="mono">{money(row.unrealized_pnl, row.currency)}</td></tr>)}
  </Table>;
}
export function Orders({ rows }: { rows: Order[] }) {
  return <Table columns={["订单 ID", "标的", "方向", "委托 / 已成交", "价格", "手续费", "状态"]} empty={!rows.length}>
    {rows.map((row, index) => <tr key={`${row.account_id}/${row.order_id}/${index}`}><td className="mono">{row.order_id}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? "买入" : "卖出"}</td><td className="mono">{row.quantity} / {row.filled_quantity ?? "—"}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.currency)}</td><td>{row.status}</td></tr>)}
  </Table>;
}
export function Fills({ rows }: { rows: Fill[] }) {
  return <Table columns={["成交时间", "标的", "方向", "数量", "价格", "手续费"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.fill_id}`}><td>{when(row.occurred_at)}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? "买入" : "卖出"}</td><td className="mono">{row.quantity}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.currency)}</td></tr>)}
  </Table>;
}
function Events({ strategyId }: { strategyId: string }) {
  const [category, setCategory] = useState("");
  const [days, setDays] = useState("7");
  const path = `events?strategy_id=${strategyId}&limit=200&start=${encodeURIComponent(new Date(Date.now() - Number(days) * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z")}${category ? `&category=${category}` : ""}`;
  const events = useData<EventRecord[]>(path);
  return <Panel title="上报事件与日志">
    <div className="toolbar"><select aria-label="分类" value={category} onChange={(e) => setCategory(e.target.value)}>
      <option value="">全部分类</option>{["trade", "open", "close", "risk", "warning", "error", "log", "alert", "custom"].map((key) =>
        <option value={key} key={key}>{categoryText[key]}</option>)}</select>
      <select aria-label="时间范围" value={days} onChange={(e) => setDays(e.target.value)}><option value="1">最近一天</option>
        <option value="7">最近七天</option><option value="30">最近三十天</option><option value="365">最近一年</option></select></div>
    <ErrorNotice error={events.error} />{events.isPending ? <Loading /> : <Table columns={["时间", "类别", "级别", "内容"]} empty={!events.data?.length}>
      {events.data?.map((item) => <tr key={item.id}><td>{when(item.occurred_at)}</td><td>{categoryText[item.category] ?? item.category}</td>
        <td>{severityText[item.severity]}</td><td className="wrap">{item.message}</td></tr>)}
    </Table>}
  </Panel>;
}

function StrategyConfig({ strategy }: { strategy: Detail }) {
  const client = useQueryClient();
  const [form, set] = useState<StrategySettings>(() => {
    const { name, mode, description, group, tags, disconnect_policy, retention_days, live_trading_enabled, alerts } = strategy;
    return { name, mode, description, group, tags, disconnect_policy, retention_days, live_trading_enabled, alerts };
  });
  const [executor, setExecutor] = useState("");
  const mutation = useMutation({
    mutationFn: (action: "save" | "archive" | "restore" | "executor") => {
      const path = strategyApi(strategy.id);
      if (action === "save") return api<Detail>(path, "PUT", form);
      if (action === "executor") return api<Detail>(path + "/executor", "PUT", { instance_id: executor });
      return action === "archive" ? api<Detail>(path, "DELETE") : api<Detail>(path + "/restore", "POST");
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: ["live"] }),
  });
  return <div className="stack">
    <Panel title="策略配置">
      <ErrorNotice error={mutation.error} />
      {mutation.isSuccess && <div role="status" className="notice">已保存</div>}
      {!strategy.archived_at && <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        if (form.live_trading_enabled && !strategy.live_trading_enabled &&
            !confirm("允许程序声明的实盘高风险操作？每次操作仍需二次确认。")) return;
        mutation.mutate("save");
      }}>
        <StrategyFields {...{ form, set }} /><div><button className="button primary" disabled={mutation.isPending}>保存配置</button></div>
      </form>}
      {strategy.archived_at && <button className="button secondary" onClick={() => mutation.mutate("restore")}>恢复归档策略</button>}
    </Panel>
    {!strategy.archived_at && <>
      <Panel title="授权执行实例" hint="一个策略只允许一个执行实例。切换前先断开原实例并处理未知交易结果。">
        <p className="subtle">当前执行实例 {strategy.executor_id ?? "尚未分配"}</p>
        <div className="toolbar"><Field label="可切换的实例"><select value={executor} onChange={(e) => setExecutor(e.target.value)}>
          <option value="">请选择</option>{strategy.instances.filter((item) =>
            item.online && item.declarations.executor && item.instance_id !== strategy.executor_id)
            .map((item) => <option key={item.instance_id}>{item.instance_id}</option>)}</select></Field>
          <button className="button secondary" disabled={!executor || strategy.executor_online || mutation.isPending}
            onClick={() => mutation.mutate("executor")}>切换执行实例</button></div>
      </Panel>
      <Panel title="删除策略"><p className="subtle">删除会将策略归档并撤销 Token。历史数据和仪表盘仍可查看。</p>
        <button className="button danger" disabled={mutation.isPending} onClick={() => {
          if (confirm(`删除并归档策略「${strategy.name}」？其接入 Token 会被撤销。`)) mutation.mutate("archive");
        }}>删除并归档</button>
      </Panel>
    </>}
  </div>;
}
