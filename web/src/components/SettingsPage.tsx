import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Globe, Languages, Radio, RefreshCw, Server, ShieldCheck, SlidersHorizontal, Wrench } from "lucide-react";
import { useState } from "react";
import { AccountDialog } from "@/components/AccountDialog";
import { PageHeader, QueryBoundary } from "@/components/common";
import { ServiceDialog } from "@/components/ServiceDialog";
import { UpdateDialog, updateLabel } from "@/components/UpdateDialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { api, type Settings, type UpdateStatus } from "@/lib/api";
import { tr, type Language } from "@/lib/i18n";

export function SettingsPage({ update, onInstalled }: { update?: UpdateStatus; onInstalled: (version: string) => void }) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [accountOpen, setAccountOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const initialTab = new URLSearchParams(location.search).get("tab");
  const latest = update?.result?.available && !update.updated ? updateLabel(update.result.latest) : null;
  const username = settings.data?.admin_username;

  return (
    <>
      <PageHeader title={tr("设置")} />
      <Tabs defaultValue={initialTab === "notifications" || initialTab === "maintenance" ? initialTab : "general"}
        onValueChange={(tab) => {
          const url = new URL(location.href);
          url.searchParams.set("tab", tab);
          history.replaceState(null, "", url);
        }}>
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="general" className="gap-1.5"><SlidersHorizontal className="size-3.5" /> {tr("常规")}</TabsTrigger>
          <TabsTrigger value="notifications" className="gap-1.5"><Radio className="size-3.5" /> {tr("通知")}</TabsTrigger>
          <TabsTrigger value="maintenance" className="gap-1.5"><Wrench className="size-3.5" /> {tr("维护")}</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <QueryBoundary query={settings}>
            {(data) => (
              <div className="grid gap-4 md:grid-cols-2">
                <LanguageCard key={data.language} initial={data.language} />
                <Card>
                  <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground" /> {tr("网页管理员")}</CardTitle></CardHeader>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <span className="break-all font-mono text-sm">{data.admin_username || tr("未设置")}</span>
                    <Button variant="outline" size="sm" onClick={() => setAccountOpen(true)}>
                      {data.admin_username ? tr("修改密码") : tr("设置管理员")}
                    </Button>
                  </CardContent>
                </Card>
                <Card className="md:col-span-2">
                  <CardHeader><CardTitle className="flex items-center gap-2"><Globe className="size-4 text-muted-foreground" /> {tr("访问地址")}</CardTitle></CardHeader>
                  <CardContent className="grid gap-2">
                    <code className="w-fit max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs">
                      {data.public_url ? `${data.public_url}/ui/` : data.listen}
                    </code>
                    <p className="text-xs text-muted-foreground">{tr("在服务器上运行 quantbot setup 修改。")}</p>
                  </CardContent>
                </Card>
              </div>
            )}
          </QueryBoundary>
        </TabsContent>
        <TabsContent value="notifications">
          <QueryBoundary query={settings}>
            {(data) => <Notifications key={JSON.stringify(data)} data={data} />}
          </QueryBoundary>
        </TabsContent>
        <TabsContent value="maintenance">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Download className="size-4 text-muted-foreground" /> {tr("版本更新")}</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-xs">{update?.version || tr("正在读取版本…")}</code>
                  {latest && <Badge tone="warning">{tr("有新版本 {0}", latest)}</Badge>}
                </div>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => setUpdateOpen(true)}>
                  {latest ? <Download /> : <RefreshCw />} {latest ? tr("查看更新") : tr("检查更新")}
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4 text-muted-foreground" /> {tr("后台服务")}</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                <p className="text-sm text-muted-foreground">{tr("查看 QuantBot 服务状态和最近日志。")}</p>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => setServiceOpen(true)}>
                  {tr("状态与日志")}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
      {accountOpen && username !== undefined && <AccountDialog username={username} onClose={() => setAccountOpen(false)} />}
      {serviceOpen && <ServiceDialog onClose={() => setServiceOpen(false)} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} checkOnOpen={!latest} onInstalled={onInstalled} />}
    </>
  );
}

