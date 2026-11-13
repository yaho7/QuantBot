import { label, t, type Message } from "../i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronRight, Eye, EyeOff, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, strategyApi, strategyPath, type Catalog, type Credential, type Detail, type Scope, type System, type StrategySettings, type Token, type TokenOptions } from "./api";
import { SandboxPanel, type SandboxCredentials } from "./sandbox";
import type { ControlRegistryView } from "./dynamic-controls";
import { CopyButton, Dialog, ErrorNotice, Field, Loading, PageTitle, Panel, Table, categoryText, severityText, useData, when } from "./ui";

export const defaultStrategy: StrategySettings = {
  name: "", mode: "paper", description: "", group: "", tags: [], disconnect_policy: "continue",
  retention_days: 90, live_trading_enabled: false, alerts: { enabled: true, minimum: "info", categories: [] },
};

export function StrategyFields({ form, set, basic = false }: { form: StrategySettings; set: (form: StrategySettings) => void; basic?: boolean }) {
  return <>
    <div className="form-grid">
      <Field label={t("onboarding.strategyName")}><input maxLength={100} required value={form.name} onChange={(e) => set({ ...form, name: e.target.value })} /></Field>
      <Field label={t("onboarding.tradingMode")}><select value={form.mode} onChange={(e) => set({ ...form, mode: e.target.value as StrategySettings["mode"], live_trading_enabled: false })}>
        <option value="paper">{t("onboarding.paper")}</option><option value="live">{t("onboarding.live")}</option><option value="backtest">{t("onboarding.backtest")}</option></select></Field>
      {!basic && <><Field label={t("onboarding.group")}><input maxLength={100} value={form.group} onChange={(e) => set({ ...form, group: e.target.value })} /></Field>
      <Field label={t("onboarding.tags")} hint={t("onboarding.commaSeparated")}><input defaultValue={form.tags.join(", ")} onChange={(e) => set({ ...form, tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} /></Field></>}
    </div>
    {!basic && <><Field label={t("onboarding.strategyDescription")}><textarea rows={2} maxLength={1000} value={form.description} onChange={(e) => set({ ...form, description: e.target.value })} /></Field>
    <details className="form-detail"><summary>{t("onboarding.disconnectBehaviorRetentionAndAlerts")}</summary><div className="stack">
      <div className="form-grid">
        <Field label={t("onboarding.disconnectPolicy")} hint={t("onboarding.theAgentMustApplyAndReportThis")}><select value={form.disconnect_policy}
          onChange={(e) => set({ ...form, disconnect_policy: e.target.value as StrategySettings["disconnect_policy"] })}>
          <option value="continue">{t("onboarding.continueRunningIndependently")}</option><option value="block_entry">{t("onboarding.blockNewEntriesAndKeepLocalRisk")}</option>
        </select></Field>
        <Field label={t("onboarding.retentionDays")}><input type="number" required min={1} max={3650} value={form.retention_days}
          onChange={(e) => set({ ...form, retention_days: Number(e.target.value) })} /></Field>
        <Field label={t("onboarding.minimumAlertSeverity")}><select value={form.alerts.minimum} onChange={(e) =>
          set({ ...form, alerts: { ...form.alerts, minimum: e.target.value as StrategySettings["alerts"]["minimum"] } })}>
          {Object.entries(severityText).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select></Field>
      </div>
      <label className="checkbox"><input type="checkbox" checked={form.alerts.enabled} onChange={(e) =>
        set({ ...form, alerts: { ...form.alerts, enabled: e.target.checked } })} /> {t("onboarding.recordAndSendAlertsForThisStrategy")}</label>
      <div className="field"><span>{t("onboarding.alertCategories")}</span><CategoryPicker selected={form.alerts.categories}
        onChange={(categories) => set({ ...form, alerts: { ...form.alerts, categories } })} /></div>
      {form.mode === "live" && <label className="checkbox danger-text"><input type="checkbox" checked={form.live_trading_enabled}
        onChange={(e) => set({ ...form, live_trading_enabled: e.target.checked })} /> {t("onboarding.allowDeclaredHighRiskLiveTradingOperations")}</label>}
    </div></details></>}
  </>;
}

export function CategoryPicker({ selected, onChange }: { selected: string[]; onChange: (items: string[]) => void }) {
  return <div className="chips">{Object.entries(categoryText).map(([key, label]) =>
    <label className="chip" key={key}><input type="checkbox" checked={selected.includes(key)}
      onChange={(e) => onChange(e.target.checked ? [...selected, key] : selected.filter((item) => item !== key))} />{t(label)}</label>)}
    <small>{t("onboarding.anEmptySelectionIncludesAllCategories")}</small></div>;
}

const scopeLabels: Record<Scope, Message> = { session: "onboarding.sessionAndHeartbeat", telemetry: "onboarding.reportData", control: "onboarding.syncEntryPermission", commands: "onboarding.claimOneTimeCommands" };

const fullScopes = Object.keys(scopeLabels) as Scope[];
const scopeSummary = (scopes: Scope[]) => scopes.length === fullScopes.length
  ? t("onboarding.fullAccess") : scopes.map((scope) => label(scopeLabels[scope])).join(" · ");

function TokenFields({ scopes, setScopes, expiry, setExpiry, expanded = false }: {
  scopes: Scope[]; setScopes: (s: Scope[]) => void; expiry?: string; setExpiry?: (s: string) => void; expanded?: boolean;
}) {
  const set = (scope: Scope, checked: boolean) => {
    const next = new Set(scopes);
    if (checked) next.add(scope); else next.delete(scope);
    if (scope === "commands" && checked) next.add("control");
    if (scope === "control" && !checked) next.delete("commands");
    setScopes([...next]);
  };
  return <>
    <details className="form-detail" open={expanded || undefined}><summary>{t("onboarding.advancedPermissions")}</summary><div className="chips">{fullScopes.map((scope) =>
      <label className="chip" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "session"}
        onChange={(e) => set(scope, e.target.checked)} />{label(scopeLabels[scope])}</label>)}</div></details>
    {setExpiry && <Field label={t("onboarding.tokenExpirationOptional")}><input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>}
    {scopes.length === fullScopes.length && <small className="subtle">{t("onboarding.fullAccessTradingOperationsStillRequireStrategy")}</small>}
  </>;
}

export function CreateStrategy({ close }: { close: () => void }) {
  const query = useQueryClient();
  const [form, set] = useState(defaultStrategy);
  const create = useMutation({
    mutationFn: () => api<{ strategy: Detail; credential: Credential }>("strategies", "POST", {
      name: form.name.trim(), mode: form.mode,
    }),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["live"] }),
  });
  if (create.data) return <CredentialDialog credential={create.data.credential} close={() => {
    location.hash = strategyPath(create.data.strategy.id, "api"); close();
  }} />;
  return <Dialog title={t("onboarding.addStrategy")} close={close}><form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
    <StrategyFields form={form} set={set} basic />
    <ErrorNotice error={create.error} />
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={close}>{t("dashboardBuilder.cancel")}</button>
      <button className="button primary" disabled={create.isPending}><KeyRound size={16} /> {t("onboarding.createAndGenerateToken")}</button></div>
  </form></Dialog>;
}

