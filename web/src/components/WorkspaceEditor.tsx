import { tr } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { structuredPatch } from "diff";
import { ChevronRight, FileCode, Folder, FolderOpen, GitBranch, Play, RefreshCw, Save, SquareTerminal } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, EmptyState, LoadingState, QueryBoundary } from "@/components/common";
import { GitHubDialog } from "@/components/GitHubDialog";
import { StrategyCodeEditor } from "@/components/StrategyCodeEditor";
import { WorkspaceProgram } from "@/components/WorkspaceProgram";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { api, type SourceFile } from "@/lib/api";
import { cn } from "@/lib/utils";

type TreeProps = { selected?: string; disabled: boolean; onFile: (path: string) => void };
const WorkspaceTerminal = lazy(() => import("@/components/WorkspaceTerminal"));

function FileTree({ path, ...props }: TreeProps & { path: string }) {
  const entries = useQuery({ queryKey: ["editor", "tree", path], queryFn: () => api.editorTree(path), retry: false });
  return (
    <QueryBoundary query={entries} rows={2}>
      {({ entries }) => entries.length ? (
        <ul className="grid gap-0.5">
          {entries.map(({ kind, name }) => {
            const target = path ? `${path}/${name}` : name;
            return kind === "directory" ? (
              <FolderRow key={name} name={name} path={target} {...props} />
            ) : (
              <li key={name}>
                <Button variant={props.selected === target ? "secondary" : "ghost"} size="sm"
                  className="w-full justify-start gap-2 rounded-md px-2 font-normal" title={name}
                  aria-current={props.selected === target ? "true" : undefined}
                  disabled={props.disabled} onClick={() => props.onFile(target)}>
                  <FileCode className="text-muted-foreground" />
                  <span className="truncate">{name}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : <p className="px-2 py-2 text-xs text-muted-foreground">{tr("文件夹为空")}</p>}
    </QueryBoundary>
  );
}

function FolderRow({ name, path, ...props }: TreeProps & { name: string; path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 rounded-md px-2 font-normal"
        title={name} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("text-muted-foreground transition-transform", open && "rotate-90")} />
        {open ? <FolderOpen /> : <Folder />}
        <span className="truncate">{name}</span>
      </Button>
      {open && <div className="ml-3 border-l border-border pl-2"><FileTree path={path} {...props} /></div>}
    </li>
  );
}

type File = SourceFile & { path: string; opened: number };

function preview(file: File, draft: string) {
  const patch = structuredPatch(file.path, file.path, file.content, draft, undefined, undefined, {
    context: 3, timeout: 250,
  });
  const lines = patch?.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines,
  ]);
  return lines ? (
    <pre className="max-h-[44vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <span key={i} className={cn("block min-h-[1em] w-max min-w-full",
          line.startsWith("+") && "bg-gain/10 text-gain",
          line.startsWith("-") && "bg-loss/10 text-loss",
          line.startsWith("@@") && "text-muted-foreground",
        )}>{line}</span>
      ))}
    </pre>
  ) : (
    <div className="grid gap-3 md:grid-cols-2">
      {[[tr("保存前"), file.content], [tr("保存后"), draft]].map(([label, code]) => (
        <section key={label} className="min-w-0">
          <h3 className="mb-1 text-xs font-medium">{label}</h3>
          <pre className="max-h-[42vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs">{code}</pre>
        </section>
      ))}
    </div>
  );
}

