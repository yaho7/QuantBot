import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { DynamicControls, type ControlRegistryView } from "./dynamic-controls";
import { api, readSession, sessionKey, strategyApi, strategyPath, type Capability, type Command, type Detail, type Scalar, type Strategy } from "./api";
import { Code, CommandBadge, Dialog, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, ParameterInput, Table, stateText, useData, when } from "./ui";

const actions: Record<string, string> = {
  pause_entry: "暂停新开仓", resume_entry: "恢复新开仓", refresh: "刷新监控",
  set_parameters: "修改参数", cancel_order: "撤销订单", close_position: "关闭持仓",
  flatten: "关闭全部归属持仓", buy: "手动买入", sell: "手动卖出",
};
const shadow = new Set(["pause_entry", "resume_entry"]);
const safe = new Set(["pause_entry", "resume_entry", "refresh"]);

export function ControlPanel({ strategy }: { strategy: Detail }) {
  const [selected, setSelected] = useState<Capability | null>(null);
  const registry = useData<ControlRegistryView>(strategyApi(strategy.id, "controls"), true, 6_000);
  const bound = new Set(registry.data?.controls.flatMap((item) => item.command ? [item.command] : []));
  const available = strategy.capabilities.filter((item) => !shadow.has(item.id) && !bound.has(item.id));
  return <div className="stack">
    <Panel title="开仓权限与风控"><EntryControl strategy={strategy} registry={registry.data} ready={registry.isSuccess} /></Panel>
    <DynamicControls strategy={strategy} registry={registry.data && { ...registry.data, controls: registry.data.controls.filter((item) => !entryBinding(item.command)) }} error={registry.error} loading={registry.isPending}
      operation={(command, close) => <OperationView command={command} strategy={strategy.name} close={close} />} />
    <Panel title="会话声明的操作" hint="操作由策略主动声明，最终状态以策略回执为准。">
      {strategy.archived_at ? <Empty title="策略已归档" /> : !available.length ?
        <Empty title="没有独立的会话操作" text="已绑定注册组件的操作可在控制面板中使用。" /> :
        <div className="control-grid">{available.map((cap) => {
          const risky = cap.high_risk || !safe.has(cap.id);
          const blocked = strategy.mode === "live" && risky && !strategy.live_trading_enabled;
          const unavailable = !shadow.has(cap.id) && !strategy.executor_online;
          return <button key={cap.id} disabled={blocked || unavailable} onClick={() => setSelected(cap)} className="control-button">
            <strong>{cap.label}</strong><small>{blocked ? "实盘高风险操作未启用" : unavailable ? "执行实例离线"
              : risky ? "需二次确认" : shadow.has(cap.id) ? "持续状态" : "一次性操作"}</small>
          </button>;
        })}</div>}
    </Panel>
    <Panel title="近期指令"><OperationTable strategyId={strategy.id} compact /></Panel>
    {selected && <CommandDialog capability={selected} strategy={strategy} close={() => setSelected(null)} />}
  </div>;
}

export const entryBinding = (action?: string) => action === "set_trading_enabled" || !!action && shadow.has(action);

