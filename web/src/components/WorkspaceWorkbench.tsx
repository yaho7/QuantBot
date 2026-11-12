import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, FolderCode, FolderOpen, GitBranch, Plus, Trash2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, EmptyState, LoadingState, PageHeader, QueryBoundary } from "@/components/common";
import { GitHubDialog } from "@/components/GitHubDialog";
import { WorkspaceContext, workspaceScope } from "@/components/WorkspaceContext";
import { WorkspaceSetup } from "@/components/WorkspaceSetup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Alert, Input } from "@/components/ui/primitives";
import { api, type WorkspaceProject } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const WorkspaceEditor = lazy(() => import("@/components/WorkspaceEditor"));
const storageKey = "quantbot-workbench";
type Session = { open: string[]; current: string; recent: string[] };

function readSession(): Session | undefined {
  try {
    const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (state && Array.isArray(state.open) && Array.isArray(state.recent) && typeof state.current === "string") {
      return state;
    }
  } catch {
    // Browser storage can be unavailable.
  }
}

function opened(state: Session, id: string): Session {
  return {
    open: state.open.includes(id) ? state.open : [...state.open, id],
    current: id,
    recent: [id, ...state.recent.filter((entry) => entry !== id)].slice(0, 20),
  };
}

function ProjectView({ project, active, onDirty, onOpen }: {
  project: WorkspaceProject; active: boolean; onDirty: (id: string, dirty: boolean) => void; onOpen: (id: string) => void;
}) {
  const scope = useMemo(() => workspaceScope(project, active), [project, active]);
  const trackDirty = useCallback((dirty: boolean) => onDirty(project.id, dirty), [onDirty, project.id]);
  return (
    <div role="tabpanel" hidden={!active} id={`workspace-panel-${project.id}`}
      aria-labelledby={`workspace-tab-${project.id}`}>
      <WorkspaceContext.Provider value={scope}>
        <Suspense fallback={<LoadingState />}>
          <WorkspaceEditor onDirty={trackDirty} onOpenProject={onOpen} />
        </Suspense>
      </WorkspaceContext.Provider>
    </div>
  );
}

