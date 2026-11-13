import { label, t, type Message } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { DynamicControls, type ControlRegistryView } from "./dynamic-controls";
import { submitted } from "./command-feedback";
import { api, readSession, sessionKey, strategyApi, strategyPath, type Capability, type Command, type Detail, type Scalar, type Strategy } from "./api";
import { Code, CommandBadge, Dialog, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, ParameterInput, Table, stateText, useData, when } from "./ui";

const actions: Record<string, Message> = {
  pause_entry: "operations.pauseNewEntries", resume_entry: "operations.resumeNewEntries", refresh: "operations.refreshMonitoring",
  set_parameters: "operations.editParameters", cancel_order: "operations.cancelOrder", close_position: "operations.closePosition",
  flatten: "operations.closeAllStrategyPositions", buy: "operations.manualBuy", sell: "operations.manualSell",
};
const shadow = new Set(["pause_entry", "resume_entry"]);
const safe = new Set(["refresh"]);

export function ControlPanel({ strategy }: { strategy: Detail }) {
  const [selected, setSelected] = useState<Capability | null>(null);
  const registry = useData<ControlRegistryView>(strategyApi(strategy.id, "controls"), true, 6_000);
  const bound = new Set(registry.data?.controls.flatMap((item) => item.command ? [item.command] : []));
  const available = strategy.capabilities.filter((item) => !shadow.has(item.id) && !bound.has(item.id));
  return <div className="stack">
    <Panel title={t("operations.entryPermissionsAndRiskControls")}><EntryControl strategy={strategy} registry={registry.data} ready={registry.isSuccess} /></Panel>
    <DynamicControls strategy={strategy} registry={registry.data && { ...registry.data, controls: registry.data.controls.filter((item) => !entryBinding(item.command)) }} error={registry.error} loading={registry.isPending}
      operation={(command, close) => <OperationView command={command} strategy={strategy.name} close={close} />} />
    <Panel title={t("operations.sessionActions")} hint={t("operations.theStrategyDeclaresTheseActionsAndReports")}>
      {strategy.archived_at ? <Empty title={t("operations.strategyArchived")} /> : !available.length ?
        <Empty title={t("operations.noStandaloneSessionActions")} text={t("operations.actionsBoundToRegisteredControlsAreAvailable")} /> :
        <div className="control-grid">{available.map((cap) => {
          const risky = cap.high_risk || !safe.has(cap.id);
          const blocked = strategy.mode === "live" && risky && !strategy.live_trading_enabled;
          const unavailable = !strategy.executor_online;
          return <button key={cap.id} disabled={blocked || unavailable} onClick={() => setSelected(cap)} className="control-button">
            <strong>{cap.label}</strong><small>{blocked ? t("operations.highRiskLiveTradingIsDisabled") : unavailable ? t("operations.executorOffline")
              : risky ? t("operations.confirmationRequired") : t("operations.oneTimeAction")}</small>
          </button>;
        })}</div>}
    </Panel>
    <Panel title={t("operations.recentCommands")}><OperationTable strategyId={strategy.id} compact /></Panel>
    {selected && <CommandDialog capability={selected} strategy={strategy} close={() => setSelected(null)} />}
  </div>;
}

export const entryBinding = (action?: string) => action === "set_trading_enabled" || !!action && shadow.has(action);

