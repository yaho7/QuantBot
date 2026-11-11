import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, CircleDashed, Download, FileCode, LogOut, Monitor, Moon, Pause, Plus, Radio, Settings, Sparkles, Sun,
} from "lucide-react";
import * as React from "react";
import { AiPromptDialog } from "@/components/AiPromptDialog";
import { BrandIcon } from "@/components/BrandIcon";
import { ConfirmDialog, EmptyState, PageHeader, QueryBoundary } from "@/components/common";
import { SettingsDialog } from "@/components/SettingsDialog";
import { StrategyAdminDialog } from "@/components/StrategyAdminDialog";
import { PauseButton, StrategyPanel } from "@/components/StrategyPanel";
import { UpdateDialog } from "@/components/UpdateDialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
const THEME_LABEL = { light: "浅色", dark: "深色", system: "跟随系统" };

const KIND_TONE = { info: "neutral", trade: "info", alert: "warning", error: "loss" } as const;
const KIND_LABEL = { info: "消息", trade: "成交", alert: "提醒", error: "报错" };
const EditorDialog = React.lazy(() => import("@/components/EditorDialog"));

function TopBar({ onLogout, onSettings, onUpdate }: {
  onLogout?: () => void;
  onSettings?: () => void;
  onUpdate?: () => void;
}) {
  const [theme, setTheme] = useTheme();
  const ThemeIcon = THEME_ICON[theme];
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-5 pt-6 sm:px-8">
      <div className="flex items-center gap-2">
        <BrandIcon className="size-6" />
        <span className="font-display text-lg">QuantBot</span>
      </div>
      <div className="flex items-center gap-1">
        {onUpdate && (
          <Button variant="outline" size="sm" className="text-warning" onClick={onUpdate}>
            <Download /> 有新版本
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => setTheme(NEXT_THEME[theme])}
          aria-label={`主题：${THEME_LABEL[theme]}`} title={`主题：${THEME_LABEL[theme]}`}>
          <ThemeIcon />
        </Button>
        {onSettings && (
          <Button variant="ghost" size="icon" onClick={onSettings} aria-label="设置" title="设置">
            <Settings />
          </Button>
        )}
        {onLogout && (
          <Button variant="ghost" size="icon" onClick={onLogout} aria-label="退出登录" title="退出登录">
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
        <h1 className="font-display text-3xl font-medium">登录 QuantBot</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">用安装时设的管理员账号登录。</p>
        <Card className="p-5">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
            <Field label="用户名" htmlFor="u">
              <Input id="u" autoComplete="username" value={username} autoFocus required
                onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="密码" htmlFor="p">
              <Input id="p" type="password" autoComplete="current-password" value={password} required
                onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {failed && <Alert tone="loss">{failed}</Alert>}
            <Button type="submit" loading={login.isPending}>登录</Button>
          </form>
        </Card>
        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
          忘了密码：在服务器上运行 <code className={code}>quantbot password</code>。
          也可以运行 <code className={code}>quantbot web</code>，或给 bot 发 <code className={code}>/web</code>，
          拿一个不用密码的一次性链接。
        </p>
      </main>
    </>
  );
}

function OnlineBadge({ s }: { s: StrategyView }) {
  if (s.online) return <Badge tone="gain"><Radio /> 在线</Badge>;
  if (!s.connected && s.last_seen === null) return <Badge><CircleDashed /> 还没连上过</Badge>;
  return <Badge tone="loss">离线</Badge>;
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
          {s.paused && <Badge tone="warning">已暂停开仓</Badge>}
          <OnlineBadge s={s} />
        </div>
      </CardHeader>
      <CardContent>
        {s.status ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{s.status}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {s.connected ? "还没有报状态。" : "在策略项目里运行 quantbot link，接上后就会出现在这里。"}
          </p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          状态 {ago(s.status_age)} · 最后联系 {ago(s.last_seen)}
          {s.pending > 0 && ` · ${s.pending} 个命令在排队`}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <PauseButton s={s} />
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            更多操作 <ChevronRight />
          </Button>
          <Button size="sm" variant="ghost" onClick={onManage}>管理</Button>
        </div>
      </CardContent>
      {open && <StrategyPanel s={s} open onOpenChange={setOpen} />}
    </Card>
  );
}

function Feed({ items }: { items: Notice[] }) {
  if (!items.length) return <EmptyState title="还没有推送" description="QuantBot 这次启动后发出的消息会显示在这里。" />;
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
          <EmptyState title="还没有操作记录" description="在网页或 Telegram 里点过的按钮会记在这里。" />
        ) : (
          <Table>
            <thead>
              <tr><Th>时间</Th><Th>操作</Th><Th>策略</Th><Th>从哪</Th><Th>结果</Th></tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.time}-${i}`}>
                  <Td className="num text-xs text-muted-foreground">{dateTime(r.time)}</Td>
                  <Td>{actionLabel(r.action)}</Td>
                  <Td className="font-mono text-xs">{r.strategy ?? r.strategies?.join(", ") ?? NA}</Td>
                  <Td className="text-xs">{r.user === "web" ? "网页" : r.user === "cli" ? "终端" : r.user ? "Telegram" : NA}</Td>
                  <Td className="max-w-md whitespace-normal text-xs">
                    {r.ok === false && <Badge tone="loss" className="mr-2">失败</Badge>}
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
        <Pause /> 全部暂停开仓
      </Button>
      <ConfirmDialog open={asking} onOpenChange={setAsking} title="全部暂停开仓？"
        description={`${count} 个在线策略都不再开新仓。已有仓位和止损照常。`}
        confirmLabel="全部暂停" loading={pause.isPending} onConfirm={() => pause.mutate()} />
    </>
  );
}

function TelegramNote({ onSettings }: { onSettings: () => void }) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  if (!settings.data || settings.data.telegram) return null;
  return (
    <Alert tone="info" className="items-center justify-between">
      <span>Telegram 没接，推送只显示在这个网页上。想在手机上收推送、点按钮，可以在设置里接上。</span>
      <Button size="sm" variant="outline" onClick={onSettings}>去设置</Button>
    </Alert>
  );
}

export function App() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5_000 });
  const update = useQuery({
    queryKey: ["update"], queryFn: api.updateStatus, enabled: !!overview.data, refetchInterval: 5_000,
  });
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => location.reload() });
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [manage, setManage] = React.useState<StrategyView | null>();
  const [updatedFrom, setUpdatedFrom] = React.useState<string>();
  const version = update.data?.version;
  React.useEffect(() => {
    if (updatedFrom && version && version !== updatedFrom && !editorOpen) location.reload();
  }, [updatedFrom, version, editorOpen]);
  if (overview.error instanceof ApiError && overview.error.status === 401) return <Login />;
  const strategies = overview.data?.strategies ?? [];
  const online = strategies.filter((s) => s.online).length;
  return (
    <>
      <TopBar onLogout={() => logout.mutate()} onSettings={() => setSettingsOpen(true)}
        onUpdate={update.data?.result?.available && !update.data.updated ? () => setUpdateOpen(true) : undefined} />
      {settingsOpen && <SettingsDialog open onOpenChange={setSettingsOpen} version={version}
        onVersion={() => { setSettingsOpen(false); setUpdateOpen(true); }} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} onInstalled={setUpdatedFrom} />}
      {promptOpen && <AiPromptDialog open onOpenChange={setPromptOpen} />}
      {manage !== undefined && <StrategyAdminDialog strategy={manage ?? undefined} onClose={() => setManage(undefined)} />}
      {editorOpen && (
        <React.Suspense fallback={
          <Dialog open onOpenChange={setEditorOpen}>
            <DialogContent title="策略编辑器"><p className="text-sm text-muted-foreground">加载中…</p></DialogContent>
          </Dialog>
        }>
          <EditorDialog onClose={() => setEditorOpen(false)} />
        </React.Suspense>
      )}
      <main className="view-enter mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-8">
        <PageHeader
          title="策略"
          description={overview.data ? `${strategies.length} 个策略，${online} 个在线 · 每 5 秒刷新` : undefined}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setManage(null)}><Plus /> 添加策略</Button>
              {overview.data?.editor_enabled && (
                <Button variant="outline" onClick={() => setEditorOpen(true)}>
                  <FileCode /> 策略编辑器
                </Button>
              )}
              <Button variant="outline" onClick={() => setPromptOpen(true)}>
                <Sparkles /> 让 AI 接入策略
              </Button>
              <PauseAll count={online} />
            </div>
          }
        />
        <QueryBoundary query={overview} rows={4}>
          {(data) => (
            <div className="grid gap-8">
              <TelegramNote onSettings={() => setSettingsOpen(true)} />
              {data.strategies.length === 0 ? (
                <Card>
                  <EmptyState title="还没有策略"
                    description="添加策略可以生成连接令牌。也可以在策略项目里运行 quantbot link。" />
                </Card>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {data.strategies.map((s) => <StrategyCard key={s.id} s={s} onManage={() => setManage(s)} />)}
                </div>
              )}
              <Tabs defaultValue="feed">
                <TabsList>
                  <TabsTrigger value="feed">推送</TabsTrigger>
                  <TabsTrigger value="audit">操作记录</TabsTrigger>
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
      </main>
    </>
  );
}
