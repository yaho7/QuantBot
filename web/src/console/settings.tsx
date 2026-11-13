import { label, t, type Message } from "../i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Database, ExternalLink, KeyRound, Server, SunMoon } from "lucide-react";
import type { Theme } from "./theme";
import { useState } from "react";
import { api, MIN_PASSWORD_LENGTH, type Alert, type System, type TelegramSettings } from "./api";
import { CategoryPicker } from "./onboarding";
import { ErrorNotice, Field, Loading, PageTitle, Panel, Table, categoryText, severityText, useData, when } from "./ui";

export function TelegramPage() {
  const config = useData<TelegramSettings>("telegram");
  const alerts = useData<Alert[]>("alerts?limit=100");
  const [category, setCategory] = useState("");
  return <>
    <PageTitle title={t("settings.notificationsAndTelegram")} sub={t("settings.configureTheBotAuthorizedUsersAndNotification")} />
    <div className="stack">
      <ErrorNotice error={config.error} />
      {config.data ? <TelegramForm config={config.data} /> : config.isPending ? <Loading /> : null}
      <Panel title={t("settings.notificationHistory")}>
        <div className="toolbar"><select aria-label={t("settings.notificationCategory")} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t("settings.allCategories")}</option>{Object.entries(categoryText).map(([value, label]) =>
            <option key={value} value={value}>{t(label)}</option>)}</select></div>
        <ErrorNotice error={alerts.error} />
        {alerts.isPending ? <Loading /> : <Table columns={[t("marketChart.time"), t("settings.category"), t("settings.severity"), t("app.notifications")]}
          empty={!alerts.data?.some((item) => !category || item.category === category)}>
          {alerts.data?.filter((item) => !category || item.category === category).map((item) =>
            <tr key={item.id}><td>{when(item.created_at)}</td><td>{label(categoryText[item.category], item.category)}</td>
              <td>{label(severityText[item.severity])}</td><td className="wrap">{item.message}</td></tr>)}
        </Table>}
      </Panel>
    </div>
  </>;
}

function TelegramForm({ config }: { config: TelegramSettings }) {
  const client = useQueryClient();
  const [form, set] = useState(config);
  const [admins, setAdmins] = useState(config.admins.join(", "));
  const [secret, setSecret] = useState("");
  const [clear, setClear] = useState(false);
  const change = useMutation({
    mutationFn: () => {
      const { enabled, notify, minimum, categories, quiet_hours, timezone, min_interval_seconds } = form;
      return api<TelegramSettings>("telegram", "PUT", {
        enabled, notify, minimum, categories, quiet_hours, timezone, min_interval_seconds,
        admins: admins.split(/[,，\s]+/).filter(Boolean).map(Number),
        ...(secret ? { bot_token: secret } : {}), clear_token: clear,
      });
    },
    onSuccess: (data) => {
      setSecret(""); setClear(false); set(data);
      void client.invalidateQueries({ queryKey: ["live", "telegram"] });
    },
  });
  const status = { connected: t("settings.connected"), disabled: t("settings.disabled"), error: t("settings.connectionError") }[config.connection_status];
  return <Panel title="Telegram Bot" hint={status} action={<Bot size={23} />}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
      <div className="toolbar">
        <label className="checkbox"><input type="checkbox" checked={form.enabled}
          onChange={(e) => set({ ...form, enabled: e.target.checked })} /> {t("settings.enableBot")}</label>
        <label className="checkbox"><input type="checkbox" checked={form.notify}
          onChange={(e) => set({ ...form, notify: e.target.checked })} /> {t("settings.enableNotifications")}</label>
      </div>
      <div className="form-grid">
        <Field label="Bot Token" hint={config.token_source === "environment" ? t("settings.providedByTheServerEnvironment")
          : config.has_token ? t("settings.configuredLeaveBlankToKeepIt") : t("settings.getFromBotfather")}>
          <input type="password" autoComplete="new-password" disabled={config.token_source === "environment" || clear}
            value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        <Field label={t("settings.authorizedUserIds")} hint={t("settings.separateNumericIdsWithCommasEachUser")}>
          <input value={admins} onChange={(e) => setAdmins(e.target.value)} /></Field>
        <Field label={t("settings.minimumNotificationSeverity")}><select value={form.minimum} onChange={(e) =>
          set({ ...form, minimum: e.target.value as TelegramSettings["minimum"] })}>
          {Object.entries(severityText).map(([key, name]) => <option value={key} key={key}>{t(name)}</option>)}
        </select></Field>
        <Field label={t("settings.minimumIntervalSeconds")}><input type="number" min={1} max={300} required value={form.min_interval_seconds}
          onChange={(e) => set({ ...form, min_interval_seconds: Number(e.target.value) })} /></Field>
      </div>
      {config.token_source === "database" && <label className="checkbox"><input type="checkbox" checked={clear}
        onChange={(e) => { setClear(e.target.checked); if (e.target.checked) setSecret(""); }} /> {t("settings.deleteTheSavedBotToken")}</label>}
      <div className="field"><span>{t("settings.notificationCategory")}</span><CategoryPicker selected={form.categories}
        onChange={(categories) => set({ ...form, categories })} /></div>
      <label className="checkbox"><input type="checkbox" checked={!!form.quiet_hours} onChange={(e) =>
        set({ ...form, quiet_hours: e.target.checked ? { start: "23:00", end: "07:00" } : null })} /> {t("settings.enableQuietHours")}</label>
      {form.quiet_hours && <div className="form-grid">
        <Field label={t("settings.timeZone")}><input required value={form.timezone} onChange={(e) => set({ ...form, timezone: e.target.value })} /></Field>
        <Field label={t("settings.start")}><input type="time" required value={form.quiet_hours.start} onChange={(e) =>
          set({ ...form, quiet_hours: { start: e.target.value, end: form.quiet_hours!.end } })} /></Field>
        <Field label={t("settings.end")}><input type="time" required value={form.quiet_hours.end} onChange={(e) =>
          set({ ...form, quiet_hours: { start: form.quiet_hours!.start, end: e.target.value } })} /></Field>
      </div>}
      <ErrorNotice error={change.error} />
      {change.isSuccess && <div role="status" className="notice">{t("settings.settingsSaved")}</div>}
      <div><button className="button primary" disabled={change.isPending}>{t("settings.saveTelegramSettings")}</button></div>
    </form>
  </Panel>;
}

