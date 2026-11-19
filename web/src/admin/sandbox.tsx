import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RiClipboardLine as Clipboard, RiFlaskLine as FlaskConical, RiLoader4Line as LoaderCircle } from "@remixicon/react";
import { useState } from "react";
import { api, client, resource, type Strategy } from "../shared/api";
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
  const query = useQuery({ ...resource<SandboxStatus>(path), refetchInterval: 2000 });
  const current = query.data;
  const active = current?.status === "active";
  const token = active && secret?.id === current.id ? secret?.token : undefined;
  const mutate = useMutation({
    mutationFn: async (action: "start" | "stop" | "reveal" | "copy") => {
      if (action === "start") {
        const status = await api<SandboxStatus>(path, "POST");
        client.setQueryData([path], status);
      } else if (action === "stop") {
        await api(path, "DELETE");
        setSecret(undefined);
        setClosing(false);
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
  const primaryPending = mutate.isPending && (mutate.variables === "copy" || mutate.variables === "start");
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
        <span className="text-muted-foreground">{t("expires")} · {timestamp(current.expiresAt, true)}</span>
        <Button variant="ghost" size="sm" disabled={mutate.isPending} onClick={() => {
          if (!closing) mutate.reset();
          setClosing(!closing);
        }}>{t(closing ? "cancel" : "sandboxStop")}</Button>
      </div>
      {closing && <div className="sandbox-confirm">
        <p>{t("sandboxStopWarning")}</p>
        <Button variant="destructive" disabled={mutate.isPending} aria-busy={mutate.isPending} onClick={() => mutate.mutate("stop")}>
          {t("sandboxStop")}
        </Button>
      </div>}
      <p className="text-muted-foreground" role="status">{t("sandboxAutomatic")}</p>
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
      <Button aria-busy={primaryPending} disabled={closing || mutate.isPending}
        onClick={() => mutate.mutate(active ? "copy" : "start")}>
        {primaryPending ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
          : active ? <Clipboard size={16} aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}
        {t(active ? "copySandboxPrompt" : "sandboxStart")}
      </Button>
    </div>
  </div>;
}
