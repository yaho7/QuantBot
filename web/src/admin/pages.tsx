import { Grid } from "@astryxdesign/core/Grid";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { ConnectionDialog, type CreatedStrategy } from "./connection-dialog";
import { useState, useSyncExternalStore } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { ChartNoAxesCombined, Plus, Trash2 } from "lucide-react";
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
  Choices,
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
          <Grid columns={{ minWidth: 162, repeat: "fit" }} gap={4}>
            {[
              [t("online"), query.data.onlineAgents],
              [t("samples"), query.data.samples],
              [t("sseSubscribers"), query.data.sseSubscribers],
              [t("queueDepth"), query.data.queueDepth],
            ].map(([label, value]) => (
              <Card padding={4} key={label}><VStack gap={1}>
                <Text type="supporting">{label}</Text>
                <Text type="large" weight="semibold" hasTabularNumbers>{Number(value).toLocaleString()}</Text>
              </VStack></Card>
            ))}
          </Grid>
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
const compactTable = matchMedia("(max-width: 600px)");
function watchTableWidth(callback: () => void) {
  compactTable.addEventListener("change", callback);
  return () => compactTable.removeEventListener("change", callback);
}

export function AdminStrategies() {
  const { t } = useLanguage();
  const query = useQuery(resource<Strategy[]>("/admin/strategies"));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const compact = useSyncExternalStore(watchTableWidth, () => compactTable.matches);
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
  const columns: TableColumn<Strategy>[] = [
    { key: "name", header: t("name"), width: proportional(2, { minWidth: 100 }),
      renderCell: strategy => <Link to={"/strategies/" + strategy.id}>{strategy.name}</Link> },
    ...(!compact ? [{ key: "group", header: t("group"), width: proportional(1, { minWidth: 90 }) }] : []),
    { key: "mode", header: t("mode"), width: proportional(1, { minWidth: 65 }),
      renderCell: strategy => strategy.mode === "live" ? <Badge tone="warning">{t("live")}</Badge> : t("paper") },
    ...(!compact ? [{ key: "lastSeen", header: t("lastSeen"), width: proportional(1, { minWidth: 120 }),
      renderCell: (strategy: Strategy) => timestamp(strategy.lastSeen, true) }] : []),
    { key: "id", header: t("action"), width: pixel(compact ? 108 : 124), align: "end", renderCell: strategy =>
      <HStack className="strategy-row-actions" gap={1} hAlign="end" vAlign="center">
        <Button label="API" size="sm" onClick={() => setConnection({ strategy })} />
        <IconButton variant="ghost" size="sm" label={t("deleteStrategy")} tooltip={t("deleteStrategy")}
          icon={<Trash2 size={16} />} onClick={() => {
            remove.reset();
            setDeleting(strategy);
          }} />
      </HStack> },
  ];
  const startCreate = () => {
    setName(""); setGroup(""); setMode("paper"); create.reset(); setOpen(true);
  };
  return (
    <Page
      title={t("strategies")}
      actions={<Button label={t("create")} variant="primary" icon={<Plus size={16} />} onClick={startCreate} />}
    >
      {query.isPending ? <Loading /> : query.error ? <ErrorView retry={() => void query.refetch()} error={query.error} /> :
        !active.length ? <EmptyState title={t("empty")} description={t("emptyDescription")} headingLevel={2}
          icon={<ChartNoAxesCombined size={24} />} /> :
          <Card padding={0}><Table data={active} columns={columns} idKey="id" hasHover /></Card>}
      <Modal title={t("create")} purpose="form" open={open} onOpenChange={value => {
        if (!create.isPending) setOpen(value);
      }}>
        <form onSubmit={event => {
          event.preventDefault();
          if (name.trim() && name.length <= 120 && group.length <= 100 && !create.isPending) create.mutate();
        }}>
          <TextInput label={t("name")} value={name} onChange={setName} hasAutoFocus
            status={name.length > 120 ? { type: "error", message: t("nameTooLong") } : undefined} />
          <TextInput label={t("group")} value={group} onChange={setGroup}
            status={group.length > 100 ? { type: "error", message: t("groupTooLong") } : undefined} />
          <fieldset>
            <legend>{t("mode")}</legend>
            <Choices label={t("mode")} value={mode} select={setMode}
              options={([{ value: "paper", label: t("paper") }, { value: "live", label: t("live") }])} />
          </fieldset>
          {create.error && <ErrorView error={create.error} />}
          <HStack hAlign="end" gap={2}>
            <Button label={t("cancel")} isDisabled={create.isPending} onClick={() => setOpen(false)} />
            <Button label={t("create")} type="submit" variant="primary" isLoading={create.isPending}
              isDisabled={!name.trim() || name.length > 120 || group.length > 100} />
          </HStack>
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
          <Button label={t("cancel")} isDisabled={remove.isPending} onClick={() => setDeleting(undefined)} />
          <Button label={t("deleteStrategy")} variant="destructive" isLoading={remove.isPending} onClick={() => remove.mutate(deleting.id)} />
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
                minLength={8}
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
