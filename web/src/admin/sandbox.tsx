import { Button } from "@astryxdesign/core/Button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clipboard, FlaskConical } from "lucide-react";
import { useState } from "react";
import { api, client, resource, type Registry, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";
import { agentPrompt } from "./agent-prompt";
import { ConnectionField, useCopyText } from "./connection-field";

type SandboxStatus = {
  id: string;
  expiresAt: number;
  endpoint?: string;
  status: "active" | "inactive" | "expired" | "revoked";
  passed: boolean;
  requests: { step: string; status: number; at: number }[];
};
type SandboxCredential = { id: string; token: string; endpoint: string; expiresAt: number };
const path = "/admin/sandbox";

export function SandboxPanel({ strategy, productionEndpoint }: { strategy: Strategy; productionEndpoint: string }) {
  const { lang, t } = useLanguage();
  const copy = useCopyText();
  const [secret, setSecret] = useState<SandboxCredential>();
  const [closing, setClosing] = useState(false);
  const [controlId, setControlId] = useState("");
  const query = useQuery({ ...resource<SandboxStatus>(path), refetchInterval: 2000 });
  const current = query.data;
  const active = current?.status === "active";
  const token = active && secret?.id === current.id ? secret?.token : undefined;
  const commands = useQuery({
    queryKey: [path + "/controls", current?.id],
    queryFn: () => api<Registry>(path + "/controls"),
    enabled: active,
    refetchInterval: 3000,
  });
  const candidates = commands.data?.controls.filter(item => item.kind === "button" && item.actual?.available && !item.readOnly) ?? [];
  const selected = candidates.find(item => item.id === controlId) ?? candidates[0];
  const mutate = useMutation({
    mutationFn: async (action: "start" | "stop" | "reveal" | "copy" | "command") => {
      if (action === "start") {
        const status = await api<SandboxStatus>(path, "POST");
        client.setQueryData([path], status);
      } else if (action === "stop") {
        await api(path, "DELETE");
        setSecret(undefined);
        setClosing(false);
      } else if (action === "command") {
        const command = await api<{ id: string; status: string }>(path + "/commands", "POST",
          { controlId: selected?.id, revision: commands.data?.revision, input: null }, crypto.randomUUID());
        if (command.status === "confirmation_required") await api(path + "/commands/" + command.id + "/confirm", "POST");
      } else {
        const issued = await api<SandboxCredential>(path + "/reveal", "POST");
        if (action === "reveal") setSecret(issued);
        else await copy(agentPrompt(location.origin, issued.endpoint, strategy, {
          lang, key: issued.id, sandboxToken: issued.token, expiresAt: issued.expiresAt, productionEndpoint,
        }));
      }
    },
    onSettled: () => void client.invalidateQueries({ queryKey: [path] }),
  });

  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorView error={query.error} retry={() => void query.refetch()} />;
  return <div className="connection-panel">
    <div className="sandbox-state">
      <FlaskConical size={19} aria-hidden="true" />
      <div>
        <strong>{t("sandboxShared")}</strong>
        <p>{t(active ? "sandboxSharedHint" : "sandboxStartHint")}</p>
      </div>
      {active && <Badge tone="success">{t("sandboxRunning")}</Badge>}
    </div>
    {active && <>
      <div className="connection-fields">
        <ConnectionField field="test-endpoint" label="Endpoint" value={current.endpoint} copyLabel={t("copyEndpoint")} />
        <ConnectionField field="test-token" label="Token" value={token} copyLabel={t("copySandboxToken")}
          revealing={mutate.isPending} onReveal={() => token ? setSecret(undefined) : mutate.mutate("reveal")} />
      </div>
      <div className="connection-options">
        <span className="muted">{t("expires")} · {timestamp(current.expiresAt, true)}</span>
        <button type="button" className="text-button" disabled={mutate.isPending} onClick={() => {
          if (!closing) mutate.reset();
          setClosing(!closing);
        }}>{t(closing ? "cancel" : "sandboxStop")}</button>
      </div>
      {closing && <div className="sandbox-confirm">
        <p>{t("sandboxStopWarning")}</p>
        <button type="button" className="danger" disabled={mutate.isPending} onClick={() => mutate.mutate("stop")}>
          {t("sandboxStop")}
        </button>
      </div>}
      {selected && <form className="sandbox-command" onSubmit={event => { event.preventDefault(); mutate.mutate("command"); }}>
        <select aria-label={t("controls")} value={selected.id} onChange={event => setControlId(event.target.value)}>
          {candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button type="submit" disabled={mutate.isPending}>{t("sandboxSimulate")}</button>
      </form>}
      {current.passed && <p className="sandbox-passed" role="status">{t("sandboxPassed")}</p>}
      {!!current.requests.length && <details className="connection-details">
        <summary>{t("sandboxRequests")}</summary>
        <ul className="sandbox-requests">
          {current.requests.slice(-10).reverse().map((entry, index) => <li key={entry.at + ":" + index}>
            <code>{entry.step}</code><span>{entry.status}</span><time>{timestamp(entry.at)}</time>
          </li>)}
        </ul>
      </details>}
    </>}
    {mutate.error && <p className="error-text" role="alert">{mutate.error.message}</p>}
    <div className="connection-footer sandbox-footer">
      <Button variant="primary" label={t(active ? "copySandboxPrompt" : "sandboxStart")}
        icon={active ? <Clipboard size={16} /> : <FlaskConical size={16} />}
        isLoading={mutate.isPending && (mutate.variables === "copy" || mutate.variables === "start")}
        isDisabled={mutate.isPending || closing} onClick={() => mutate.mutate(active ? "copy" : "start")} />
    </div>
  </div>;
}