export function EntryControl({ strategy, registry, ready }: { strategy: Detail; registry?: ControlRegistryView; ready: boolean }) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [requestIds, setRequestIds] = useState(() => [crypto.randomUUID(), crypto.randomUUID()]);
  const [command, setCommand] = useState<Command>();
  const latest = useData<Command>(`commands/${command?.id ?? ""}`, !!command, 3_000);
  const record = latest.data ?? command;
  const pending = !!record && ["confirmation_required", "pending", "accepted", "executing", "unknown"].includes(record.state);
  const control = strategy.control;
  const reported = control.reported_current ? control.reported : null;
  const requested = control.desired.entry_enabled;
  const values = [
    ["期望交易权限", requested === undefined ? "由策略决定" : requested ? "允许新开仓" : "暂停新开仓"],
    ["实际上报权限", reported?.entry_enabled != null ? reported.entry_enabled ? "允许新开仓" : "暂停新开仓" : "等待当前实例回报"],
    ["本地风控锁", reported?.risk_locked == null ? "未知" : reported.risk_locked ? "已锁定" : "未锁定"],
    ["有效开仓权限", control.effective_entry_enabled == null ? "未知" : control.effective_entry_enabled ? "允许" : "禁止"],
  ] as const;
  const issue = useMutation({
    mutationFn: ({ enabled, binding }: { enabled: boolean; binding?: NonNullable<ControlRegistryView["controls"][number]> }) =>
      binding ? api<Command>(strategyApi(strategy.id, `controls/${binding.id}/invoke`), "POST", {
        revision: registry?.revision, request_id: requestIds[Number(enabled)], ...(binding.type === "toggle" ? { value: enabled } : {}),
      }) : api<Command>(strategyApi(strategy.id, "commands"), "POST", {
        action: enabled ? "resume_entry" : "pause_entry", request_id: requestIds[Number(enabled)],
      }),
    onSuccess: (result) => {
      setConfirm(false);
      setRequestIds([crypto.randomUUID(), crypto.randomUUID()]);
      setCommand(result);
      void client.invalidateQueries({ queryKey: ["live"] });
    },
  });
  const toggle = registry?.controls.find((item) => item.command === "set_trading_enabled");
  const blocked = !ready || !!strategy.archived_at || pending || issue.isPending;
  function action(enabled: boolean) {
    const id = enabled ? "resume_entry" : "pause_entry";
    const capability = strategy.capabilities.find((item) => item.id === id);
    const binding = toggle ?? registry?.controls.find((item) => item.command === id && item.type === "button");
    const disabled = blocked || !capability || (binding ? !registry?.states[binding.id]?.available :
      strategy.mode === "live" && capability.high_risk && !strategy.live_trading_enabled);
    return { capability, binding, disabled };
  }
  const pause = action(false);
  const resume = action(true);
  return <div className="stack entry-control">
    <div className="value-grid">{values.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div role="status">{control.in_sync ? "已同步" : "等待策略确认"}</div>
    <div className="toolbar">
      {pause.capability && <button type="button" className="button secondary" disabled={pause.disabled}
        onClick={() => issue.mutate({ enabled: false, binding: pause.binding })}>暂停新开仓</button>}
      {resume.capability && <button type="button" className="button secondary" disabled={resume.disabled}
        onClick={() => setConfirm(true)}>恢复新开仓</button>}
    </div>
    {record && <div className="toolbar"><CommandBadge state={record.state} /><a href={`#operations/${record.id}`}>查看指令</a></div>}
    <ErrorNotice error={issue.error} />
    {confirm && <Dialog title="恢复新开仓" close={() => setConfirm(false)}>
      <p>{strategy.name} · 实际权限 {values[1][1]} · 本地风控锁 {values[2][1]}</p>
      <p>恢复开仓权限后，本地风控锁继续生效。</p>
      <ErrorNotice error={issue.error} />
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setConfirm(false)}>取消</button>
        <button type="button" className="button primary" disabled={resume.disabled}
          onClick={() => issue.mutate({ enabled: true, binding: resume.binding })}>提交恢复请求</button></div>
    </Dialog>}
  </div>;
}

