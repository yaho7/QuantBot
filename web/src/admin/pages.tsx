import { ConnectionDialog, type CreatedStrategy } from "./connection-dialog";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  client,
  resource,
  type Strategy,
  type Diagnostics,
  type Session,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { useDisplay } from "../shared/display";
import {
  Badge,
  ErrorView,
  Loading,
  Modal,
  shown,
  timestamp,
} from "../shared/ui";
import { Page } from "../app/App";

export function AdminDashboard() {
  const { t } = useLanguage();
  const display = useDisplay();
  const query = useQuery({
    ...resource<Diagnostics>("/admin/diagnostics"),
    refetchInterval: 10_000,
  });
  return (
    <Page title={t("dashboard")}>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <>
          <div className="summary-grid">
            {[
              [t("online"), query.data.onlineAgents],
              [t("samples"), query.data.samples],
              [t("sseSubscribers"), query.data.sseSubscribers],
              [t("queueDepth"), query.data.queueDepth],
            ].map(([label, value]) => (
              <div className="summary-card" key={label}>
                <span className="muted">{label}</span>
                <strong>{Number(value).toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <section className="section surface padded">
            <dl className="system-dl">
              {[
                [t("uptime"), display.unit(Math.floor(query.data.uptimeSeconds), "second")],
                [
                  t("peakMemory"),
                  (query.data.peakRssBytes / 1048576).toFixed(1) + " MiB",
                ],
                [t("heapMemory"), (query.data.heapBytes / 1048576).toFixed(1) + " MiB"],
                ["CPU", display.unit(query.data.cpuSeconds, "second")],
                [t("goRoutines"), query.data.goroutines],
                [t("writeFailures"), query.data.writeFailures],
                ...Object.entries(query.data.walBytes ?? {}).map(
                  ([name, value]) => [
                    name + " WAL",
                    (value / 1048576).toFixed(2) + " MiB",
                  ],
                ),
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </Page>
  );
}
export function AdminStrategies() {
  const { t } = useLanguage();
  const query = useQuery(resource<Strategy[]>("/admin/strategies"));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [mode, setMode] = useState("paper");
  const [connection, setConnection] = useState<{ strategy: Strategy; created?: CreatedStrategy }>();
  const [deleting, setDeleting] = useState<Strategy>();
  const active = (query.data ?? []).filter(strategy => !strategy.archivedAt);
  const remove = useMutation({
    mutationFn: (id: string) => api<void>("/admin/strategies/" + id, "DELETE"),
    onSuccess: () => {
      setDeleting(undefined);
      void client.invalidateQueries();
    },
  });
  const create = useMutation({
    gcTime: 0,
    mutationFn: () =>
      api<CreatedStrategy>(
        "/admin/strategies",
        "POST",
        { name, group, mode },
      ),
    onSuccess: (created) => {
      setOpen(false);
      setConnection({ strategy: created.strategy, created });
      void client.invalidateQueries();
    },
  });
  return (
    <Page
      title={t("strategies")}
      actions={
        <button
          className="primary"
          onClick={() => {
            setName("");
            setGroup("");
            setMode("paper");
            create.reset();
            setOpen(true);
          }}
        >
          <Plus size={17} />
          {t("create")}
        </button>
      }
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="surface table-scroll admin-strategies-table">
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th className="strategy-table-detail">{t("group")}</th>
                <th>{t("mode")}</th>
                <th className="strategy-table-detail">{t("lastSeen")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((strategy) => (
                <tr key={strategy.id}>
                  <td>
                    <Link to={"/strategies/" + strategy.id}>
                      {strategy.name}
                    </Link>
                  </td>
                  <td className="strategy-table-detail">{strategy.group}</td>
                  <td>
                    <Badge tone={strategy.mode === "live" ? "warning" : ""}>
                      {t(strategy.mode)}
                    </Badge>
                  </td>
                  <td className="strategy-table-detail">{timestamp(strategy.lastSeen, true)}</td>
                  <td>
                    <div className="strategy-row-actions">
                      <button type="button" className="strategy-api-button" onClick={() => setConnection({ strategy })}>
                        API
                      </button>
                      <button type="button" className="icon-button strategy-delete-button"
                        aria-label={t("deleteStrategy")} title={t("deleteStrategy")} onClick={() => {
                          remove.reset();
                          setDeleting(strategy);
                        }}><Trash2 size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!active.length && <p className="empty-inline">{t("empty")}</p>}
        </div>
      )}
      <Modal title={t("create")} open={open} onOpenChange={value => {
        if (!create.isPending) setOpen(value);
      }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label>
              {t("name")}
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {t("group")}
              <input
                maxLength={100}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              />
            </label>
            <label>
              {t("mode")}
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="paper">{t("paper")}</option>
                <option value="live">{t("live")}</option>
              </select>
            </label>
            {create.error && (
              <p className="error-text" role="alert">
                {create.error.message}
              </p>
            )}
            <button className="primary" disabled={create.isPending}>
              {t("create")}
            </button>
          </form>
      </Modal>
      {connection && <ConnectionDialog {...connection} onClose={() => {
        setConnection(undefined);
        create.reset();
      }} />}
      {deleting && <Modal title={t("deleteStrategy")} open
        onOpenChange={value => { if (!value && !remove.isPending) setDeleting(undefined); }}>
        <p><strong>{deleting.name}</strong></p>
        <p>{t("deleteStrategyWarning")}</p>
        {remove.error && <p className="error-text" role="alert">{remove.error.message}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={remove.isPending} onClick={() => setDeleting(undefined)}>{t("cancel")}</button>
          <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id)}>{t("deleteStrategy")}</button>
        </div>
      </Modal>}
    </Page>
  );
}
export function Audit() {
  const { t } = useLanguage();
  const [before, setBefore] = useState("");
  const query = useQuery(
    resource<
      {
        id: number;
        at: number;
        actor: string;
        action: string;
        strategyId?: string;
        details: unknown;
      }[]
    >("/admin/audit" + (before ? "?before=" + before : "")),
  );
  return (
    <Page title={t("audit")}>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <>
          <div className="surface table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("created")}</th>
                  <th>{t("actor")}</th>
                  <th>{t("action")}</th>
                  <th>{t("details")}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((row) => (
                  <tr key={row.id}>
                    <td>{timestamp(row.at)}</td>
                    <td>{row.actor}</td>
                    <td>{row.action}</td>
                    <td>
                      <code>{shown(row.details)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.data.length === 100 && (
            <button onClick={() => setBefore(String(query.data.at(-1)!.id))}>
              ↓ 100
            </button>
          )}
        </>
      )}
    </Page>
  );
}
export function Security() {
  const { t } = useLanguage();
  const session = useQuery(resource<Session>("/auth/session"));
  const sessions = useQuery(
    resource<{ createdAt: number; expiresAt: number; current: boolean }[]>(
      "/auth/sessions",
    ),
  );
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api<Session>("/auth/password", "PUT", { currentPassword, newPassword }),
    onSuccess: (result) => {
      client.setQueryData(["/auth/session"], result);
      setCurrent("");
      setNew("");
      void client.invalidateQueries();
      toast.success(t("save"));
    },
  });
  return (
    <Page title={t("security")}>
      <div className="two-columns">
        <section className="surface padded">
          <h2>{session.data?.username}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            <label>
              {t("currentPassword")}
              <input
                autoComplete="current-password"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              {t("newPassword")}
              <input
                autoComplete="new-password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
              />
            </label>
            <button disabled={mutation.isPending} className="primary">
              {t("changePassword")}
            </button>
            {mutation.error && (
              <p role="alert" className="error-text">
                {mutation.error.message}
              </p>
            )}
          </form>
        </section>
        <section className="surface padded">
          <h2>{t("sessions")}</h2>
          {sessions.data?.map((s, i) => (
            <div className="event-line" key={i}>
              {s.current && <Badge tone="success">{t("current")}</Badge>}
              <time>
                {timestamp(s.createdAt, true)} → {timestamp(s.expiresAt, true)}
              </time>
            </div>
          ))}
        </section>
      </div>
    </Page>
  );
}
