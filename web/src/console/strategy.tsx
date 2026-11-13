import { label, t } from "../i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, CloudOff, Shield } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { api, strategyApi, strategyPath, workbenchPath, type Detail, type EventRecord, type StrategySettings } from "./api";
import { StrategyFields, TokenPanel } from "./onboarding";
import { ControlPanel } from "./operations";
import { Accounts, Fills, Orders, Performance, Positions } from "./telemetry-views";
import { Empty, ErrorNotice, Field, Loading, PageTitle, Panel, StatusBadge, Table, TextLink, categoryText, modeText, money, observed, relative, severityText, useData, when } from "./ui";

const DashboardBuilder = lazy(() => import("./dashboard-builder"));

const tabs = [
  ["", "strategy.summary"], ["charts", "strategy.dashboard"], ["funds", "strategy.fundsAndPerformance"], ["positions", "strategy.positions"],
  ["orders", "strategy.ordersAndFills"], ["events", "strategy.eventsAndLogs"], ["api", "strategy.tokenAndDiagnostics"], ["settings", "strategy.configuration"],
] as const;

export function StrategyPage({ strategyId, tab = "" }: { strategyId: string; tab?: string }) {
  const [instance, setInstance] = useState("");
  const query = useData<Detail>(strategyApi(strategyId) + (instance ? `?instance=${encodeURIComponent(instance)}` : ""));
  const strategy = query.data;
  if (!strategy) return <><a className="text-link" href="#strategies"><ArrowLeft size={16} /> {t("app.strategies")}</a>
    <ErrorNotice error={query.error} />{query.isPending && <Loading />}</>;
  const snapshot = strategy.snapshot;
  const times = snapshot?.section_observed_at;
  const offline = strategy.status === "offline";
  return <>
    <a className="back-link" href="#strategies"><ArrowLeft size={15} /> {t("strategy.strategyList")}</a>
    <PageTitle title={strategy.name} sub={[label(modeText[strategy.mode]), strategy.group, strategy.description].filter(Boolean).join(" · ")}
      action={<div className="toolbar"><StatusBadge status={strategy.status} /><a className="button secondary" href={workbenchPath(strategyId)}>{t("strategy.openWorkbench")}</a></div>} />
    {strategy.archived_at && <div className="notice warn">{t("strategy.thisStrategyIsArchivedHistoryAndSettings")}</div>}
    <nav className="tabs" aria-label={t("strategy.strategyDetails")}>
      {tabs.map(([key, label]) => <a key={key} href={strategyPath(strategyId, key)} aria-current={tab === key ? "page" : undefined}>{t(label)}</a>)}
    </nav>
    <label className="field mobile-strategy-tabs"><span>{t("strategy.strategyDetails")}</span>
      <select value={tabs.some(([key]) => key === tab) ? tab : ""} onChange={(event) => { location.hash = strategyPath(strategyId, event.target.value); }}>
        {tabs.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select>
    </label>
    <ErrorNotice error={query.error} />
    {!tab && <StrategyOverview strategy={strategy} />}
    {tab === "charts" && <Suspense fallback={<Loading />}><DashboardBuilder strategy={strategy} /></Suspense>}
    {tab === "funds" && <div className="stack"><Panel title={t("overview.accountFunds")} hint={observed(times?.portfolio, offline)} action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Accounts rows={snapshot?.accounts ?? []} /></Panel><Panel title={t("strategy.performanceMetrics")} hint={observed(times?.performance, offline)}><Performance values={snapshot?.performance} /></Panel></div>}
    {tab === "positions" && <div className="stack"><Panel title={t("strategy.strategyPositions")} hint={observed(times?.position, offline)} action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Positions rows={snapshot?.strategy_positions ?? []} /></Panel>
      <Panel title={t("strategy.brokerAccountPositions")} hint={observed(times?.position, offline)}><Positions rows={snapshot?.broker_positions ?? []} /></Panel></div>}
    {tab === "orders" && <div className="stack"><Panel title={t("strategy.openOrders")} hint={observed(times?.order, offline)} action={<InstanceFilter {...{ strategy, instance, setInstance }} />}>
      <Orders rows={snapshot?.open_orders ?? []} /></Panel>
      <Panel title={t("strategy.completedOrders")} hint={observed(times?.order, offline)}><Orders rows={snapshot?.completed_orders ?? []} /></Panel>
      <Panel title={t("strategy.fillHistory")} hint={observed(times?.fill, offline)}><Fills rows={snapshot?.fills ?? []} /></Panel></div>}
    {tab === "events" && <Events strategyId={strategyId} />}
    {tab === "control" && <ControlPanel strategy={strategy} />}
    {tab === "api" && <TokenPanel strategy={strategy} />}
    {tab === "settings" && <StrategyConfig strategy={strategy} />}
  </>;
}

function InstanceFilter({ strategy, instance, setInstance }: { strategy: Detail; instance: string; setInstance: (value: string) => void }) {
  return strategy.instances.length > 1 ? <select aria-label={t("strategy.reportingInstance")} value={instance} onChange={(e) => setInstance(e.target.value)}>
    <option value="">{t("strategy.defaultInstance")}</option>{strategy.instances.map((item) => <option key={item.instance_id}>{item.instance_id}</option>)}</select> : null;
}

function StrategyOverview({ strategy }: { strategy: Detail }) {
  const latest = strategy.instances.find((item) => item.instance_id === strategy.executor_id) ?? strategy.instances[0];
  return <div className="stack">
    <div className="summary-grid strategy-summary">
      <Panel><div className="small-stat"><Activity size={20} /><span>{t("strategy.agentConnection")}</span><StatusBadge status={strategy.status} /></div></Panel>
      <Panel><div className="small-stat"><ArrowRight size={20} /><span>{t("operations.effectiveEntryPermission")}</span><strong>{strategy.control.effective_entry_enabled == null ?
        t("operations.unknown") : strategy.control.effective_entry_enabled ? t("operations.allowed") : t("operations.blocked")}</strong></div></Panel>
      <Panel><div className="small-stat"><Shield size={20} /><span>{t("operations.localRiskLock")}</span><strong>{strategy.control.reported_current && strategy.control.reported?.risk_locked != null ?
        strategy.control.reported.risk_locked ? t("operations.locked") : t("operations.unlocked") : t("operations.unknown")}</strong></div></Panel>
      <Panel><div className="small-stat"><CloudOff size={20} /><span>{t("overview.lastSeen")}</span><strong>{relative(strategy.last_seen)}</strong></div></Panel>
    </div>
    <Panel title={t("strategy.latestRuntimeData")} hint={observed(strategy.snapshot?.section_observed_at?.status, strategy.status === "offline")}
      action={<TextLink href={strategyPath(strategy.id, "api")}>{t("onboarding.connectionDiagnostics")}</TextLink>}>
      {!latest ? <Empty title={t("strategy.waitingForAgentConnection")} text={t("strategy.openAnHttpSessionWithTheStrategy")}
        action={<a className="button secondary" href={strategyPath(strategy.id, "api")}>{t("strategy.viewIntegrationDetails")}</a>} /> :
        <dl className="detail-list">
          <dt>{t("onboarding.instance")}</dt><dd>{latest.instance_id}</dd><dt>{t("strategy.agentVersion")}</dt><dd>{latest.declarations.version ?? "—"}</dd>
          <dt>{t("strategy.framework")}</dt><dd>{[latest.declarations.language, latest.declarations.framework].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>{t("strategy.brokerConnection")}</dt><dd>{latest.runtime.broker_connected == null ? t("dynamicControls.notReported") : latest.runtime.broker_connected ? t("settings.connected") : t("strategy.disconnected")}</dd>
          <dt>{t("strategy.uptime")}</dt><dd>{latest.runtime.uptime_seconds == null ? "—" : t("strategy.sec", { seconds: latest.runtime.uptime_seconds.toLocaleString() })}</dd>
          <dt>{t("strategy.authorizationExpires")}</dt><dd>{when(latest.runtime.authorization_expires_at)}</dd>
        </dl>}
    </Panel>
    <Panel title={t("strategy.customMetrics")} hint={observed(strategy.snapshot?.section_observed_at?.metric, strategy.status === "offline")} action={<TextLink href={strategyPath(strategy.id, "charts")}>{t("strategy.dashboard")}</TextLink>}>
      {strategy.snapshot?.metrics?.length ? <div className="value-grid">{strategy.snapshot.metrics.map((item, i) => <div key={`${item.name}-${i}`}>
        <span>{item.label ?? item.name}</span><strong>{money(item.value, item.unit)}</strong></div>)}</div> :
        <Empty title={t("strategy.noSnapshotMetrics")} text={t("strategy.historicalStandardMetricsAreAvailableInThe")} />}
    </Panel>
  </div>;
}

function Events({ strategyId }: { strategyId: string }) {
  const [category, setCategory] = useState("");
  const [days, setDays] = useState("7");
  const path = `events?strategy_id=${strategyId}&limit=200&start=${encodeURIComponent(new Date(Date.now() - Number(days) * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z")}${category ? `&category=${category}` : ""}`;
  const events = useData<EventRecord[]>(path);
  return <Panel title={t("strategy.reportedEventsAndLogs")}>
    <div className="toolbar"><select aria-label={t("strategy.category")} value={category} onChange={(e) => setCategory(e.target.value)}>
      <option value="">{t("settings.allCategories")}</option>{["trade", "open", "close", "risk", "warning", "error", "log", "alert", "custom"].map((key) =>
        <option value={key} key={key}>{label(categoryText[key])}</option>)}</select>
      <select aria-label={t("dashboardBuilder.timeRange")} value={days} onChange={(e) => setDays(e.target.value)}><option value="1">{t("strategy.lastDay")}</option>
        <option value="7">{t("strategy.last7Days")}</option><option value="30">{t("strategy.last30Days")}</option><option value="365">{t("strategy.lastYear")}</option></select></div>
    <ErrorNotice error={events.error} />{events.isPending ? <Loading /> : <Table columns={[t("marketChart.time"), t("settings.category"), t("strategy.level"), t("marketChart.content")]} empty={!events.data?.length}>
      {events.data?.map((item) => <tr key={item.id}><td>{when(item.occurred_at)}</td><td>{label(categoryText[item.category], item.category)}</td>
        <td>{label(severityText[item.severity])}</td><td className="wrap">{item.message}</td></tr>)}
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
    <Panel title={t("strategy.strategySettings")}>
      <ErrorNotice error={mutation.error} />
      {mutation.isSuccess && <div role="status" className="notice">{t("strategy.saved")}</div>}
      {!strategy.archived_at && <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        if (form.live_trading_enabled && !strategy.live_trading_enabled &&
            !confirm(t("strategy.allowDeclaredHighRiskLiveActionsEach"))) return;
        mutation.mutate("save");
      }}>
        <StrategyFields {...{ form, set }} /><div><button className="button primary" disabled={mutation.isPending}>{t("strategy.saveConfiguration")}</button></div>
      </form>}
      {strategy.archived_at && <button className="button secondary" onClick={() => mutation.mutate("restore")}>{t("strategy.restoreArchivedStrategy")}</button>}
    </Panel>
    {!strategy.archived_at && <>
      <Panel title={t("strategy.authorizeExecutor")} hint={t("strategy.aStrategyHasOneExecutorDisconnectThe")}>
        <p className="subtle">{t("strategy.currentExecutor")}{" "}{strategy.executor_id ?? t("strategy.unassigned")}</p>
        <div className="toolbar"><Field label={t("strategy.availableInstances")}><select value={executor} onChange={(e) => setExecutor(e.target.value)}>
          <option value="">{t("dashboardBuilder.selectAnOption")}</option>{strategy.instances.filter((item) =>
            item.online && item.declarations.executor && item.instance_id !== strategy.executor_id)
            .map((item) => <option key={item.instance_id}>{item.instance_id}</option>)}</select></Field>
          <button className="button secondary" disabled={!executor || strategy.executor_online || mutation.isPending}
            onClick={() => mutation.mutate("executor")}>{t("strategy.switchExecutor")}</button></div>
      </Panel>
      <Panel title={t("strategy.deleteStrategy")}><p className="subtle">{t("strategy.deletingArchivesTheStrategyAndRevokesIts")}</p>
        <button className="button danger" disabled={mutation.isPending} onClick={() => {
          if (confirm(t("strategy.deleteAndArchiveItsAccessTokensWill", { name: strategy.name }))) mutation.mutate("archive");
        }}>{t("strategy.deleteAndArchive")}</button>
      </Panel>
    </>}
  </div>;
}
