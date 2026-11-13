import { t, type Message } from "../i18n";
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
  session: "sandbox.openASession", heartbeat: "sandbox.sendHeartbeat", telemetry: "sandbox.reportTelemetry", controls: "sandbox.registerControls",
  control_sync: "sandbox.syncEntryState", command: "sandbox.claimAndAcknowledgeASimulatedCommand",
} as const;
const actions: [Action, Message][] = [
  ["pause_entry", "sandbox.simulatePause"], ["resume_entry", "sandbox.simulateResume"], ["refresh", "sandbox.simulateRefresh"],
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
        toast.success(t("sandbox.aiIntegrationPromptCopied"));
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
      toast.success(t("sandbox.sandboxPassedYouCanSwitchToProduction"));
      setPassedNotice(data.key);
    }
  }, [data, passedNotice]);

  const production = t("sandbox.inQuantbotJsonOnTheStrategyHost", { endpoint: endpoint, strategyId: strategyId });
  return <Panel title={t("onboarding.oneClickAiIntegrationTest")}
    action={<button className="button primary" type="button" disabled={disabled || copy.isPending}
      onClick={() => { setNow(Date.now()); copy.mutate(); }}>
      <Copy size={16} /> {copy.isPending ? t("sandbox.generatingTestPrompt") : t("sandbox.copyAiIntegrationPrompt")}
    </button>}>
    <p>{t("sandbox.giveTheCopiedPromptToCodexOr")}</p>
    <ErrorNotice error={copy.error ?? change.error ?? status.error} />
    {data && <div className="stack">
      <div className={active && remaining > 5 ? "notice" : "notice warn"} role="status">
        {data.status === "closed" ? t("sandbox.sandboxClosed") : !active ? t("sandbox.sandboxExpiredCopyThePromptAgainTo") :
          remaining <= 5 ? t("sandbox.sandboxExpiresInMinYouCanExtend", { minutes: remaining }) : t("sandbox.sandboxExpiresAt", { date: when(data.expires_at) })}
      </div>
      {data.passed && <div className="notice" role="status">{t("sandbox.integrationTestPassedCopyTheInstructionsBelow")}</div>}
      <div className="toolbar">
        {active && <>
          <button className="button secondary" type="button" disabled={change.isPending} onClick={() => change.mutate("renew")}>{t("sandbox.extendBy60Minutes")}</button>
          <button className="button secondary" type="button" disabled={change.isPending} onClick={() => change.mutate("close")}>{t("sandbox.closeSandbox")}</button>
        </>}
        <CopyButton value={production} label={t("sandbox.copyProductionSetupInstructions")} />
      </div>
      <div className="chips">{Object.entries(steps).map(([key, label]) =>
        <span className="chip" key={key}>{t(label)} · {data.steps.includes(key) ? t("sandbox.verified") : t("sandbox.pendingVerification")}</span>)}</div>
      <details className="form-detail"><summary>{t("sandbox.controlRegistrationAndSimulatedOperations")}</summary>
        <div className="stack">
          <p>{t("sandbox.registryRevision")}{" "}{data.registry_revision} · {data.controls.length} {t("sandbox.controls")}{" "}{data.control?.in_sync ? t("sandbox.controlStateSynchronized") : t("sandbox.waitingForControlReport")}</p>
          <div className="chips">{data.controls.map((item) => <span className="chip" key={item.id}>{item.label} · {item.type}</span>)}</div>
          {active && <div className="toolbar">{actions.map(([action, label]) =>
            <button type="button" className="button secondary" key={action} disabled={change.isPending || !data.steps.includes("session")}
              onClick={() => change.mutate(action)}>{t(label)}</button>)}</div>}
          <Table columns={[t("sandbox.simulatedCommand"), t("onboarding.status")]} empty={!data.commands.length}>{data.commands.map((command) =>
            <tr key={command.id}><td>{command.action}</td><td><CommandBadge state={command.state} /></td></tr>)}</Table>
        </div>
      </details>
      <details className="form-detail"><summary>{t("sandbox.recentRequestsAndSchemaValidation")}</summary>
        <Table columns={[t("marketChart.time"), t("sandbox.request"), t("onboarding.status"), t("sandbox.validation"), t("sandbox.requestId")]} empty={!data.requests.length}>
          {data.requests.map((item) => <tr key={item.request_id}><td>{when(item.at)}</td>
            <td>{item.method} {item.path}</td><td>{item.status}</td>
            <td>{item.errors.length ? item.errors.join(" · ") : item.status < 300 ? t("sandbox.passed") : t("sandbox.requestRejected")}</td>
            <td className="mono">{item.request_id}</td></tr>)}
        </Table>
      </details>
    </div>}
    {!data && <CopyButton value={production} label={t("sandbox.copyProductionSetupInstructions")} />}
    <details className="form-detail" open={!data || undefined}><summary>{t("sandbox.previewPrompt")}</summary>
      <pre className="agent-prompt">{preview}</pre></details>
    {manual && active && <Dialog title={t("sandbox.copyAiIntegrationPromptManually")} close={() => setManual("")}>
      <textarea aria-label={t("sandbox.fullAiIntegrationPrompt")} readOnly autoFocus value={manual} rows={12}
        onFocus={(event) => event.target.select()} />
    </Dialog>}
  </Panel>;
}
