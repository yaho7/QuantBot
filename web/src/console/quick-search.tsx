import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { strategyApi, workbenchPath, type Detail, type Strategy } from "./api";
import { type ControlRegistryView } from "./dynamic-controls";
import { controlWidgets } from "./workbench-controls";
import { Dialog, useData } from "./ui";

export function QuickSearch({ strategyId }: { strategyId?: string }) {
  const [open, setOpen] = useState(false);
  const strategies = useData<Strategy[]>("strategies", open);
  const detail = useData<Detail>(strategyApi(strategyId ?? ""), open && !!strategyId);
  const controls = useData<ControlRegistryView>(strategyApi(strategyId ?? "", "controls"), open && !!strategyId);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const go = (hash: string) => { location.hash = hash; setOpen(false); };
  return <>
    <button type="button" className="icon-button" aria-label="快捷搜索" title="快捷搜索 (Ctrl/⌘ K)" onClick={() => setOpen(true)}><Search size={18} /></button>
    {open && <Dialog title="快捷搜索" close={() => setOpen(false)}>
      <Command label="搜索策略、控件与页面">
        <Command.Input autoFocus placeholder="搜索策略、控件与页面" aria-label="搜索策略、控件与页面" />
        <Command.List>
          <Command.Empty>没有匹配结果</Command.Empty>
          <Command.Group heading="页面">
            {[["工作台", "#workbench"], ["策略", "#strategies"], ["操作记录", "#operations"], ["通知", "#telegram"], ["设置", "#system"]].map(([label, path]) =>
              <Command.Item key={path} onSelect={() => go(path!)}>{label}</Command.Item>)}
          </Command.Group>
          <Command.Group heading="策略">
            {strategies.data?.filter((item) => !item.archived_at).map((item) =>
              <Command.Item key={item.id} value={item.id} keywords={[item.name]} onSelect={() => go(workbenchPath(item.id))}>{item.name}</Command.Item>)}
          </Command.Group>
          {detail.data && <Command.Group heading="当前策略控件">
            {controlWidgets(detail.data, controls.data).map((item) =>
              <Command.Item key={item.id} value={item.id} keywords={[item.title, ...(item.kind === "entry" ? ["暂停新开仓", "恢复新开仓"] : [])]}
                onSelect={() => go(`${workbenchPath(detail.data!.id)}/${encodeURIComponent(item.ref ?? item.kind)}`)}>{item.title}</Command.Item>)}
          </Command.Group>}
        </Command.List>
      </Command>
    </Dialog>}
  </>;
}
