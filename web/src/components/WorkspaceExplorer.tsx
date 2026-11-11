import * as Menu from "@radix-ui/react-context-menu";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Eye, EyeOff, FileCode, FilePlus, Folder, FolderOpen, FolderPlus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tree, type TreeApi } from "react-arborist";
import { useWorkspace } from "@/components/WorkspaceContext";
import { ConfirmDialog, LoadingState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Input } from "@/components/ui/primitives";
import { type FileAction } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Entry = { id: string; name: string; children?: Entry[] };
type Prompt = { action: FileAction; path: string; parent: string; name: string; title: string };

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (parent: string, name: string) => parent ? parent + "/" + name : name;

export function WorkspaceExplorer({ selected, onOpen, canChange, onChange, onDirectory }: {
  selected?: string;
  onOpen: (path: string) => void;
  canChange: (path: string) => boolean;
  onChange: (action: FileAction, path: string, destination?: string) => void;
  onDirectory: (path: string) => void;
}) {
  const qc = useQueryClient();
  const { active, api, key, project } = useWorkspace();
  const tree = useRef<TreeApi<Entry>>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320);
  const hiddenKey = `quantbot-show-dotfiles:${project.id}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(hiddenKey) !== "false");
  const [directories, setDirectories] = useState([""]);
  const [prompt, setPrompt] = useState<Prompt>();
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const [clipboard, setClipboard] = useState<{ path: string; action: "move" | "copy" }>();
  const [error, setError] = useState("");
  const queries = useQueries({
    queries: directories.map((path) => ({ queryKey: key("tree", path), enabled: active, queryFn: () => api.editorTree(path), retry: false })),
  });
  const children = new Map(directories.map((path, i) => [path, queries[i]?.data?.entries]));
  function entries(path: string): Entry[] {
    return (children.get(path) ?? []).filter(({ name }) => hidden || !name.startsWith(".")).map(({ kind, name }) => {
      const id = join(path, name);
      return { id, name, children: kind === "directory" ? entries(id) : undefined };
    });
  }
  const data = entries("");
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.height > 0) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function loadDirectory(path: string) {
    setDirectories((previous) => previous.includes(path) ? previous : [...previous, path]);
  }
  const [reveal, setReveal] = useState<string>();
  useEffect(() => {
    if (reveal && tree.current?.get(reveal)) {
      tree.current.open(reveal);
      setReveal(undefined);
    }
  }, [data, reveal]);
  const change = useMutation({
    mutationFn: ({ action, path, destination }: { action: FileAction; path: string; destination?: string }) =>
      api.changeEditorPath(action, path, destination),
    onSuccess: ({ path: result }, { action, path, destination }) => {
      setPrompt(undefined);
      if (action === "move" || action === "delete") {
        setDirectories((previous) => previous.filter((dir) => dir !== path && !dir.startsWith(path + "/")));
        setFocus("");
      }
      if (action !== "delete") {
        const parent = parentOf(result);
        if (parent) tree.current?.open(parent);
        loadDirectory(parent);
        if (action === "folder") {
          loadDirectory(result);
          setReveal(result);
        }
        setFocus(result);
      }
      if (action === "move" && clipboard?.path === path) setClipboard(undefined);
      onChange(action, path, destination);
      void qc.invalidateQueries({ queryKey: key("tree") });
      if (action === "file") onOpen(result);
    },
    onError: (err) => setError(err.message),
  });
  function changePath(action: FileAction, path: string, destination?: string) {
    setError("");
    if ((action === "move" || action === "delete") && !canChange(path)) {
      setError(tr("请先保存或关闭此路径中的未保存文件。"));
      return;
    }
    change.mutate({ action, path, destination });
  }
  function ask(action: FileAction, parent: string, path = "") {
    setError("");
    const titles = {
      file: tr("新建文件"), folder: tr("新建文件夹"), move: tr("重命名"),
      copy: tr("复制到这里"), delete: tr("删除此路径？"),
    };
    const initial = path ? nameOf(path) : "";
    setName(initial);
    setPrompt({ action, path, parent, name: initial, title: titles[action] });
  }
  function paste(parent: string) {
    if (!clipboard) return;
    if (clipboard.action === "copy" && parentOf(clipboard.path) === parent) {
      ask("copy", parent, clipboard.path);
    } else {
      changePath(clipboard.action, clipboard.path, join(parent, nameOf(clipboard.path)));
    }
  }
  function menu(path: string, directory: boolean) {
    const parent = directory ? path : parentOf(path);
    const item = "cursor-default rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-40";
    return (
      <Menu.Portal>
        <Menu.Content className="z-50 min-w-36 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          <Menu.Item className={item} onSelect={() => ask("file", parent)}>{tr("新建文件")}</Menu.Item>
          <Menu.Item className={item} onSelect={() => ask("folder", parent)}>{tr("新建文件夹")}</Menu.Item>
          {path && <>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item className={item} onSelect={() => ask("move", parentOf(path), path)}>{tr("重命名")}</Menu.Item>
            <Menu.Item className={item} onSelect={() => setClipboard({ action: "move", path })}>{tr("剪切")}</Menu.Item>
            <Menu.Item className={item} onSelect={() => setClipboard({ action: "copy", path })}>{tr("复制")}</Menu.Item>
          </>}
          <Menu.Item className={item} disabled={!clipboard} onSelect={() => paste(parent)}>{tr("粘贴")}</Menu.Item>
          {path && <Menu.Item className={cn(item, "text-loss")} onSelect={() => ask("delete", parent, path)}>{tr("删除")}</Menu.Item>}
        </Menu.Content>
      </Menu.Portal>
    );
  }
  const toolbarPath = tree.current?.get(focus)?.isInternal ? focus : parentOf(focus);
  const validName = !!name.trim() && !/[\/]/.test(name) && name !== "." && name !== ".."
    && !(prompt?.action === "move" && name === prompt.name);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
        <span className="truncate text-xs text-muted-foreground" title={toolbarPath}>{toolbarPath || tr("策略文件")}</span>
        <div className="flex shrink-0">
          <Button variant="ghost" size="icon" className="size-7" title={tr("显示隐藏文件")} aria-label={tr("显示隐藏文件")}
            aria-pressed={hidden} onClick={() => {
              setHidden(!hidden);
              localStorage.setItem(hiddenKey, String(!hidden));
            }}>{hidden ? <Eye /> : <EyeOff />}</Button>
          <Button variant="ghost" size="icon" className="size-7" title={tr("新建文件")} aria-label={tr("新建文件")}
            onClick={() => ask("file", toolbarPath)}><FilePlus /></Button>
          <Button variant="ghost" size="icon" className="size-7" title={tr("新建文件夹")} aria-label={tr("新建文件夹")}
            onClick={() => ask("folder", toolbarPath)}><FolderPlus /></Button>
        </div>
      </div>
      {!prompt && error && <Alert tone="loss">{error}</Alert>}
      <Menu.Root>
        <Menu.Trigger asChild>
          <div ref={viewport} className="min-h-32 flex-1 overflow-hidden" onKeyDownCapture={(event) => {
            const node = tree.current?.focusedNode;
            if (!node || (event.key !== "F2" && event.key !== "Delete")) return;
            event.preventDefault();
            event.stopPropagation();
            ask(event.key === "F2" ? "move" : "delete", parentOf(node.id), node.id);
          }}>
            {queries[0]?.isPending ? <LoadingState rows={2} /> : queries[0]?.error ?
              <Alert tone="loss">{queries[0]?.error.message}</Alert> : data.length === 0 ?
              <p className="p-3 text-xs text-muted-foreground">{tr("文件夹为空")}</p> : (
              <Tree<Entry> ref={tree} data={data} width="100%" height={height} rowHeight={29}
                indent={16} openByDefault={false} selection={focus || selected} disableMultiSelection
                onToggle={loadDirectory}
                onFocus={(node) => {
                  setFocus(node.id);
                  onDirectory(node.isInternal ? node.id : parentOf(node.id));
                }}
                onActivate={(node) => { if (node.isLeaf) onOpen(node.id); }}
                disableDrop={({ parentNode, dragNodes }) =>
                  dragNodes.length !== 1 || parentOf(dragNodes[0]?.id ?? "") === (parentNode.isRoot ? "" : parentNode.id)}
                onMove={({ dragIds, parentId }) => {
                  const path = dragIds[0];
                  if (path) changePath("move", path, join(parentId ?? "", nameOf(path)));
                }}>
                {({ node, style, dragHandle }) => (
                  <Menu.Root>
                    <Menu.Trigger asChild>
                      <div ref={dragHandle} style={style} title={node.id}
                        className={cn("flex h-full cursor-default items-center gap-1.5 pr-2 text-sm outline-none hover:bg-accent/60",
                          (node.isSelected || node.id === selected) && "bg-accent text-accent-foreground")}
                        onClick={() => {
                          node.select();
                          if (node.isInternal) node.toggle();
                          else onOpen(node.id);
                        }}>
                        {node.isInternal ? <>
                          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground", node.isOpen && "rotate-90")} />
                          {node.isOpen ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
                        </> : <FileCode className="ml-[1.125rem] size-4 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{node.data.name}</span>
                      </div>
                    </Menu.Trigger>
                    {menu(node.id, node.isInternal)}
                  </Menu.Root>
                )}
              </Tree>
            )}
          </div>
        </Menu.Trigger>
        {menu("", true)}
      </Menu.Root>
      <Dialog open={!!prompt && prompt.action !== "delete"} onOpenChange={(open) => { if (!open) setPrompt(undefined); }}>
        <DialogContent title={prompt?.title ?? ""} description={prompt?.parent || tr("工作区根目录")}>
          <form className="grid gap-3" onSubmit={(event) => {
            event.preventDefault();
            if (!prompt || !validName || change.isPending) return;
            const target = join(prompt.parent, name);
            if (prompt.action === "file" || prompt.action === "folder") changePath(prompt.action, target);
            else changePath(prompt.action, prompt.path, target);
          }}>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus
              aria-label={tr("名称")} maxLength={255} />
            {error && <Alert tone="loss">{error}</Alert>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPrompt(undefined)}>{tr("取消")}</Button>
              <Button type="submit" loading={change.isPending} disabled={!validName}>{tr("确定")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={prompt?.action === "delete"} onOpenChange={(open) => { if (!open) setPrompt(undefined); }}
        title={tr("删除此路径？")} description={prompt?.path} confirmLabel={tr("删除")} destructive
        loading={change.isPending} onConfirm={() => { if (prompt) changePath("delete", prompt.path); }}>
        {error && <Alert tone="loss">{error}</Alert>}
      </ConfirmDialog>
    </div>
  );
}

export function WorkspaceSearch({ onOpen }: { onOpen: (path: string, line?: number) => void }) {
  const { active, api, key } = useWorkspace();
  const [text, setText] = useState("");
  const [content, setContent] = useState(false);
  const [ignored, setIgnored] = useState(false);
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: key("search", term, content, ignored),
    queryFn: () => api.searchWorkspace(term, content, ignored),
    enabled: active && !!term,
    retry: false,
  });
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" value={text} onChange={(event) => setText(event.target.value)}
          placeholder={tr("搜索工作区")} aria-label={tr("搜索工作区")} maxLength={200} />
      </div>
      <div className="flex gap-1" role="group" aria-label={tr("搜索范围")}>
        <Button size="sm" variant={content ? "ghost" : "secondary"} onClick={() => setContent(false)}>{tr("文件名")}</Button>
        <Button size="sm" variant={content ? "secondary" : "ghost"} onClick={() => setContent(true)}>{tr("文件内容")}</Button>
      </div>
      <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <input type="checkbox" checked={ignored} onChange={(event) => setIgnored(event.target.checked)} />
        {tr("包含被忽略的文件")}
      </label>
      {term && results.isPending && <LoadingState rows={2} />}
      {results.error && <Alert tone="loss">{results.error.message}</Alert>}
      {results.data?.length === 0 && <p className="px-1 text-xs text-muted-foreground">{tr("没有匹配结果")}</p>}
      <div className="min-h-0 overflow-auto">
        {results.data?.map(({ path, line, text }) => (
          <button key={path} className="grid w-full cursor-pointer gap-0.5 rounded-md px-2 py-1 text-left hover:bg-accent"
            title={path} onClick={() => onOpen(path, line)}>
            <span className="truncate text-xs">{path}{line && ":" + line}</span>
            {text && <code className="truncate text-xs text-muted-foreground">{text}</code>}
          </button>
        ))}
      </div>
    </div>
  );
}
