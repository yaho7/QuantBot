import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronRight, Eye, EyeOff, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, strategyApi, strategyPath, type Catalog, type Credential, type Detail, type Scope, type System, type StrategySettings, type Token, type TokenOptions } from "./api";
import type { ControlRegistryView } from "./dynamic-controls";
import { CopyButton, Dialog, ErrorNotice, Field, Loading, PageTitle, Panel, Table, categoryText, severityText, useData, when } from "./ui";

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

const fullScopes = Object.keys(scopeLabels) as Scope[];
const scopeSummary = (scopes: Scope[]) => scopes.length === fullScopes.length
  ? "完整接入" : scopes.map((scope) => scopeLabels[scope]).join(" · ");

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
    <details className="form-detail" open={expanded || undefined}><summary>高级权限设置</summary><div className="chips">{fullScopes.map((scope) =>
      <label className="chip" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "session"}
        onChange={(e) => set(scope, e.target.checked)} />{scopeLabels[scope]}</label>)}</div></details>
    {setExpiry && <Field label="Token 到期时间（可选）"><input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>}
    {scopes.length === fullScopes.length && <small className="subtle">完整接入 · 交易操作仍需策略授权</small>}
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

function useAgentEndpoint() {
  const system = useData<System>("system", true, 0);
  return `${system.data?.public_url ?? window.location.origin}/api/agent`;
}

const repository = "https://github.com/yaho7/QuantBot";
const docs = `${repository}/blob/main`;