export function EntryControl({ strategy, registry, ready, preview = false, compact = false, widget = false }: {
  strategy: Detail; registry?: ControlRegistryView; ready: boolean; preview?: boolean; compact?: boolean; widget?: boolean;
}) {
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
    [t("operations.desiredEntryPermission"), requested === undefined ? t("operations.managedByTheStrategy") : requested ? t("operations.allowNewEntries") : t("operations.pauseNewEntries")],
    [t("operations.reportedEntryPermission"), reported?.entry_enabled != null ? reported.entry_enabled ? t("operations.allowNewEntries") : t("operations.pauseNewEntries") : t("operations.waitingForCurrentInstance")],
    [t("operations.localRiskLock"), reported?.risk_locked == null ? t("operations.unknown") : reported.risk_locked ? t("operations.locked") : t("operations.unlocked")],
    [t("operations.effectiveEntryPermission"), control.effective_entry_enabled == null ? t("operations.unknown") : control.effective_entry_enabled ? t("operations.allowed") : t("operations.blocked")],
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
      setCommand(result); submitted(result);
      void client.invalidateQueries({ queryKey: ["live"] });
    },
  });
  const toggle = registry?.controls.find((item) => item.command === "set_trading_enabled");
  const blocked = preview || !ready || !!strategy.archived_at || pending || issue.isPending;
  const awaitingApply = !control.in_sync || issue.isPending || record?.state === "pending";
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
  const sync = control.in_sync && !awaitingApply ? t("operations.inSync") :
    !reported && !pending && !issue.isPending ? t("operations.awaitingReport") : t("operations.waitingForStrategyConfirmation");
  const facts = <dl className="entry-facts">{values.slice(0, 3).map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
  return <div className="entry-control">
    <div className="entry-overview">
      <div><span>{values[3][0]}</span><strong>{values[3][1]}</strong></div>
      <span className={`badge ${awaitingApply ? "waiting" : "online"}`} role="status">{sync}</span>
    </div>
    {(!compact || !widget) && facts}
    {!preview && <div className="entry-actions">
      {pause.capability && <button type="button" className={`button ${control.effective_entry_enabled === true ? "primary" : "secondary"}`} disabled={pause.disabled}
        onClick={() => issue.mutate({ enabled: false, binding: pause.binding })}>{t("operations.pauseNewEntries")}</button>}
      {resume.capability && <button type="button" className={`button ${control.effective_entry_enabled === false ? "primary" : "secondary"}`} disabled={resume.disabled}
        onClick={() => setConfirm(true)}>{t("operations.resumeNewEntries")}</button>}
    </div>}
    {!preview && record && <div className="toolbar entry-receipt"><CommandBadge state={record.state} /><a href={`#operations/${record.id}`}>{t("commandFeedback.viewCommand")}</a></div>}
    {!preview && <ErrorNotice error={issue.error} />}
    {!preview && confirm && <Dialog title={t("operations.resumeNewEntries")} close={() => setConfirm(false)}>
      <div className="stack">
        <strong dir="auto">{strategy.name}</strong>
        {facts}
        <p>{t("operations.theLocalRiskLockRemainsActiveWhen")}</p>
      </div>
      <ErrorNotice error={issue.error} />
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setConfirm(false)}>{t("dashboardBuilder.cancel")}</button>
        <button type="button" className="button primary" disabled={resume.disabled}
          onClick={() => issue.mutate({ enabled: true, binding: resume.binding })}>{t("operations.submitResumeRequest")}</button></div>
    </Dialog>}
  </div>;
}

export function CommandDialog({ capability, strategy, close, initial, context }: {
  capability: Capability; strategy: Detail; close: () => void; initial?: Record<string, Scalar>; context?: string;
}) {
  const client = useQueryClient();
  const [requestId] = useState(() => crypto.randomUUID());
  const [parameters, setParameters] = useState<Record<string, Scalar | undefined>>(() =>
    Object.fromEntries(Object.entries(capability.parameters).map(([key, value]) => [key, initial?.[key] ?? value.default ?? undefined])));
  const [command, setCommand] = useState<Command>();
  const operation = useData<Command>(`commands/${command?.id ?? ""}`, !!command?.id, 3_000);
  const record = operation.data ?? command;
  const create = useMutation({
    mutationFn: () => api<Command>(strategyApi(strategy.id, "commands"), "POST",
      { action: capability.id, request_id: requestId, arguments: parameters }),
    onSuccess: (result) => { setCommand(result); submitted(result); void client.invalidateQueries({ queryKey: ["live"] }); },
  });
  return <Dialog title={capability.label} close={close}>
    {record ? <OperationView command={record} strategy={strategy.name} close={close} /> :
      <form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <p>{t("dynamicControls.targetStrategy")}{" "}<strong>{strategy.name}</strong></p>
        {context && <p>{context}</p>}
        {(capability.high_risk || !safe.has(capability.id)) && <p className="notice warn">{t("operations.reviewTheAccountSymbolAndQuantityBefore")}</p>}
        {Object.entries(capability.parameters).map(([name, parameter]) => <ParameterInput key={name}
          {...{ name, parameter }} value={parameters[name]} set={(value) => setParameters({ ...parameters, [name]: value })} />)}
        <ErrorNotice error={create.error} />
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>{t("dashboardBuilder.cancel")}</button>
          <button className="button primary" disabled={create.isPending}>{t("dynamicControls.submitRequest")}</button></div>
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
      {strategy && <><dt>{t("app.strategies")}</dt><dd>{strategy}</dd></>}
      <dt>{t("operations.command")}</dt><dd>{label(actions[display.action], display.action)}</dd>
      <dt>{t("operations.requestedBy")}</dt><dd>{display.actor}</dd><dt>{t("operations.deadline")}</dt><dd>{when(display.expires_at)}</dd>
      {display.control_id && <><dt>{t("operations.control")}</dt><dd>{display.control_id} · v{display.control_revision}</dd></>}
      {display.revision != null && <><dt>{t("operations.controlRevision")}</dt><dd>{display.revision}</dd></>}
    </dl>
    {Object.keys(display.arguments).length > 0 && <Code label={t("operations.submittedParameters")}>{JSON.stringify(display.arguments, null, 2)}</Code>}
    {display.result != null && <Code label={t("operations.strategyReceipt")}>{JSON.stringify(display.result, null, 2)}</Code>}
    {display.error && <div className="notice warn">{display.error}</div>}
    {!!audit.data?.length && <details className="form-detail"><summary>{t("operations.executionAudit")}</summary>
      <Table columns={[t("marketChart.time"), t("onboarding.actions"), t("operations.actor")]}>
        {audit.data.map((row) => <tr key={row.id}><td>{when(row.created_at)}</td>
          <td className="mono">{row.action}</td><td className="mono">{row.actor}</td></tr>)}
      </Table>
    </details>}
    {canConfirm && <div className="notice warn"><CircleAlert size={17} /><span>{t("operations.reviewTheStrategyAndParametersConfirmationLets")}</span></div>}
    {display.state === "unknown" && <form className="stack" onSubmit={(e) => { e.preventDefault(); act.mutate("reconcile"); }}>
      <div className="notice warn">{t("operations.checkTheAgentAndBrokerRecordsBefore")}</div>
      <Field label={t("operations.reconciliationOutcome")}><select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
        <option value="failed">{t("operations.verifiedUnsuccessful")}</option><option value="succeeded">{t("operations.verifiedSuccessful")}</option></select></Field>
      <Field label={t("operations.reconciliationEvidence")}><textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} required minLength={3} maxLength={1000} /></Field>
      <button className="button secondary" disabled={act.isPending}>{t("operations.saveReconciliation")}</button>
    </form>}
    <ErrorNotice error={act.error} />
    <div className="dialog-actions"><button className="button secondary" onClick={close}>{t("dynamicControls.close")}</button>
      {canCancel && <button className="button quiet danger-text" disabled={act.isPending} onClick={() => act.mutate("cancel")}>{t("operations.cancelRequest")}</button>}
      {canConfirm && <button className="button danger" disabled={act.isPending} onClick={() => act.mutate("confirm")}>{t("operations.confirmExecution")}</button>}</div>
  </div>;
}

