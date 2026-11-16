import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, Clipboard, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { api, client, resource, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Choices, ErrorView, Loading, Modal } from "../shared/ui";
import { agentPrompt, agentReferences } from "./agent-prompt";
import { SandboxPanel } from "./sandbox";
import { ConnectionField, useCopyText } from "./connection-field";

type KeyMetadata = {
  id: string;
  label: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revealable: boolean;
};
type Issued = KeyMetadata & { token: string };
export type CreatedStrategy = {
  endpoint: string;
  strategy: Strategy;
  credential: Issued;
};

export function ConnectionDialog({
  strategy,
  created,
  onClose,
}: {
  strategy: Strategy;
  created?: CreatedStrategy;
  onClose: () => void;
}) {
  const { lang, t } = useLanguage();
  const copy = useCopyText();
  const [view, setView] = useState<"production" | "sandbox">("sandbox");
  const [confirm, setConfirm] = useState(false);
  const [issued, setIssued] = useState<KeyMetadata | undefined>(
    created?.credential,
  );
  const [secret, setSecret] = useState(
    created
      ? { id: created.credential.id, value: created.credential.token }
      : undefined,
  );
  const path = "/admin/strategies/" + strategy.id;
  const tokens = useQuery(resource<KeyMetadata[]>(path + "/tokens"));
  const endpoint = created?.endpoint ?? location.origin + "/api/agent";
  const active = tokens.data?.filter(
    (item) =>
      !item.revokedAt &&
      (!item.expiresAt || item.expiresAt * 1000 > Date.now()),
  );
  const primary =
    active === undefined
      ? issued
      : (active.find((item) => item.id === issued?.id) ??
        active.find((item) => item.label === "Initial Agent") ??
        active[0]);
  const value =
    primary && primary.id === secret?.id ? secret?.value : undefined;
  const reveal = useMutation({
    mutationFn: async (id: string) => {
      const result = await api<{ token: string }>(
        path + "/tokens/" + id + "/reveal",
        "POST",
      );
      setSecret({ id, value: result.token });
    },
  });
  const regenerate = useMutation({
    mutationFn: async () => {
      const { token, ...key } = primary
        ? await api<Issued>(
            path + "/tokens/" + primary.id + "/regenerate",
            "POST",
          )
        : await api<Issued>(path + "/tokens", "POST", {
            label: "Initial Agent",
            scopes: ["heartbeat", "report", "control", "command"],
          });
      client.setQueryData<KeyMetadata[]>([path + "/tokens"], (previous) => [
        key,
        ...(previous ?? []).filter(
          (item) => item.id !== primary?.id && item.id !== key.id,
        ),
      ]);
      setIssued(key);
      setSecret({ id: key.id, value: token });
      reveal.reset();
      setConfirm(false);
    },
    onSettled: () =>
      void client.invalidateQueries({ queryKey: [path + "/tokens"] }),
  });
  const canGenerate = !tokens.isPending && !tokens.isError;
  return (
    <Modal
      title={t(
        confirm
          ? "regenerateToken"
          : created
            ? "strategyCreated"
            : "strategyAPI",
      )}
      className="connection-dialog"
      open
      onOpenChange={(open) => {
        if (open || regenerate.isPending) return;
        if (confirm) setConfirm(false);
        else onClose();
      }}
    >
      <Text type="supporting" className="connection-caption">
        {strategy.name}
      </Text>
      {confirm ? (
        <>
          <Text as="p" className="muted text-secondary">
            {t("regenerateTokenWarning")}
          </Text>
          {regenerate.error && (
            <Text as="p" className="error-text text-error" role="alert">
              {regenerate.error.message}
            </Text>
          )}
          <HStack
            gap={3}
            wrap="wrap"
            vAlign="center"
            className="dialog-actions flex flex-wrap items-center justify-end gap-2"
          >
            <Button
              label={t("cancel")}
              type="button"
              isDisabled={regenerate.isPending}
              onClick={() => setConfirm(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              label={t("regenerateToken")}
              type="button"
              className="danger text-error"
              isDisabled={regenerate.isPending || !primary}
              onClick={() => regenerate.mutate()}
            >
              {t("regenerateToken")}
            </Button>
          </HStack>
        </>
      ) : (
        <>
          <Choices
            label={t("connectionType")}
            value={view}
            fill
            size="lg"
            select={setView}
            options={[
              { value: "sandbox", label: t("sandboxTest") },
              { value: "production", label: t("productionConnection") },
            ]}
          />
          {view === "production" ? (
            <VStack gap={3} className="connection-panel min-w-0">
              <VStack
                gap={0}
                className="connection-fields border border-border rounded-lg px-4"
              >
                <ConnectionField
                  field="endpoint"
                  label="Endpoint"
                  value={endpoint}
                  copyLabel={t("copyEndpoint")}
                />
                <ConnectionField
                  field="key"
                  label="Key"
                  value={primary?.id}
                  copyLabel={t("copyKey")}
                />
                <ConnectionField
                  field="token"
                  label="Token"
                  value={value}
                  copyLabel={t("copyAgentToken")}
                  revealing={reveal.isPending || regenerate.isPending}
                  onReveal={
                    primary?.revealable
                      ? () =>
                          value
                            ? setSecret(undefined)
                            : reveal.mutate(primary.id)
                      : undefined
                  }
                />
              </VStack>
              {tokens.error && (
                <ErrorView
                  error={tokens.error}
                  retry={() => void tokens.refetch()}
                />
              )}
              {reveal.error && (
                <Text as="p" className="error-text text-error" role="alert">
                  {reveal.error.message}
                </Text>
              )}
              {regenerate.error && (
                <Text as="p" className="error-text text-error" role="alert">
                  {regenerate.error.message}
                </Text>
              )}
              <VStack gap={3} className="connection-options text-secondary">
                {primary && !primary.revealable && (
                  <Text className="muted text-secondary">
                    {t("legacyTokenHint")}
                  </Text>
                )}
                <Button
                  label={t(primary ? "regenerateToken" : "createToken")}
                  type="button"
                  className="text-button"
                  isDisabled={
                    !canGenerate || reveal.isPending || regenerate.isPending
                  }
                  onClick={() => {
                    regenerate.reset();
                    if (primary) setConfirm(true);
                    else regenerate.mutate();
                  }}
                >
                  <AstryxIcon icon={RotateCw} size="sm" />
                  {t(primary ? "regenerateToken" : "createToken")}
                </Button>
              </VStack>
              <ExecutorSettings strategy={strategy} path={path} />
              <VStack
                gap={3}
                className="connection-footer border-t border-border pt-4"
              >
                <a
                  href={agentReferences.integration}
                  target="_blank"
                  rel="noreferrer"
                >
                  <AstryxIcon icon={BookOpen} size="sm" />
                  {t("integrationExamples")}
                </a>
                <Button
                  variant="primary"
                  label={t("copyAgentPrompt")}
                  icon={<AstryxIcon icon={Clipboard} size="sm" />}
                  onClick={() =>
                    void copy(
                      agentPrompt(location.origin, endpoint, strategy, {
                        key: primary?.id,
                        lang,
                      }),
                    )
                  }
                />
              </VStack>
            </VStack>
          ) : (
            <SandboxPanel strategy={strategy} productionEndpoint={endpoint} />
          )}
        </>
      )}
    </Modal>
  );
}

function ExecutorSettings({
  strategy,
  path,
}: {
  strategy: Strategy;
  path: string;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const query = useQuery({
    ...resource<Strategy>(path),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const current = (query.data ?? strategy).executorInstance ?? "";
  const save = useMutation({
    mutationFn: () =>
      api<void>(path + "/executor", "PUT", {
        instanceId: (selected ?? current) || null,
      }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [path] }),
        client.invalidateQueries({ queryKey: ["/strategies/" + strategy.id] }),
      ]);
      setSelected(undefined);
      toast.success(t("save"));
    },
  });
  return (
    <details
      className="connection-details border-t border-border pt-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("executor")}</summary>
      {open && (
        <VStack gap={3} className="connection-detail-body mt-3">
          {query.isPending ? (
            <Loading />
          ) : query.error ? (
            <ErrorView error={query.error} />
          ) : (
            <>
              <Text as="p" className="muted text-secondary">
                {t("current")} · {current || t("noExecutor")}
              </Text>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate();
                }}
              >
                <Selector
                  label={t("executor")}
                  isLabelHidden
                  value={String(selected ?? current)}
                  onChange={(event) => setSelected(event)}
                  options={[
                    { value: String(""), label: String(t("noExecutor")) },
                    ...(query.data.instances ?? []).map((instance) => ({
                      value: String(instance.instanceId),
                      label: String(
                        instance.instanceId +
                          "·" +
                          t(instance.online ? "online" : "offline"),
                      ),
                    })),
                  ]}
                />
                <Button
                  label={t("save")}
                  type="submit"
                  isDisabled={
                    save.isPending ||
                    selected === undefined ||
                    selected === current
                  }
                >
                  {t("save")}
                </Button>
              </form>
              {save.error && (
                <Text as="p" className="error-text text-error" role="alert">
                  {save.error.message}
                </Text>
              )}
            </>
          )}
        </VStack>
      )}
    </details>
  );
}