function aiInstructions(endpoint: string, strategyId?: string) {
  return `请帮我将当前量化交易程序**完整接入 QuantBot 监控与远程控制平台**，直接修改项目代码完成接入。

**QuantBot GitHub 仓库：** [${repository}](${repository})

**Endpoint：** [${endpoint}](${endpoint})

**策略 ID：** \`${strategyId ?? "请填写策略 ID"}\`

**稳定实例名称建议：** \`${strategyId ? `strategy-${strategyId.slice(0, 8)}` : "my-strategy"}\`

**协议：** Agent HTTP API，报告和控件 \`schema_version: 1\`。规范和示例由 GitHub 仓库维护。

### 一、接入目标

先主动读取 GitHub 上的 [README](${docs}/README.md)、[PROTOCOL.md](${docs}/PROTOCOL.md)、[跨语言接入指南](${docs}/docs/INTEGRATION.md)、[OpenAPI](${docs}/docs/openapi.json)、[JSON Schema](${repository}/tree/main/docs/schemas)、[接入示例](${repository}/tree/main/examples) 和 [连接排查](${docs}/docs/TROUBLESHOOTING.md)。阅读当前项目后，直接修改代码，按实际能力完成监控和安全的高级控制。先识别当前语言、现有 HTTP 客户端、主程序生命周期、数据缓存、开仓判断和原有风控入口，再选择实现方式。Python 可用 urllib.request，JavaScript/TypeScript 用 fetch，Go 用 net/http，C# 和 Java 用标准 HttpClient。C++ 或特殊运行环境优先复用现有 HTTP 库。避免重复开发。

### 二、主程序集成

- 接入代码运行在量化主程序内，可单独组织成模块。随主程序启动自动连接，无需额外进程或容器。
- 复用当前程序的运行状态、参数、持仓、订单和交易执行入口。
- 保留原有策略算法、券商连接、交易规则及风控。网络通信不得阻塞行情、下单或风控流程。

### 三、配置与密钥

- 创建 \`quantbot.json\` 保存 Endpoint、Secret、稳定实例名称和必要配置。仅在文件不存在时创建，Secret 预留为空。启动时自动读取，无需设置环境变量。用 Secret 作为 Bearer Token，Key 仅用于识别凭据。
- 创建 \`quantbot.example.json\`，并将真实配置文件加入 \`.gitignore\`。不要提交或记录明文 Token。
- 配置使用 \`endpoint\`、\`secret\` 和 \`instance_name\` 字段。Endpoint 已包含 \`/api/agent\`，仅追加 \`/session\` 等相对路径。缺少配置或 Secret 时保留原有程序行为。失联时遵循最后实际应用并持久化的开仓权限和断线策略。

### 四、完整数据监控

- **运行监控**：在线状态、健康状态、运行时长、券商连接和异常。
- **账户及交易**：余额、可用资金、账户净值、购买力、持仓、订单、成交、信号及手续费。
- **策略绩效**：累计收益、当日收益、净值曲线、最大回撤和已有绩效指标。
- **行情、日志和自定义指标**：已有 K 线和行情、重要日志、错误、风控事件、交易提醒及有意义的内部指标。

按会话返回的间隔发送心跳，运行状态变化时更新。其他数据按事件或合理的间隔上报。复用内存、缓存和已有数据，避免额外频繁请求券商 API。使用官方 Schema，没有的数据不要编造，成交重传沿用相同事件 ID。

### 五、高级控制功能

**高级控制是接入重点。** 使用官方会话、能力声明、动态控件和命令机制，为当前程序完成可安全实施的功能。

1. **运行控制**：优先支持暂停和恢复新开仓、主动刷新，以及运行阶段、异常和风控锁的展示。按现有能力考虑启用或停用程序已有功能。
2. **动态参数**：展示当前参数和实际生效值。对允许动态调整的参数，按需使用开关、滑块、数值输入或下拉菜单，并回报实际应用结果。
3. **订单和持仓**：展示订单及持仓，明确区分策略归属持仓与券商账户持仓。根据程序已有能力评估撤单、指定平仓、全部平仓及手动买卖。
4. **自定义操作**：从程序现有功能中选择适合远程操作的方法，提供清晰的名称、参数范围、实际状态和错误反馈。只展示已经实现和验证的操作。
5. **执行与安全**：正确同步期望状态和实际状态。一次性命令按协议领取执行许可，再执行和回报真实结果。处理超时、重连、重复命令及结果未知。交易操作必须通过原有风控及交易执行入口。

### 六、高级功能实施原则

- **只读和低风险功能**：状态查询、参数展示、刷新信息和只读控件可直接完成。
- **暂停和恢复新开仓**：优先实现，仅改变新开仓权限。确保止损、减仓和必要风控继续运行，恢复开仓不能解除本地风控锁。
- **影响交易行为的功能**：修改交易参数、撤单、平仓、手动买卖等，先给出具体方案，经我同意后再修改相关代码。可先完成其余接入工作。
- **程序尚不支持的功能**：说明限制及可行扩展，不凭空增加交易能力。

使用 QuantBot 官方动态控件与命令机制，让控制面板随程序实际能力变化。

### 七、可靠性

- 统一发送 \`User-Agent: QuantBot-Integration/1.0\`、\`Accept: application/json\`、\`Content-Type: application/json\` 和 Bearer Secret。保持 TLS 校验，禁止自动跟随重定向。
- 用独立线程或异步任务执行 HTTP，设置连接和请求超时。按有上限的指数退避和随机抖动自动重连。429 遵守 Retry-After，401 提示更换 Secret，403 区分 QuantBot 权限与 Cloudflare 1010 等上游拦截。脱敏诊断仅包含请求路径、状态、错误类型和追踪 ID。
- 用有界队列批量上报，快照可合并，重要事件和待发回执应持久化。重传沿用事件 ID 和时间戳。最后应用的开仓权限保存到本地，重连和重启后先对账。命令执行前持久化命令 ID，按一次性许可执行并保存真实回执，结果未知时核对原交易记录。
- 文件尽量精简，优先保留一个通信模块和本地配置。不引入无关依赖或重构。

### 八、测试与交付

直接完成监控和可安全实施的控制功能。使用模拟数据验证上报、动态控件、参数读取、暂停和恢复开仓、命令回执及异常重连，禁止触发真实交易。

完成后列出修改的文件，并用新手能理解的方式说明：

1. Token 填在哪个文件、哪个字段。
2. 怎样按原来的方式启动程序。
3. 如何在 QuantBot 网页确认接入，查看监控和控制面板。
4. 已实现哪些高级功能，如何使用。
5. 哪些功能需要我批准，以及实现难度和风险。

**除填写 Token 和审批高风险操作外，尽量不要让我手动修改代码。**

整体原则：**充分发挥 QuantBot 的高级能力，监控全面、控制灵活、操作安全、实现简洁，且不干扰原有量化交易程序。**`;
}

function AgentPrompt({ endpoint, strategyId }: { endpoint: string; strategyId?: string }) {
  const prompt = aiInstructions(endpoint, strategyId);
  return <Panel title="AI 接入提示词" action={<CopyButton value={prompt} label="复制 AI 提示词" />}>
    <pre className="agent-prompt">{prompt}</pre>
  </Panel>;
}