const countLabels: Record<string, Message> = { strategies: "app.strategies", archived: "overview.archived", metrics: "settings.metricSamples", events: "settings.events", reports: "settings.standardRecords", commands: "operations.command" };

export function SystemPage({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  const system = useData<System>("system");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const password = useMutation({
    mutationFn: () => api("system/password", "PUT", { current_password: current, new_password: next }),
    onSuccess: () => { setCurrent(""); setNext(""); },
  });
  return <>
    <PageTitle title={t("settings.systemSettings")} sub={t("settings.administratorSecurityServiceVersionAndDataStorage")} />
    <div className="stack">
      <Panel title={t("settings.appearance")} action={<SunMoon size={21} />}>
        <Field label={t("settings.theme")}><select value={theme} onChange={(e) => onTheme(e.target.value as Theme)}>
          <option value="system">{t("settings.systemDefault")}</option><option value="light">{t("settings.light")}</option><option value="dark">{t("settings.dark")}</option>
        </select></Field>
      </Panel>
      <Panel title={t("settings.administratorPassword")} action={<KeyRound size={21} />}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); password.mutate(); }}>
          <div className="form-grid"><Field label={t("settings.currentPassword")}><input type="password" required autoComplete="current-password" value={current}
            onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field label={t("settings.newPassword")} hint={t("app.atLeastCharacters", { minimum: MIN_PASSWORD_LENGTH })}><input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={next}
              onChange={(e) => setNext(e.target.value)} /></Field></div>
          <ErrorNotice error={password.error} />
          {password.isSuccess && <div role="status" className="notice">{t("settings.passwordUpdatedPreviousWebSessionsHaveBeen")}</div>}
          <div><button className="button primary" disabled={password.isPending}>{t("settings.updatePassword")}</button></div>
        </form>
      </Panel>
      <Panel title={t("settings.dataManagement")} action={<Database size={21} />}>
        <ErrorNotice error={system.error} />
        {system.data ? <>
          <p className="subtle">{system.data.storage} · Schema {system.data.schema_version}</p>
          <div className="value-grid">{Object.entries(system.data.counts).map(([key, count]) =>
            <div key={key}><span>{label(countLabels[key], key)}</span><strong>{count.toLocaleString()}</strong></div>)}</div>
        </> : system.isPending ? <Loading /> : null}
      </Panel>
      <Panel title={t("settings.serviceAndUpdates")} action={<Server size={21} />}>
        <dl className="detail-list"><dt>{t("settings.currentVersion")}</dt><dd>{system.data?.version ?? "—"}</dd>
          <dt>{t("settings.publicUrl")}</dt><dd>{system.data?.public_url ?? location.origin}</dd>
          <dt>{t("settings.serviceHealth")}</dt><dd><a href="/healthz">/healthz</a></dd></dl>
        <div className="toolbar"><a className="button secondary" href="https://github.com/yaho7/QuantBot/releases"
          target="_blank" rel="noreferrer">{t("settings.viewQuantbotReleases")}{" "}<ExternalLink size={15} /></a></div>
      </Panel>
    </div>
  </>;
}
