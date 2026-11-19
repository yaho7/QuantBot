import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  RiNotification3Line as Bell,
  RiAddLine as Plus,
  RiSendPlaneLine as Send,
  RiEditLine as Pencil,
  RiDeleteBin6Line as Trash2,
} from "@remixicon/react";
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
      actions={<Button onClick={() => setEditing("new")}><Plus size={16} aria-hidden="true" />{t("addChannel")}</Button>}
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="controls-grid">
          {query.data.map((channel) => (
            <Card key={channel.id}>
              <CardContent>
                <article className="channel-card grid gap-3">
                  <header>
                    <Bell size={16} aria-hidden="true" />
                    <h2>{providers.find(([id]) => id === channel.provider)?.[1] ?? channel.provider}</h2>
                    <Badge tone={channel.enabled ? "success" : ""}>
                      {channel.enabled ? t("enabled") : t("disabled")}
                    </Badge>
                  </header>
                  <div className="channel-events">
                    {channel.events.map((event) => (
                      <Badge key={event}>{display.kind(event)}</Badge>
                    ))}
                  </div>
                  <div className="channel-actions">
                    <Button variant="outline" onClick={() => setEditing(channel)}>
                      <Pencil size={16} aria-hidden="true" />{t("editChannel")}
                    </Button>
                    <Button variant="outline" disabled={action.isPending}
                      onClick={() => {
                        setSelected(channel.id);
                        action.mutate({ id: channel.id, method: "POST", suffix: "/test" });
                      }}>
                      <Send size={16} aria-hidden="true" />{t("testDelivery")}
                    </Button>
                    <Button size="icon" aria-label={channel.name + " " + t("remove")} variant="ghost"
                      disabled={action.isPending} onClick={() => action.mutate({ id: channel.id, method: "DELETE" })}>
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  </div>
                  <Button className="justify-self-start" variant="ghost" size="sm" onClick={() => setSelected(channel.id)}>
                    {t("deliveryHistory")}
                  </Button>
                </article>
              </CardContent>
            </Card>
          ))}
          {!query.data.length && (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Bell size={24} aria-hidden="true" /></EmptyMedia>
                <EmptyTitle role="heading" aria-level={2}>{t("noChannels")}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      )}
      {action.error && (
        <p className="error-text" role="alert">
          {action.error.message}
        </p>
      )}
      {editing && (
        <ChannelForm
          channel={editing === "new" ? undefined : editing}
          close={() => setEditing(undefined)}
        />
      )}
      {selected && (
        <section className="section">
          <h2>{t("deliveryHistory")}</h2>
          <Card className="py-0">
            <Table className="admin-data-table" aria-label={t("deliveryHistory")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("type")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("attempts")}</TableHead>
                  <TableHead>{t("nextAttempt")}</TableHead>
                  <TableHead>{t("details")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data?.map(delivery => (
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
          </Card>
        </section>
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
          name: providers.find(([id]) => id === provider)?.[1] ?? provider,
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
          if (events.length && !mutation.isPending) mutation.mutate();
        }}
      >
        <Field>
          <FieldLabel htmlFor="notification-provider">{t("provider")}</FieldLabel>
          <NativeSelect id="notification-provider" value={provider} onChange={(event) => {
            setProvider(event.target.value);
            setReplace(true);
          }}>
            {providers.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field orientation="horizontal">
          <Switch id="notification-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <FieldLabel htmlFor="notification-enabled">{t("enabled")}</FieldLabel>
        </Field>
        <FieldSet>
          <FieldLegend>{t("events")}</FieldLegend>
          <FieldGroup className="gap-2">
            {["alert", "risk", "fill", "command"].map(event => (
              <Field orientation="horizontal" key={event}>
                <Checkbox id={"notification-event-" + event} checked={events.includes(event)}
                  onCheckedChange={checked => setEvents(current => checked ? [...current, event] : current.filter(value => value !== event))} />
                <FieldLabel htmlFor={"notification-event-" + event}>{display.kind(event)}</FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
        {channel && (
          <Field orientation="horizontal">
            <Checkbox id="notification-replace" checked={replace} onCheckedChange={setReplace} />
            <FieldLabel htmlFor="notification-replace">{t("replaceCredentials")}</FieldLabel>
          </Field>
        )}
        {replace && (
          provider === "telegram" ? (
            <>
              <Field>
                <FieldLabel htmlFor="notification-bot-token">Bot Token</FieldLabel>
                <Input id="notification-bot-token" type="password" autoComplete="new-password"
                  value={token} onChange={event => setToken(event.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="notification-chat-id">Chat ID</FieldLabel>
                <Input id="notification-chat-id" value={chatId} onChange={event => setChatId(event.target.value)} required />
              </Field>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="notification-webhook">Webhook URL</FieldLabel>
                <Input id="notification-webhook" type="password" autoComplete="new-password"
                  value={webhook} onChange={event => setWebhook(event.target.value)} required />
              </Field>
              {provider !== "wecom" && (
                <Field>
                  <FieldLabel htmlFor="notification-signing-secret">Signing secret</FieldLabel>
                  <Input id="notification-signing-secret" type="password" autoComplete="new-password"
                    value={secret} onChange={event => setSecret(event.target.value)} />
                </Field>
              )}
            </>
          )
        )}
        {mutation.error && (
          <p className="error-text" role="alert">
            {mutation.error.message}
          </p>
        )}
        <Button type="submit" aria-busy={mutation.isPending} disabled={mutation.isPending || !events.length}>
          {t("save")}
        </Button>
      </form>
    </Modal>
  );
}
