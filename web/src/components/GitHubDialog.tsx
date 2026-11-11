import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input } from "@/components/ui/primitives";
import { api, type GitHubAuthorization, type GitHubStatus } from "@/lib/api";

type SyncAction = "pull" | "push" | "unbind";
const labels = { pull: "拉取提交", push: "推送已有提交", unbind: "解除绑定" };
const confirmText = {
  pull: "将 GitHub 上的新提交同步到编辑目录。拉取只在本地工作区干净、分支可以快进时执行。",
  push: "将当前分支的已有提交推送到 GitHub。网页里保存的文件需要在服务器上提交后才能推送。",
  unbind: "从 QuantBot 移除这个仓库的授权凭据。",
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
  const [branch, setBranch] = useState("");
  const [clientId, setClientId] = useState("");
  const [authorization, setAuthorization] = useState<GitHubAuthorization>();
  const [confirm, setConfirm] = useState<SyncAction>();
  const [error, setError] = useState("");
  const showError = (err: Error) => setError(err.message);
  const update = (data: GitHubStatus) => qc.setQueryData(queryKey, data);

  const bind = useMutation({
    mutationFn: api.githubBind,
    onSuccess: setAuthorization,
    onError: showError,
  });
  const { mutate: poll, isPending: polling } = useMutation({
    mutationFn: api.githubAuthorize,
    onSuccess: (answer) => {
      if (!answer.status) {
        setAuthorization((current) => current && { ...current, interval: answer.interval ?? current.interval });
        return;
      }
      update(answer.status);
      setAuthorization(undefined);
      setBinding(false);
      onChanged();
      toast.success("GitHub 已绑定。");
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
      toast.success(action === "check" ? "已检查远端状态。" : `${labels[action]}完成。`);
    },
    onError: showError,
    onSettled: () => setConfirm(undefined),
  });
  const busy = bind.isPending || sync.isPending || polling;
  return (
    <>
      <Dialog open onOpenChange={() => { if (!busy) onClose(); }}>
        <DialogContent title="GitHub 仓库" className="max-w-lg">
          <QueryBoundary query={status}>
            {(data) => authorization ? (
              <div className="grid gap-4">
                <p className="text-sm text-muted-foreground">打开 GitHub，输入验证码并授权访问仓库。</p>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
                  <code className="select-all font-mono text-lg tracking-widest">{authorization.code}</code>
                  <Button asChild variant="outline" size="sm">
                    <a href={authorization.url} target="_blank" rel="noreferrer"><ExternalLink /> 打开 GitHub</a>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground" role="status">等待 GitHub 授权…</p>
              </div>
            ) : binding || !data.bound ? (
              <form className="grid gap-3" onSubmit={(event) => {
                event.preventDefault();
                setError("");
                bind.mutate({ repo, branch, client_id: clientId });
              }}>
                <Field label="仓库" htmlFor="github-repo" hint="填写 owner/repo 或 GitHub 仓库地址。">
                  <Input id="github-repo" value={repo} onChange={(e) => setRepo(e.target.value)} required />
                </Field>
                <Field label="分支" htmlFor="github-branch" hint="留空使用本地分支或仓库默认分支。">
                  <Input id="github-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
                </Field>
                <Field label="GitHub App Client ID" htmlFor="github-client"
                  hint="在 GitHub App 设置中启用设备授权，并将 App 安装到策略仓库。">
                  <Input id="github-client" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
                </Field>
                <p className="text-xs text-muted-foreground">编辑目录为空时，授权后会将仓库克隆到该目录。</p>
                {error && <Alert tone="loss">{error}</Alert>}
                <DialogFooter>
                  {data.bound && <Button type="button" variant="outline" onClick={() => { setBinding(false); setError(""); }}>返回</Button>}
                  <Button type="submit" loading={bind.isPending}><GitBranch /> 开始 GitHub 授权</Button>
                </DialogFooter>
              </form>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-1 rounded-lg border bg-card p-3 text-sm">
                  <a className="inline-flex w-fit items-center gap-2 break-all font-medium hover:underline"
                    href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">
                    {data.repo} <ExternalLink className="size-3 shrink-0" />
                  </a>
                  <span className="font-mono text-xs text-muted-foreground">{data.branch}</span>
                  {!data.error && (
                    <span className="text-xs text-muted-foreground">
                      领先 {data.ahead} 个提交 · 落后 {data.behind} 个提交
                    </span>
                  )}
                </div>
                {(dirty || data.dirty) && <Alert tone="warning">本地有未提交的改动，处理后可以拉取。</Alert>}
                {(error || data.error) && <Alert tone="loss">{error || data.error}</Alert>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={busy || !!data.error}
                    onClick={() => { setError(""); sync.mutate("check"); }}><RefreshCw /> 检查远端</Button>
                  <Button variant="outline" size="sm" disabled={busy || dirty || !!data.dirty || !!data.error}
                    onClick={() => setConfirm("pull")}><ArrowDownToLine /> 拉取</Button>
                  <Button variant="outline" size="sm" disabled={busy || !!data.error}
                    onClick={() => setConfirm("push")}><ArrowUpFromLine /> 推送</Button>
                </div>
                <DialogFooter>
                  <Button variant="ghost" className="text-loss sm:mr-auto" disabled={busy} onClick={() => setConfirm("unbind")}>
                    解除绑定
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => {
                    setRepo(data.repo || "");
                    setBranch(data.branch || "");
                    setClientId(data.client_id || "");
                    setError("");
                    setBinding(true);
                  }}>重新绑定</Button>
                </DialogFooter>
              </div>
            )}
          </QueryBoundary>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(undefined); }}
        title={confirm ? labels[confirm] : "同步 GitHub"} description={confirm && confirmText[confirm]}
        confirmLabel={confirm ? labels[confirm] : "确认"} destructive={confirm === "unbind"} loading={busy}
        onConfirm={() => {
          if (confirm) { setError(""); sync.mutate(confirm); }
        }} />
    </>
  );
}
