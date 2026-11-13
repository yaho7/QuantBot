import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, strategyApi, type CommandState, type Control } from "./api";
import { CommandBadge, CopyButton, Dialog, ErrorNotice, Panel, Table, useData, when } from "./ui";

interface SandboxStatus {
  key: string;
  status: "active" | "expired" | "closed";
  expires_at: string;
  passed: boolean;
  steps: string[];
  requests: { at: string; method: string; path: string; status: number; request_id: string; errors: string[] }[];
  registry_revision: number;
  controls: { id: string; label: string; type: string }[];
  control: Control;
  commands: { id: string; action: string; state: CommandState }[];
}
export interface SandboxCredentials extends SandboxStatus {
  endpoint: string;
  secret: string;
  strategy_id: string;
}
type Action = "renew" | "close" | "pause_entry" | "resume_entry" | "refresh";

const steps = {
  session: "建立会话", heartbeat: "发送心跳", telemetry: "上报遥测", controls: "注册控件",
  control_sync: "同步开仓状态", command: "领取模拟指令并回执",
};
const actions: [Action, string][] = [
  ["pause_entry", "模拟暂停开仓"], ["resume_entry", "模拟恢复开仓"], ["refresh", "模拟刷新"],
];

export function SandboxPanel({ strategyId, endpoint, prompt, preview, disabled }: {
  strategyId: string; endpoint: string; prompt: (credentials: SandboxCredentials) => string; preview: string; disabled?: boolean;
}) {
  const client = useQueryClient();
  const path = strategyApi(strategyId, "sandbox");
  const status = useData<SandboxStatus | null>(path, true, 5_000);
  const data = status.data;
  const [manual, setManual] = useState("");
  const [now, setNow] = useState(Date.now);
  const remaining = data ? Math.ceil((Date.parse(data.expires_at) - now) / 60_000) : 0;
  const active = data?.status === "active" && remaining > 0;
  const copy = useMutation({
    mutationFn: async () => {
      const { secret, endpoint, strategy_id, ...diagnostics } = await api<SandboxCredentials>(path, "POST");
      client.setQueryData(["live", path], diagnostics);
      const text = prompt({ ...diagnostics, secret, endpoint, strategy_id });
      try {
        await navigator.clipboard.writeText(text);
        toast.success("已复制 AI 接入提示词");
      } catch {
        setManual(text);
      }
    },
  });
  const change = useMutation({
    mutationFn: (action: Action) => api<SandboxStatus>(`${path}/${data!.key}/${action}`, "POST"),
    onSuccess: (result) => {
      client.setQueryData(["live", path], result);
      if (result.status !== "active") setManual("");
    },
  });
  const [passedNotice, setPassedNotice] = useState("");
  useEffect(() => {
    if (!data || !active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [data, active]);
  useEffect(() => {
    if (data?.passed && data.key !== passedNotice) {
      toast.success("Sandbox 接入测试通过，可以切换正式配置");
      setPassedNotice(data.key);
    }
  }, [data, passedNotice]);

  const production = `在原量化程序的 quantbot.json 中，将 endpoint 改为 ${endpoint}，将 secret 改为策略 ${strategyId} 的正式 Secret。通过 QuantBot 的「Token 与诊断」查看正式 Secret。保留 instance_name，重启程序后在工作台检查真实策略状态。正式配置文件继续保留在 .gitignore 中。`;
  return <Panel title="AI 一键接入测试"
    action={<button className="button primary" type="button" disabled={disabled || copy.isPending}
      onClick={() => { setNow(Date.now()); copy.mutate(); }}>
      <Copy size={16} /> {copy.isPending ? "正在生成测试提示词…" : "复制 AI 接入提示词"}
    </button>}>
    <p>把复制的提示词交给 Codex 或 Cursor。提示词包含临时测试配置，默认 60 分钟有效。</p>
    <ErrorNotice error={copy.error ?? change.error ?? status.error} />
    {data && <div className="stack">
      <div className={active && remaining > 5 ? "notice" : "notice warn"} role="status">
        {data.status === "closed" ? "Sandbox 已关闭" : !active ? "Sandbox 已到期。重新复制提示词可创建新会话。" :
          remaining <= 5 ? `Sandbox 将在 ${remaining} 分钟内到期，可以续期。` : `Sandbox 有效至 ${when(data.expires_at)}`}
      </div>
      {data.passed && <div className="notice" role="status">接入测试通过。可复制下方说明，替换正式 Endpoint 和 Secret。</div>}
      <div className="toolbar">
        {active && <>
          <button className="button secondary" type="button" disabled={change.isPending} onClick={() => change.mutate("renew")}>续期 60 分钟</button>
          <button className="button secondary" type="button" disabled={change.isPending} onClick={() => change.mutate("close")}>关闭 Sandbox</button>
        </>}
        <CopyButton value={production} label="复制正式配置说明" />
      </div>
      <div className="chips">{Object.entries(steps).map(([key, label]) =>
        <span className="chip" key={key}>{label} · {data.steps.includes(key) ? "已验证" : "待验证"}</span>)}</div>
      <details className="form-detail"><summary>控件注册与模拟控制</summary>
        <div className="stack">
          <p>注册版本 {data.registry_revision} · {data.controls.length} 个控件 · {data.control?.in_sync ? "控制状态已同步" : "等待控制回报"}</p>
          <div className="chips">{data.controls.map((item) => <span className="chip" key={item.id}>{item.label} · {item.type}</span>)}</div>
          {active && <div className="toolbar">{actions.map(([action, label]) =>
            <button type="button" className="button secondary" key={action} disabled={change.isPending || !data.steps.includes("session")}
              onClick={() => change.mutate(action)}>{label}</button>)}</div>}
          <Table columns={["模拟指令", "状态"]} empty={!data.commands.length}>{data.commands.map((command) =>
            <tr key={command.id}><td>{command.action}</td><td><CommandBadge state={command.state} /></td></tr>)}</Table>
        </div>
      </details>
      <details className="form-detail"><summary>最近请求与 Schema 校验</summary>
        <Table columns={["时间", "请求", "状态", "校验", "请求 ID"]} empty={!data.requests.length}>
          {data.requests.map((item) => <tr key={item.request_id}><td>{when(item.at)}</td>
            <td>{item.method} {item.path}</td><td>{item.status}</td>
            <td>{item.errors.length ? item.errors.join(" · ") : item.status < 300 ? "通过" : "请求被拒绝"}</td>
            <td className="mono">{item.request_id}</td></tr>)}
        </Table>
      </details>
    </div>}
    {!data && <CopyButton value={production} label="复制正式配置说明" />}
    <details className="form-detail" open={!data || undefined}><summary>预览提示词</summary>
      <pre className="agent-prompt">{preview}</pre></details>
    {manual && active && <Dialog title="手动复制 AI 接入提示词" close={() => setManual("")}>
      <textarea aria-label="完整 AI 接入提示词" readOnly autoFocus value={manual} rows={12}
        onFocus={(event) => event.target.select()} />
    </Dialog>}
  </Panel>;
}
