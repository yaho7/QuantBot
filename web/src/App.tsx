import { tr } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, CircleDashed, FolderCode, LogOut, Monitor, Moon, Pause, Plus, Radio, Settings, Sparkles, Sun,
} from "lucide-react";
import * as React from "react";
import { AiPromptDialog } from "@/components/AiPromptDialog";
import { BrandIcon } from "@/components/BrandIcon";
import { ConfirmDialog, EmptyState, LoadingState, PageHeader, QueryBoundary } from "@/components/common";
import { SettingsPage } from "@/components/SettingsPage";
import { StrategyAdminDialog } from "@/components/StrategyAdminDialog";
import { PauseButton, StrategyPanel } from "@/components/StrategyPanel";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Table, Td, Th,
} from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Theme, useTheme } from "@/hooks/useTheme";
import { api, ApiError, type Notice, type StrategyView } from "@/lib/api";
import { actionLabel, ago, dateTime, NA } from "@/lib/format";
import { cn } from "@/lib/utils";

const NEXT_THEME: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };
const THEME_LABEL = { light: tr("浅色"), dark: tr("深色"), system: tr("跟随系统") };

const KIND_TONE = { info: "neutral", trade: "info", alert: "warning", error: "loss" } as const;
const KIND_LABEL = { info: tr("消息"), trade: tr("成交"), alert: tr("提醒"), error: tr("报错") };
const WorkspaceEditor = React.lazy(() => import("@/components/WorkspaceEditor"));

type View = "strategies" | "workspace" | "settings";

function TopBar({ onLogout, view }: {
  onLogout?: () => void;
  view?: View;
}) {
  const [theme, setTheme] = useTheme();
  const ThemeIcon = THEME_ICON[theme];
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 pt-6 sm:px-8">
      <div className="flex items-center gap-2">
        <BrandIcon className="size-6" />
        <span className="font-display text-lg">QuantBot</span>
      </div>
      {view && (
        <nav aria-label={tr("主导航")} className="order-last flex w-full gap-1 sm:order-none sm:ml-3 sm:w-auto">
          <Button asChild variant={view === "strategies" ? "secondary" : "ghost"} size="sm">
            <a href="/ui/" aria-current={view === "strategies" ? "page" : undefined}>{tr("策略")}</a>
          </Button>
          <Button asChild variant={view === "workspace" ? "secondary" : "ghost"} size="sm">
            <a href="/ui/?view=workspace" aria-current={view === "workspace" ? "page" : undefined}>
              <FolderCode /> {tr("工作区")}
            </a>
          </Button>
        </nav>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="icon" onClick={() => setTheme(NEXT_THEME[theme])}
          aria-label={tr("主题：{0}", THEME_LABEL[theme])} title={tr("主题：{0}", THEME_LABEL[theme])}>
          <ThemeIcon />
        </Button>
        {view && (
          <Button asChild variant={view === "settings" ? "secondary" : "ghost"} size="icon">
            <a href="/ui/?view=settings" aria-current={view === "settings" ? "page" : undefined}
              aria-label={tr("设置")} title={tr("设置")}><Settings /></a>
          </Button>
        )}
        {onLogout && (
          <Button variant="ghost" size="icon" onClick={onLogout} aria-label={tr("退出登录")} title={tr("退出登录")}>
            <LogOut />
          </Button>
        )}
      </div>
    </header>
  );
}

const code = "rounded bg-muted px-1.5 py-0.5 font-mono text-xs";

function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (answer) => {
      if (answer.ok) void qc.invalidateQueries();
      else setPassword("");
    },
  });
  const failed = login.data && !login.data.ok ? login.data.message : login.error?.message;
  return (
    <>
      <TopBar />
      <main className="view-enter mx-auto max-w-md px-5 pt-20">
        <h1 className="font-display text-3xl font-medium">{tr("登录 QuantBot")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">{tr("用安装时设的管理员账号登录。")}</p>
        <Card className="p-5">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
            <Field label={tr("用户名")} htmlFor="u">
              <Input id="u" autoComplete="username" value={username} autoFocus required
                onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={tr("密码")} htmlFor="p">
              <Input id="p" type="password" autoComplete="current-password" value={password} required
                onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {failed && <Alert tone="loss">{failed}</Alert>}
            <Button type="submit" loading={login.isPending}>{tr("登录")}</Button>
          </form>
        </Card>
        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
          {tr("忘了密码：在服务器上运行")} <code className={code}>quantbot password</code>
          {tr("。 也可以运行")} <code className={code}>quantbot web</code>
          {tr("，或给 bot 发")} <code className={code}>/web</code>
          {tr("， 拿一个不用密码的一次性链接。")}
        </p>
      </main>
    </>
  );
}

