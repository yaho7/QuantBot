import { tr } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChartLine, ChevronRight, CircleDashed, FolderCode, LayoutGrid, LogOut, Pause, Plus, Radio, Settings, SlidersHorizontal, Sparkles, Zap,
} from "lucide-react";
import * as React from "react";
import { AiPromptDialog } from "@/components/AiPromptDialog";
import { BrandIcon } from "@/components/BrandIcon";
import { ConfirmDialog, LoadingState, PageHeader, QueryBoundary } from "@/components/common";
import { Quickstart } from "@/components/Quickstart";
import { SettingsPage } from "@/components/SettingsPage";
import { StrategyAdminDialog } from "@/components/StrategyAdminDialog";
import { PauseButton, StrategyPanel } from "@/components/StrategyPanel";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import {
  Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input,
} from "@/components/ui/primitives";
import { useTheme } from "@/hooks/useTheme";
import { api, ApiError, type StrategyView } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const StrategyTools = React.lazy(() => import("@/components/StrategyTools"));
const WorkspaceWorkbench = React.lazy(() => import("@/components/WorkspaceWorkbench"));
const pageFrame = "mx-auto max-w-6xl px-3 sm:px-8";

type View = "strategies" | "workspace" | "settings";

function TopBar({ onLogout, view, actions }: {
  onLogout?: () => void;
  view?: View;
  actions?: React.ReactNode;
}) {
  const navButton = "size-8 shrink-0 px-0 sm:w-auto sm:px-3";
  return (
    <header className={cn(pageFrame, "flex items-center gap-1 pt-6 sm:gap-3")}>
      <a href="/ui/" aria-label={tr("QuantBot 首页")} title={tr("QuantBot 首页")}
        className="flex shrink-0 items-center gap-2 rounded-md hover:text-primary focus-visible:outline focus-visible:outline-ring">
        <BrandIcon className="size-6" />
        <span className="hidden font-display text-lg min-[460px]:inline">QuantBot</span>
      </a>
      {view && (
        <nav aria-label={tr("主导航")} className="flex items-center gap-0.5 sm:gap-1">
          <Button asChild variant={view === "strategies" ? "secondary" : "ghost"} size="sm" className={navButton}>
            <a href="/ui/" aria-label={tr("策略")} title={tr("策略")}
              aria-current={view === "strategies" ? "page" : undefined}>
              <LayoutGrid /> <span className="hidden sm:inline">{tr("策略")}</span>
            </a>
          </Button>
          <Button asChild variant={view === "workspace" ? "secondary" : "ghost"} size="sm" className={navButton}>
            <a href="/ui/?view=workspace" aria-label={tr("工作区")} title={tr("工作区")}
              aria-current={view === "workspace" ? "page" : undefined}>
              <FolderCode /> <span className="hidden sm:inline">{tr("工作区")}</span>
            </a>
          </Button>
        </nav>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        {actions && <div className="flex items-center gap-0.5 sm:hidden">{actions}</div>}
        {view && (
          <Button asChild variant={view === "settings" ? "secondary" : "ghost"} size="icon" className="size-8">
            <a href="/ui/?view=settings" aria-current={view === "settings" ? "page" : undefined}
              aria-label={tr("设置")} title={tr("设置")}><Settings /></a>
          </Button>
        )}
        {onLogout && (
          <Button variant="ghost" size="icon" className="size-8" onClick={onLogout}
            aria-label={tr("退出登录")} title={tr("退出登录")}><LogOut /></Button>
        )}
      </div>
    </header>
  );
}

const code = "rounded bg-muted px-1.5 py-0.5 font-mono text-xs";
const overviewKey = ["overview"];

function needsLogin(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const login = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (answer) => {
      if (answer.ok) void qc.invalidateQueries({ queryKey: overviewKey });
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
  if (s.stopped) return <Badge>{tr("已停止")}</Badge>;
  if (!s.connected && s.last_seen === null) return <Badge><CircleDashed /> {tr("还没连上过")}</Badge>;
  return <Badge tone="loss">{tr("离线")}</Badge>;
}

function StrategyCard({ s, onManage }: { s: StrategyView; onManage: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [tools, setTools] = React.useState<"metrics" | "actions">();
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
          {!!s.metrics?.length && <Button size="sm" variant="outline" onClick={() => setTools("metrics")}>
            <ChartLine /> {tr("指标")}</Button>}
          {!!s.actions?.length && <Button size="sm" variant="outline" onClick={() => setTools("actions")}>
            <Zap /> {tr("策略操作")}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{tr("更多操作")} <ChevronRight />
          </Button>
          <Button size="sm" variant="ghost" onClick={onManage}><SlidersHorizontal /> {tr("管理")}</Button>
        </div>
      </CardContent>
      {open && <StrategyPanel s={s} open onOpenChange={setOpen} />}
      {tools && <React.Suspense fallback={null}>
        <StrategyTools strategy={s} mode={tools} onClose={() => setTools(undefined)} />
      </React.Suspense>}
    </Card>
  );
}

function PauseAll({ count, compact }: { count: number; compact: boolean }) {
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
      <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "default"}
        className={compact ? "size-8" : undefined} disabled={!count} onClick={() => setAsking(true)}
        aria-label={tr("全部暂停开仓")} title={tr("全部暂停开仓")}>
        <Pause /> {!compact && tr("全部暂停开仓")}</Button>
      <ConfirmDialog open={asking} onOpenChange={setAsking} title={tr("全部暂停开仓？")}
        description={tr("{0} 个在线策略都不再开新仓。已有仓位和止损照常。", count)}
        confirmLabel={tr("全部暂停")} loading={pause.isPending} onConfirm={() => pause.mutate()} />
    </>
  );
}

function StrategyActions({ compact = false, online, onAdd, onPrompt }: {
  compact?: boolean; online: number; onAdd: () => void; onPrompt: () => void;
}) {
  const size = compact ? "icon" : "default";
  const variant = compact ? "ghost" : "outline";
  const iconSize = compact ? "size-8" : undefined;
  return (
    <>
      <Button variant={variant} size={size} className={iconSize} onClick={onAdd}
        aria-label={tr("添加策略")} title={tr("添加策略")}><Plus /> {!compact && tr("添加策略")}</Button>
      <Button variant={variant} size={size} className={iconSize} onClick={onPrompt}
        aria-label={tr("让 AI 接入策略")} title={tr("让 AI 接入策略")}>
        <Sparkles /> {!compact && tr("让 AI 接入策略")}
      </Button>
      <PauseAll count={online} compact={compact} />
    </>
  );
}

function TelegramNote() {
  const key = "quantbot-hide-telegram-tip";
  const [dismissed, setDismissed] = React.useState(() => localStorage.getItem(key) === "1");
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000, enabled: !dismissed });
  if (dismissed || !settings.data || settings.data.telegram) return null;
  return (
    <Alert tone="info" className="flex-wrap items-center justify-between">
      <span>{tr("Telegram 没接，推送只显示在这个网页上。想在手机上收推送、点按钮，可以在设置里接上。")}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => {
          localStorage.setItem(key, "1");
          setDismissed(true);
        }}>{tr("不再显示")}</Button>
        <Button asChild size="sm" variant="outline">
          <a href="/ui/?view=settings&tab=notifications">{tr("去设置")}</a>
        </Button>
      </div>
    </Alert>
  );
}