export function CommandDialog({ capability, strategy, close }: { capability: Capability; strategy: Detail; close: () => void }) {
  const client = useQueryClient();
  const [requestId] = useState(() => crypto.randomUUID());
  const [parameters, setParameters] = useState<Record<string, Scalar | undefined>>(() =>
    Object.fromEntries(Object.entries(capability.parameters).map(([key, value]) => [key, value.default ?? undefined])));
  const [command, setCommand] = useState<Command>();
  const operation = useData<Command>(`commands/${command?.id ?? ""}`, !!command?.id, 3_000);
  const record = operation.data ?? command;
  const create = useMutation({
    mutationFn: () => api<Command>(strategyApi(strategy.id, "commands"), "POST",
      { action: capability.id, request_id: requestId, arguments: parameters }),
    onSuccess: (result) => { setCommand(result); void client.invalidateQueries({ queryKey: ["live"] }); },
  });
  return <Dialog title={capability.label} close={close}>
    {record ? <OperationView command={record} strategy={strategy.name} close={close} /> :
      <form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <p>目标策略 <strong>{strategy.name}</strong></p>
        {Object.entries(capability.parameters).map(([name, parameter]) => <ParameterInput key={name}
          {...{ name, parameter }} value={parameters[name]} set={(value) => setParameters({ ...parameters, [name]: value })} />)}
        {shadow.has(capability.id) && <div className="notice">服务会保存期望权限。收到策略实际应用的回报后，指令才会显示成功。</div>}
        <ErrorNotice error={create.error} />
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>取消</button>
          <button className="button primary" disabled={create.isPending}>提交请求</button></div>
      </form>}
  </Dialog>;
}

export function OperationView({ command, strategy, close }: { command: Command; strategy?: string; close: () => void }) {
  const client = useQueryClient();
  const [evidence, setEvidence] = useState("");
  const [resolution, setResolution] = useState<"succeeded" | "failed">("failed");
  const session = useQuery({ queryKey: sessionKey, queryFn: readSession, enabled: false });
  const audit = useData<Array<{ id: number; actor: string; action: string; created_at: string }>>(
    `audit?command_id=${encodeURIComponent(command.id)}`,
  );
  const act = useMutation({
    mutationFn: (action: "confirm" | "reconcile" | "cancel") => api<Command>(`commands/${command.id}/${action}`, "POST",
      action === "reconcile" ? { evidence, status: resolution } : undefined),
    onSuccess: (data) => {
      client.setQueryData(["live", `commands/${command.id}`], data);
      void client.invalidateQueries({ queryKey: ["live"] });
    },
  });
  const display = act.data && act.data.updated_at >= command.updated_at ? act.data : command;
  const owner = display.actor === session.data?.actor;
  const canConfirm = display.state === "confirmation_required" && owner;
  const canCancel = owner && display.revision == null &&
    ["confirmation_required", "pending", "accepted"].includes(display.state);
  return <div className="stack">
    <div className="toolbar"><CommandBadge state={display.state} /><span className="mono subtle">{display.id}</span></div>
    <dl className="detail-list">
      {strategy && <><dt>策略</dt><dd>{strategy}</dd></>}
      <dt>指令</dt><dd>{actions[display.action] ?? display.action}</dd>
      <dt>发起人</dt><dd>{display.actor}</dd><dt>截止时间</dt><dd>{when(display.expires_at)}</dd>
      {display.control_id && <><dt>控件</dt><dd>{display.control_id} · v{display.control_revision}</dd></>}
      {display.revision != null && <><dt>控制修订</dt><dd>{display.revision}</dd></>}
    </dl>
    {Object.keys(display.arguments).length > 0 && <Code label="提交参数">{JSON.stringify(display.arguments, null, 2)}</Code>}
    {display.result != null && <Code label="策略回执">{JSON.stringify(display.result, null, 2)}</Code>}
    {display.error && <div className="notice warn">{display.error}</div>}
    {!!audit.data?.length && <details className="form-detail"><summary>执行审计</summary>
      <Table columns={["时间", "操作", "执行者"]}>
        {audit.data.map((row) => <tr key={row.id}><td>{when(row.created_at)}</td>
          <td className="mono">{row.action}</td><td className="mono">{row.actor}</td></tr>)}
      </Table>
    </details>}
    {canConfirm && <div className="notice warn"><CircleAlert size={17} /><span>请核对策略和参数。确认后，授权实例可在有效期内领取一次性执行许可。</span></div>}
    {display.state === "unknown" && <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate("reconcile"); }}>
      <div className="notice warn">请先核对程序与券商侧的实际记录，再填写核对依据。</div>
      <Field label="核对结果"><select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
        <option value="failed">已核实未执行成功</option><option value="succeeded">已核实执行成功</option></select></Field>
      <Field label="核对依据"><textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} required minLength={3} maxLength={1000} /></Field>
      <button className="button secondary" disabled={act.isPending}>保存核对结果</button>
    </form>}
    <ErrorNotice error={act.error} />
    <div className="dialog-actions"><button className="button secondary" onClick={close}>关闭</button>
      {canCancel && <button className="button quiet danger-text" disabled={act.isPending} onClick={() => act.mutate("cancel")}>取消请求</button>}
      {canConfirm && <button className="button danger" disabled={act.isPending} onClick={() => act.mutate("confirm")}>确认执行</button>}</div>
  </div>;
}

