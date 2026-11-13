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
    <PageTitle title="通知与 Telegram" sub="配置 Bot、授权私聊管理员和推送规则。" />
    <div className="stack">
      <ErrorNotice error={config.error} />
      {config.data ? <TelegramForm config={config.data} /> : config.isPending ? <Loading /> : null}
      <Panel title="通知历史">
        <div className="toolbar"><select aria-label="通知分类" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">全部分类</option>{Object.entries(categoryText).map(([value, label]) =>
            <option key={value} value={value}>{label}</option>)}</select></div>
        <ErrorNotice error={alerts.error} />
        {alerts.isPending ? <Loading /> : <Table columns={["时间", "类别", "等级", "通知"]}
          empty={!alerts.data?.some((item) => !category || item.category === category)}>
          {alerts.data?.filter((item) => !category || item.category === category).map((item) =>
            <tr key={item.id}><td>{when(item.created_at)}</td><td>{categoryText[item.category] ?? item.category}</td>
              <td>{severityText[item.severity]}</td><td className="wrap">{item.message}</td></tr>)}
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
  const status = { connected: "已连接", disabled: "未启用", error: "连接异常" }[config.connection_status];
  return <Panel title="Telegram Bot" hint={status} action={<Bot size={23} />}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
      <div className="toolbar">
        <label className="checkbox"><input type="checkbox" checked={form.enabled}
          onChange={(e) => set({ ...form, enabled: e.target.checked })} /> 启用 Bot</label>
        <label className="checkbox"><input type="checkbox" checked={form.notify}
          onChange={(e) => set({ ...form, notify: e.target.checked })} /> 启用通知推送</label>
      </div>
      <div className="form-grid">
        <Field label="Bot Token" hint={config.token_source === "environment" ? "由服务环境提供"
          : config.has_token ? "已配置，留空继续使用" : "从 BotFather 获取"}>
          <input type="password" autoComplete="new-password" disabled={config.token_source === "environment" || clear}
            value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        <Field label="授权用户 ID" hint="多个数字 ID 以逗号分隔。每位用户先与 Bot 私聊发送 /start。">
          <input value={admins} onChange={(e) => setAdmins(e.target.value)} /></Field>
        <Field label="最低通知等级"><select value={form.minimum} onChange={(e) =>
          set({ ...form, minimum: e.target.value as TelegramSettings["minimum"] })}>
          {Object.entries(severityText).map(([key, name]) => <option value={key} key={key}>{name}</option>)}
        </select></Field>
        <Field label="最短推送间隔（秒）"><input type="number" min={1} max={300} required value={form.min_interval_seconds}
          onChange={(e) => set({ ...form, min_interval_seconds: Number(e.target.value) })} /></Field>
      </div>
      {config.token_source === "database" && <label className="checkbox"><input type="checkbox" checked={clear}
        onChange={(e) => { setClear(e.target.checked); if (e.target.checked) setSecret(""); }} /> 删除已保存的 Bot Token</label>}
      <div className="field"><span>通知分类</span><CategoryPicker selected={form.categories}
        onChange={(categories) => set({ ...form, categories })} /></div>
      <label className="checkbox"><input type="checkbox" checked={!!form.quiet_hours} onChange={(e) =>
        set({ ...form, quiet_hours: e.target.checked ? { start: "23:00", end: "07:00" } : null })} /> 启用静音时段</label>
      {form.quiet_hours && <div className="form-grid">
        <Field label="时区"><input required value={form.timezone} onChange={(e) => set({ ...form, timezone: e.target.value })} /></Field>
        <Field label="起始"><input type="time" required value={form.quiet_hours.start} onChange={(e) =>
          set({ ...form, quiet_hours: { start: e.target.value, end: form.quiet_hours!.end } })} /></Field>
        <Field label="结束"><input type="time" required value={form.quiet_hours.end} onChange={(e) =>
          set({ ...form, quiet_hours: { start: form.quiet_hours!.start, end: e.target.value } })} /></Field>
      </div>}
      <ErrorNotice error={change.error} />
      {change.isSuccess && <div role="status" className="notice">设置已保存</div>}
      <div><button className="button primary" disabled={change.isPending}>保存 Telegram 设置</button></div>
    </form>
  </Panel>;
}

const countLabels: Record<string, string> = { strategies: "策略", archived: "已归档", metrics: "指标点", events: "事件", reports: "标准记录", commands: "指令" };

export function SystemPage({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  const system = useData<System>("system");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const password = useMutation({
    mutationFn: () => api("system/password", "PUT", { current_password: current, new_password: next }),
    onSuccess: () => { setCurrent(""); setNext(""); },
  });
  return <>
    <PageTitle title="系统设置" sub="管理员安全、服务版本与数据存储。" />
    <div className="stack">
      <Panel title="外观" action={<SunMoon size={21} />}>
        <Field label="主题"><select value={theme} onChange={(e) => onTheme(e.target.value as Theme)}>
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select></Field>
      </Panel>
      <Panel title="管理员密码" action={<KeyRound size={21} />}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); password.mutate(); }}>
          <div className="form-grid"><Field label="当前密码"><input type="password" required autoComplete="current-password" value={current}
            onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field label="新密码" hint={`至少 ${MIN_PASSWORD_LENGTH} 个字符`}><input type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={next}
              onChange={(e) => setNext(e.target.value)} /></Field></div>
          <ErrorNotice error={password.error} />
          {password.isSuccess && <div role="status" className="notice">密码已更新，之前的网页登录会话已撤销。</div>}
          <div><button className="button primary" disabled={password.isPending}>更新密码</button></div>
        </form>
      </Panel>
      <Panel title="数据管理" action={<Database size={21} />}>
        <ErrorNotice error={system.error} />
        {system.data ? <>
          <p className="subtle">{system.data.storage} · Schema {system.data.schema_version}</p>
          <div className="value-grid">{Object.entries(system.data.counts).map(([key, count]) =>
            <div key={key}><span>{countLabels[key] ?? key}</span><strong>{count.toLocaleString()}</strong></div>)}</div>
        </> : system.isPending ? <Loading /> : null}
      </Panel>
      <Panel title="服务和更新" action={<Server size={21} />}>
        <dl className="detail-list"><dt>当前版本</dt><dd>{system.data?.version ?? "—"}</dd>
          <dt>访问地址</dt><dd>{system.data?.public_url ?? location.origin}</dd>
          <dt>服务健康</dt><dd><a href="/healthz">/healthz</a></dd></dl>
        <div className="toolbar"><a className="button secondary" href="https://github.com/yaho7/QuantBot/releases"
          target="_blank" rel="noreferrer">查看 QuantBot 发布版本 <ExternalLink size={15} /></a></div>
      </Panel>
    </div>
  </>;
}
