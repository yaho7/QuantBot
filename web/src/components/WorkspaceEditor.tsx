import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { FileCode, Files, GitBranch, Play, Search, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ConfirmDialog, EmptyState, LoadingState } from "@/components/common";
import { GitHubDialog } from "@/components/GitHubDialog";
import { StrategyCodeEditor } from "@/components/StrategyCodeEditor";
import { WorkspaceDiff } from "@/components/WorkspaceDiff";
import { WorkspaceExplorer, WorkspaceSearch } from "@/components/WorkspaceExplorer";
import { WorkspaceProgram } from "@/components/WorkspaceProgram";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { api, type FileAction, type SourceFile } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const WorkspaceTerminal = lazy(() => import("@/components/WorkspaceTerminal"));
const under = (path: string, folder: string) => path === folder || path.startsWith(folder + "/");

export default function WorkspaceEditor({ managed }: { managed: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, { base: SourceFile; text: string }>>({});
  const [location, setLocation] = useState<{ path: string; line: number; request: number }>();
  const [sidebar, setSidebar] = useState<"files" | "search">("files");
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState<{ path: string; close: boolean }>();
  const [githubOpen, setGithubOpen] = useState(() => new URLSearchParams(window.location.search).has("github"));
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [programOpen, setProgramOpen] = useState(false);
  const dirty = Object.keys(drafts).length > 0;
  const files = useQueries({ queries: tabs.map((path) => ({
    queryKey: ["editor", "file", path],
    queryFn: () => api.editorFile(path),
    retry: false,
  })) });
  const fileQuery = active === undefined ? undefined : files[tabs.indexOf(active)];
  const disk = fileQuery?.data;
  const draft = active === undefined ? undefined : drafts[active];
  const base = draft?.base ?? disk;
  const conflicted = !!draft && (fileQuery?.isError || (disk && disk.revision !== draft.base.revision));

  const refresh = useCallback(() => {
    for (const key of ["tree", "file", "search", "git", "github"]) {
      void qc.invalidateQueries({ queryKey: ["editor", key] });
    }
  }, [qc]);
  useEffect(() => {
    const events = new EventSource("/ui/api/editor/events");
    events.onmessage = refresh;
    return () => events.close();
  }, [refresh]);
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const edit = useCallback((text: string) => {
    if (!active || !base) return;
    setDrafts((previous) => {
      const next = { ...previous };
      if (text === base.content) delete next[active];
      else next[active] = { base, text };
      return next;
    });
  }, [active, base]);
  function dropDraft(path: string) {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[path];
      return next;
    });
  }
  const save = useMutation({
    mutationFn: api.saveEditorFile,
    onSuccess: (source, { path }) => {
      qc.setQueryData(["editor", "file", path], source);
      dropDraft(path);
      setReview(false);
      toast.success(tr("文件已保存。"));
    },
  });
  function open(path: string, line?: number) {
    setTabs((previous) => previous.includes(path) ? previous : [...previous, path]);
    setActive(path);
    save.reset();
    if (line) setLocation((previous) => ({ path, line, request: (previous?.request ?? 0) + 1 }));
  }
  function close(path: string) {
    const index = tabs.indexOf(path);
    const remaining = tabs.filter((item) => item !== path);
    setTabs(remaining);
    if (active === path) setActive(remaining[Math.min(index, remaining.length - 1)]);
    dropDraft(path);
  }
  function changed(action: FileAction, path: string, destination?: string) {
    if (action === "move" && destination) {
      const rename = (tab: string) => under(tab, path) ? destination + tab.slice(path.length) : tab;
      setTabs((previous) => [...new Set(previous.map(rename))]);
      setActive((previous) => previous && rename(previous));
    } else if (action === "delete") {
      const remaining = tabs.filter((tab) => !under(tab, path));
      setTabs(remaining);
      if (active && under(active, path)) setActive(remaining.at(-1));
    }
    refresh();
  }
  const showTerminal = managed && terminalOpen;
  const showProgram = managed && programOpen;
  const jump = location && location.path === active ? location : undefined;
  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap justify-between gap-2 border-b px-2 py-1.5">
          <div className="flex gap-1">
            <Button size="sm" variant={sidebar === "files" ? "secondary" : "ghost"} aria-pressed={sidebar === "files"}
              onClick={() => setSidebar("files")}><Files /> {tr("文件")}</Button>
            <Button size="sm" variant={sidebar === "search" ? "secondary" : "ghost"} aria-pressed={sidebar === "search"}
              onClick={() => setSidebar("search")}><Search /> {tr("搜索")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setGithubOpen(true)}><GitBranch /> Git</Button>
          </div>
          {managed && <div className="flex gap-1">
            <Button size="sm" variant={showTerminal ? "secondary" : "ghost"} aria-pressed={showTerminal}
              onClick={() => { setTerminalOpen(!terminalOpen); setProgramOpen(false); }}><SquareTerminal /> {tr("终端")}</Button>
            <Button size="sm" variant={showProgram ? "secondary" : "ghost"} aria-pressed={showProgram}
              onClick={() => { setProgramOpen(!programOpen); setTerminalOpen(false); }}><Play /> {tr("运行")}</Button>
          </div>}
        </div>
        <Group className="h-[min(62vh,42rem)] min-h-[24rem]">
          <Panel id="workspace-sidebar" defaultSize="24%" minSize="7rem" maxSize="55%">
            <div className={cn("h-full", sidebar !== "files" && "hidden")}>
              <WorkspaceExplorer selected={active} onOpen={open}
                canChange={(path) => !Object.keys(drafts).some((item) => under(item, path))} onChange={changed} />
            </div>
            {sidebar === "search" && <WorkspaceSearch onOpen={open} />}
          </Panel>
          <Separator aria-label={tr("调整文件栏宽度")} className="w-px bg-border hover:bg-ring focus-visible:bg-ring" />
          <Panel id="workspace-source" minSize="10rem">
            <section className="flex h-full min-w-0 flex-col bg-background" aria-label={tr("编辑文件")}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  if (draft && !conflicted) setReview(true);
                }
              }}>
              {tabs.length > 0 && <div className="flex shrink-0 overflow-x-auto border-b bg-card">
                {tabs.map((path) => (
                  <div key={path} className={cn("flex shrink-0 items-center border-r", path === active && "bg-background")}>
                    <button type="button" title={path} aria-pressed={path === active}
                      className="cursor-pointer px-2.5 py-2 text-xs" onClick={() => open(path)}>
                      {path.slice(path.lastIndexOf("/") + 1)}{drafts[path] && <span className="ml-1 text-warning">●</span>}
                    </button>
                    <Button variant="ghost" size="icon" className="mr-1 size-6" aria-label={tr("关闭 {0}", path)}
                      disabled={save.isPending} onClick={() => drafts[path] ? setDiscard({ path, close: true }) : close(path)}>
                      <X />
                    </Button>
                  </div>
                ))}
              </div>}
              {!active ? <EmptyState icon={FileCode} title={tr("选择要编辑的文件")} /> :
                <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2.5">
                  {fileQuery?.isPending && !base && <LoadingState rows={2} />}
                  {fileQuery?.error && !draft && <Alert tone="loss">{fileQuery.error.message}</Alert>}
                  {base && <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="break-all text-xs text-muted-foreground">{active}</code>
                      <Button size="sm" variant="outline" disabled={!draft || !!conflicted || save.isPending}
                        onClick={() => { save.reset(); setReview(true); }}>{tr("预览并保存")}</Button>
                    </div>
                    {conflicted && <Alert tone="warning">
                      {tr("磁盘上的文件已变更，草稿仍保留。")}
                      <Button variant="ghost" size="sm" onClick={() => setDiscard({ path: active, close: false })}>
                        {tr("重新读取")}
                      </Button>
                    </Alert>}
                    <StrategyCodeEditor key={active + ":" + base.revision} path={active} initial={draft?.text ?? base.content}
                      onChange={edit} disabled={save.isPending} jump={jump} />
                  </>}
                </div>}
            </section>
          </Panel>
        </Group>
        {(showTerminal || showProgram) && <div className="border-t p-2">
          {showTerminal && <Suspense fallback={<LoadingState />}><WorkspaceTerminal /></Suspense>}
          {showProgram && <WorkspaceProgram />}
        </div>}
      </div>
      <Dialog open={review && !!draft} onOpenChange={(open) => { if (!open && !save.isPending) setReview(false); }}>
        <DialogContent title={tr("确认保存")} description={active} className="max-w-4xl">
          {draft && <WorkspaceDiff before={draft.base.content} after={draft.text} labels={[tr("保存前"), tr("保存后")]} />}
          {save.error && <Alert tone="loss">{save.error.message}</Alert>}
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setReview(false)}>{tr("返回编辑")}</Button>
            <Button loading={save.isPending} disabled={!!conflicted} onClick={() => {
              if (active && draft) save.mutate({ path: active, content: draft.text, revision: draft.base.revision });
            }}>{tr("保存文件")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!discard} onOpenChange={(open) => { if (!open) setDiscard(undefined); }}
        title={tr("放弃未保存的改动？")} description={discard?.path} confirmLabel={tr("放弃改动")} destructive
        onConfirm={() => {
          if (discard?.close) close(discard.path);
          else if (discard) {
            dropDraft(discard.path);
            void qc.invalidateQueries({ queryKey: ["editor", "file", discard.path] });
          }
          setDiscard(undefined);
        }} />
      {githubOpen && <GitHubDialog dirty={dirty} onClose={() => {
        setGithubOpen(false);
        const url = new URL(window.location.href);
        if (url.searchParams.has("github")) {
          url.searchParams.delete("github");
          history.replaceState(null, "", url);
        }
      }} onChanged={refresh} />}
    </>
  );
}