function InspectCommand({ id, close }: { id: string; close: () => void }) {
  const operation = useData<Command>(`commands/${id}`, true, 3_000);
  return <Dialog title="指令详情" close={close}><ErrorNotice error={operation.error} />
    {operation.data ? <OperationView command={operation.data} close={close} /> : operation.isPending ? <Loading /> : null}</Dialog>;
}

export function OperationTable({ strategyId, compact = false, selected, close }: {
  strategyId?: string; compact?: boolean; selected?: string; close?: () => void;
}) {
  const [cursor, setCursor] = useState<string[]>([]);
  const [inspect, setInspect] = useState<string>();
  const before = cursor.at(-1);
  const [state, setState] = useState("");
  const query = new URLSearchParams({ limit: compact ? "8" : "30" });
  if (!compact) query.set("unknown_first", "true");
  if (strategyId) query.set("strategy_id", strategyId);
  if (before) query.set("before", before);
  if (state) query.set("state", state);
  const commands = useData<Command[]>(`commands?${query}`);
  const strategies = useData<Strategy[]>("strategies", !compact);
  const names = Object.fromEntries((strategies.data ?? []).map((s) => [s.id, s.name]));
  const rows = commands.data ?? [];
  return <>
    {!compact && <div className="toolbar"><select aria-label="筛选操作状态" value={state} onChange={(e) => { setState(e.target.value); setCursor([]); }}>
      <option value="">全部状态</option>{Object.entries(stateText).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>}
    <ErrorNotice error={commands.error} />
    {commands.isPending ? <Loading /> : <Table columns={["指令", ...(compact ? [] : ["策略"]), "状态", "发起人", "创建时间", ""]} empty={!rows.length}>
      {rows.map((item) => <tr key={item.id}><td>{actions[item.action] ?? item.action}</td>
        {!compact && <td><a href={strategyPath(item.strategy_id, "control")}>{names[item.strategy_id] ?? item.strategy_id}</a></td>}
        <td><CommandBadge state={item.state} /></td><td className="mono subtle">{item.actor}</td><td>{when(item.created_at)}</td>
        <td><button className="button quiet" onClick={() => setInspect(item.id)}>详情</button></td></tr>)}
    </Table>}
    {!compact && <div className="toolbar"><button className="button secondary" disabled={!before} onClick={() => setCursor(cursor.slice(0, -1))}>上一页</button>
      <button className="button secondary" disabled={commands.data?.length !== 30} onClick={() => {
        const last = commands.data?.at(-1);
        if (last) setCursor([...cursor, last.id]);
      }}>下一页</button></div>}
    {(inspect || selected) && <InspectCommand id={(inspect ?? selected)!} close={() => { setInspect(undefined); close?.(); }} />}
  </>;
}

export function OperationsPage({ commandId }: { commandId?: string }) {
  return <><PageTitle title="操作记录" sub="Web 和 Telegram 的远程指令、执行回执与核对结果。" />
    <Panel><OperationTable selected={commandId} close={() => { if (commandId) location.hash = "#operations"; }} /></Panel></>;
}