function CredentialDialog({ credential, close }: { credential: Credential; close: () => void }) {
  const endpoint = useAgentEndpoint();
  return <Dialog title="接入凭据已生成" close={close}><div className="stack">
    <KeyValue label="Endpoint" value={endpoint} />
    <KeyValue label="策略 ID" value={credential.strategy_id} />
    <KeyValue label="Key" value={credential.id} />
    <small className="subtle">{scopeSummary(credential.scopes)}</small>
    <SecretValue load={async () => credential.token} />
    <AgentPrompt endpoint={endpoint} strategyId={credential.strategy_id} />
    <div className="dialog-actions"><button className="button primary" onClick={close}>完成</button></div>
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
      <button type="button" className="icon-button" aria-label={secret ? "隐藏 Secret" : "查看 Secret"}
        disabled={pending} onClick={() => void toggle()}>{secret ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      {secret && <CopyButton value={secret} label="复制 Secret" />}
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
    <Panel title="接入凭据" hint="重新生成会立即作废当前 Token，并沿用它的权限和到期时间。"
      action={!strategy.archived_at && <div className="toolbar">
        {current && <button className="button primary" onClick={() => { regenerate.reset(); setReplacing(current); }}><RefreshCw size={16} /> 重新生成 Token</button>}
        <button className={`button ${current ? "secondary" : "primary"}`} onClick={() => setEditing("new")}><Plus size={16} /> 新建 Token</button>
      </div>}>
      <KeyValue label="策略 ID" value={id} /><KeyValue label="Endpoint" value={endpoint} />
      {current && <><KeyValue label="Key" value={current.id} />
        <SecretValue key={current.id} load={async () => (await api<Credential>(strategyApi(id, `tokens/${current.id}/reveal`), "POST")).token} /></>}
      <ErrorNotice error={tokens.error ?? revoke.error} />
      {tokens.isPending ? <Loading /> : <Table columns={["Key", "权限", "最近使用", "有效期", "状态", "操作"]} empty={!tokens.data?.length}>
        {tokens.data?.map((token) => {
          const expired = token.expires_at && Date.parse(token.expires_at) <= Date.now();
          return <tr key={token.id}><td className="mono">{token.id}</td><td>{scopeSummary(token.scopes)}</td>
            <td>{when(token.last_used_at)}</td><td>{token.expires_at ? when(token.expires_at) : "长期"}</td>
            <td>{token.revoked_at ? "已撤销" : expired ? "已过期" : "有效"}</td>
            <td className="row-actions">{!strategy.archived_at && <>
              {!token.revoked_at && !expired && <button className="button quiet" onClick={() => setPermissions(token)}>编辑权限</button>}
              <button className="button quiet" onClick={() => setEditing(token)}>轮换</button>
              {!token.revoked_at && <button className="button quiet danger-text" onClick={() => {
                if (confirm("撤销该 Token 后，使用它的实例将失去连接。继续撤销？")) revoke.mutate(token);
              }}>撤销</button>}
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
    {replacing && <Dialog title="重新生成 Token" close={() => { if (!regenerate.isPending) setReplacing(null); }}>
      <div className="stack">
        <p>旧 Token <code>{replacing.id}</code> 会立即失效。请将新 Token 填入量化程序的配置文件，让程序恢复连接。</p>
        <ErrorNotice error={regenerate.error} />
        <div className="dialog-actions">
          <button className="button secondary" disabled={regenerate.isPending} onClick={() => setReplacing(null)}>取消</button>
          <button className="button danger" disabled={regenerate.isPending} onClick={() => regenerate.mutate(replacing)}>
            {regenerate.isPending ? "正在生成…" : "确认重新生成"}
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
  return <Panel title="连接诊断" action={<CopyButton value={JSON.stringify(diagnostics, null, 2)} label="复制诊断" />}>
    <ErrorNotice error={catalog.error ?? controls.error ?? delivery.error} />
    <p className="subtle">{instance ? "下方信息来自 QuantBot 收到的请求。" : "等待程序连接。启动后，这里会自动更新。"} 代理拦截请查看策略端的脱敏诊断。</p>
    <dl className="form-grid detail-list">
      <div><dt>当前 Key</dt><dd>{loadingToken ? "加载中" : !token ? "无有效凭据" : token.last_used_at ? `已使用 · ${when(token.last_used_at)}` : "未使用"}</dd></div>
      <div><dt>最近实例</dt><dd>{instance ? `${instance.instance_id} · ${instance.online ? "在线" : "离线"}` : "尚未连接"}</dd></div>
      <div><dt>收到的标准报告</dt><dd>{types.length ? types.join(" · ") : catalog.data ? "尚无报告" : "—"}</dd></div>
      <div><dt>控制执行资格</dt><dd>{diagnostics.executor_authorized ? `已授权 · ${executor?.instance_id}` : "未授权"}</dd></div>
      <div><dt>动态控件</dt><dd>{controls.data ? `${controls.data.controls.length} 个` : "—"}</dd></div>
      <div><dt>命令接收</dt><dd>{lastDelivery ? `已验证 · ${when(lastDelivery)}` : "未验证"}</dd></div>
    </dl>
    <Table columns={["实例", "连接", "最后心跳", "程序", "Key"]} empty={!strategy.instances.length}>
      {strategy.instances.map((item) => <tr key={item.instance_id}><td className="mono">{item.instance_id}</td><td>{item.online ? "在线" : "离线"}</td>
        <td>{when(item.last_seen)}</td><td>{[item.declarations.language, item.declarations.framework, item.declarations.version, item.declarations.broker].filter(Boolean).join(" · ") || "—"}</td>
        <td className="mono">{item.token_id}</td></tr>)}
    </Table>
    {failures.map((item) => <div key={item.type} className="notice warn">
      {item.type} · 协议不兼容 · {item.count} 次 · {when(item.observed_at)}
    </div>)}
    <a className="button secondary" href={`#api/${encodeURIComponent(id)}`}><BookOpen size={16} /> AI 接入指引</a>
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
  return <Dialog title={previous ? "轮换 Token" : "新建 Token"} close={close}>
    <form className="stack" onSubmit={submit}>
      {previous && <div className="notice">旧 Token 最多保留一小时，原有到期时间更早时仍按原时间到期。程序使用新 Token 接入后，可手动撤销旧 Token。</div>}
      <TokenFields {...{ scopes, setScopes, expiry, setExpiry }} />
      <ErrorNotice error={mutation.error} />
      <div className="dialog-actions"><button className="button primary" disabled={mutation.isPending}>{previous ? "确认轮换" : "生成 Token"}</button></div>
    </form>
  </Dialog>;
}

function EditPermissions({ token, close, saved }: { token: Token; close: () => void; saved: (token: Token) => void }) {
  const [scopes, setScopes] = useState(token.scopes);
  const mutation = useMutation({
    mutationFn: () => api<Token>(strategyApi(token.strategy_id, `tokens/${token.id}/permissions`), "PUT", { scopes }),
    onSuccess: saved,
  });
  return <Dialog title="编辑 Token 权限" close={close}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <p className="subtle">保存后立即生效。Secret 保持不变。</p>
      <TokenFields scopes={scopes} setScopes={setScopes} expanded />
      <ErrorNotice error={mutation.error} />
      <div className="dialog-actions"><button className="button primary" disabled={mutation.isPending}>保存权限</button></div>
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
    <PageTitle title="API 接入" sub="使用标准 HTTP 注册、上报和接收控制指令。" action={<a href={`${docs}/PROTOCOL.md`} target="_blank" rel="noreferrer" className="button secondary"><BookOpen size={16} /> GitHub 文档</a>} />
    <div className="stack">
      <AgentPrompt endpoint={endpoint} strategyId={strategyId} />
      <Panel title="连接信息">
        <Field label="自定义 Endpoint" hint="填写策略所在机器可以访问的完整 Endpoint。">
          <input type="url" placeholder={defaultEndpoint} value={customEndpoint} onChange={(event) => setCustomEndpoint(event.target.value)} />
        </Field>
        {entered && !valid && <p role="alert" className="notice error">请输入 https://域名/api/agent。HTTP 仅可用于回环地址。</p>}
        <KeyValue label="Endpoint" value={endpoint} />
        {strategyId && <KeyValue label="策略 ID" value={strategyId} />}
        {strategyId ? <a className="text-link" href={strategyPath(strategyId, "api")}>管理 Token 和连接诊断 <ChevronRight size={14} /></a>
          : <a className="text-link" href="#strategies">选择策略并管理 Token <ChevronRight size={14} /></a>}
      </Panel>
      <Panel title="GitHub 接入文档">
        <div className="toolbar">
          <a className="text-link" href={`${docs}/docs/INTEGRATION.md`} target="_blank" rel="noreferrer">接入指南 <ChevronRight size={14} /></a>
          <a className="text-link" href={`${docs}/docs/openapi.json`} target="_blank" rel="noreferrer">OpenAPI <ChevronRight size={14} /></a>
          <a className="text-link" href={`${repository}/tree/main/docs/schemas`} target="_blank" rel="noreferrer">JSON Schema <ChevronRight size={14} /></a>
          <a className="text-link" href={`${repository}/tree/main/examples`} target="_blank" rel="noreferrer">HTTP 示例 <ChevronRight size={14} /></a>
        </div>
      </Panel>
    </div>
  </>;
}
