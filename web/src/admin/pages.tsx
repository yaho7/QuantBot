import { SandboxPanel } from "./sandbox";
import { agentPrompt, agentReferences } from "./agent-prompt";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Link } from "../shared/page-links";
import { Copy, Plus, ExternalLink } from "lucide-react";
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
    mutationFn: () =>
      api<{ strategy: Strategy; credential: { token: string } }>(
        "/admin/strategies",
        "POST",
        { name, group, mode },
      ),
    onSuccess: () => { void client.invalidateQueries(); },
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
        <div className="surface table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("group")}</th>
                <th>{t("mode")}</th>
                <th>{t("lastSeen")}</th>
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
                  <td>{strategy.group}</td>
                  <td>
                    <Badge tone={strategy.mode === "live" ? "warning" : ""}>
                      {t(strategy.mode)}
                    </Badge>
                  </td>
                  <td>{timestamp(strategy.lastSeen, true)}</td>
                  <td>
                    <div className="actions">
                      <Link to={"/admin/integration?strategy=" + strategy.id}>
                        {t("integration")} <ExternalLink size={14} />
                      </Link>
                      <button type="button" className="text-button danger" onClick={() => {
                        remove.reset();
                        setDeleting(strategy);
                      }}>{t("deleteStrategy")}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!active.length && <p className="empty-inline">{t("empty")}</p>}
        </div>
      )}
      <Modal title={t(create.data ? "strategyCreated" : "create")} open={open}
        onOpenChange={value => {
          if (create.isPending) return;
          setOpen(value);
          if (!value) create.reset();
        }}>
        {create.data ? (
          <>
            <p><strong>{create.data.strategy.name}</strong></p>
            <p>{t("credentialsHint")}</p>
            <h3>Agent Token</h3>
            <Secret value={create.data.credential.token} label={t("copyAgentToken")} />
            <CopyAgentPrompt strategy={create.data.strategy} primary />
            <p className="muted">
              <a href={agentReferences.protocol} target="_blank" rel="noreferrer">{t("protocol")}</a>
              {" · "}
              <a href={agentReferences.integration} target="_blank" rel="noreferrer">{t("integrationExamples")}</a>
            </p>
          </>
        ) : (
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
        )}
      </Modal>
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
type Token = {
  id: string;
  label: string;
  scopes: string[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};
export function Integration() {
  const { t } = useLanguage();
  const display = useDisplay();
  const strategies = useQuery(resource<Strategy[]>("/admin/strategies"));
  const [params, setParams] = useSearchParams();
  const id =
    params.get("strategy") ??
    strategies.data?.find((s) => !s.archivedAt)?.id ??
    "";
  const detail = useQuery({
    ...resource<Strategy>("/strategies/" + id),
    enabled: !!id,
  });
  const tokens = useQuery({
    ...resource<Token[]>("/admin/strategies/" + id + "/tokens"),
    enabled: !!id,
  });
  const [label, setLabel] = useState("Agent");
  const [scopes, setScopes] = useState(["heartbeat", "report", "control"]);
  const [token, setToken] = useState("");
  const [executor, setExecutor] = useState("");
  const mutation = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: string;
      body?: unknown;
    }) => api<{ token?: string }>(path, method, body),
    onSuccess: (data) => {
      if (data?.token) setToken(data.token);
      void client.invalidateQueries();
    },
  });
  const run = (path: string, method: string, body?: unknown) =>
    mutation.mutate({ path, method, body });
  return (
    <Page title={t("integration")}>
      <select
        aria-label={t("strategies")}
        value={id}
        onChange={(e) => {
          setToken("");
          setParams({ strategy: e.target.value });
        }}
      >
        {strategies.data?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {!id ? (
        <p className="empty-inline">{t("empty")}</p>
      ) : (
        <>
          <section className="section surface padded">
            <h2>{t("token")}</h2>
            <p className="muted">{t("credentialsHint")}</p>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                run("/admin/strategies/" + id + "/tokens", "POST", {
                  label,
                  scopes,
                });
              }}
            >
              <label>
                {t("displayName")}
                <input
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <fieldset>
                <legend>{t("scopes")}</legend>
                {["heartbeat", "report", "control", "command"].map((scope) => (
                  <label className="check-label" key={scope}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(e) =>
                        setScopes(
                          e.target.checked
                            ? [...scopes, scope]
                            : scopes.filter((s) => s !== scope),
                        )
                      }
                    />
                    {display.scope(scope)}
                  </label>
                ))}
              </fieldset>
              <button disabled={mutation.isPending || scopes.length === 0}>
                <Plus size={16} />
                {t("createToken")}
              </button>
            </form>
            {token && <Secret value={token} />}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("displayName")}</th>
                    <th>{t("scopes")}</th>
                    <th>{t("created")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tokens.data?.map((row) => (
                    <tr key={row.id}>
                      <td>{row.label}</td>
                      <td>{row.scopes.map(display.scope).join(" · ")}</td>
                      <td>{timestamp(row.createdAt, true)}</td>
                      <td>
                        {row.revokedAt ? (
                          <Badge>{t("revoke")}</Badge>
                        ) : (
                          <button
                            disabled={mutation.isPending}
                            onClick={() =>
                              run(
                                "/admin/strategies/" + id + "/tokens/" + row.id,
                                "DELETE",
                              )
                            }
                          >
                            {t("revoke")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="section surface padded">
            <h2>{t("executor")}</h2>
            <p className="muted">
              {t("current")} ·{" "}
              {detail.data?.executorInstance ?? t("noExecutor")}
            </p>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                run("/admin/strategies/" + id + "/executor", "PUT", {
                  instanceId: executor || null,
                });
              }}
            >
              <label>
                {t("executor")}
                <select
                  value={executor}
                  onChange={(e) => setExecutor(e.target.value)}
                >
                  <option value="">{t("noExecutor")}</option>
                  {detail.data?.instances?.map((i) => (
                    <option key={i.instanceId} value={i.instanceId}>
                      {i.instanceId} · {i.online ? t("online") : t("offline")}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={mutation.isPending}>{t("save")}</button>
            </form>
          </section>
          <SandboxPanel key={id} strategyId={id} />
          <section className="section surface padded">
            <h2>{t("protocol")}</h2>
            <code>{location.origin}/api/agent/session</code>
            <p>
              <a
                href="/api/agent/schemas/report.json"
                target="_blank"
                rel="noreferrer"
              >
                {t("reportSchema")} <ExternalLink size={14} />
              </a>
            </p>
            <p>
              <a
                href="/api/agent/schemas/agent.json"
                target="_blank"
                rel="noreferrer"
              >
                {t("agentSchema")} <ExternalLink size={14} />
              </a>
            </p>
            <CopyAgentPrompt strategy={detail.data} />
            <pre>{`curl -X POST '${location.origin}/api/agent/session' \\\n  -H 'Authorization: Bearer YOUR_AGENT_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"instanceId":"worker-a","bootId":"NEW_PROCESS_UUID"}'`}</pre>
          </section>
        </>
      )}
      {mutation.error && (
        <p role="alert" className="error-text">
          {mutation.error.message}
        </p>
      )}
    </Page>
  );
}
function CopyAgentPrompt({ strategy, primary = false }: { strategy?: Strategy; primary?: boolean }) {
  const { t } = useLanguage();
  return <button type="button" className={primary ? "primary" : undefined}
    onClick={async () => {
      try {
        await navigator.clipboard.writeText(agentPrompt(location.origin, undefined, strategy));
        toast.success(t("copied"));
      } catch {
        toast.error(t("copyFailed"));
      }
    }}>
    <Copy size={16} /> {t(primary ? "copyAgentPrompt" : "copyProductionPrompt")}
  </button>;
}

function Secret({ value, label }: { value: string; label?: string }) {
  const { t } = useLanguage();
  return (
    <div className="secret">
      <code>{value}</code>
      <button
        type="button"
        aria-label={label ?? t("copy")}
        title={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast.success(t("copied"));
          } catch {
            toast.error(t("copyFailed"));
          }
        }}
      >
        <Copy size={16} />
      </button>
    </div>
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
