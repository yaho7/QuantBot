import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Minus, Plus, RefreshCw } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useWorkspace } from "@/components/WorkspaceContext";
import { ConfirmDialog, LoadingState, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Alert, Input, Select } from "@/components/ui/primitives";
import { type GitAction, type LocalGitStatus } from "@/lib/api";
import { tr } from "@/lib/i18n";

const WorkspaceDiff = lazy(() => import("@/components/WorkspaceDiff"));

export function WorkspaceGit({ dirty, onConnect, onChanged }: {
  dirty: boolean; onConnect: () => void; onChanged: () => void;
}) {
  const { active, api, key: workspaceKey } = useWorkspace();
  const key = workspaceKey("git");
  const toast = useToast();
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [diff, setDiff] = useState<{ path: string; staged: boolean }>();
  const [confirm, setConfirm] = useState<"pull" | "push">();
  const status = useQuery({ queryKey: key, queryFn: api.gitStatus, enabled: active, retry: false });
  const branches = useQuery({
    queryKey: [...key, "branches"],
    queryFn: api.gitBranches,
    enabled: active && branchOpen,
    retry: false,
  });
  const difference = useQuery({
    queryKey: [...key, "diff", diff?.path, diff?.staged],
    queryFn: () => api.gitDiff(diff!.path, diff!.staged),
    enabled: active && !!diff,
    retry: false,
  });
  const change = useMutation({
    mutationFn: ({ action, paths, branch }: { action: GitAction; paths?: string[]; branch?: string }) =>
      api.gitAction(action, { paths, branch }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setConfirm(undefined);
      onChanged();
    },
    onError: (error) => toast.error(error.message),
  });
  const commit = useMutation({
    mutationFn: () => api.gitCommit([], message),
    onSuccess: ({ revision }) => {
      setMessage("");
      onChanged();
      toast.success(tr("已提交 {0}。", revision));
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = change.isPending || commit.isPending;
  const labels = { pull: tr("拉取"), push: tr("推送") };

  function files(data: LocalGitStatus, staged: boolean) {
    const items = data.files.filter(({ status }) => staged ? status[0] !== " " && status[0] !== "?" : status[1] !== " ");
    if (!items.length) return null;
    return (
      <section className="grid min-w-0 gap-0.5">
        <h3 className="px-1 py-1 text-xs font-medium text-muted-foreground">
          {staged ? tr("已暂存") : tr("未暂存")} · {items.length}
        </h3>
        {items.map(({ path, status }) => {
          const label = staged ? tr("取消暂存 {0}", path) : tr("暂存 {0}", path);
          return (
            <div className="flex items-center gap-0.5 rounded-md hover:bg-accent/60" key={path + status}>
              <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 py-1.5 text-left text-xs"
                title={path} onClick={() => setDiff({ path, staged })}>
                <span className="truncate">{path}</span>
                <code className="ml-auto text-muted-foreground">{status[staged ? 0 : 1]}</code>
              </button>
              <Button size="icon" className="size-7 shrink-0" variant="ghost" disabled={busy} aria-label={label} title={label}
                onClick={() => change.mutate({ action: staged ? "unstage" : "stage", paths: [path] })}>
                {staged ? <Minus /> : <Plus />}
              </Button>
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <div className="h-full space-y-2 overflow-y-auto p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">{tr("源代码管理")}</h2>
        <Button variant="ghost" size="sm" onClick={onConnect}>GitHub</Button>
      </div>
      <QueryBoundary query={status} rows={2}>
        {(data) => !data.repository ? (
          <div className="grid gap-2">
            <p className="px-1 text-xs text-muted-foreground">{tr("工作区里还没有 Git 仓库。")}</p>
            <Button variant="outline" size="sm" loading={change.isPending} onClick={() => change.mutate({ action: "init" })}>
              <GitBranch /> {tr("初始化 Git 仓库")}
            </Button>
          </div>
        ) : (() => {
          const ahead = data.ahead ?? 0;
          const behind = data.behind ?? 0;
          const unsaved = dirty || data.files.length > 0;
          const diverged = ahead > 0 && behind > 0;
          const branchReason = unsaved ? tr("请先提交或处理本地改动，再切换分支。") : "";
          const syncReason = !data.branch ? tr("请先选择分支，再同步远端。")
            : diverged ? tr("本地与远端分支已分叉。请在终端合并后再同步。")
            : behind > 0 ? tr("先拉取远端提交，再推送。") : "";
          const pullReason = diverged || !data.branch ? syncReason
            : unsaved ? tr("请先保存并处理本地改动，再拉取。")
            : !data.remote_branch ? tr("未找到对应的远端分支。请检查远端，或推送以创建该分支。") : "";
          return (
          <div className="grid min-w-0 gap-2">
            {data.repo && <a href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer"
              className="truncate px-1 text-xs text-muted-foreground hover:underline">{data.repo}</a>}
            <div className="flex flex-wrap items-center gap-1">
              <Button variant="outline" size="sm" className="max-w-full"
                aria-expanded={branchOpen} aria-label={tr("选择分支")} onClick={() => setBranchOpen(!branchOpen)}>
                <GitBranch /><span className="truncate">{data.branch || tr("分离的 HEAD")}</span>
              </Button>
            </div>
            {data.remote_branch && <p className="px-1 text-xs text-muted-foreground">
              {ahead || behind ? [ahead > 0 && tr("{0} 个提交尚未推送", ahead), behind > 0 && tr("远端有 {0} 个新提交", behind)].filter(Boolean).join(" · ")
                : tr("与上次检查的远端一致")}
            </p>}
            {branchOpen && <QueryBoundary query={branches} rows={1}>
              {({ branches: choices, current }) => <Select aria-label={tr("选择分支")} value={current}
                disabled={busy || !!branchReason}
                onChange={(event) => change.mutate({ action: "switch", branch: event.target.value })}>
                {!choices.includes(current) && <option value={current}>{current || tr("选择分支")}</option>}
                {choices.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </Select>}
            </QueryBoundary>}
            {data.remote && <div className="flex flex-wrap gap-1">
              <Button size="icon" className="size-8" variant="ghost" title={tr("检查远端")} aria-label={tr("检查远端")}
                disabled={busy} onClick={() => change.mutate({ action: "check" })}><RefreshCw /></Button>
              <Button size="sm" variant="ghost" title={pullReason || labels.pull}
                disabled={busy || !!pullReason} onClick={() => setConfirm("pull")}><ArrowDownToLine /> {labels.pull}</Button>
              <Button size="sm" variant="ghost" title={syncReason || labels.push}
                disabled={busy || !!syncReason} onClick={() => setConfirm("push")}><ArrowUpFromLine /> {labels.push}</Button>
            </div>}
            {[...new Set([data.remote && pullReason, data.remote && syncReason, branchOpen && branchReason].filter(Boolean))]
              .map((reason) => <p key={String(reason)} className="px-1 text-xs text-muted-foreground">{reason}</p>)}
            <form className="grid gap-1.5 border-b pb-2" onSubmit={(event) => {
              event.preventDefault();
              if (message.trim() && !busy) commit.mutate();
            }}>
              <Input value={message} maxLength={1000} onChange={(event) => setMessage(event.target.value)}
                aria-label={tr("提交说明")} placeholder={tr("提交说明")} />
              <Button type="submit" size="sm" loading={commit.isPending}
                disabled={busy || !message.trim() || !data.files.some(({ status }) => ![" ", "?"].includes(status[0] ?? " "))}>
                {tr("提交已暂存文件")}
              </Button>
            </form>
            {files(data, true)}
            {files(data, false)}
            {data.files.length === 0 && <p className="px-1 text-xs text-muted-foreground">{tr("没有本地改动")}</p>}
          </div>
          );
        })()}
      </QueryBoundary>
      <Dialog open={!!diff} onOpenChange={(open) => { if (!open) setDiff(undefined); }}>
        <DialogContent title={tr("文件差异")} description={diff?.path} className="max-w-4xl">
          <QueryBoundary query={difference}>
            {({ before, after }) => <Suspense fallback={<LoadingState rows={2} />}>
              <WorkspaceDiff before={before} after={after}
                labels={diff?.staged ? ["HEAD", tr("暂存区")] : [tr("暂存区"), tr("工作区")]} />
            </Suspense>}
          </QueryBoundary>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(undefined); }}
        title={confirm ? labels[confirm] : ""} confirmLabel={confirm ? labels[confirm] : ""}
        description={confirm === "pull" ? tr("拉取只在本地工作区干净、分支可以快进时执行。") : tr("将当前分支的已有提交推送到远端。")}
        loading={change.isPending} onConfirm={() => { if (confirm) change.mutate({ action: confirm }); }}>
        {change.error && <Alert tone="loss">{change.error.message}</Alert>}
      </ConfirmDialog>
    </div>
  );
}
