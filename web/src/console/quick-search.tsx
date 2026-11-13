import { t } from "../i18n";
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
    <button type="button" className="icon-button" aria-label={t("quickSearch.quickSearch")} title={t("quickSearch.quickSearchCtrlK")} onClick={() => setOpen(true)}><Search size={18} /></button>
    {open && <Dialog title={t("quickSearch.quickSearch")} close={() => setOpen(false)}>
      <Command label={t("quickSearch.searchStrategiesControlsAndPages")}>
        <Command.Input autoFocus placeholder={t("quickSearch.searchStrategiesControlsAndPages")} aria-label={t("quickSearch.searchStrategiesControlsAndPages")} />
        <Command.List>
          <Command.Empty>{t("quickSearch.noMatchingResults")}</Command.Empty>
          <Command.Group heading={t("quickSearch.pages")}>
            {[[t("app.workbench"), "#workbench"], [t("app.strategies"), "#strategies"], [t("app.operations"), "#operations"], [t("app.notifications"), "#telegram"], [t("app.settings"), "#system"]].map(([label, path]) =>
              <Command.Item key={path} onSelect={() => go(path!)}>{label}</Command.Item>)}
          </Command.Group>
          <Command.Group heading={t("app.strategies")}>
            {strategies.data?.filter((item) => !item.archived_at).map((item) =>
              <Command.Item key={item.id} value={item.id} keywords={[item.name]} onSelect={() => go(workbenchPath(item.id))}>{item.name}</Command.Item>)}
          </Command.Group>
          {detail.data && <Command.Group heading={t("quickSearch.currentStrategyControls")}>
            {controlWidgets(detail.data, controls.data).map((item) =>
              <Command.Item key={item.id} value={item.id} keywords={[item.title, ...(item.kind === "entry" ? [t("operations.pauseNewEntries"), t("operations.resumeNewEntries")] : [])]}
                onSelect={() => go(`${workbenchPath(detail.data!.id)}/${encodeURIComponent(item.ref ?? item.kind)}`)}>{item.title}</Command.Item>)}
          </Command.Group>}
        </Command.List>
      </Command>
    </Dialog>}
  </>;
}