export default function WorkspaceEditor({ managed }: { managed: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState<ReactNode>(null);
  const [discard, setDiscard] = useState<string>();
  const [githubOpen, setGithubOpen] = useState(() => new URLSearchParams(location.search).has("github"));
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  const showTerminal = managed && terminalOpen;
  const dirty = !!file && file.content !== draft;
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const load = useMutation({
    mutationFn: api.editorFile,
    onSuccess: (source, path) => {
      setFile((previous) => ({ ...source, path, opened: (previous?.opened ?? 0) + 1 }));
      setDraft(source.content);
    },
    onError: (err) => setError(err.message),
  });
  const save = useMutation({
    mutationFn: api.saveEditorFile,
    onSuccess: (source) => {
      setFile((current) => current && { ...current, ...source });
      toast.success(tr("文件已保存。"));
    },
    onError: (err) => setError(err.message),
    onSettled: () => setReview(null),
  });
  const busy = load.isPending || save.isPending;

  function go(target: string) {
    setError("");
    load.mutate(target);
  }
  function choose(target: string) {
    if (busy) return;
    if (dirty) setDiscard(target);
    else go(target);
  }

  return (
    <>
      <div className="grid gap-4">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setGithubOpen(true)}>
            <GitBranch /> Git</Button>
          {managed && (
            <>
              <Button variant={programOpen ? "secondary" : "outline"} size="sm" aria-pressed={programOpen}
                onClick={() => setProgramOpen((open) => !open)}><Play /> {tr("运行")}</Button>
              <Button variant={showTerminal ? "secondary" : "outline"} size="sm" aria-pressed={showTerminal}
                onClick={() => setTerminalOpen((open) => !open)}><SquareTerminal /> {tr("终端")}</Button>
            </>
          )}
        </div>
        <div className={cn("items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]", showTerminal ? "hidden md:grid" : "grid")}>
          <nav aria-label={tr("策略文件")} className="max-h-44 overflow-auto rounded-lg border bg-card p-2 md:max-h-[58vh]">
            <FileTree path="" selected={file?.path} disabled={busy} onFile={(path) => {
              if (path !== file?.path) choose(path);
            }} />
          </nav>
          <section className="grid min-w-0 gap-3" aria-label={tr("编辑文件")}>
            {error && <Alert tone="loss">{error}</Alert>}
            {file ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <code className="min-w-0 break-all text-xs">{file.path}</code>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => choose(file.path)}>
                    <RefreshCw /> {tr("重新读取")}</Button>
                </div>
                <StrategyCodeEditor key={file.opened} path={file.path} initial={file.content}
                  onChange={setDraft} disabled={busy || !!review || !!discard} />
                <DialogFooter className="sm:items-center">
                  {dirty && <span className="mr-auto text-xs text-warning">{tr("有未保存的改动")}</span>}
                  <Button disabled={busy || !dirty} onClick={() => {
                    setError("");
                    setReview(preview(file, draft));
                  }}>
                    <Save /> {tr("预览并保存")}</Button>
                </DialogFooter>
              </>
            ) : <EmptyState icon={FileCode} title={load.isPending ? tr("正在读取文件") : tr("选择要编辑的文件")} />}
          </section>
        </div>
        {showTerminal && <Suspense fallback={<LoadingState />}><WorkspaceTerminal /></Suspense>}
        {managed && programOpen && <WorkspaceProgram />}
      </div>
      <Dialog open={!!review} onOpenChange={(open) => { if (!open && !save.isPending) setReview(null); }}>
        <DialogContent title={tr("确认保存")} description={file?.path} className="max-w-4xl">
          {review}
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setReview(null)}>{tr("返回编辑")}</Button>
            <Button loading={save.isPending} onClick={() => {
              if (file) save.mutate({ path: file.path, content: draft, revision: file.revision });
            }}>{tr("保存文件")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!discard} onOpenChange={(open) => { if (!open) setDiscard(undefined); }}
        title={tr("放弃未保存的改动？")} description={file?.path} confirmLabel={tr("放弃改动")}
        destructive onConfirm={() => {
          if (discard) go(discard);
          setDiscard(undefined);
        }} />
      {githubOpen && <GitHubDialog dirty={dirty} onClose={() => {
        setGithubOpen(false);
        const url = new URL(location.href);
        if (url.searchParams.has("github")) {
          url.searchParams.delete("github");
          history.replaceState(null, "", url);
        }
      }}
        onChanged={() => {
          void qc.invalidateQueries({ queryKey: ["editor", "tree"] });
          if (file && !dirty) {
            setFile(undefined);
            setDraft("");
            load.mutate(file.path);
          }
        }} />}
    </>
  );
}