function OnlineBadge({ s }: { s: StrategyView }) {
  if (s.online) return <Badge tone="gain"><Radio /> {tr("在线")}</Badge>;
  if (!s.connected && s.last_seen === null) return <Badge><CircleDashed /> {tr("还没连上过")}</Badge>;
  return <Badge tone="loss">{tr("离线")}</Badge>;
}

function StrategyCard({ s, onManage }: { s: StrategyView; onManage: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card className={cn(!s.online && "opacity-80")}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">{s.name}</CardTitle>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{s.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {s.paused && <Badge tone="warning">{tr("已暂停开仓")}</Badge>}
          <OnlineBadge s={s} />
        </div>
      </CardHeader>
      <CardContent>
        {s.status ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{s.status}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {s.connected ? tr("还没有报状态。") : tr("在策略项目里运行 quantbot link，接上后就会出现在这里。")}
          </p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">{tr("状态")} {ago(s.status_age)} {tr("· 最后联系")} {ago(s.last_seen)}
          {s.pending > 0 && tr(" · {0} 个命令在排队", s.pending)}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <PauseButton s={s} />
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{tr("更多操作")} <ChevronRight />
          </Button>
          <Button size="sm" variant="ghost" onClick={onManage}>{tr("管理")}</Button>
        </div>
      </CardContent>
      {open && <StrategyPanel s={s} open onOpenChange={setOpen} />}
    </Card>
  );
}

function Feed({ items }: { items: Notice[] }) {
  if (!items.length) return <EmptyState title={tr("还没有推送")} description={tr("QuantBot 这次启动后发出的消息会显示在这里。")} />;
  return (
    <ul className="divide-y">
      {items.map((n, i) => (
        <li key={`${n.time}-${i}`} className="flex gap-3 px-5 py-3">
          <span className="num w-28 shrink-0 text-xs text-muted-foreground">{dateTime(n.time)}</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{n.strategy}</span>
              <Badge tone={KIND_TONE[n.kind] ?? "neutral"}>{KIND_LABEL[n.kind] ?? n.kind}</Badge>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{n.text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AuditLog() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit, refetchInterval: 15_000 });
  return (
    <QueryBoundary query={audit}>
      {({ records }) =>
        records.length === 0 ? (
          <EmptyState title={tr("还没有操作记录")} description={tr("在网页或 Telegram 里点过的按钮会记在这里。")} />
        ) : (
          <Table>
            <thead>
              <tr><Th>{tr("时间")}</Th><Th>{tr("操作")}</Th><Th>{tr("策略")}</Th><Th>{tr("从哪")}</Th><Th>{tr("结果")}</Th></tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.time}-${i}`}>
                  <Td className="num text-xs text-muted-foreground">{dateTime(r.time)}</Td>
                  <Td>{actionLabel(r.action)}</Td>
                  <Td className="font-mono text-xs">{r.strategy ?? r.strategies?.join(", ") ?? NA}</Td>
                  <Td className="text-xs">{r.user === "web" ? tr("网页") : r.user === "cli" ? tr("终端") : r.user ? "Telegram" : NA}</Td>
                  <Td className="max-w-md whitespace-normal text-xs">
                    {r.ok === false && <Badge tone="loss" className="mr-2">{tr("失败")}</Badge>}
                    {r.result ?? NA}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </QueryBoundary>
  );
}

function PauseAll({ count }: { count: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = React.useState(false);
  const pause = useMutation({
    mutationFn: api.pauseAll,
    onSuccess: (answer) => {
      setAsking(false);
      toast.success(answer.message);
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: toast.error,
  });
  return (
    <>
      <Button variant="outline" disabled={!count} onClick={() => setAsking(true)}>
        <Pause /> {tr("全部暂停开仓")}</Button>
      <ConfirmDialog open={asking} onOpenChange={setAsking} title={tr("全部暂停开仓？")}
        description={tr("{0} 个在线策略都不再开新仓。已有仓位和止损照常。", count)}
        confirmLabel={tr("全部暂停")} loading={pause.isPending} onConfirm={() => pause.mutate()} />
    </>
  );
}

function TelegramNote() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  if (!settings.data || settings.data.telegram) return null;
  return (
    <Alert tone="info" className="items-center justify-between">
      <span>{tr("Telegram 没接，推送只显示在这个网页上。想在手机上收推送、点按钮，可以在设置里接上。")}</span>
      <Button asChild size="sm" variant="outline">
        <a href="/ui/?view=settings&tab=notifications">{tr("去设置")}</a>
      </Button>
    </Alert>
  );
}

export function App() {
  const requested = new URLSearchParams(location.search).get("view");
  const view: View = requested === "workspace" || requested === "settings" ? requested : "strategies";
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5_000 });
  const update = useQuery({
    queryKey: ["update"], queryFn: api.updateStatus, enabled: !!overview.data && view === "settings", refetchInterval: 5_000,
  });
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => location.reload() });
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [manage, setManage] = React.useState<StrategyView | null>();
  const [updatedFrom, setUpdatedFrom] = React.useState<string>();
  const version = update.data?.version;
  React.useEffect(() => {
    if (updatedFrom && version && version !== updatedFrom) location.reload();
  }, [updatedFrom, version]);
  if (overview.error instanceof ApiError && overview.error.status === 401) return <Login />;
  const strategies = overview.data?.strategies ?? [];
  const online = strategies.filter((s) => s.online).length;
  return (
    <>
      <TopBar onLogout={() => logout.mutate()} view={overview.data ? view : undefined} />
      {promptOpen && <AiPromptDialog open onOpenChange={setPromptOpen} />}
      {manage !== undefined && <StrategyAdminDialog strategy={manage ?? undefined} onClose={() => setManage(undefined)} />}
      <main className="view-enter mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8">
        {view === "settings" ? (
          <QueryBoundary query={overview}>
            {() => <SettingsPage update={update.data} onInstalled={setUpdatedFrom} />}
          </QueryBoundary>
        ) : view === "workspace" ? (
          <>
            <PageHeader title={tr("工作区")} />
            <QueryBoundary query={overview}>
              {(data) => data.editor_enabled ? (
                <React.Suspense fallback={<LoadingState />}>
                  <WorkspaceEditor managed={data.workspace_managed} />
                </React.Suspense>
              ) : (
                <Card className="p-5">
                  <EmptyState icon={FolderCode} title={tr("设置工作区")}
                    description={tr("在运行 QuantBot 的服务器上选定目录后，即可在这里编辑代码并绑定 GitHub。")} />
                  <pre className="mx-auto max-w-fit overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">
                    quantbot workspace init
                  </pre>
                </Card>
              )}
            </QueryBoundary>
          </>
        ) : <>
          <PageHeader
            title={tr("策略")}
            description={overview.data ? tr("{0} 个策略，{1} 个在线 · 每 5 秒刷新", strategies.length, online) : undefined}
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setManage(null)}><Plus /> {tr("添加策略")}</Button>
                <Button variant="outline" onClick={() => setPromptOpen(true)}>
                  <Sparkles /> {tr("让 AI 接入策略")}</Button>
                <PauseAll count={online} />
              </div>
            }
          />
          <QueryBoundary query={overview} rows={4}>
            {(data) => (
              <div className="grid gap-8">
                <TelegramNote />
                {data.strategies.length === 0 ? (
                  <Card>
                    <EmptyState title={tr("还没有策略")}
                      description={tr("可以先在工作区绑定 GitHub 并准备代码，或添加策略获取连接令牌。")} />
                  </Card>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {data.strategies.map((s) => <StrategyCard key={s.id} s={s} onManage={() => setManage(s)} />)}
                  </div>
                )}
                <Tabs defaultValue="feed">
                  <TabsList>
                    <TabsTrigger value="feed">{tr("推送")}</TabsTrigger>
                    <TabsTrigger value="audit">{tr("操作记录")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="feed">
                    <Card><Feed items={data.feed} /></Card>
                  </TabsContent>
                  <TabsContent value="audit">
                    <Card className="py-2"><AuditLog /></Card>
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </QueryBoundary>
        </>}
      </main>
    </>
  );
}