function LanguageCard({ initial }: { initial: Language }) {
  const [language, setLanguage] = useState(initial);
  const save = useMutation({
    mutationFn: async () => {
      const answer = await api.saveSettings({ language });
      if (!answer.ok) throw new Error(answer.message);
    },
    onSuccess: () => location.reload(),
  });
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Languages className="size-4 text-muted-foreground" /> {tr("语言")}</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="min-w-32 flex-1" aria-label={tr("语言")} value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}>
              <option value="zh" lang="zh-CN">简体中文</option>
              <option value="en" lang="en">English</option>
            </Select>
            <Button type="submit" size="sm" disabled={language === initial} loading={save.isPending}>{tr("保存")}</Button>
          </div>
          {save.error && <Alert tone="loss">{save.error.message}</Alert>}
        </form>
      </CardContent>
    </Card>
  );
}

function Notifications({ data }: { data: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState(String(data.owner_id ?? ""));
  const [quiet, setQuiet] = useState(data.quiet_hours);
  const [timezone, setTimezone] = useState(data.timezone);
  const [heartbeat, setHeartbeat] = useState(data.heartbeat_url);
  const changes: Partial<Record<keyof Settings | "token", string>> = {};
  if (token.trim()) changes.token = token.trim();
  if (owner.trim() !== String(data.owner_id ?? "")) changes.owner_id = owner.trim();
  if (quiet.trim() !== data.quiet_hours) changes.quiet_hours = quiet.trim();
  if (timezone.trim() !== data.timezone) changes.timezone = timezone.trim();
  if (heartbeat.trim() !== data.heartbeat_url) changes.heartbeat_url = heartbeat.trim();
  const changed = Object.keys(changes).length > 0;
  const linkChanged = "token" in changes || "owner_id" in changes;
  const save = useMutation({
    mutationFn: async (body: Parameters<typeof api.saveSettings>[0]) => {
      const answer = await api.saveSettings(body);
      if (!answer.ok) throw new Error(answer.message);
      return answer.message;
    },
    onSuccess: (message) => {
      setToken("");
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (changed) save.mutate(changes); }}>
      <div className="grid items-start gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Telegram</CardTitle>
            <Badge tone={data.telegram ? "gain" : "neutral"}>
              {data.telegram ? `@${data.bot_username || "bot"}` : tr("未连接")}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Bot token" htmlFor="st" hint={data.telegram ? tr("留空不改。") : tr("例如 123456789:AAH...")}>
              <Input id="st" type="password" autoComplete="off" value={token} placeholder="123456789:AAH..."
                onChange={(event) => setToken(event.target.value)} />
            </Field>
            <Field label={tr("主人的 Telegram id")} htmlFor="so"
              hint={data.owner_name ? tr("现在是 {0}。只有这个账号能用 bot。", data.owner_name) : tr("只有这个账号能用 bot。可以向 @userinfobot 查询。")}>
              <Input id="so" inputMode="numeric" value={owner} onChange={(event) => setOwner(event.target.value)} />
            </Field>
            {!data.telegram && <p className="text-xs text-muted-foreground">{tr("想在手机上收推送、点按钮：在 @BotFather 发 /newbot 建一个 bot，用你的账号给它发一条消息，再填下面两项。")}</p>}
            {linkChanged && <Alert tone="warning">{tr("换 bot 或主人前，先用新账号给新 bot 发一条消息。保存时会发一条测试消息，发不出去就不保存。")}</Alert>}
            {data.telegram && (
              <Button type="button" size="sm" variant="ghost" className="w-fit text-loss"
                loading={save.isPending && !!save.variables?.remove_telegram} onClick={() => save.mutate({ remove_telegram: true })}>
                {tr("断开 Telegram")}
              </Button>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>{tr("通知时段")}</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Field label={tr("静音时段")} htmlFor="sq" hint={tr("例如 23-07。留空不设。")}>
                <Input id="sq" value={quiet} disabled={!data.telegram && !token} placeholder="23-07"
                  onChange={(event) => setQuiet(event.target.value)} />
              </Field>
              <Field label={tr("时区")} htmlFor="sz">
                <Input id="sz" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{tr("心跳")}</CardTitle></CardHeader>
            <CardContent>
              <Field label={tr("心跳地址")} htmlFor="sh" hint={tr("Healthchecks.io 的 ping 地址。留空不设。")}>
                <Input id="sh" value={heartbeat} placeholder="https://hc-ping.com/..."
                  onChange={(event) => setHeartbeat(event.target.value)} />
              </Field>
            </CardContent>
          </Card>
        </div>
      </div>
      {save.error && <Alert tone="loss">{save.error.message}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" disabled={!changed} loading={save.isPending && !save.variables?.remove_telegram}>{tr("保存通知设置")}</Button>
      </div>
    </form>
  );
}