export function App() {
  const [theme, setTheme] = useTheme();
  const requested = new URLSearchParams(location.search).get("view");
  const view: View = requested === "workspace" || requested === "settings" ? requested : "strategies";
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: api.overview,
    // A refetch without cached data clears the 401 while pending, which unmounts the login form.
    refetchInterval: (query) => needsLogin(query.state.error) ? false : 5_000,
    refetchOnWindowFocus: (query) => !needsLogin(query.state.error),
    refetchOnReconnect: (query) => !needsLogin(query.state.error),
  });
  const signedOut = needsLogin(overview.error);
  const update = useQuery({
    queryKey: ["update"], queryFn: api.updateStatus,
    enabled: !signedOut && !!overview.data && view === "settings", refetchInterval: 5_000,
  });
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => location.reload() });
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [manage, setManage] = React.useState<StrategyView | null>();
  const [updatedFrom, setUpdatedFrom] = React.useState<string>();
  const [quickstartProject, setQuickstartProject] = React.useState<string>();
  const quickstartRequested = new URLSearchParams(location.search).get("quickstart") === "1";
  const version = update.data?.version;
  React.useEffect(() => {
    if (updatedFrom && version && version !== updatedFrom) location.reload();
  }, [updatedFrom, version]);
  if (signedOut) return <Login />;
  const strategies = overview.data?.strategies ?? [];
  const online = strategies.filter((s) => s.online).length;
  const actions = { online, onAdd: () => setManage(null), onPrompt: () => setPromptOpen(true) };
  return (
    <>
      <TopBar onLogout={overview.data ? () => logout.mutate() : undefined} view={overview.data ? view : undefined}
        actions={overview.data && view === "strategies" ? <StrategyActions compact {...actions} /> : undefined} />
      {promptOpen && <AiPromptDialog open onOpenChange={setPromptOpen} />}
      {manage !== undefined && <StrategyAdminDialog strategy={manage ?? undefined} onClose={() => setManage(undefined)} />}
      <main className={cn(pageFrame, "view-enter pb-16 pt-10", view !== "workspace" && "px-5")}>
        {view === "settings" ? (
          <QueryBoundary query={overview}>
            {({ feed }) => <SettingsPage feed={feed} update={update.data} onInstalled={setUpdatedFrom} theme={theme} onTheme={setTheme} />}
          </QueryBoundary>
        ) : view === "workspace" ? (
          overview.data ? <React.Suspense fallback={<LoadingState />}><WorkspaceWorkbench /></React.Suspense>
            : <QueryBoundary query={overview}>{() => null}</QueryBoundary>
        ) : <>
          <PageHeader
            title={tr("策略")}
            description={overview.data ? tr("{0} 个策略，{1} 个在线 · 每 5 秒刷新", strategies.length, online) : undefined}
            actions={<div className="hidden flex-wrap gap-2 sm:flex"><StrategyActions {...actions} /></div>}
          />
          <QueryBoundary query={overview} rows={4}>
            {(data) => (
              <div className="grid gap-8">
                <TelegramNote />
                {quickstartProject && <Alert tone="info" className="flex-wrap items-center justify-between">
                  <span>{tr("模拟策略已启动。现在可以在这里或 Telegram 试用策略按钮。")}</span>
                  <Button size="sm" variant="outline" asChild>
                    <a href={`/ui/?view=workspace&workspace=${quickstartProject}`}>{tr("打开工作区")}</a>
                  </Button>
                </Alert>}
                {data.strategies.length > 0 && (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {data.strategies.map((s) => <StrategyCard key={s.id} s={s} onManage={() => setManage(s)} />)}
                  </div>
                )}
                <Quickstart visible={data.strategies.length === 0}
                  requested={quickstartRequested} onStarted={setQuickstartProject} />
              </div>
            )}
          </QueryBoundary>
        </>}
      </main>
    </>
  );
}
