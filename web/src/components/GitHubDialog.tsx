import { tr } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitBranch, GitCommitHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { api, type GitHubAuthorization, type GitHubStatus } from "@/lib/api";

type SyncAction = "pull" | "push" | "unbind";
const labels = { pull: tr("拉取提交"), push: tr("推送已有提交"), unbind: tr("解除绑定") };
const confirmText = {
  pull: tr("将 GitHub 上的新提交同步到编辑目录。拉取只在本地工作区干净、分支可以快进时执行。"),
  push: tr("将当前分支的已有提交推送到 GitHub。保存的文件可以在「本地改动」中提交。"),
  unbind: tr("从 QuantBot 移除这个仓库的授权凭据。"),
};

export function GitHubDialog({ dirty, onClose, onChanged }: {
  dirty: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const queryKey = ["editor", "github"];
  const status = useQuery({ queryKey, queryFn: api.githubStatus, retry: false });
  const [binding, setBinding] = useState(false);
  const [repo, setRepo] = useState("");
  const [grant, setGrant] = useState("");
  const [authorization, setAuthorization] = useState<GitHubAuthorization>();
  const [confirm, setConfirm] = useState<SyncAction>();
  const [error, setError] = useState("");
  const showError = (err: Error) => setError(err.message);
  const update = (data: GitHubStatus) => qc.setQueryData<GitHubStatus>(queryKey, (current) => ({ ...current, ...data }));
  const repositories = useQuery({
    queryKey: ["editor", "github-repositories", grant],
    queryFn: () => api.githubRepositories(grant),
    enabled: !!grant,
    retry: false,
  });
  const select = useMutation({
    mutationFn: () => api.githubSelect(grant, repo),
    onSuccess: ({ status: data }) => {
      update(data);
      setGrant("");
      setRepo("");
      setBinding(false);
      onChanged();
      toast.success(tr("GitHub 已绑定。"));
    },
    onError: showError,
  });

  const bind = useMutation({
    mutationFn: api.githubBind,
    onSuccess: setAuthorization,
    onError: showError,
  });
  const { mutate: poll, isPending: polling } = useMutation({
    mutationFn: api.githubAuthorize,
    onSuccess: (answer) => {
      if (answer.ready && authorization) {
        setGrant(authorization.state);
        setAuthorization(undefined);
      } else {
        setAuthorization((current) => current && { ...current, interval: answer.interval ?? current.interval });
      }
    },
    onError: (err) => { setAuthorization(undefined); showError(err); },
  });
  useEffect(() => {
    if (!authorization) return;
    const timer = window.setTimeout(() => poll(authorization.state), authorization.interval * 1000);
    return () => window.clearTimeout(timer);
  }, [authorization, poll]);

  const sync = useMutation({
    mutationFn: api.githubSync,
    onSuccess: ({ status }, action) => {
      update(status);
      if (action === "pull") onChanged();
      toast.success(action === "check" ? tr("已检查远端状态。") : tr("{0}完成。", labels[action]));
    },
    onError: showError,
    onSettled: () => setConfirm(undefined),
  });
  const busy = bind.isPending || sync.isPending || polling || select.isPending;
  return (
    <>
      <Dialog open onOpenChange={() => { if (!busy) onClose(); }}>
        <DialogContent title="Git" className="max-w-lg">
          <Tabs defaultValue="remote">
            <TabsList>
              <TabsTrigger value="remote">{tr("GitHub 仓库")}</TabsTrigger>
              <TabsTrigger value="local" disabled={busy || !!authorization || !!grant}>{tr("本地改动")}</TabsTrigger>
            </TabsList>
            <TabsContent value="remote">
          <QueryBoundary query={status}>
            {(data) => authorization ? (
              <div className="grid gap-4">
                <p className="text-sm text-muted-foreground">{tr("打开 GitHub，输入验证码并授权访问仓库。")}</p>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
                  <code className="select-all font-mono text-lg tracking-widest">{authorization.code}</code>
                  <Button asChild variant="outline" size="sm">
                    <a href={authorization.url} target="_blank" rel="noreferrer"><ExternalLink /> {tr("打开 GitHub")}</a>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground" role="status">{tr("等待 GitHub 授权…")}</p>
              </div>
            ) : grant ? (
              <div className="grid gap-3">
                <QueryBoundary query={repositories}>
                  {({ repositories: items }) => items.length ? (
                    <form className="grid gap-3" onSubmit={(event) => {
                      event.preventDefault();
                      if (repo) { setError(""); select.mutate(); }
                    }}>
                      <Field label={tr("选择仓库")} htmlFor="github-repository">
                        <Select id="github-repository" value={repo} disabled={busy}
                          onChange={(event) => setRepo(event.target.value)} required>
                          <option value="">{tr("选择已授权的仓库")}</option>
                          {items.map((item) => <option key={item.name} value={item.name}>
                            {item.name}{item.private ? ` · ${tr("私有")}` : ""}
                          </option>)}
                        </Select>
                      </Field>
                      <DialogFooter>
                        <Button type="submit" disabled={!repo} loading={select.isPending}>{tr("绑定仓库")}</Button>
                      </DialogFooter>
                    </form>
                  ) : <Alert tone="info">{tr("GitHub 没有返回可用仓库。请将应用安装到目标仓库。")}</Alert>}
                </QueryBoundary>
                <div className="flex flex-wrap gap-2">
                  {data.app_slug && <GitHubInstall slug={data.app_slug} />}
                  <Button size="sm" variant="ghost" disabled={busy} loading={repositories.isFetching}
                    onClick={() => void repositories.refetch()}><RefreshCw /> {tr("刷新仓库列表")}</Button>
                </div>
                {error && <Alert tone="loss">{error}</Alert>}
              </div>
            ) : binding || !data.bound ? (
              <GitHubConnect data={data} busy={bind.isPending} error={error}
                onConnect={() => { setError(""); bind.mutate(); }}
                onCancel={data.bound ? () => { setBinding(false); setError(""); } : undefined}
                onConfigured={() => { setError(""); void status.refetch(); }} />
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-1 rounded-lg border bg-card p-3 text-sm">
                  <a className="inline-flex w-fit items-center gap-2 break-all font-medium hover:underline"
                    href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">
                    {data.repo} <ExternalLink className="size-3 shrink-0" />
                  </a>
                  <span className="font-mono text-xs text-muted-foreground">{data.branch}</span>
                  {!data.error && (
                    <span className="text-xs text-muted-foreground">{tr("领先")} {data.ahead} {tr("个提交 · 落后")} {data.behind} {tr("个提交")}</span>
                  )}
                </div>
                {(dirty || data.dirty) && <Alert tone="warning">{tr("本地有未提交的改动，处理后可以拉取。")}</Alert>}
                {(error || data.error) && <Alert tone="loss">{error || data.error}</Alert>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={busy || !!data.error}
                    onClick={() => { setError(""); sync.mutate("check"); }}><RefreshCw /> {tr("检查远端")}</Button>
                  <Button variant="outline" size="sm" disabled={busy || dirty || !!data.dirty || !!data.error}
                    onClick={() => setConfirm("pull")}><ArrowDownToLine /> {tr("拉取")}</Button>
                  <Button variant="outline" size="sm" disabled={busy || !!data.error}
                    onClick={() => setConfirm("push")}><ArrowUpFromLine /> {tr("推送")}</Button>
                </div>
                <DialogFooter>
                  <Button variant="ghost" className="text-loss sm:mr-auto" disabled={busy} onClick={() => setConfirm("unbind")}>{tr("解除绑定")}</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => {
                    setError("");
                    setBinding(true);
                  }}>{tr("重新绑定")}</Button>
                </DialogFooter>
              </div>
            )}
          </QueryBoundary>
            </TabsContent>
            <TabsContent value="local"><LocalGitChanges unsaved={dirty} /></TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(undefined); }}
        title={confirm ? labels[confirm] : tr("同步 GitHub")} description={confirm && confirmText[confirm]}
        confirmLabel={confirm ? labels[confirm] : tr("确认")} destructive={confirm === "unbind"} loading={busy}
        onConfirm={() => {
          if (confirm) { setError(""); sync.mutate(confirm); }
        }} />
    </>
  );
}

