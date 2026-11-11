import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { api, workspaceApi, type GitHubAuthorization } from "@/lib/api";
import { tr } from "@/lib/i18n";

const statusKey = ["editor", "github"];

export function GitHubDialog({ project = "", onClose, onChanged, onProject }: {
  project?: string; onClose: () => void; onChanged: () => void; onProject?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [authorization, setAuthorization] = useState<GitHubAuthorization>();
  const [repository, setRepository] = useState("");
  const [target, setTarget] = useState<"new" | "current">("new");
  const [folder, setFolder] = useState("");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState(false);
  const status = useQuery({ queryKey: statusKey, queryFn: api.githubStatus, retry: false });
  const repositories = useQuery({
    queryKey: ["editor", "github-repositories", status.data?.account],
    queryFn: api.githubRepositories,
    enabled: !!status.data?.account && !authorization,
    retry: false,
  });
  const bind = useMutation({ mutationFn: api.githubBind, onSuccess: setAuthorization });
  const poll = useQuery({
    queryKey: ["editor", "github-device", authorization?.state],
    queryFn: () => api.githubAuthorize(authorization!.state),
    enabled: !!authorization,
    retry: false,
    refetchInterval: (query) => query.state.data?.ready || query.state.error ? false : 2_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (!poll.data?.ready) return;
    setAuthorization(undefined);
    void qc.invalidateQueries({ queryKey: statusKey });
  }, [poll.data, qc]);
  const cancel = useMutation({
    mutationFn: api.githubCancel,
    onSettled: () => setAuthorization(undefined),
  });
  const clone = useMutation({
    mutationFn: () => workspaceApi(project).githubSelect(repository, target === "new" ? folder.trim() : undefined),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["workspace"] });
      onChanged();
      if (result.project && result.project !== project) onProject?.(result.project);
      toast.success(tr("GitHub 仓库已就绪。"));
      onClose();
    },
  });
  const logout = useMutation({
    mutationFn: api.githubLogout,
    onSuccess: async () => {
      setConfirm(false);
      setRepository("");
      setFilter("");
      await qc.invalidateQueries({ queryKey: statusKey });
    },
  });
  const busy = bind.isPending || clone.isPending || logout.isPending || cancel.isPending;
  const error = bind.error || clone.error || logout.error || cancel.error;
  const normalized = filter.trim().toLowerCase();
  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
        <DialogContent title={tr("连接 GitHub")} className="max-w-md">
          <QueryBoundary query={status}>
            {(data) => !data.configured ? (
              <div className="grid gap-3">
                <Alert tone="info">{tr("请先初始化工作区。")}</Alert>
                <Button asChild className="w-fit"><a href="/ui/?view=workspace">{tr("打开工作区")}</a></Button>
              </div>
            ) : !data.available ? (
              <Alert tone="warning">{tr("请在服务器上安装 GitHub CLI（gh）。")}</Alert>
            ) : authorization ? (
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">{tr("打开 GitHub，输入验证码并授权访问仓库。")}</p>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
                  <code className="mr-auto select-all font-mono text-lg tracking-widest">{authorization.code}</code>
                  <Button size="icon" variant="ghost" aria-label={tr("复制验证码")} title={tr("复制验证码")}
                    onClick={() => void navigator.clipboard?.writeText(authorization.code).then(
                      () => toast.success(tr("已复制")), () => toast.error(tr("请手动复制验证码。")),
                    )}><Copy /></Button>
                  <Button asChild variant="outline" size="sm">
                    <a href={authorization.url} target="_blank" rel="noreferrer"><ExternalLink /> {tr("打开 GitHub")}</a>
                  </Button>
                </div>
                {poll.error ? <Alert tone="loss">{poll.error.message}</Alert> :
                  <p className="text-xs text-muted-foreground" role="status">{tr("等待 GitHub 授权…")}</p>}
                <DialogFooter>
                  <Button variant="outline" loading={cancel.isPending} onClick={() => cancel.mutate(authorization.state)}>
                    {poll.error ? tr("返回") : tr("取消授权")}
                  </Button>
                </DialogFooter>
              </div>
            ) : data.account ? (
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{data.account}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>{tr("退出登录")}</Button>
                </div>
                <QueryBoundary query={repositories} rows={2}>
                  {({ repositories: items }) => items.length ? (
                    <form className="grid gap-3" onSubmit={(event) => {
                      event.preventDefault();
                      if (repository && (target === "current" || folder.trim()) && !busy) clone.mutate();
                    }}>
                      <Input aria-label={tr("搜索仓库")} placeholder={tr("搜索仓库")} value={filter}
                        onChange={(event) => {
                          setFilter(event.target.value);
                          setRepository("");
                        }} />
                      <Field label={tr("选择仓库")} htmlFor="github-repository">
                        <Select id="github-repository" value={repository}
                          onChange={(event) => {
                            setRepository(event.target.value);
                            setFolder(event.target.value.split("/").at(-1)?.replace(/^\.+/, "") || "");
                          }}>
                          <option value="">{tr("选择已授权的仓库")}</option>
                          {items.filter((item) => item.name.toLowerCase().includes(normalized)).map((item) => (
                            <option key={item.name} value={item.name}>
                              {item.name}{item.private ? ` · ${tr("私有")}` : ""}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {project && <Field label={tr("导入位置")} htmlFor="github-target">
                        <Select id="github-target" value={target}
                          onChange={(event) => setTarget(event.target.value === "current" ? "current" : "new")}>
                          <option value="new">{tr("新建工作区")}</option>
                          <option value="current">{tr("当前工作区")}</option>
                        </Select>
                      </Field>}
                      {target === "new" && <Field label={tr("新工作区文件夹")} htmlFor="github-folder">
                        <Input id="github-folder" value={folder} maxLength={100} required
                          onChange={(event) => setFolder(event.target.value)} />
                      </Field>}
                      <DialogFooter>
                        <Button type="button" variant="ghost" loading={repositories.isFetching}
                          onClick={() => void repositories.refetch()}><RefreshCw /> {tr("刷新仓库列表")}</Button>
                        <Button type="submit" disabled={!repository || (target === "new" && !folder.trim())} loading={clone.isPending}>{tr("导入仓库")}</Button>
                      </DialogFooter>
                    </form>
                  ) : <Alert tone="info">{tr("GitHub 没有返回可用仓库。")}</Alert>}
                </QueryBoundary>
              </div>
            ) : (
              <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">{tr("在 GitHub 输入一次性授权码后，回到这里选择仓库。")}</p>
                <Button className="w-fit" loading={bind.isPending} onClick={() => bind.mutate()}>
                  <GitBranch /> {tr("使用 GitHub 登录")}
                </Button>
              </div>
            )}
          </QueryBoundary>
          {error && <Alert tone="loss">{error.message}</Alert>}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={tr("退出 GitHub 登录？")}
        description={tr("工作区中的文件和 Git 提交仍可在本地使用。")} confirmLabel={tr("退出登录")}
        loading={logout.isPending} onConfirm={() => logout.mutate()}>
        {logout.error && <Alert tone="loss">{logout.error.message}</Alert>}
      </ConfirmDialog>
    </>
  );
}
