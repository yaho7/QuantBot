import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, client, resource, type Registry } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";
import { agentPrompt } from "./agent-prompt";

type SandboxStatus = {
  id: string;
  strategyId: string;
  expiresAt: number;
  status: "active" | "inactive" | "expired" | "revoked";
  passed: boolean;
  requests: { step: string; status: number; at: number }[];
};

type SandboxCredential = SandboxStatus & { token: string; endpoint: string };

export function SandboxPanel({ strategyId }: { strategyId: string }) {
  const { t } = useLanguage();
  const path = "/admin/strategies/" + strategyId + "/sandbox";
  const [credential, setCredential] = useState<SandboxCredential>();
  const [controlId, setControlId] = useState("");
  const query = useQuery({
    ...resource<SandboxStatus>(path),
    refetchInterval: 2000,
  });
  const current = query.data;
  const active = current?.status === "active";
  const controls = useQuery({
    ...resource<Registry>(path + "/controls"),
    enabled: active,
    refetchInterval: 3000,
  });
  const candidates =
    controls.data?.controls.filter(
      (control) =>
        control.kind === "button" &&
        control.actual?.available &&
        !control.readOnly,
    ) ?? [];
  const selected =
    candidates.find((control) => control.id === controlId) ?? candidates[0];
  const mutation = useMutation({
    mutationFn: async (action: "create" | "extend" | "revoke" | "command") => {
      if (action === "command") {
        const command = await api<{ id: string; status: string }>(
          path + "/commands",
          "POST",
          {
            controlId: selected?.id,
            revision: controls.data?.revision,
            input: null,
          },
          crypto.randomUUID(),
        );
        if (command.status === "confirmation_required")
          await api(path + "/commands/" + command.id + "/confirm", "POST");
        return;
      }
      if (action === "create") {
        const issued = await api<SandboxCredential>(path, "POST");
        setCredential(issued);
        client.setQueryData([path], {
          ...issued,
          endpoint: undefined,
          token: undefined,
        });
        try {
          await navigator.clipboard.writeText(sandboxPrompt(issued));
          toast.success(t("copied"));
        } catch {
          toast.error(t("copyFailed"));
        }
      } else if (action === "extend") {
        const renewed = await api<SandboxStatus>(path, "PUT");
        setCredential(
          (previous) =>
            previous && { ...previous, expiresAt: renewed.expiresAt },
        );
      } else {
        await api(path, "DELETE");
        setCredential(undefined);
      }
    },
    onSettled: () => void client.invalidateQueries({ queryKey: [path] }),
  });

  return (
    <section className="section surface padded">
      <h2>Sandbox</h2>
      <p className="muted">{t("sandboxHint")}</p>
      {query.isPending && <Loading />}
      {query.error && <ErrorView error={query.error} />}
      <div className="actions">
        <button
          onClick={() => mutation.mutate("create")}
          disabled={mutation.isPending}
        >
          <Copy size={16} />{" "}
          {t(credential && active ? "sandboxReplaceKey" : "copyAgentPrompt")}
        </button>
        {credential && active && (
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(sandboxPrompt(credential))
                .then(() => toast.success(t("copied")))
                .catch(() => toast.error(t("copyFailed")))
            }
          >
            {t("copy")}
          </button>
        )}
        {active && (
          <>
            <button
              onClick={() => mutation.mutate("extend")}
              disabled={mutation.isPending}
            >
              {t("sandboxExtend")}
            </button>
            <button
              onClick={() => mutation.mutate("revoke")}
              disabled={mutation.isPending}
            >
              {t("revoke")}
            </button>
          </>
        )}
      </div>
      {active && (
        <p>
          {t("expires")} {timestamp(current.expiresAt, true)}
        </p>
      )}
      {credential && active && (
        <details>
          <summary>{t("sandboxKey")}</summary>
          <code>{credential.token}</code>
        </details>
      )}
      {(current?.status === "expired" || current?.status === "revoked") && (
        <p role="status">{t("sandboxExpired")}</p>
      )}
      {active && selected && (
        <div className="inline-form">
          <label>
            {t("controls")}{" "}
            <select
              value={selected.id}
              onChange={(e) => setControlId(e.target.value)}
            >
              {candidates.map((control) => (
                <option key={control.id} value={control.id}>
                  {control.title}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => mutation.mutate("command")}
            disabled={mutation.isPending}
          >
            {t("sandboxSimulate")}
          </button>
        </div>
      )}
      {current?.passed && (
        <p role="status">
          <Badge tone="success">{t("sandboxPassed")}</Badge>
        </p>
      )}
      {!!current?.requests.length && (
        <details>
          <summary>{t("sandboxRequests")}</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("protocol")}</th>
                  <th>HTTP</th>
                  <th>{t("time")}</th>
                </tr>
              </thead>
              <tbody>
                {current.requests
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <tr key={entry.at + ":" + index}>
                      <td>{entry.step}</td>
                      <td>{entry.status}</td>
                      <td>{timestamp(entry.at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {mutation.error && (
        <p className="error-text" role="alert">
          {mutation.error.message}
        </p>
      )}
    </section>
  );
}

function sandboxPrompt(credential: SandboxCredential) {
  return [
    "Test the QuantBot integration in Sandbox with simulated data and operations. Keep broker connections disabled during the trial.",
    "Strategy ID " + credential.strategyId,
    "Sandbox endpoint " + credential.endpoint,
    "Expires " + new Date(credential.expiresAt * 1000).toISOString(),
    "Set QB_AGENT_TOKEN locally to the temporary credential below. Keep it out of source control and logs.",
    credential.token,
    agentPrompt(location.origin, credential.endpoint),
    "After Sandbox passes, obtain the production endpoint and credential from the administrator.",
  ].join("\n\n");
}
