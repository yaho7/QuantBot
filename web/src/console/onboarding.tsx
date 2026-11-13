import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronRight, KeyRound, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, strategyApi, strategyPath, type Catalog, type Credential, type DataType, type Detail, type Scope, type System, type StrategySettings, type Token, type TokenOptions } from "./api";
import { Code, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, Table, categoryText, severityText, useData, when } from "./ui";

export const defaultStrategy: StrategySettings = {
  name: "", mode: "paper", description: "", group: "", tags: [], disconnect_policy: "continue",
  retention_days: 90, live_trading_enabled: false, alerts: { enabled: true, minimum: "info", categories: [] },
};

export function StrategyFields({ form, set, basic = false }: { form: StrategySettings; set: (form: StrategySettings) => void; basic?: boolean }) {
  return <>
    <div className="form-grid">
      <Field label="策略名称"><input maxLength={100} required value={form.name} onChange={(e) => set({ ...form, name: e.target.value })} /></Field>
      <Field label="交易模式"><select value={form.mode} onChange={(e) => set({ ...form, mode: e.target.value as StrategySettings["mode"], live_trading_enabled: false })}>
        <option value="paper">模拟盘</option><option value="live">实盘</option><option value="backtest">回测</option></select></Field>
      {!basic && <><Field label="分组"><input maxLength={100} value={form.group} onChange={(e) => set({ ...form, group: e.target.value })} /></Field>
      <Field label="标签" hint="以逗号分隔"><input defaultValue={form.tags.join(", ")} onChange={(e) => set({ ...form, tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} /></Field></>}
    </div>
    {!basic && <><Field label="策略说明"><textarea rows={2} maxLength={1000} value={form.description} onChange={(e) => set({ ...form, description: e.target.value })} /></Field>
    <details className="form-detail"><summary>断线、数据保留与告警</summary><div className="stack">
      <div className="form-grid">
        <Field label="断线策略" hint="需要程序自行实施并回报"><select value={form.disconnect_policy}
          onChange={(e) => set({ ...form, disconnect_policy: e.target.value as StrategySettings["disconnect_policy"] })}>
          <option value="continue">继续自主运行</option><option value="block_entry">禁止新开仓，保留本地风控</option>
        </select></Field>
        <Field label="数据保留（天）"><input type="number" required min={1} max={3650} value={form.retention_days}
          onChange={(e) => set({ ...form, retention_days: Number(e.target.value) })} /></Field>
        <Field label="最低告警等级"><select value={form.alerts.minimum} onChange={(e) =>
          set({ ...form, alerts: { ...form.alerts, minimum: e.target.value as StrategySettings["alerts"]["minimum"] } })}>
          {Object.entries(severityText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field>
      </div>
      <label className="checkbox"><input type="checkbox" checked={form.alerts.enabled} onChange={(e) =>
        set({ ...form, alerts: { ...form.alerts, enabled: e.target.checked } })} /> 记录并通知该策略的告警</label>
      <div className="field"><span>告警分类</span><CategoryPicker selected={form.alerts.categories}
        onChange={(categories) => set({ ...form, alerts: { ...form.alerts, categories } })} /></div>
      {form.mode === "live" && <label className="checkbox danger-text"><input type="checkbox" checked={form.live_trading_enabled}
        onChange={(e) => set({ ...form, live_trading_enabled: e.target.checked })} /> 允许通过 QuantBot 提交已声明的实盘高风险操作</label>}
    </div></details></>}
  </>;
}

export function CategoryPicker({ selected, onChange }: { selected: string[]; onChange: (items: string[]) => void }) {
  return <div className="chips">{Object.entries(categoryText).map(([key, label]) =>
    <label className="chip" key={key}><input type="checkbox" checked={selected.includes(key)}
      onChange={(e) => onChange(e.target.checked ? [...selected, key] : selected.filter((item) => item !== key))} />{label}</label>)}
    <small>未选择时包含全部分类</small></div>;
}

const scopeLabels: Record<Scope, string> = { session: "会话与心跳", telemetry: "上报数据", control: "同步开仓权限", commands: "领取一次性指令" };

function TokenFields({ scopes, setScopes, expiry, setExpiry }: {
  scopes: Scope[]; setScopes: (s: Scope[]) => void; expiry: string; setExpiry: (s: string) => void;
}) {
  const set = (scope: Scope, checked: boolean) => {
    const next = new Set(scopes);
    if (checked) next.add(scope); else next.delete(scope);
    if (scope === "commands" && checked) next.add("control");
    if (scope === "control" && !checked) next.delete("commands");
    setScopes([...next]);
  };
  return <>
    <div className="field"><span>Token 权限</span><div className="chips">{(Object.keys(scopeLabels) as Scope[]).map((scope) =>
      <label className="chip" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "session"}
        onChange={(e) => set(scope, e.target.checked)} />{scopeLabels[scope]}</label>)}</div></div>
    <Field label="Token 到期时间（可选）"><input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
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
  return <Dialog title="添加策略" close={close}><form className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
    <StrategyFields form={form} set={set} basic />
    <ErrorNotice error={create.error} />
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={close}>取消</button>
      <button className="button primary" disabled={create.isPending}><KeyRound size={16} /> 创建并生成 Token</button></div>
  </form></Dialog>;
}

function useAgentOrigin() {
  const system = useData<System>("system", true, 0);
  return system.data?.public_url ?? window.location.origin;
}

function shell(origin: string) {
  return `export QB_URL=${JSON.stringify(origin)}
read -rs QB_TOKEN
export QB_TOKEN
while true; do
  curl -fsS --max-time 10 "$QB_URL/api/v2/agent/monitor/my-program" \\
    -H "Authorization: Bearer $QB_TOKEN" -H 'Content-Type: application/json' \\
    -d "{\"records\":[{\"type\":\"status\",\"schema_version\":1,\"observed_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"runtime\":{\"health\":\"healthy\"}}]}"
  sleep 15
done`;
}

function python(origin: string) {
  return `import json, os, time, urllib.error, urllib.request
from datetime import datetime, timezone

root = os.getenv("QB_URL", ${JSON.stringify(origin)}).rstrip("/") + "/api/v2/agent"
headers = {"Authorization": "Bearer " + os.environ["QB_TOKEN"],
           "Content-Type": "application/json"}

def request(path, method, data):
    req = urllib.request.Request(root + path, json.dumps(data).encode(),
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)

if __name__ == "__main__":
    while True:
        try:
            request("/monitor/my-program", "POST", {"records": [{
                "type": "status", "schema_version": 1,
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "runtime": {"health": "healthy"},
            }]})
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403, 422, 426):
                raise SystemExit(f"接入失败（HTTP {exc.code}），请检查 Token、地址和数据")
            print(f"HTTP {exc.code}，15 秒后重试", flush=True)
        except (OSError, urllib.error.URLError) as exc:
            print(f"连接失败：{exc}，15 秒后重试", flush=True)
        time.sleep(15)`;
}

function aiInstructions(origin: string, strategyId?: string) {
  return `为我的独立量化程序添加 QuantBot HTTP 接入。API 地址 ${origin}/api/v2/agent${strategyId ? `，Strategy ID ${strategyId}` : ""}。
从环境变量 QB_TOKEN 读取策略凭据，并作为 Authorization: Bearer 发送。仅监控时每 15 秒 POST /monitor/{稳定实例名}，使用 {"records":[...]} 上报状态和指标，不需要会话或额外心跳。网络错误后重试。
用 OpenAPI 和 JSON Schema 校验数据。金额和数量用十进制字符串，时间戳带时区，事件 ID 在重传时保持不变。
只有需要远程控制时才启用控制权限并 POST /session，后续带 X-Agent-Session，按返回的间隔 PUT /heartbeat，遇 409 重建会话。应用并本地持久化期望开仓权限，再回报 revision 与风险锁。一次性指令须先领取许可，记录命令 ID，结果未知先核对。
接口与数据定义：${origin}/openapi.json、${origin}/api/v2/data-types。`;
}

function CredentialDialog({ credential, close }: { credential: Credential; close: () => void }) {
  const origin = useAgentOrigin();
  return <Dialog title="接入 Token 已生成" close={close}><div className="stack">
    <div className="notice warn">Token 明文仅显示一次。请复制并保存到程序的密钥配置。</div>
    <KeyValue label="API 地址" value={`${origin}/api/v2/agent`} />
    <KeyValue label="策略 ID" value={credential.strategy_id} />
    <KeyValue label="API Token" value={credential.token} />
    <details className="form-detail" open><summary>HTTP 接入示例和 AI 提示词</summary><div className="stack">
      <Code label="curl">{shell(origin)}</Code><Code label="Python">{python(origin)}</Code>
      <Code label="AI 接入提示词">{aiInstructions(origin, credential.strategy_id)}</Code>
    </div></details>
    <div className="dialog-actions"><button className="button primary" onClick={close}>完成</button></div>
  </div></Dialog>;
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="key-value"><div><small>{label}</small><code>{value}</code></div><CopyButton value={value} /></div>;
}

export function TokenPanel({ strategy }: { strategy: Detail }) {
  const id = strategy.id;
  const origin = useAgentOrigin();
  const query = useQueryClient();
  const tokens = useData<Token[]>(strategyApi(id, "tokens"));
  const catalog = useData<Catalog>(strategyApi(id, "components"));
  const [editing, setEditing] = useState<Token | "new" | null>(null);
  const [revealed, reveal] = useState<Credential | null>(null);
  const revoke = useMutation({
    mutationFn: (token: Token) => api(strategyApi(id, `tokens/${token.id}`), "DELETE"),
    onSuccess: () => void query.invalidateQueries({ queryKey: ["live"] }),
  });
  return <div className="stack">
    <Panel title="接入凭据" hint="每个 Token 的权限、有效期和最近使用时间独立管理。"
      action={!strategy.archived_at && <button className="button primary" onClick={() => setEditing("new")}><Plus size={16} /> 新建 Token</button>}>
      <KeyValue label="策略 ID" value={id} /><KeyValue label="API 地址" value={`${origin}/api/v2/agent`} />
      <ErrorNotice error={tokens.error ?? revoke.error} />
      {tokens.isPending ? <Loading /> : <Table columns={["Token ID", "权限", "最近使用", "有效期", "状态", "操作"]} empty={!tokens.data?.length}>
        {tokens.data?.map((token) => {
          const expired = token.expires_at && Date.parse(token.expires_at) <= Date.now();
          return <tr key={token.id}><td className="mono">{token.id}</td><td>{token.scopes.join(" · ")}</td>
            <td>{when(token.last_used_at)}</td><td>{token.expires_at ? when(token.expires_at) : "长期"}</td>
            <td>{token.revoked_at ? "已撤销" : expired ? "已过期" : "有效"}</td>
            <td className="row-actions">{!strategy.archived_at && <>
              <button className="button quiet" onClick={() => setEditing(token)}>轮换</button>
              {!token.revoked_at && <button className="button quiet danger-text" onClick={() => {
                if (confirm("撤销该 Token 后，使用它的实例将失去连接。继续撤销？")) revoke.mutate(token);
              }}>撤销</button>}
            </>}</td></tr>;
        })}
      </Table>}
    </Panel>
    <Panel title="连接诊断" hint="实例最近心跳、声明能力和协议校验情况。">
      <Table columns={["实例", "连接", "最后心跳", "程序", "Token ID"]} empty={!strategy.instances.length}>
        {strategy.instances.map((item) => <tr key={item.instance_id}><td className="mono">{item.instance_id}</td><td>{item.online ? "在线" : "离线"}</td>
          <td>{when(item.last_seen)}</td><td>{[item.declarations.language, item.declarations.framework, item.declarations.version, item.declarations.broker].filter(Boolean).join(" · ") || "—"}</td>
          <td className="mono">{item.token_id}</td></tr>)}
      </Table>
      {catalog.data?.schema_failures.map((item) => <div key={item.type} className={`notice ${item.active ? "warn" : ""}`}>
        {item.type} · {item.active ? "协议不兼容" : "已收到兼容数据"} · {item.count} 次 · {when(item.observed_at)}
      </div>)}
      <a className="button secondary" href={`#api/${encodeURIComponent(id)}`}><BookOpen size={16} /> 接口规则与接入示例</a>
    </Panel>
    {editing && <EditToken strategyId={id} previous={editing === "new" ? undefined : editing}
      close={() => setEditing(null)} done={(credential) => {
        setEditing(null); reveal(credential); void query.invalidateQueries({ queryKey: ["live"] });
      }} />}
    {revealed && <CredentialDialog credential={revealed} close={() => reveal(null)} />}
  </div>;
}

function EditToken({ strategyId, previous, close, done }: { strategyId: string; previous?: Token; close: () => void; done: (credential: Credential) => void }) {
  const [scopes, setScopes] = useState<Scope[]>(previous?.scopes ?? ["session", "telemetry"]);
  const [expiry, setExpiry] = useState("");
  const mutation = useMutation({
    mutationFn: (payload: TokenOptions) => api<Credential>(strategyApi(strategyId, previous ? `tokens/${previous.id}/rotate` : "tokens"), "POST", payload),
    onSuccess: done,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate({ scopes, expires_at: expiry ? new Date(expiry).toISOString() : null });
  }
  return <Dialog title={previous ? "轮换 Token" : "新建 Token"} close={close}>
    <form className="stack" onSubmit={submit}>
      {previous && <div className="notice warn">生成新 Token 时会同时撤销旧 Token。</div>}
      <TokenFields {...{ scopes, setScopes, expiry, setExpiry }} />
      <ErrorNotice error={mutation.error} />
      <div className="dialog-actions"><button className="button primary" disabled={mutation.isPending}>{previous ? "确认轮换" : "生成 Token"}</button></div>
    </form>
  </Dialog>;
}

type OpenApi = { paths: Record<string, Record<string, { summary?: string; description?: string }>> };

export function ApiPage({ strategyId }: { strategyId?: string }) {
  const defaultOrigin = useAgentOrigin();
  const [customOrigin, setCustomOrigin] = useState("");
  let parsed: URL | undefined;
  try { parsed = customOrigin.trim() ? new URL(customOrigin.trim()) : undefined; } catch { /* Show validation below. */ }
  const valid = parsed && ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password &&
    parsed.pathname === "/" && !parsed.search && !parsed.hash;
  const origin = (valid ? parsed?.origin : undefined) ?? defaultOrigin;
  const spec = useQuery({ queryKey: ["spec"], queryFn: () => api<OpenApi>("/openapi.json"), staleTime: Infinity });
  const types = useQuery({ queryKey: ["types"], queryFn: () => api<DataType[]>("/api/v2/data-types"), staleTime: Infinity });
  const [schema, setSchema] = useState("status");
  const schemaUrl = `/api/v2/schemas/${schema}`;
  const definition = useQuery({ queryKey: ["schema", schema], queryFn: () => api<unknown>(schemaUrl), staleTime: Infinity });
  return <>
    <PageTitle title="API 接入" sub="使用标准 HTTP 注册、上报和接收控制指令。" action={<a href="/docs" className="button secondary"><BookOpen size={16} /> 交互文档</a>} />
    <div className="stack">
      <Panel title="连接信息">
        <Field label="策略接入地址" hint="从其他机器接入时，使用策略所在机器可以访问的地址。">
          <input type="url" placeholder={defaultOrigin} value={customOrigin} onChange={(event) => setCustomOrigin(event.target.value)} />
        </Field>
        {customOrigin.trim() && !valid && <p role="alert" className="notice error">请输入不带路径的 HTTP 或 HTTPS 地址。</p>}
        <KeyValue label="API 地址" value={`${origin}/api/v2/agent`} />
        {strategyId && <KeyValue label="策略 ID" value={strategyId} />}
        {strategyId ? <a className="text-link" href={strategyPath(strategyId, "api")}>管理 Token 和连接诊断 <ChevronRight size={14} /></a>
          : <a className="text-link" href="#strategies">选择策略并管理 Token <ChevronRight size={14} /></a>}
      </Panel>
      <Panel title="接入规则"><ol className="steps">
        <li>基础监控：用 Bearer Token 每 15 秒 POST <code>/monitor/实例名</code> 上报数据。</li>
        <li>需要远程控制时，以 Bearer Token 请求 <code>POST /session</code>，记录服务返回的会话 ID。</li>
        <li>后续请求设置 <code>X-Agent-Session</code>，并按会话返回的间隔发送心跳。会话过期时重新连接。</li>
        <li>遥测记录包含 <code>type</code>、<code>schema_version</code> 和带时区时间戳。金额和数量使用十进制字符串，重传沿用原有 ID 和时间戳。</li>
        <li>从 <code>/control</code> 对账开仓权限。实际应用并本地持久化后，回报修订版本与风控锁。交易和本地风控由程序独立处理。</li>
        <li>一次性指令用 <code>/commands?wait=25</code> 长轮询，领取许可后才可执行。执行前保存命令 ID，按期回报实际结果。</li>
      </ol>
        <ErrorNotice error={spec.error} />
        {spec.data && <><Table columns={["方法", "路径", "说明"]}>
          {Object.entries(spec.data.paths).filter(([path]) => path.startsWith("/api/v2/agent/")).flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, info]) => <tr key={`${method} ${path}`}><td className="mono">{method.toUpperCase()}</td>
              <td className="mono">{path}</td><td>{info.description ?? info.summary}</td></tr>))}
        </Table><div className="toolbar"><CopyButton value={JSON.stringify(spec.data, null, 2)} label="复制完整 OpenAPI" />
          <a href="/openapi.json" download="quantbot-openapi.json" className="button quiet">下载 OpenAPI</a></div></>}
      </Panel>
      <Panel title="数据类型与 JSON Schema">
        <ErrorNotice error={types.error ?? definition.error} />
        {types.data ? <div className="stack">
          <Field label="数据类型"><select value={schema} onChange={(e) => setSchema(e.target.value)}>
            {types.data.map((type) => <option key={type.type} value={type.type}>{type.type} · {type.storage}</option>)}
            {["batch", "snapshot", "event", "metric-definitions", "controls", "control-state", "control-invocation"].map((type) => <option key={type}>{type}</option>)}
          </select></Field>
          {definition.data ? <Code label={schemaUrl}>{JSON.stringify(definition.data, null, 2)}</Code> : <Loading />}
        </div> : types.isPending ? <Loading /> : <Empty />}
      </Panel>
      <Panel title="自定义控制组件" hint="Web 和 Telegram 使用同一份声明与执行回执。">
        <div className="stack">
          <p className="subtle">支持 button、toggle、select、number、slider、text、form 和 readonly。声明引用当前会话已注册的 command。重复发送同一版本和内容是幂等操作。更新和移除时发送完整列表并递增 revision。</p>
          <Code label="PUT /api/v2/agent/controls">{JSON.stringify({
            schema_version: 1, revision: 1, groups: [{ id: "parameters", label: "参数" }],
            controls: [{ id: "rsi_period", type: "number", label: "RSI 周期", command: "set_rsi",
              group: "parameters", parameter: "period", integer: true, min: 5, max: 30, step: 1 }],
          }, null, 2)}</Code>
          <Code label="PUT /api/v2/agent/controls/state">{JSON.stringify({
            revision: 1, observed_at: "2026-01-01T12:00:00Z", values: { rsi_period: 14 },
          }, null, 2)}</Code>
          <Code label="curl · 注册组件">{`curl -fsS -X PUT "$QB_URL/api/v2/agent/controls" \\
  -H "Authorization: Bearer $QB_TOKEN" \\
  -H "X-Agent-Session: $QB_SESSION" \\
  -H 'Content-Type: application/json' --data-binary @controls.json`}</Code>
          <Code label="Python · 更新及移除">{`# 复用下方示例的标准库 request() 与 headers
request("/controls", "PUT", registry)
# 保留其余定义，移除 rsi_period
registry["revision"] += 1
registry["controls"] = [c for c in registry["controls"] if c["id"] != "rsi_period"]
request("/controls", "PUT", registry)`}</Code>
          <Code label="命令领取和结果回报">{`# 先 GET /commands?wait=25，再 POST /commands/{id}/claim
request(f"/commands/{command_id}/result", "POST", {
    "permit": permit, "status": "succeeded", "result": {"period": 14},
})
# 已实际生效的值再用 PUT /controls/state 上报。`}</Code>
          <p className="subtle">401 表示凭据无效，403 表示缺少作用域或实例授权，409 表示版本、状态或许可冲突，422 表示 Schema 或参数验证失败。</p>
          <a className="text-link" href="/api/v2/schemas/controls">查看完整 Control Schema <ChevronRight size={14} /></a>
        </div>
      </Panel>
      <Panel title="HTTP 示例" hint="使用环境变量传入策略 Token。">
        <div className="stack"><Code label="curl">{shell(origin)}</Code><Code label="Python 标准库">{python(origin)}</Code>
          <Code label="AI 接入提示词">{aiInstructions(origin, strategyId)}</Code></div>
      </Panel>
    </div>
  </>;
}
