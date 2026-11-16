import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import {
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
} from "@astryxdesign/core/Table";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Switch } from "@astryxdesign/core/Switch";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, Plus, Send, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, client, resource } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { useDisplay } from "../shared/display";
import { Badge, ErrorView, Loading, Modal, timestamp } from "../shared/ui";
import { Page } from "../app/App";

type Channel = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  events: string[];
  updatedAt: number;
};
type Delivery = {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
};
const providers = [
  ["telegram", "Telegram"],
  ["feishu", "飞书 / Lark"],
  ["wecom", "企业微信"],
  ["dingtalk", "钉钉"],
];
export default function Notifications() {
  const { t } = useLanguage();
  const display = useDisplay();
  const query = useQuery(resource<Channel[]>("/admin/notifications"));
  const [editing, setEditing] = useState<Channel | "new">();
  const [selected, setSelected] = useState("");
  const action = useMutation({
    mutationFn: ({
      id,
      method,
      suffix = "",
    }: {
      id: string;
      method: string;
      suffix?: string;
    }) => api("/admin/notifications/" + id + suffix, method),
    onSuccess: () => {
      void client.invalidateQueries();
      toast.success(t("save"));
    },
  });
  const history = useQuery({
    ...resource<Delivery[]>("/admin/notifications/" + selected + "/deliveries"),
    enabled: !!selected,
    refetchInterval: selected ? 5000 : false,
  });
  return (
    <Page
      title={t("notifications")}
      actions={
        <Button
          label={t("addChannel")}
          variant="primary"
          icon={<AstryxIcon icon={Plus} size="sm" />}
          onClick={() => setEditing("new")}
        />
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <VStack
          gap={3}
          className={
            "controls-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" +
            "   grid"
          }
        >
          {query.data.map((channel) => (
            <Card padding={4} key={channel.id}>
              <VStack as="article" className="channel-card" gap={3}>
                <HStack
                  as="header"
                  hAlign="between"
                  vAlign="center"
                  gap={2}
                  wrap="wrap"
                >
                  <AstryxIcon icon={Bell} size="md" />
                  <Heading level={2}>{channel.name}</Heading>
                  <Badge tone={channel.enabled ? "success" : ""}>
                    {channel.enabled ? t("enabled") : t("disabled")}
                  </Badge>
                </HStack>
                <Text as="p" className="muted text-secondary">
                  {providers.find((p) => p[0] === channel.provider)?.[1]}
                </Text>
                <HStack gap={2} wrap="wrap" className="channel-events">
                  {channel.events.map((event) => (
                    <Badge key={event}>{display.kind(event)}</Badge>
                  ))}
                </HStack>
                <HStack
                  gap={3}
                  wrap="wrap"
                  vAlign="center"
                  className="channel-actions"
                >
                  <Button
                    label={t("editChannel")}
                    icon={<AstryxIcon icon={Pencil} size="sm" />}
                    onClick={() => setEditing(channel)}
                  />
                  <Button
                    label={t("testDelivery")}
                    icon={<AstryxIcon icon={Send} size="sm" />}
                    isDisabled={action.isPending}
                    onClick={() => {
                      setSelected(channel.id);
                      action.mutate({
                        id: channel.id,
                        method: "POST",
                        suffix: "/test",
                      });
                    }}
                  />
                  <IconButton
                    label={channel.name + " " + t("remove")}
                    tooltip={t("remove")}
                    variant="ghost"
                    icon={<AstryxIcon icon={Trash2} size="sm" />}
                    isDisabled={action.isPending}
                    onClick={() =>
                      action.mutate({ id: channel.id, method: "DELETE" })
                    }
                  />
                </HStack>
                <Button
                  label={t("deliveryHistory")}
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(channel.id)}
                />
              </VStack>
            </Card>
          ))}
          {!query.data.length && (
            <EmptyState
              title={t("noChannels")}
              headingLevel={2}
              icon={<AstryxIcon icon={Bell} size="lg" />}
            />
          )}
        </VStack>
      )}
      {action.error && (
        <Text as="p" className="error-text text-error" role="alert">
          {action.error.message}
        </Text>
      )}
      {editing && (
        <ChannelForm
          channel={editing === "new" ? undefined : editing}
          close={() => setEditing(undefined)}
        />
      )}
      {selected && (
        <VStack
          as="section"
          gap={4}
          className="section flex flex-col gap-4 min-w-0"
        >
          <Heading level={2}>{t("deliveryHistory")}</Heading>
          <VStack
            gap={3}
            className="surface bg-surface border border-border rounded-lg   table-scroll overflow-auto min-w-0 max-w-full"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t("type")}</TableHeaderCell>
                  <TableHeaderCell>{t("status")}</TableHeaderCell>
                  <TableHeaderCell>{t("attempts")}</TableHeaderCell>
                  <TableHeaderCell>{t("nextAttempt")}</TableHeaderCell>
                  <TableHeaderCell>{t("details")}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data?.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell>{display.kind(delivery.kind)}</TableCell>
                    <TableCell>{display.delivery(delivery.status)}</TableCell>
                    <TableCell>{delivery.attempts}</TableCell>
                    <TableCell>{timestamp(delivery.nextAt)}</TableCell>
                    <TableCell>{delivery.lastError}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {history.error && <ErrorView error={history.error} />}
          </VStack>
        </VStack>
      )}
    </Page>
  );
}
function ChannelForm({
  channel,
  close,
}: {
  channel?: Channel;
  close: () => void;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const [name, setName] = useState(channel?.name ?? "");
  const [provider, setProvider] = useState(channel?.provider ?? "telegram");
  const [enabled, setEnabled] = useState(channel?.enabled ?? false);
  const [events, setEvents] = useState(channel?.events ?? ["alert", "risk"]);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState("");
  const [replace, setReplace] = useState(!channel);
  const mutation = useMutation({
    mutationFn: () =>
      api(
        "/admin/notifications" + (channel ? "/" + channel.id : ""),
        channel ? "PUT" : "POST",
        {
          name,
          provider,
          enabled,
          events,
          ...(replace
            ? {
                credentials:
                  provider === "telegram"
                    ? { token, chatId }
                    : { webhook, secret },
              }
            : {}),
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries();
      close();
    },
  });
  return (
    <Modal
      title={channel ? t("editChannel") : t("addChannel")}
      purpose="form"
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            name.trim() &&
            name.length <= 120 &&
            events.length &&
            !mutation.isPending
          )
            mutation.mutate();
        }}
      >
        <TextInput
          label={t("channelName")}
          value={name}
          onChange={setName}
          isRequired
          status={
            name.length > 120
              ? { type: "error", message: t("nameTooLong") }
              : undefined
          }
        />
        <VStack gap={2}>
          {t("provider")}
          <Selector
            label={t("provider")}
            isLabelHidden
            value={String(provider)}
            onChange={(e) => {
              setProvider(e);
              setReplace(true);
            }}
            options={[
              ...providers.map(([value, label]) => ({
                value: String(value),
                label: String(label),
              })),
            ]}
          />
        </VStack>
        <Switch label={t("enabled")} value={enabled} onChange={setEnabled} />
        <fieldset>
          <legend>{t("events")}</legend>
          {["alert", "risk", "fill", "command"].map((event) => (
            <VStack
              gap={2}
              className="check-label flex flex-row items-center gap-2"
              key={event}
            >
              <CheckboxInput
                label={display.kind(event)}
                isLabelHidden
                value={events.includes(event)}
                onChange={(e) =>
                  setEvents(
                    e ? [...events, event] : events.filter((v) => v !== event),
                  )
                }
              />
              {display.kind(event)}
            </VStack>
          ))}
        </fieldset>
        {channel && (
          <VStack
            gap={2}
            className="check-label flex flex-row items-center gap-2"
          >
            <CheckboxInput
              label={t("replaceCredentials")}
              isLabelHidden
              value={replace}
              onChange={(e) => setReplace(e)}
            />
            {t("replaceCredentials")}
          </VStack>
        )}
        {replace &&
          (provider === "telegram" ? (
            <>
              <VStack gap={2}>
                Bot Token
                <TextInput
                  label="Bot Token"
                  isLabelHidden
                  type="password"
                  isRequired
                  autoComplete="new-password"
                  value={token}
                  onChange={(e) => setToken(e)}
                />
              </VStack>
              <VStack gap={2}>
                Chat ID
                <TextInput
                  label="Chat ID"
                  isLabelHidden
                  isRequired
                  value={chatId}
                  onChange={(e) => setChatId(e)}
                />
              </VStack>
            </>
          ) : (
            <>
              <VStack gap={2}>
                Webhook URL
                <TextInput
                  label="Webhook URL"
                  isLabelHidden
                  type="password"
                  isRequired
                  autoComplete="new-password"
                  value={webhook}
                  onChange={(e) => setWebhook(e)}
                />
              </VStack>
              {provider !== "wecom" && (
                <VStack gap={2}>
                  Signing secret
                  <TextInput
                    label="Signing secret"
                    isLabelHidden
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => setSecret(e)}
                  />
                </VStack>
              )}
            </>
          ))}
        {mutation.error && (
          <Text as="p" className="error-text text-error" role="alert">
            {mutation.error.message}
          </Text>
        )}
        <Button
          label={t("save")}
          variant="primary"
          type="submit"
          isLoading={mutation.isPending}
          isDisabled={!name.trim() || name.length > 120 || !events.length}
        />
      </form>
    </Modal>
  );
}