function GitHubInstall({ slug }: { slug: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={`https://github.com/apps/${slug}/installations/new`} target="_blank" rel="noreferrer">
        <ExternalLink /> {tr("在 GitHub 选择授权仓库")}
      </a>
    </Button>
  );
}

function GitHubConnect({ data, busy, error, onConnect, onCancel, onConfigured }: {
  data: GitHubStatus;
  busy: boolean;
  error: string;
  onConnect: () => void;
  onCancel?: () => void;
  onConfigured: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [slug, setSlug] = useState("");
  const fromSetup = new URLSearchParams(location.search).get("github") === "setup";
  const register = useMutation({
    mutationFn: api.githubRegister,
    onSuccess: ({ url, manifest }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = url;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(manifest);
      form.append(input);
      document.body.append(form);
      form.submit();
    },
  });
  const configure = useMutation({
    mutationFn: () => api.githubConfigure(clientId.trim(), slug.trim()),
    onSuccess: onConfigured,
  });
  return (
    <div className="grid gap-3">
      {!data.app_configured ? (
        <>
          <p className="text-sm text-muted-foreground">{tr("首次使用时，在 GitHub 创建 QuantBot 应用，并为策略仓库授权。")}</p>
          <Button className="w-fit" loading={register.isPending} onClick={() => register.mutate()}>
            <ExternalLink /> {tr("在 GitHub 创建应用")}
          </Button>
        </>
      ) : (
        <>
          {fromSetup && <Alert tone="info">{tr("应用已登记。请在 GitHub 应用设置中启用 Device Flow，再安装到目标仓库。")}</Alert>}
          <p className="text-sm text-muted-foreground">{tr("在 GitHub 输入一次性授权码后，回到这里选择仓库。")}</p>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={onConnect}><GitBranch /> {tr("连接 GitHub")}</Button>
            {data.app_slug && <GitHubInstall slug={data.app_slug} />}
            {data.app_slug && (fromSetup || !!error) && (
              <Button asChild size="sm" variant="outline">
                <a href={`https://github.com/settings/apps/${data.app_slug}`} target="_blank" rel="noreferrer">
                  <ExternalLink /> {tr("GitHub 应用设置")}
                </a>
              </Button>
            )}
          </div>
        </>
      )}
      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{tr("使用已有 GitHub 应用")}</summary>
        <form className="mt-3 grid gap-3" onSubmit={(event) => { event.preventDefault(); configure.mutate(); }}>
          <Field label="GitHub App Client ID" htmlFor="github-client">
            <Input id="github-client" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
          </Field>
          <Field label={tr("GitHub 应用名称")} htmlFor="github-slug" hint={tr("可填 github.com/apps/ 后的应用名称。")}>
            <Input id="github-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          <Button className="w-fit" variant="outline" size="sm" type="submit" loading={configure.isPending}>{tr("保存应用")}</Button>
        </form>
      </details>
      {(error || register.error || configure.error) && <Alert tone="loss">{error || register.error?.message || configure.error?.message}</Alert>}
      {onCancel && <Button variant="ghost" size="sm" className="w-fit" onClick={onCancel}>{tr("返回")}</Button>}
    </div>
  );
}

function LocalGitChanges({ unsaved }: { unsaved: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["editor", "git"], queryFn: api.gitStatus, retry: false });
  const [selection, setSelection] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const paths = selection.filter((path) => status.data?.files.some((file) => file.path === path));
  const commit = useMutation({
    mutationFn: () => api.gitCommit(paths, message),
    onSuccess: ({ revision }) => {
      setSelection([]);
      setMessage("");
      void qc.invalidateQueries({ queryKey: ["editor", "git"] });
      void qc.invalidateQueries({ queryKey: ["editor", "github"] });
      toast.success(tr("已提交 {0}。", revision));
    },
  });
  return (
    <QueryBoundary query={status}>
      {(data) => !data.repository ? (
        <p className="text-sm text-muted-foreground">{tr("工作区里还没有 Git 仓库。")}</p>
      ) : (
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); commit.mutate(); }}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 font-mono text-xs"><GitBranch className="size-4 shrink-0" /> <span className="truncate">{data.branch}</span></span>
            <Button type="button" variant="ghost" size="sm" loading={status.isFetching} onClick={() => void status.refetch()}>
              <RefreshCw /> {tr("刷新改动")}
            </Button>
          </div>
          {data.files.length ? (
            <ul className="max-h-52 divide-y overflow-auto rounded-lg border bg-card text-sm">
              {data.files.map((file) => (
                <li key={file.path}>
                  <label className="flex items-center gap-3 px-3 py-2">
                    <input type="checkbox" className="accent-primary" checked={selection.includes(file.path)}
                      onChange={(e) => setSelection(e.target.checked ? [...selection, file.path] : selection.filter((path) => path !== file.path))} />
                    <code className="text-xs text-muted-foreground">{file.status}</code>
                    <span className="min-w-0 break-all font-mono text-xs">{file.path}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">{tr("没有未提交的改动。")}</p>}
          {data.files.length > 0 && (
            <Field label={tr("提交说明")} htmlFor="git-message">
              <Input id="git-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} required />
            </Field>
          )}
          {unsaved && <Alert tone="warning">{tr("请先保存编辑器里的改动。")}</Alert>}
          {commit.error && <Alert tone="loss">{commit.error.message}</Alert>}
          <DialogFooter>
            <Button type="submit" loading={commit.isPending} disabled={!paths.length || !message.trim() || unsaved}>
              <GitCommitHorizontal /> {tr("提交所选文件")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </QueryBoundary>
  );
}
