import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, Clipboard, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { api, client, resource, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { ErrorView, Loading, Modal } from "../shared/ui";
import { agentPrompt, agentReferences } from "./agent-prompt";
import { SandboxPanel } from "./sandbox";
import { ConnectionField, useCopyText } from "./connection-field";
import "./connection.css";

type KeyMetadata = {
  id: string;
  label: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revealable: boolean;
};
type Issued = KeyMetadata & { token: string };
export type CreatedStrategy = { endpoint: string; strategy: Strategy; credential: Issued };

export function ConnectionDialog({ strategy, created, onClose }: {
  strategy: Strategy; created?: CreatedStrategy; onClose: () => void;
}) {
  const { t } = useLanguage();
  const copy = useCopyText();
  const [view, setView] = useState<"production" | "sandbox">("production");
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<KeyMetadata | undefined>(created?.credential);
  const [secret, setSecret] = useState(created ? { id: created.credential.id, value: created.credential.token } : undefined);
  const path = "/admin/strategies/" + strategy.id;
  const tokens = useQuery(resource<KeyMetadata[]>(path + "/tokens"));
  const endpoint = created?.endpoint ?? location.origin + "/api/agent";
  const active = tokens.data?.filter(item => !item.revokedAt && (!item.expiresAt || item.expiresAt * 1000 > Date.now()));
  const primary = active === undefined ? issued :
    active.find(item => item.id === issued?.id) ?? active.find(item => item.label === "Initial Agent") ?? active[0];
  const value = primary && primary.id === secret?.id ? secret?.value : undefined;
  const reveal = useMutation({
    mutationFn: async (id: string) => {
      const result = await api<{ token: string }>(path + "/tokens/" + id + "/reveal", "POST");
      setSecret({ id, value: result.token });
    },
  });
  const regenerate = useMutation({
    mutationFn: async () => {
      const { token, ...key } = primary
        ? await api<Issued>(path + "/tokens/" + primary.id + "/regenerate", "POST")
        : await api<Issued>(path + "/tokens", "POST", { label: "Initial Agent", scopes: ["heartbeat", "report", "control", "command"] });
      client.setQueryData<KeyMetadata[]>([path + "/tokens"], previous =>
        [key, ...(previous ?? []).filter(item => item.id !== primary?.id && item.id !== key.id)]);
      setIssued(key);
      setSecret({ id: key.id, value: token });
      reveal.reset();
      setConfirm(false);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: [path + "/tokens"] }),
  });
  const canGenerate = !tokens.isPending && !tokens.isError;
  return <Modal title={t(confirm ? "regenerateToken" : created ? "strategyCreated" : "strategyAPI")}
    className="connection-dialog" open onOpenChange={open => {
      if (open || regenerate.isPending) return;
      if (confirm) setConfirm(false); else onClose();
    }}>
    <div className="connection-caption">{strategy.name}</div>
    {confirm ? <>
      <p className="muted">{t("regenerateTokenWarning")}</p>
      {regenerate.error && <p className="error-text" role="alert">{regenerate.error.message}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={regenerate.isPending} onClick={() => setConfirm(false)}>{t("cancel")}</button>
        <button type="button" className="danger" disabled={regenerate.isPending || !primary}
          onClick={() => regenerate.mutate()}>{t("regenerateToken")}</button>
      </div>
    </> : <>
      <div className="connection-switch" role="group" aria-label={t("connectionType")}>
        <button type="button" aria-pressed={view === "production"}
          onClick={() => setView("production")}>{t("productionConnection")}</button>
        <button type="button" aria-pressed={view === "sandbox"}
          onClick={() => setView("sandbox")}>Sandbox</button>
      </div>
      {view === "production" ? <div className="connection-panel">
        <div className="connection-fields">
          <ConnectionField field="endpoint" label="Endpoint" value={endpoint} copyLabel={t("copyEndpoint")} />
          <ConnectionField field="key" label="Key" value={primary?.id} copyLabel={t("copyKey")} />
          <ConnectionField field="token" label="Token" value={value} copyLabel={t("copyAgentToken")}
            revealing={reveal.isPending || regenerate.isPending}
            onReveal={primary?.revealable ? () => value ? setSecret(undefined) : reveal.mutate(primary.id) : undefined} />
        </div>
        {tokens.error && <ErrorView error={tokens.error} retry={() => void tokens.refetch()} />}
        {reveal.error && <p className="error-text" role="alert">{reveal.error.message}</p>}
        {regenerate.error && <p className="error-text" role="alert">{regenerate.error.message}</p>}
        <div className="connection-options">
          {primary && !primary.revealable && <span className="muted">{t("legacyTokenHint")}</span>}
          <button type="button" className="text-button" disabled={!canGenerate || reveal.isPending || regenerate.isPending}
            onClick={() => {
              regenerate.reset();
              if (primary) setConfirm(true); else regenerate.mutate();
            }}><RotateCw size={14} />{t(primary ? "regenerateToken" : "createToken")}</button>
        </div>
        <ExecutorSettings strategy={strategy} path={path} />
        <div className="connection-footer">
          <a href={agentReferences.integration} target="_blank" rel="noreferrer">
            <BookOpen size={15} />{t("integrationExamples")}
          </a>
          <button type="button" className="primary" onClick={() => void copy(agentPrompt(location.origin, endpoint, strategy, { key: primary?.id }))}>
            <Clipboard size={16} />{t("copyAgentPrompt")}
          </button>
        </div>
      </div> : <SandboxPanel />}
    </>}
  </Modal>;
}

function ExecutorSettings({ strategy, path }: { strategy: Strategy; path: string }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const query = useQuery({ ...resource<Strategy>(path), enabled: open, refetchInterval: open ? 5000 : false });
  const current = (query.data ?? strategy).executorInstance ?? "";
  const save = useMutation({
    mutationFn: () => api<void>(path + "/executor", "PUT", { instanceId: (selected ?? current) || null }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [path] }),
        client.invalidateQueries({ queryKey: ["/strategies/" + strategy.id] }),
      ]);
      setSelected(undefined);
      toast.success(t("save"));
    },
  });
  return <details className="connection-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("executor")}</summary>
    {open && <div className="connection-detail-body">
      {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} /> : <>
        <p className="muted">{t("current")} · {current || t("noExecutor")}</p>
        <form onSubmit={event => { event.preventDefault(); save.mutate(); }}>
          <select aria-label={t("executor")} value={selected ?? current} onChange={event => setSelected(event.target.value)}>
            <option value="">{t("noExecutor")}</option>
            {query.data.instances?.map(instance => <option key={instance.instanceId} value={instance.instanceId}>
              {instance.instanceId} · {t(instance.online ? "online" : "offline")}
            </option>)}
          </select>
          <button disabled={save.isPending || selected === undefined || selected === current}>{t("save")}</button>
        </form>
        {save.error && <p className="error-text" role="alert">{save.error.message}</p>}
      </>}
    </div>}
  </details>;
}