function useAgentEndpoint() {
  const system = useData<System>("system", true, 0);
  return `${system.data?.public_url ?? window.location.origin}/api/agent`;
}

const repository = "https://github.com/yaho7/QuantBot";
const docs = `${repository}/blob/main`;

function aiInstructions(endpoint: string, strategyId: string, sandbox?: SandboxCredentials) {
  const testEndpoint = sandbox?.endpoint ?? t("onboarding.filledInWhenCopied");
  const instanceName = `strategy-${strategyId.slice(0, 8)}`;
  const config = JSON.stringify({ endpoint: testEndpoint, secret: sandbox?.secret ?? t("onboarding.filledInWhenCopied"), instance_name: instanceName }, null, 2);
  return t("onboarding.sandboxPrompt", { repository, docs, testEndpoint, key: sandbox?.key ?? t("onboarding.filledInWhenCopied"), expires: sandbox?.expires_at ?? t("onboarding.filledInWhenCopied"), strategyId, endpoint, config });
}

function AgentPrompt({ endpoint, strategyId, disabled }: { endpoint: string; strategyId?: string; disabled?: boolean }) {
  if (!strategyId) return <Panel title={t("onboarding.oneClickAiIntegrationTest")}><a className="button secondary" href="#strategies">{t("onboarding.selectAStrategyToStartTesting")}</a></Panel>;
  return <SandboxPanel {...{ endpoint, strategyId, disabled }} preview={aiInstructions(endpoint, strategyId)}
    prompt={(credentials) => aiInstructions(endpoint, strategyId, credentials)} />;
}

