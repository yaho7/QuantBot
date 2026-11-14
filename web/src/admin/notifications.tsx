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
        <button className="primary" onClick={() => setEditing("new")}>
          <Plus size={16} />
          {t("addChannel")}
        </button>
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="controls-grid">
          {query.data.map((channel) => (
            <article className="surface padded channel-card" key={channel.id}>
              <header>
                <Bell size={18} />
                <h2>{channel.name}</h2>
                <Badge tone={channel.enabled ? "success" : ""}>
                  {channel.enabled ? t("enabled") : t("disabled")}
                </Badge>
              </header>
              <p className="muted">
                {providers.find((p) => p[0] === channel.provider)?.[1]}
              </p>
              <div className="channel-events">
                {channel.events.map((event) => (
                  <Badge key={event}>{display.kind(event)}</Badge>
                ))}
              </div>
              <div className="channel-actions">
                <button
                  onClick={() => setEditing(channel)}
                  aria-label={channel.name + " " + t("editChannel")}
                >
                  <Pencil size={15} />
                  {t("editChannel")}
                </button>
                <button
                  disabled={action.isPending}
                  onClick={() => {
                    setSelected(channel.id);
                    action.mutate({
                      id: channel.id,
                      method: "POST",
                      suffix: "/test",
                    });
                  }}
                >
                  <Send size={15} />
                  {t("testDelivery")}
                </button>
                <button
                  aria-label={channel.name + " " + t("remove")}
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ id: channel.id, method: "DELETE" })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <button
                className="text-button"
                onClick={() => setSelected(channel.id)}
              >
                {t("deliveryHistory")}
              </button>
            </article>
          ))}
          {!query.data.length && (
            <div className="surface empty-state">
              <Bell />
              <p>{t("noChannels")}</p>
            </div>
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
          <div className="surface table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("type")}</th>
                  <th>{t("status")}</th>
                  <th>{t("attempts")}</th>
                  <th>{t("nextAttempt")}</th>
                  <th>{t("details")}</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{display.kind(delivery.kind)}</td>
                    <td>{display.delivery(delivery.status)}</td>
                    <td>{delivery.attempts}</td>
                    <td>{timestamp(delivery.nextAt)}</td>
                    <td>{delivery.lastError}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.error && <ErrorView error={history.error} />}
          </div>
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
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          {t("channelName")}
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </label>
        <label>
          {t("provider")}
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setReplace(true);
            }}
          >
            {providers.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("enabled")}
        </label>
        <fieldset>
          <legend>{t("events")}</legend>
          {["alert", "risk", "fill", "command"].map((event) => (
            <label className="check-label" key={event}>
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(e) =>
                  setEvents(
                    e.target.checked
                      ? [...events, event]
                      : events.filter((v) => v !== event),
                  )
                }
              />
              {display.kind(event)}
            </label>
          ))}
        </fieldset>
        {channel && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            {t("replaceCredentials")}
          </label>
        )}
        {replace &&
          (provider === "telegram" ? (
            <>
              <label>
                Bot Token
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <label>
                Chat ID
                <input
                  required
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                Webhook URL
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={webhook}
                  onChange={(e) => setWebhook(e.target.value)}
                />
              </label>
              {provider !== "wecom" && (
                <label>
                  Signing secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
              )}
            </>
          ))}
        {mutation.error && (
          <p className="error-text" role="alert">
            {mutation.error.message}
          </p>
        )}
        <button className="primary" disabled={mutation.isPending}>
          {t("save")}
        </button>
      </form>
    </Modal>
  );
}