function InspectCommand({ id, close }: { id: string; close: () => void }) {
  const operation = useData<Command>(`commands/${id}`, true, 3_000);
  return <Dialog title={t("operations.commandDetails")} close={close}><ErrorNotice error={operation.error} />
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
    {!compact && <div className="toolbar"><select aria-label={t("operations.filterCommandStatus")} value={state} onChange={(e) => { setState(e.target.value); setCursor([]); }}>
      <option value="">{t("operations.allStatuses")}</option>{Object.entries(stateText).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></div>}
    <ErrorNotice error={commands.error} />
    {commands.isPending ? <Loading /> : <Table className={compact ? "operations-table compact" : "operations-table"} columns={[t("operations.command"), ...(compact ? [] : [t("app.strategies")]), t("onboarding.status"), t("operations.requestedBy"), t("operations.createdAt"), t("onboarding.actions")]} empty={!rows.length}>
      {rows.map((item) => {
        const name = names[item.strategy_id] ?? item.strategy_id;
        const title = label(actions[item.action], item.action);
        const strategyLink = <a href={strategyPath(item.strategy_id, "control")} title={name}>{name}</a>;
        return <tr key={item.id}>
          <td className="operation-name"><strong>{title}</strong>{!compact && <span className="operation-mobile-strategy">{strategyLink}</span>}</td>
          {!compact && <td className="operation-strategy">{strategyLink}</td>}
          <td className="operation-status"><CommandBadge state={item.state} /></td>
          <td className="operation-actor mono subtle">{item.actor}</td><td className="operation-time">{when(item.created_at)}</td>
          <td><button className="button quiet" onClick={() => setInspect(item.id)}>{t("operations.details")}</button></td>
        </tr>;
      })}
    </Table>}
    {!compact && <div className="toolbar operation-pagination"><button className="button secondary" disabled={!before} onClick={() => setCursor(cursor.slice(0, -1))}>{t("operations.previousPage")}</button>
      <button className="button secondary" disabled={commands.data?.length !== 30} onClick={() => {
        const last = commands.data?.at(-1);
        if (last) setCursor([...cursor, last.id]);
      }}>{t("operations.nextPage")}</button></div>}
    {(inspect || selected) && <InspectCommand id={(inspect ?? selected)!} close={() => { setInspect(undefined); close?.(); }} />}
  </>;
}

export function OperationsPage({ commandId }: { commandId?: string }) {
  return <div className="operations-page"><PageTitle title={t("app.operations")} sub={t("operations.remoteCommandsFromTheWebAndTelegram")} />
    <Panel><OperationTable selected={commandId} close={() => { if (commandId) location.hash = "#operations"; }} /></Panel></div>;
}