function CredentialDialog({ credential, close }: { credential: Credential; close: () => void }) {
  const endpoint = useAgentEndpoint();
  return <Dialog title={t("onboarding.accessCredentialCreated")} close={close}><div className="stack">
    <KeyValue label="Endpoint" value={endpoint} />
    <KeyValue label={t("onboarding.strategyId")} value={credential.strategy_id} />
    <KeyValue label="Key" value={credential.id} />
    <small className="subtle">{scopeSummary(credential.scopes)}</small>
    <SecretValue load={async () => credential.token} />
    <AgentPrompt endpoint={endpoint} strategyId={credential.strategy_id} />
    <div className="dialog-actions"><button className="button primary" onClick={close}>{t("onboarding.done")}</button></div>
  </div></Dialog>;
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="key-value"><div><small>{label}</small><code>{value}</code></div><CopyButton value={value} /></div>;
}

function SecretValue({ load }: { load: () => Promise<string> }) {
  const [secret, setSecret] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function toggle() {
    if (secret) { setSecret(undefined); return; }
    setPending(true);
    setError(undefined);
    try { setSecret(await load()); }
    catch (error) { setError(error); }
    finally { setPending(false); }
  }
  return <>
    <div className="key-value"><div><small>Secret</small><code>{secret ?? "••••••••••••"}</code></div>
      <button type="button" className="icon-button" aria-label={secret ? t("onboarding.hideSecret") : t("onboarding.showSecret")}
        disabled={pending} onClick={() => void toggle()}>{secret ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      {secret && <CopyButton value={secret} label={t("onboarding.copySecret")} />}
    </div>
    <ErrorNotice error={error} />
  </>;
}

export function TokenPanel({ strategy }: { strategy: Detail }) {
  const id = strategy.id;
  const endpoint = useAgentEndpoint();
  const query = useQueryClient();
  const tokens = useData<Token[]>(strategyApi(id, "tokens"));
  const [editing, setEditing] = useState<Token | "new" | null>(null);
  const [permissions, setPermissions] = useState<Token | null>(null);
  const [replacing, setReplacing] = useState<Token | null>(null);
  const [revealed, reveal] = useState<Credential | null>(null);
  const current = tokens.data?.find((token) => !token.revoked_at && (!token.expires_at || Date.parse(token.expires_at) > Date.now()));
  const regenerate = useMutation({
    mutationFn: (token: Token) => api<Credential>(strategyApi(id, `tokens/${token.id}/regenerate`), "POST"),
    onSuccess: (credential, token) => {
      const { token: _secret, ...metadata } = credential;
      query.setQueryData<Token[]>(["live", strategyApi(id, "tokens")], (previous) => [metadata,
        ...(previous ?? []).map((item) => item.id === token.id ? { ...item, revoked_at: credential.created_at } : item),
      ]);
      setReplacing(null);
      reveal(credential);
      void query.invalidateQueries({ queryKey: ["live"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (token: Token) => api(strategyApi(id, `tokens/${token.id}`), "DELETE"),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["live"] }),
  });
  return <div className="stack">
    <AgentPrompt endpoint={endpoint} strategyId={strategy.id} disabled={!!strategy.archived_at} />
    <Panel className="credentials-panel" title={t("onboarding.accessCredentials")}
      action={!strategy.archived_at && <div className="toolbar">
        {current && <button className="button quiet" onClick={() => { regenerate.reset(); setReplacing(current); }}><RefreshCw size={16} /> {t("onboarding.regenerateToken")}</button>}
        <button className="button secondary" onClick={() => setEditing("new")}><Plus size={16} /> {t("onboarding.newToken")}</button>
      </div>}>
      <div className="credential-grid">
        <KeyValue label={t("onboarding.strategyId")} value={id} /><KeyValue label="Endpoint" value={endpoint} />
        {current && <><KeyValue label="Key" value={current.id} />
          <SecretValue key={current.id} load={async () => (await api<Credential>(strategyApi(id, `tokens/${current.id}/reveal`), "POST")).token} /></>}
      </div>
      <ErrorNotice error={tokens.error ?? revoke.error} />
      {tokens.isPending ? <Loading /> : <Table columns={["Key", t("onboarding.permissions"), t("onboarding.lastUsed"), t("onboarding.expires"), t("onboarding.status"), t("onboarding.actions")]} empty={!tokens.data?.length}>
        {tokens.data?.map((token) => {
          const expired = token.expires_at && Date.parse(token.expires_at) <= Date.now();
          return <tr key={token.id}><td className="mono">{token.id}</td><td>{scopeSummary(token.scopes)}</td>
            <td>{when(token.last_used_at)}</td><td>{token.expires_at ? when(token.expires_at) : t("onboarding.noExpiration")}</td>
            <td>{token.revoked_at ? t("onboarding.revoked") : expired ? t("onboarding.expired") : t("onboarding.active")}</td>
            <td className="row-actions">{!strategy.archived_at && <>
              {!token.revoked_at && !expired && <button className="button quiet" onClick={() => setPermissions(token)}>{t("onboarding.editPermissions")}</button>}
              <button className="button quiet" onClick={() => setEditing(token)}>{t("onboarding.rotate")}</button>
              {!token.revoked_at && <button className="button quiet danger-text" onClick={() => {
                if (confirm(t("onboarding.revokeThisTokenAgentsUsingItWill"))) revoke.mutate(token);
              }}>{t("onboarding.revoke")}</button>}
            </>}{!strategy.archived_at && !token.revoked_at && !expired && token.id !== current?.id &&
              <SecretValue load={async () => (await api<Credential>(strategyApi(id, `tokens/${token.id}/reveal`), "POST")).token} />}</td></tr>;
        })}
      </Table>}
    </Panel>
    <ConnectionDiagnostics strategy={strategy} endpoint={endpoint} token={current}
      loadingToken={tokens.isPending} />
    {editing && <EditToken strategyId={id} previous={editing === "new" ? undefined : editing}
      close={() => setEditing(null)} done={(credential) => {
        setEditing(null); reveal(credential); void query.invalidateQueries({ queryKey: ["live"] });
      }} />}
    {permissions && <EditPermissions token={permissions} close={() => setPermissions(null)} saved={(updated) => {
      query.setQueryData<Token[]>(["live", strategyApi(id, "tokens")],
        (items) => items?.map((item) => item.id === updated.id ? updated : item));
      setPermissions(null);
      void query.invalidateQueries({ queryKey: ["live"] });
    }} />}
    {replacing && <Dialog title={t("onboarding.regenerateToken")} close={() => { if (!regenerate.isPending) setReplacing(null); }}>
      <div className="stack">
        <p>{t("onboarding.theOldToken")}{" "}<code>{replacing.id}</code> {t("onboarding.willExpireImmediatelyUpdateYourStrategyConfiguration")}</p>
        <ErrorNotice error={regenerate.error} />
        <div className="dialog-actions">
          <button className="button secondary" disabled={regenerate.isPending} onClick={() => setReplacing(null)}>{t("dashboardBuilder.cancel")}</button>
          <button className="button danger" disabled={regenerate.isPending} onClick={() => regenerate.mutate(replacing)}>
            {regenerate.isPending ? t("onboarding.generating") : t("onboarding.confirmRegeneration")}
          </button>
        </div>
      </div>
    </Dialog>}
    {revealed && <CredentialDialog credential={revealed} close={() => reveal(null)} />}
  </div>;
}

function ConnectionDiagnostics({ strategy, endpoint, token, loadingToken }: {
  strategy: Detail; endpoint: string; token?: Token; loadingToken: boolean;
}) {
  const id = strategy.id;
  const catalog = useData<Catalog>(strategyApi(id, "components"));
  const controls = useData<ControlRegistryView>(strategyApi(id, "controls"));
  const delivery = useData<Array<{ created_at: string }>>(
    `audit?strategy_id=${encodeURIComponent(id)}&action=command.accepted&limit=1`);
  const instance = strategy.instances[0];
  const executor = strategy.instances.find((item) => item.instance_id === strategy.executor_id);
  const types = catalog.data?.reported_types ?? [];
  const failures = catalog.data?.schema_failures.filter((item) => item.active) ?? [];
  const lastDelivery = delivery.data?.[0]?.created_at;
  const diagnostics = {
    endpoint,
    strategy_id: id,
    key_used: token ? Boolean(token.last_used_at) : null,
    last_authenticated_at: token?.last_used_at ?? null,
    latest_instance: instance ? { id: instance.instance_id, online: instance.online, last_seen: instance.last_seen } : null,
    reports: types,
    executor: executor?.instance_id ?? null,
    executor_authorized: Boolean(executor?.declarations.executor && executor.scopes.includes("control")),
    executor_online: strategy.executor_online,
    control_in_sync: strategy.control.in_sync,
    controls: controls.data?.controls.map((item) => item.type) ?? [],
    last_command_delivery_at: lastDelivery ?? null,
    schema_errors: failures.map(({ type, observed_at, count }) => ({ type, observed_at, count })),
  };
  return <Panel title={t("onboarding.connectionDiagnostics")} action={<CopyButton value={JSON.stringify(diagnostics, null, 2)} label={t("onboarding.copyDiagnostics")} />}>
    <ErrorNotice error={catalog.error ?? controls.error ?? delivery.error} />
    <p className="subtle">{instance ? t("onboarding.informationBelowComesFromRequestsReceivedBy") : t("onboarding.waitingForTheAgentToConnectThis")} {t("onboarding.seeTheAgentSRedactedDiagnosticsFor")}</p>
    <dl className="form-grid detail-list">
      <div><dt>{t("onboarding.currentKey")}</dt><dd>{loadingToken ? t("onboarding.loading") : !token ? t("onboarding.noValidCredential") : token.last_used_at ? t("onboarding.used", { date: when(token.last_used_at) }) : t("onboarding.unused")}</dd></div>
      <div><dt>{t("onboarding.latestInstance")}</dt><dd>{instance ? `${instance.instance_id} · ${instance.online ? t("onboarding.online") : t("onboarding.offline")}` : t("onboarding.neverConnected")}</dd></div>
      <div><dt>{t("onboarding.standardReportsReceived")}</dt><dd>{types.length ? types.join(" · ") : catalog.data ? t("onboarding.noReportsYet") : "—"}</dd></div>
      <div><dt>{t("onboarding.executorAuthorization")}</dt><dd>{diagnostics.executor_authorized ? t("onboarding.authorized", { instance: executor?.instance_id }) : t("onboarding.unauthorized")}</dd></div>
      <div><dt>{t("onboarding.dynamicControls")}</dt><dd>{controls.data ? t("onboarding.registered", { total: controls.data.controls.length }) : "—"}</dd></div>
      <div><dt>{t("onboarding.commandDelivery")}</dt><dd>{lastDelivery ? t("onboarding.verified", { date: when(lastDelivery) }) : t("onboarding.unverified")}</dd></div>
    </dl>
    <Table columns={[t("onboarding.instance"), t("onboarding.connection"), t("onboarding.lastHeartbeat"), t("onboarding.agent"), "Key"]} empty={!strategy.instances.length}>
      {strategy.instances.map((item) => <tr key={item.instance_id}><td className="mono">{item.instance_id}</td><td>{item.online ? t("onboarding.online") : t("onboarding.offline")}</td>
        <td>{when(item.last_seen)}</td><td>{[item.declarations.language, item.declarations.framework, item.declarations.version, item.declarations.broker].filter(Boolean).join(" · ") || "—"}</td>
        <td className="mono">{item.token_id}</td></tr>)}
    </Table>
    {failures.map((item) => <div key={item.type} className="notice warn">
      {item.type} {t("onboarding.incompatibleProtocol")}{" "}{item.count} {t("onboarding.occurrences")}{" "}{when(item.observed_at)}
    </div>)}
    <a className="button secondary" href={`#api/${encodeURIComponent(id)}`}><BookOpen size={16} /> {t("onboarding.aiIntegrationGuide")}</a>
  </Panel>;
}

function EditToken({ strategyId, previous, close, done }: { strategyId: string; previous?: Token; close: () => void; done: (credential: Credential) => void }) {
  const [scopes, setScopes] = useState<Scope[]>(previous?.scopes ?? fullScopes);
  const [expiry, setExpiry] = useState("");
  const mutation = useMutation({
    mutationFn: (payload: TokenOptions) => api<Credential>(strategyApi(strategyId, previous ? `tokens/${previous.id}/rotate` : "tokens"), "POST", payload),
    onSuccess: done,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate({ scopes, expires_at: expiry ? new Date(expiry).toISOString() : null });
  }
  return <Dialog title={previous ? t("onboarding.rotateToken") : t("onboarding.newToken")} close={close}>
    <form className="stack" onSubmit={submit}>
      {previous && <div className="notice">{t("onboarding.theOldTokenStaysValidForUp")}</div>}
      <TokenFields {...{ scopes, setScopes, expiry, setExpiry }} />
      <ErrorNotice error={mutation.error} />
      <div className="dialog-actions"><button className="button primary" disabled={mutation.isPending}>{previous ? t("onboarding.confirmRotation") : t("onboarding.generateToken")}</button></div>
    </form>
  </Dialog>;
}

function EditPermissions({ token, close, saved }: { token: Token; close: () => void; saved: (token: Token) => void }) {
  const [scopes, setScopes] = useState(token.scopes);
  const mutation = useMutation({
    mutationFn: () => api<Token>(strategyApi(token.strategy_id, `tokens/${token.id}/permissions`), "PUT", { scopes }),
    onSuccess: saved,
  });
  return <Dialog title={t("onboarding.editTokenPermissions")} close={close}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <p className="subtle">{t("onboarding.changesTakeEffectImmediatelyAndKeepThe")}</p>
      <TokenFields scopes={scopes} setScopes={setScopes} expanded />
      <ErrorNotice error={mutation.error} />
      <div className="dialog-actions"><button className="button primary" disabled={mutation.isPending}>{t("onboarding.savePermissions")}</button></div>
    </form>
  </Dialog>;
}

export function ApiPage({ strategyId }: { strategyId?: string }) {
  const defaultEndpoint = useAgentEndpoint();
  const [customEndpoint, setCustomEndpoint] = useState("");
  const entered = customEndpoint.trim();
  let parsed: URL | undefined;
  try { parsed = entered ? new URL(entered) : undefined; } catch { /* Show validation below. */ }
  const valid = parsed && /^(https?:)\/\/[a-z0-9.:[\]-]+\/api\/agent\/?$/i.test(entered) &&
    (parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)));
  const endpoint = valid ? `${parsed!.origin}/api/agent` : defaultEndpoint;
  return <>
    <PageTitle title={t("app.apiIntegration")} sub={t("onboarding.registerAgentsReportDataAndReceiveCommands")} action={<a href={`${docs}/PROTOCOL.md`} target="_blank" rel="noreferrer" className="button secondary"><BookOpen size={16} /> {t("onboarding.githubDocumentation")}</a>} />
    <div className="stack">
      <AgentPrompt endpoint={endpoint} strategyId={strategyId} />
      <Panel title={t("onboarding.connectionDetails")}>
        <Field label={t("onboarding.customEndpoint")} hint={t("onboarding.enterTheFullEndpointReachableFromThe")}>
          <input type="url" placeholder={defaultEndpoint} value={customEndpoint} onChange={(event) => setCustomEndpoint(event.target.value)} />
        </Field>
        {entered && !valid && <p role="alert" className="notice error">{t("onboarding.enterHttpsYourHostApiAgentHttp")}</p>}
        <KeyValue label="Endpoint" value={endpoint} />
        {strategyId && <KeyValue label={t("onboarding.strategyId")} value={strategyId} />}
        {strategyId ? <a className="text-link" href={strategyPath(strategyId, "api")}>{t("onboarding.manageTokensAndDiagnostics")}{" "}<ChevronRight size={14} /></a>
          : <a className="text-link" href="#strategies">{t("onboarding.selectAStrategyToManageTokens")}{" "}<ChevronRight size={14} /></a>}
      </Panel>
      <Panel title={t("onboarding.githubIntegrationDocs")}>
        <div className="toolbar">
          <a className="text-link" href={`${docs}/docs/INTEGRATION.md`} target="_blank" rel="noreferrer">{t("onboarding.integrationGuide")}{" "}<ChevronRight size={14} /></a>
          <a className="text-link" href={`${docs}/docs/openapi.json`} target="_blank" rel="noreferrer">OpenAPI <ChevronRight size={14} /></a>
          <a className="text-link" href={`${repository}/tree/main/docs/schemas`} target="_blank" rel="noreferrer">JSON Schema <ChevronRight size={14} /></a>
          <a className="text-link" href={`${repository}/tree/main/examples`} target="_blank" rel="noreferrer">{t("onboarding.httpExamples")}{" "}<ChevronRight size={14} /></a>
        </div>
      </Panel>
    </div>
  </>;
}