function ProjectList({ projects, onOpen, onRemove }: {
  projects: WorkspaceProject[];
  onOpen: (id: string) => void;
  onRemove: (project: WorkspaceProject) => void;
}) {
  return (
    <div className="max-h-64 divide-y overflow-auto rounded-lg border bg-card">
      {projects.map((project) => (
        <div key={project.id} className="flex items-center gap-1 pr-2">
          <button type="button" onClick={() => onOpen(project.id)}
            className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left hover:bg-muted">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0">
              <span className="truncate text-sm font-medium">{project.name}</span>
              <code title={project.path} className="truncate text-xs text-muted-foreground">{project.path}</code>
            </span>
          </button>
          <Button variant="ghost" size="icon" aria-label={tr("移除工作区 {0}", project.name)}
            title={tr("移除工作区 {0}", project.name)} onClick={() => onRemove(project)}>
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function WorkspaceWorkbench() {
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ["workspace", "projects"], queryFn: api.workspaceProjects, staleTime: 5_000, refetchInterval: 10_000,
  });
  const [session, setSession] = useState(readSession);
  const [picker, setPicker] = useState<"recent" | "folder">();
  const [filter, setFilter] = useState("");
  const [github, setGithub] = useState(false);
  const [closing, setClosing] = useState<WorkspaceProject>();
  const [removing, setRemoving] = useState<WorkspaceProject>();
  const remove = useMutation({
    mutationFn: api.removeWorkspace,
    onSuccess: (result, id) => {
      close(id);
      setSession((previous) => previous && { ...previous, recent: previous.recent.filter((entry) => entry !== id) });
      client.setQueryData(["workspace", "projects"], result);
      setRemoving(undefined);
    },
  });
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const requested = useRef(new URLSearchParams(location.search).get("workspace"));
  const reportDirty = useCallback((id: string, value: boolean) => {
    setDirty((previous) => !!previous[id] === value ? previous : { ...previous, [id]: value });
  }, []);

  useEffect(() => {
    if (!catalog.data) return;
    const known = catalog.data.projects;
    const requestedId = requested.current;
    requested.current = null;
    setSession((previous) => {
      const fresh: Session = { open: [], current: "", recent: [] };
      if (requestedId && known.some(({ id }) => id === requestedId)) return opened(previous ?? fresh, requestedId);
      if (previous) return previous;
      const initial = known.find((project) => project.default) ?? known[0];
      return initial ? opened(fresh, initial.id) : fresh;
    });
  }, [catalog.data]);

  useEffect(() => {
    if (!session) return;
    try { localStorage.setItem(storageKey, JSON.stringify(session)); } catch { /* Storage is optional. */ }
    const url = new URL(location.href);
    if (session.current) url.searchParams.set("workspace", session.current);
    else url.searchParams.delete("workspace");
    history.replaceState(null, "", url);
  }, [session]);

  function open(id: string) {
    setSession((previous) => opened(previous ?? { open: [], current: "", recent: [] }, id));
    setPicker(undefined);
  }

  function close(id: string) {
    setSession((previous) => {
      if (!previous) return previous;
      const index = previous.open.indexOf(id);
      const remaining = previous.open.filter((entry) => entry !== id);
      const current = previous.current === id ? remaining[Math.min(index, remaining.length - 1)] ?? "" : previous.current;
      return current ? opened({ ...previous, open: remaining }, current) : { ...previous, open: remaining, current };
    });
    reportDirty(id, false);
    setClosing(undefined);
  }

  function showPicker(mode: "recent" | "folder") {
    setFilter("");
    setPicker(mode);
  }

  function askRemove(project: WorkspaceProject) {
    remove.reset();
    setRemoving(project);
  }

  const known = catalog.data?.projects ?? [];
  const byId = new Map(known.map((project) => [project.id, project]));
  const projects = (session?.open ?? []).flatMap((id) => byId.get(id) ?? []);
  const current = projects.find(({ id }) => id === session?.current) ?? projects[0];
  const recent = (session?.recent ?? []).flatMap((id) => byId.get(id) ?? []);
  const term = filter.trim().toLowerCase();
  const matches = (project: WorkspaceProject) => project.path.toLowerCase().includes(term);
  const remaining = known.filter((project) => !recent.includes(project));

  return (
    <>
      <PageHeader title={tr("工作区")} description={current?.path} actions={<>
        <Button variant="outline" onClick={() => setGithub(true)}><GitBranch /> {tr("从 GitHub 导入")}</Button>
        <Button variant="outline" onClick={() => showPicker("recent")}><Clock3 /> {tr("最近打开")}</Button>
        <Button variant="outline" onClick={() => showPicker("folder")}><FolderOpen /> {tr("打开文件夹")}</Button>
        {current && <Button variant="outline" onClick={() => askRemove(current)}><Trash2 /> {tr("移除工作区")}</Button>}
      </>} />
      {!catalog.data ? <QueryBoundary query={catalog}>{() => null}</QueryBoundary> :
        projects.length ? (
          <div className="grid gap-2">
            <div role="tablist" aria-label={tr("已打开的工作区")}
              className="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card p-1">
              {projects.map((project) => (
                <div key={project.id} className={cn("flex shrink-0 items-center rounded-md pr-1",
                  current?.id === project.id && "bg-accent")}>
                  <button type="button" role="tab" aria-selected={current?.id === project.id}
                    aria-label={project.name} aria-description={dirty[project.id] ? tr("有未保存的改动") : undefined}
                    tabIndex={current?.id === project.id ? 0 : -1}
                    aria-controls={`workspace-panel-${project.id}`} id={`workspace-tab-${project.id}`}
                    className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-sm" title={project.path}
                    onClick={() => open(project.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      const index = projects.indexOf(project);
                      const next = projects[(index + projects.length + (event.key === "ArrowLeft" ? -1 : 1)) % projects.length];
                      if (next) {
                        open(next.id);
                        document.getElementById(`workspace-tab-${next.id}`)?.focus();
                      }
                    }}>
                    <FolderCode className="size-4" /> {project.name}
                    {dirty[project.id] && <span className="text-xs text-warning" aria-hidden>●</span>}
                  </button>
                  <Button variant="ghost" size="icon" className="size-6" aria-label={tr("关闭工作区 {0}", project.name)}
                    onClick={() => dirty[project.id] ? setClosing(project) : close(project.id)}><X /></Button>
                </div>
              ))}
              <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={tr("打开另一个工作区")}
                title={tr("打开另一个工作区")} onClick={() => showPicker("recent")}><Plus /></Button>
            </div>
            {projects.map((project) => <ProjectView key={project.id} project={project}
              active={current?.id === project.id} onDirty={reportDirty} onOpen={open} />)}
          </div>
        ) : recent.length || known.length ? (
          <div className="max-w-xl space-y-2">
            <h2 className="text-sm font-medium">{tr(recent.length ? "最近打开" : "工作区目录")}</h2>
            <ProjectList projects={recent.length ? recent : known} onOpen={open} onRemove={askRemove} />
          </div>
        ) : (
          <EmptyState icon={FolderCode} title={tr("打开一个工作区")}
            description={<Button className="mt-1" onClick={() => showPicker("folder")}>{tr("打开文件夹")}</Button>} />
        )}
      <Dialog open={!!picker} onOpenChange={(value) => { if (!value) setPicker(undefined); }}>
        <DialogContent title={tr(picker === "folder" ? "打开文件夹" : "最近打开")}>
          {picker === "folder" ? <WorkspaceSetup onDone={open} /> : (
            <div className="grid gap-3">
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} autoFocus
                aria-label={tr("搜索工作区目录")} placeholder={tr("搜索工作区目录")} />
              {recent.filter(matches).length > 0 && <ProjectList projects={recent.filter(matches)} onOpen={open} onRemove={askRemove} />}
              {remaining.filter(matches).length > 0 && (
                <section className="grid gap-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">{tr("其他工作区")}</h3>
                  <ProjectList projects={remaining.filter(matches)} onOpen={open} onRemove={askRemove} />
                </section>
              )}
              {!known.some(matches) && <p className="text-sm text-muted-foreground">{tr("没有匹配的工作区")}</p>}
              <Button variant="outline" className="w-fit" onClick={() => showPicker("folder")}>
                <FolderOpen /> {tr("打开其他文件夹")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {github && <GitHubDialog onClose={() => setGithub(false)} onChanged={() => {}} onProject={open} />}
      <ConfirmDialog open={!!closing} onOpenChange={(open) => { if (!open) setClosing(undefined); }}
        title={tr("关闭工作区并放弃草稿？")} description={closing?.path} confirmLabel={tr("关闭工作区")} destructive
        onConfirm={() => { if (closing) close(closing.id); }} />
      <ConfirmDialog open={!!removing} onOpenChange={(open) => {
        if (!open && !remove.isPending) setRemoving(undefined);
      }}
        title={tr("移除工作区 {0}？", removing?.name ?? "")}
        description={tr("将关闭这个工作区并撤销其策略连接。服务器上的目录和文件会保留。")}
        confirmLabel={tr("移除工作区")} destructive loading={remove.isPending}
        onConfirm={() => { if (removing) remove.mutate(removing.id); }}>
        {removing && <code className="break-all text-xs">{removing.path}</code>}
        {removing && dirty[removing.id] && <Alert tone="warning">{tr("此工作区有未保存的改动。")}</Alert>}
        {remove.error && <Alert tone="loss">{remove.error.message}</Alert>}
      </ConfirmDialog>
    </>
  );
}
