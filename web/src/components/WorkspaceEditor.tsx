import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { FileCode, Files, GitBranch, Play, Search, Sparkles, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AiPromptDialog } from "@/components/AiPromptDialog";
import { ConfirmDialog, EmptyState, LoadingState } from "@/components/common";
import { GitHubDialog } from "@/components/GitHubDialog";
import { WorkspaceExplorer, WorkspaceSearch } from "@/components/WorkspaceExplorer";
import { useWorkspace } from "@/components/WorkspaceContext";
import { WorkspaceGit } from "@/components/WorkspaceGit";
import { WorkspaceProgram } from "@/components/WorkspaceProgram";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { type FileAction, type SourceFile } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const WorkspaceTerminal = lazy(() => import("@/components/WorkspaceTerminal"));
const StrategyCodeEditor = lazy(() => import("@/components/StrategyCodeEditor"));
const WorkspaceDiff = lazy(() => import("@/components/WorkspaceDiff"));
const under = (path: string, folder: string) => path === folder || path.startsWith(folder + "/");

export default function WorkspaceEditor({ onDirty, onOpenProject, showRun }: {
  onDirty: (dirty: boolean) => void; onOpenProject: (id: string) => void; showRun: boolean;
}) {
  const { project, active: visible, api, key } = useWorkspace();
  const managed = project.managed;
  const toast = useToast();
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, { base: SourceFile; text: string }>>({});
  const [location, setLocation] = useState<{ path: string; line: number; request: number }>();
  const [sidebar, setSidebar] = useState<"files" | "search" | "git">("files");
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState<{ path: string; close: boolean }>();
  const [promptOpen, setPromptOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(() => visible && new URLSearchParams(window.location.search).has("github"));
  const [directory, setDirectory] = useState("");
  const [terminalPath, setTerminalPath] = useState<string>();
  const [programOpen, setProgramOpen] = useState(showRun);
  useEffect(() => { if (showRun) setProgramOpen(true); }, [showRun]);
  const dirty = Object.keys(drafts).length > 0;
  const files = useQueries({ queries: tabs.map((path) => ({
    queryKey: key("file", path),
    enabled: visible,
    queryFn: () => api.editorFile(path),
    retry: false,
  })) });
  const fileQuery = active === undefined ? undefined : files[tabs.indexOf(active)];
  const disk = fileQuery?.data;
  const draft = active === undefined ? undefined : drafts[active];
  const base = draft?.base ?? disk;
  const conflicted = !!draft && (fileQuery?.isError || (disk && disk.revision !== draft.base.revision));

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key(), predicate: ({ queryKey }) => queryKey[2] !== "program" });
  }, [qc, key]);
  useEffect(() => {
    if (!visible) return;
    const events = new EventSource(`/ui/api/editor/events?${new URLSearchParams({ workspace: project.id })}`);
    events.onmessage = refresh;
    return () => events.close();
  }, [refresh, visible, project.id]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
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
      qc.setQueryData(key("file", path), source);
      dropDraft(path);
      setReview(false);
      toast.success(tr("文件已保存。"));
    },
  });
  function saveDraft() {
    if (active && draft && !conflicted && !save.isPending) {
      save.mutate({ path: active, content: draft.text, revision: draft.base.revision });
    }
  }
  function open(path: string, line?: number) {
    setTabs((previous) => previous.includes(path) ? previous : [...previous, path]);
    setActive(path);
    setDirectory(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
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
      setDirectory((previous) => rename(previous));
    } else if (action === "delete") {
      const remaining = tabs.filter((tab) => !under(tab, path));
      setTabs(remaining);
      if (active && under(active, path)) setActive(remaining.at(-1));
      setDirectory((previous) => under(previous, path) ? "" : previous);
    }
    refresh();
  }
  const showTerminal = managed && terminalPath !== undefined && !programOpen;
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
            <Button size="sm" variant={sidebar === "git" ? "secondary" : "ghost"} aria-pressed={sidebar === "git"}
              onClick={() => setSidebar("git")}><GitBranch /> Git</Button>
            <Button size="sm" variant="ghost" aria-label={tr("让 AI 接入策略")} title={tr("让 AI 接入策略")}
              onClick={() => setPromptOpen(true)}>
              <Sparkles /> <span className="hidden min-[360px]:inline">{tr("让 AI 接入策略")}</span>
            </Button>
          </div>
          {managed && <div className="flex gap-1">
            <Button size="sm" variant={showTerminal ? "secondary" : "ghost"} aria-pressed={showTerminal}
              onClick={() => {
                if (showTerminal) setTerminalPath(undefined);
                else setTerminalPath(terminalPath ?? directory);
                setProgramOpen(false);
              }}><SquareTerminal /> {tr("终端")}</Button>
            <Button size="sm" variant={showProgram ? "secondary" : "ghost"} aria-pressed={showProgram}
              onClick={() => setProgramOpen(!programOpen)}><Play /> {tr("运行")}</Button>
          </div>}
        </div>
        <Group className="h-[min(62vh,42rem)] min-h-[24rem]">
          <Panel id="workspace-sidebar" defaultSize="24%" minSize="7rem" maxSize="55%">
            <div className={cn("h-full", sidebar !== "files" && "hidden")}>
              <WorkspaceExplorer selected={active} onOpen={open} onDirectory={setDirectory}
                canChange={(path) => !Object.keys(drafts).some((item) => under(item, path))} onChange={changed} />
            </div>
            {sidebar === "search" && <WorkspaceSearch onOpen={open} />}
            {sidebar === "git" && <WorkspaceGit dirty={dirty} onConnect={() => setGithubOpen(true)} onChanged={refresh} />}
          </Panel>
          <Separator aria-label={tr("调整文件栏宽度")} className="w-px bg-border hover:bg-ring focus-visible:bg-ring" />
          <Panel id="workspace-source" minSize="10rem">
            <section className="flex h-full min-w-0 flex-col bg-background" aria-label={tr("编辑文件")}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  saveDraft();
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
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" disabled={!draft || save.isPending}
                          onClick={() => setReview(true)}>{tr("预览差异")}</Button>
                        <Button size="sm" variant="outline" disabled={!draft || !!conflicted} loading={save.isPending}
                          onClick={saveDraft}>{tr("保存文件")}</Button>
                      </div>
                    </div>
                    {save.error && !review && <Alert tone="loss">{save.error.message}</Alert>}
                    {conflicted && <Alert tone="warning">
                      {tr("磁盘上的文件已变更，草稿仍保留。")}
                      <Button variant="ghost" size="sm" onClick={() => setDiscard({ path: active, close: false })}>
                        {tr("重新读取")}
                      </Button>
                    </Alert>}
                    <Suspense fallback={<LoadingState rows={2} />}>
                      <StrategyCodeEditor key={active + ":" + base.revision} path={active} initial={draft?.text ?? base.content}
                        onChange={edit} disabled={save.isPending} jump={jump} />
                    </Suspense>
                  </>}
                </div>}
            </section>
          </Panel>
        </Group>
        {(terminalPath !== undefined || showProgram) && <div className="border-t p-2">
          {terminalPath !== undefined && <div hidden={!showTerminal}>
            <Suspense fallback={<LoadingState />}><WorkspaceTerminal path={terminalPath} /></Suspense>
          </div>}
          {showProgram && <WorkspaceProgram />}
        </div>}
      </div>
      <Dialog open={review && !!draft} onOpenChange={(open) => { if (!open && !save.isPending) setReview(false); }}>
        <DialogContent title={tr("预览差异")} description={active} className="max-w-4xl">
          {draft && <Suspense fallback={<LoadingState rows={2} />}>
            <WorkspaceDiff before={draft.base.content} after={draft.text} labels={[tr("保存前"), tr("保存后")]} />
          </Suspense>}
          {save.error && <Alert tone="loss">{save.error.message}</Alert>}
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setReview(false)}>{tr("返回编辑")}</Button>
            <Button loading={save.isPending} disabled={!!conflicted} onClick={saveDraft}>{tr("保存文件")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!discard} onOpenChange={(open) => { if (!open) setDiscard(undefined); }}
        title={tr("放弃未保存的改动？")} description={discard?.path} confirmLabel={tr("放弃改动")} destructive
        onConfirm={() => {
          if (discard?.close) close(discard.path);
          else if (discard) {
            dropDraft(discard.path);
            void qc.invalidateQueries({ queryKey: key("file", discard.path) });
          }
          setDiscard(undefined);
        }} />
      {visible && promptOpen && <AiPromptDialog open onOpenChange={setPromptOpen} />}
      {githubOpen && <GitHubDialog project={project.id} onProject={onOpenProject} onClose={() => {
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
