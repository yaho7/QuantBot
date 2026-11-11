import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Folder, FolderPlus, ChevronRight } from "lucide-react";
import { useState } from "react";
import { QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { tr } from "@/lib/i18n";

export function WorkspaceSetup({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const dirs = useQuery({
    queryKey: ["workspace", "directories", path],
    queryFn: () => api.workspaceDirectories(path),
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => api.createWorkspaceFolder(path, name.trim()),
    onSuccess: (folder) => {
      void qc.invalidateQueries({ queryKey: ["workspace", "directories"] });
      setPath(folder.path);
      setAdding(false);
      setName("");
    },
  });
  const initialize = useMutation({
    mutationFn: api.initializeWorkspace,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["editor"] });
      void qc.invalidateQueries({ queryKey: ["workspace", "directories"] });
      onDone?.();
    },
  });
  const busy = create.isPending || initialize.isPending;
  const error = create.error ?? initialize.error;

  function go(folder: string) {
    setPath(folder);
    create.reset();
    initialize.reset();
    setAdding(false);
    setName("");
  }

  return (
    <div className="grid gap-4">
      {path && (
        <Button variant="ghost" size="sm" className="w-fit" disabled={busy}
          onClick={() => go(path.split("/").slice(0, -1).join("/"))}>
          <ArrowUp /> {tr("上一级")}
        </Button>
      )}
      <QueryBoundary query={dirs}>
        {(data) => !data.supported ? (
          <Alert tone="info">{tr("网页初始化适用于以 root 运行的 Linux 服务器。其他环境可用 quantbot editor on --root 选择编辑目录。")}</Alert>
        ) : "configured" in data ? (
          <>
            <code className="break-all text-sm">{data.configured}</code>
            <Button className="w-fit" loading={initialize.isPending} onClick={() => initialize.mutate("")}>
              {tr("打开已初始化的工作区")}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="min-w-0 break-all rounded-md bg-muted px-2 py-1 text-xs">{data.base}{path && `/${path}`}</code>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { create.reset(); setAdding(!adding); }}>
                <FolderPlus /> {tr("新建文件夹")}
              </Button>
            </div>
            {adding && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
                event.preventDefault();
                if (name.trim() && !busy) create.mutate();
              }}>
                <Field label={tr("文件夹名称")} htmlFor="workspace-folder-name" className="min-w-40 flex-1">
                  <Input id="workspace-folder-name" value={name} autoFocus maxLength={255}
                    onChange={(event) => setName(event.target.value)} />
                </Field>
                <Button size="sm" type="submit" disabled={!name.trim() || busy} loading={create.isPending}>{tr("创建")}</Button>
              </form>
            )}
            <div className="max-h-64 divide-y overflow-auto rounded-lg border">
              {data.folders.length ? data.folders.map((folder) => (
                <button type="button" key={folder} disabled={busy}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                  onClick={() => go(path ? `${path}/${folder}` : folder)}>
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 break-all">{folder}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )) : <p className="px-3 py-3 text-sm text-muted-foreground">{tr("没有可选的子文件夹。")}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {path && !data.empty ? tr("请进入或新建一个空文件夹。") : tr("选择一个空文件夹作为工作区。")}
              </p>
              <Button disabled={!path || !data.empty || busy} loading={initialize.isPending}
                onClick={() => initialize.mutate(path)}>{tr("初始化此文件夹")}</Button>
            </div>
          </>
        )}
      </QueryBoundary>
      {error && <Alert tone="loss">{error.message}</Alert>}
    </div>
  );
}
