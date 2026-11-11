/** The Telegram link and notice settings, the same ones `quantbot setup` asks for. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { AccountDialog } from "@/components/AccountDialog";
import { QueryBoundary } from "@/components/common";
import { ServiceDialog } from "@/components/ServiceDialog";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input } from "@/components/ui/primitives";
import { api, type Settings } from "@/lib/api";

export function SettingsDialog({ open, onOpenChange, version, onVersion }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
  onVersion: () => void;
}) {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: open });
  const [accountOpen, setAccountOpen] = React.useState(false);
  const [serviceOpen, setServiceOpen] = React.useState(false);
  const username = settings.data?.admin_username;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置" className="max-w-lg"
        description="Telegram 可以不接，只用网页。保存后 QuantBot 会自己重启一下。">
        <div className="divide-y divide-border rounded-lg border bg-card px-3 text-sm">
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span>版本</span>
            <Button variant="ghost" size="sm" className="font-mono" onClick={onVersion}>
              {version || "查看版本"}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span>网页管理员</span>
            <Button variant="ghost" size="sm" disabled={username === undefined} onClick={() => setAccountOpen(true)}>
              {username ? `${username} · 修改密码` : "设置管理员"}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span>后台服务</span>
            <Button variant="ghost" size="sm" onClick={() => setServiceOpen(true)}>状态与日志</Button>
          </div>
        </div>
        <QueryBoundary query={settings}>
          {({ admin_username, ...data }) => (
            <SettingsForm key={JSON.stringify(data)} data={data} onDone={() => onOpenChange(false)} />
          )}
        </QueryBoundary>
      </DialogContent>
      {accountOpen && username !== undefined && <AccountDialog username={username} onClose={() => setAccountOpen(false)} />}
      {serviceOpen && <ServiceDialog onClose={() => setServiceOpen(false)} />}
    </Dialog>
  );
}

function SettingsForm({ data, onDone }: { data: Omit<Settings, "admin_username">; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [token, setToken] = React.useState("");
  const [owner, setOwner] = React.useState(data.owner_id === null ? "" : String(data.owner_id));
  const [quiet, setQuiet] = React.useState(data.quiet_hours);
  const [timezone, setTimezone] = React.useState(data.timezone);
  const [heartbeat, setHeartbeat] = React.useState(data.heartbeat_url);
  const [error, setError] = React.useState<string | null>(null);

  const changes: Record<string, unknown> = {};
  if (token.trim()) changes.token = token.trim();
  if (owner.trim() !== String(data.owner_id ?? "")) changes.owner_id = owner.trim();
  if (quiet.trim() !== data.quiet_hours) changes.quiet_hours = quiet.trim();
  if (timezone.trim() !== data.timezone) changes.timezone = timezone.trim();
  if (heartbeat.trim() !== data.heartbeat_url) changes.heartbeat_url = heartbeat.trim();
  const changed = Object.keys(changes).length > 0;
  const linkChanged = "token" in changes || "owner_id" in changes;

  const save = useMutation({
    mutationFn: (remove: boolean) => api.saveSettings(remove ? { remove_telegram: true } : changes),
    onSuccess: (answer) => {
      if (!answer.ok) return setError(answer.message);
      toast.success(answer.message);
      void qc.invalidateQueries({ queryKey: ["settings"] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <form className="grid gap-4" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      if (changed) save.mutate(false);
    }}>
      <dl className="grid gap-1 rounded-lg border bg-card px-3 py-2 text-sm">
        <dt className="font-medium">{data.public_url ? "网页地址" : "监听地址"}</dt>
        <dd className="break-all font-mono text-xs">{data.public_url ? `${data.public_url}/ui/` : data.listen}</dd>
        <dd className="text-xs text-muted-foreground">在服务器上运行 quantbot setup 修改。</dd>
      </dl>
      <h4 className="text-sm font-medium">
        Telegram {data.telegram ? `· 已接 @${data.bot_username || "bot"}` : "· 没接"}
      </h4>
      {!data.telegram && (
        <p className="-mt-2 text-xs text-muted-foreground">
          想在手机上收推送、点按钮：在 @BotFather 发 /newbot 建一个 bot，用你的账号给它发一条消息，再填下面两项。
        </p>
      )}
      <Field label="Bot token" htmlFor="st"
        hint={data.telegram ? "留空不改。" : "例如 123456789:AAH..."}>
        <Input id="st" type="password" autoComplete="off" value={token} placeholder="123456789:AAH..."
          onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="主人的 Telegram id" htmlFor="so"
        hint={data.owner_name ? `现在是 ${data.owner_name}。只有这个账号能用 bot。` : "只有这个账号能用 bot。可以向 @userinfobot 查询。"}>
        <Input id="so" inputMode="numeric" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="静音时段" htmlFor="sq" hint="例如 23-07。留空不设。">
          <Input id="sq" value={quiet} disabled={!data.telegram && !token} placeholder="23-07" onChange={(e) => setQuiet(e.target.value)} />
        </Field>
        <Field label="时区" htmlFor="sz">
          <Input id="sz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
      </div>
      <Field label="心跳地址" htmlFor="sh" hint="Healthchecks.io 的 ping 地址。留空不设。">
        <Input id="sh" value={heartbeat} placeholder="https://hc-ping.com/..." onChange={(e) => setHeartbeat(e.target.value)} />
      </Field>
      {linkChanged && (
        <Alert tone="warning">
          换 bot 或主人前，先用新账号给新 bot 发一条消息。保存时会发一条测试消息，发不出去就不保存。
        </Alert>
      )}
      {error && <Alert tone="loss">{error}</Alert>}
      <DialogFooter className="sm:items-center">
        {data.telegram && (
          <Button type="button" variant="ghost" className="text-loss sm:mr-auto"
            disabled={save.isPending} onClick={() => { setError(null); save.mutate(true); }}>
            断开 Telegram
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onDone}>取消</Button>
        <Button type="submit" disabled={!changed} loading={save.isPending && save.variables === false}>保存</Button>
      </DialogFooter>
    </form>
  );
}
