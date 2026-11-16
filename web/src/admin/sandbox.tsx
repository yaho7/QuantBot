import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Clipboard, FlaskConical } from "lucide-react";
import { useState } from "react";
import {
  api,
  client,
  resource,
  type Registry,
  type Strategy,
} from "../shared/api";
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
type SandboxCredential = {
  id: string;
  token: string;
  endpoint: string;
  expiresAt: number;
};
const path = "/admin/sandbox";

export function SandboxPanel({
  strategy,
  productionEndpoint,
}: {
  strategy: Strategy;
  productionEndpoint: string;
}) {
  const { lang, t } = useLanguage();
  const copy = useCopyText();
  const [secret, setSecret] = useState<SandboxCredential>();
  const [closing, setClosing] = useState(false);
  const [controlId, setControlId] = useState("");
  const query = useQuery({
    ...resource<SandboxStatus>(path),
    refetchInterval: 2000,
  });
  const current = query.data;
  const active = current?.status === "active";
  const token = active && secret?.id === current.id ? secret?.token : undefined;
  const commands = useQuery({
    queryKey: [path + "/controls", current?.id],
    queryFn: () => api<Registry>(path + "/controls"),
    enabled: active,
    refetchInterval: 3000,
  });
  const candidates =
    commands.data?.controls.filter(
      (item) =>
        item.kind === "button" && item.actual?.available && !item.readOnly,
    ) ?? [];
  const selected =
    candidates.find((item) => item.id === controlId) ?? candidates[0];
  const mutate = useMutation({
    mutationFn: async (
      action: "start" | "stop" | "reveal" | "copy" | "command",
    ) => {
      if (action === "start") {
        const status = await api<SandboxStatus>(path, "POST");
        client.setQueryData([path], status);
      } else if (action === "stop") {
        await api(path, "DELETE");
        setSecret(undefined);
        setClosing(false);
      } else if (action === "command") {
        const command = await api<{ id: string; status: string }>(
          path + "/commands",
          "POST",
          {
            controlId: selected?.id,
            revision: commands.data?.revision,
            input: null,
          },
          crypto.randomUUID(),
        );
        if (command.status === "confirmation_required")
          await api(path + "/commands/" + command.id + "/confirm", "POST");
      } else {
        const issued = await api<SandboxCredential>(path + "/reveal", "POST");
        if (action === "reveal") setSecret(issued);
        else
          await copy(
            agentPrompt(location.origin, issued.endpoint, strategy, {
              lang,
              key: issued.id,
              sandboxToken: issued.token,
              expiresAt: issued.expiresAt,
              productionEndpoint,
            }),
          );
      }
    },
    onSettled: () => void client.invalidateQueries({ queryKey: [path] }),
  });

  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorView error={query.error} retry={() => void query.refetch()} />;
  return (
    <VStack gap={3} className="connection-panel min-w-0">
      <VStack gap={3} className="sandbox-state min-w-0">
        <AstryxIcon icon={FlaskConical} size="md" aria-hidden="true" />
        <VStack gap={3}>
          <Text weight="semibold">{t("sandboxShared")}</Text>
          <Text as="p">
            {t(active ? "sandboxSharedHint" : "sandboxStartHint")}
          </Text>
        </VStack>
        {active && <Badge tone="success">{t("sandboxRunning")}</Badge>}
      </VStack>
      {active && (
        <>
          <VStack
            gap={3}
            className="connection-fields border border-border rounded-lg px-4"
          >
            <ConnectionField
              field="test-endpoint"
              label="Endpoint"
              value={current.endpoint}
              copyLabel={t("copyEndpoint")}
            />
            <ConnectionField
              field="test-token"
              label="Token"
              value={token}
              copyLabel={t("copySandboxToken")}
              revealing={mutate.isPending}
              onReveal={() =>
                token ? setSecret(undefined) : mutate.mutate("reveal")
              }
            />
          </VStack>
          <VStack gap={3} className="connection-options text-secondary">
            <Text className="muted text-secondary">
              {t("expires")} · {timestamp(current.expiresAt, true)}
            </Text>
            <Button
              label={t(closing ? "cancel" : "sandboxStop")}
              type="button"
              className="text-button"
              isDisabled={mutate.isPending}
              onClick={() => {
                if (!closing) mutate.reset();
                setClosing(!closing);
              }}
            >
              {t(closing ? "cancel" : "sandboxStop")}
            </Button>
          </VStack>
          {closing && (
            <VStack gap={3} className="sandbox-confirm text-secondary">
              <Text as="p">{t("sandboxStopWarning")}</Text>
              <Button
                label={t("sandboxStop")}
                type="button"
                className="danger text-error"
                isDisabled={mutate.isPending}
                onClick={() => mutate.mutate("stop")}
              >
                {t("sandboxStop")}
              </Button>
            </VStack>
          )}
          {selected && (
            <form
              className="sandbox-command"
              onSubmit={(event) => {
                event.preventDefault();
                mutate.mutate("command");
              }}
            >
              <Selector
                label={t("controls")}
                isLabelHidden
                value={String(selected.id)}
                onChange={(event) => setControlId(event)}
                options={[
                  ...candidates.map((item) => ({
                    value: String(item.id),
                    label: String(item.title),
                  })),
                ]}
              />
              <Button
                label={t("sandboxSimulate")}
                type="submit"
                isDisabled={mutate.isPending}
              >
                {t("sandboxSimulate")}
              </Button>
            </form>
          )}
          {current.passed && (
            <Text as="p" className="sandbox-passed text-success" role="status">
              {t("sandboxPassed")}
            </Text>
          )}
          {!!current.requests.length && (
            <details className="connection-details border-t border-border pt-3">
              <summary>{t("sandboxRequests")}</summary>
              <ul className="sandbox-requests list-none p-0 flex flex-col gap-2">
                {current.requests
                  .slice(-10)
                  .reverse()
                  .map((entry, index) => (
                    <li key={entry.at + ":" + index}>
                      <code>
                        <Text type="code">{entry.step}</Text>
                      </code>
                      <Text>{entry.status}</Text>
                      <time>
                        <Text type="supporting">{timestamp(entry.at)}</Text>
                      </time>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </>
      )}
      {mutate.error && (
        <Text as="p" className="error-text text-error" role="alert">
          {mutate.error.message}
        </Text>
      )}
      <VStack
        gap={3}
        className="connection-footer border-t border-border pt-4   sandbox-footer"
      >
        <Button
          variant="primary"
          label={t(active ? "copySandboxPrompt" : "sandboxStart")}
          icon={
            active ? (
              <AstryxIcon icon={Clipboard} size="sm" />
            ) : (
              <AstryxIcon icon={FlaskConical} size="sm" />
            )
          }
          isLoading={
            mutate.isPending &&
            (mutate.variables === "copy" || mutate.variables === "start")
          }
          isDisabled={mutate.isPending || closing}
          onClick={() => mutate.mutate(active ? "copy" : "start")}
        />
      </VStack>
    </VStack>
  );
}
