import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConnectionDialog, type CreatedStrategy } from "./connection-dialog";
import { useState, useSyncExternalStore } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { RiLineChartLine as ChartNoAxesCombined, RiAddLine as Plus, RiDeleteBin6Line as Trash2 } from "@remixicon/react";
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
  const { lang, t } = useLanguage();
  const display = useDisplay();
  const query = useQuery({
    ...resource<Diagnostics>("/admin/diagnostics"),
    refetchInterval: 10_000,
  });
  const { data, error, isPending, isLoadingError } = query;
  const locale = lang === "zh" ? "zh-CN" : "en";
  const numbers = new Intl.NumberFormat(locale);
  const mib = (bytes: number, digits: number) => `${(bytes / 1048576).toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} MiB`;
  return (
    <Page title={t("dashboard")}>
      {isPending ? (
        <Loading />
      ) : isLoadingError ? (
        <ErrorView error={error} retry={() => void query.refetch()} />
      ) : (
        <>
          {error && <ErrorView error={error} retry={() => void query.refetch()} />}
          <Card className="admin-kpi-panel p-0">
            <dl className="admin-kpis">
              {[
                [t("online"), data.onlineAgents],
                [t("samples"), data.samples],
                [t("sseSubscribers"), data.sseSubscribers],
                [t("queueDepth"), data.queueDepth],
              ].map(([label, value]) => (
                <div className="grid gap-2 p-4" key={label}>
                  <dt className="text-muted-foreground text-sm">{label}</dt>
                  <dd className="text-2xl font-medium tabular-nums">{numbers.format(Number(value))}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <section className="grid gap-3" aria-labelledby="admin-runtime-heading">
            <h2 className="m-0 text-base font-medium" id="admin-runtime-heading">{t("runtimeMetrics")}</h2>
            <Card className="admin-runtime-panel p-0">
              <dl className="admin-runtime">
                {[
                  [t("uptime"), display.unit(Math.floor(data.uptimeSeconds), "second")],
                  [t("peakMemory"), mib(data.peakRssBytes, 1)],
                  [t("heapMemory"), mib(data.heapBytes, 1)],
                  ["CPU", display.unit(data.cpuSeconds, "second")],
                  [t("goRoutines"), numbers.format(data.goroutines)],
                  [t("writeFailures"), numbers.format(data.writeFailures)],
                  ...Object.entries(data.walBytes ?? {}).map(([name, value]) => [name + " WAL", mib(value, 2)]),
                ].map(([label, value]) => (
                  <div className="flex items-center justify-between gap-3 px-4" key={label}>
                    <dt className="text-muted-foreground text-sm">{label}</dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
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
  const startCreate = () => {
    setName(""); setGroup(""); setMode("paper"); create.reset(); setOpen(true);
  };
  return (
    <Page
      title={t("strategies")}
      actions={<Button onClick={startCreate}><Plus size={16} aria-hidden="true" />{t("create")}</Button>}
    >
      {query.isPending ? <Loading /> : query.error ? <ErrorView retry={() => void query.refetch()} error={query.error} /> :
        !active.length ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ChartNoAxesCombined size={24} aria-hidden="true" /></EmptyMedia>
              <EmptyTitle role="heading" aria-level={2}>{t("empty")}</EmptyTitle>
              <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="py-0">
            <Table className="admin-data-table" aria-label={t("strategies")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  {!compact && <TableHead>{t("group")}</TableHead>}
                  <TableHead>{t("mode")}</TableHead>
                  {!compact && <TableHead>{t("lastSeen")}</TableHead>}
                  <TableHead className="text-end">{t("action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map(strategy => (
                  <TableRow key={strategy.id}>
                    <TableCell className="admin-strategy-name">
                      <Link to={"/strategies/" + strategy.id}>{strategy.name}</Link>
                    </TableCell>
                    {!compact && <TableCell>{strategy.group}</TableCell>}
                    <TableCell>{strategy.mode === "live" ? <Badge tone="warning">{t("live")}</Badge> : t("paper")}</TableCell>
                    {!compact && <TableCell>{timestamp(strategy.lastSeen, true)}</TableCell>}
                    <TableCell>
                      <div className="strategy-row-actions flex items-center gap-1">
                        <Button variant="outline" size="sm" onClick={() => setConnection({ strategy })}>API</Button>
                        <Button variant="ghost" size="icon-sm" aria-label={t("deleteStrategy")} onClick={() => {
                          remove.reset();
                          setDeleting(strategy);
                        }}><Trash2 size={16} aria-hidden="true" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      <Modal title={t("create")} purpose="form" open={open} onOpenChange={value => {
        if (!create.isPending) setOpen(value);
      }}>
        <form onSubmit={event => {
          event.preventDefault();
          if (name.trim() && name.length <= 120 && group.length <= 100 && !create.isPending) create.mutate();
        }}>
          <Field data-invalid={name.length > 120}>
            <FieldLabel htmlFor="create-strategy-name">{t("name")}</FieldLabel>
            <Input id="create-strategy-name" autoFocus required value={name} onChange={event => setName(event.target.value)}
              aria-invalid={name.length > 120 || undefined} aria-describedby={name.length > 120 ? "create-strategy-name-error" : undefined} />
            {name.length > 120 && <FieldError id="create-strategy-name-error">{t("nameTooLong")}</FieldError>}
          </Field>
          <Field data-invalid={group.length > 100}>
            <FieldLabel htmlFor="create-strategy-group">{t("group")}</FieldLabel>
            <Input id="create-strategy-group" value={group} onChange={event => setGroup(event.target.value)}
              aria-invalid={group.length > 100 || undefined} aria-describedby={group.length > 100 ? "create-strategy-group-error" : undefined} />
            {group.length > 100 && <FieldError id="create-strategy-group-error">{t("groupTooLong")}</FieldError>}
          </Field>
          <fieldset>
            <legend>{t("mode")}</legend>
            <Choices label={t("mode")} value={mode} select={setMode}
              options={([{ value: "paper", label: t("paper") }, { value: "live", label: t("live") }])} />
          </fieldset>
          {create.error && <ErrorView error={create.error} />}
          <div className="dialog-actions">
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button type="submit" aria-busy={create.isPending}
              disabled={create.isPending || !name.trim() || name.length > 120 || group.length > 100}>{t("create")}</Button>
          </div>
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
          <Button variant="outline" disabled={remove.isPending} onClick={() => setDeleting(undefined)}>{t("cancel")}</Button>
          <Button variant="destructive" disabled={remove.isPending} aria-busy={remove.isPending} onClick={() => remove.mutate(deleting.id)}>{t("deleteStrategy")}</Button>
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
          <Card className="py-0">
            <Table className="admin-data-table" aria-label={t("audit")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("created")}</TableHead>
                  <TableHead>{t("actor")}</TableHead>
                  <TableHead>{t("action")}</TableHead>
                  <TableHead>{t("details")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.map(row => (
                  <TableRow key={row.id}>
                    <TableCell>{timestamp(row.at)}</TableCell>
                    <TableCell>{row.actor}</TableCell>
                    <TableCell>{row.action}</TableCell>
                    <TableCell><code>{shown(row.details)}</code></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {query.data.length === 100 && (
            <Button variant="outline" onClick={() => setBefore(String(query.data.at(-1)!.id))}>
              ↓ 100
            </Button>
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
              if (!mutation.isPending) mutation.mutate();
            }}
          >
            <Field>
              <FieldLabel htmlFor="current-password">{t("currentPassword")}</FieldLabel>
              <Input id="current-password" type="password" autoComplete="current-password"
                value={currentPassword} onChange={event => setCurrent(event.target.value)} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">{t("newPassword")}</FieldLabel>
              <Input id="new-password" type="password" autoComplete="new-password" minLength={8} maxLength={256}
                value={newPassword} onChange={event => setNew(event.target.value)} required />
            </Field>
            <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>{t("changePassword")}</Button>
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
