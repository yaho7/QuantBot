import { useState } from "react";
import { type Detail } from "./api";
import { type ControlWidget } from "./dashboard-types";
import { DynamicControl, type ControlRegistryView } from "./dynamic-controls";
import { CommandDialog, EntryControl, entryBinding, OperationView } from "./operations";
import { Empty, StatusBadge } from "./ui";

function referenceId(prefix: string, ref: string) {
  const key = `${prefix}-${ref}`;
  if (key.length <= 64) return key;
  let hash = 0;
  for (const character of ref) hash = Math.imul(hash, 31) + character.charCodeAt(0) | 0;
  return `${key.slice(0, 54)}-${(hash >>> 0).toString(36)}`;
}

export function controlWidgets(strategy: Detail, registry?: ControlRegistryView): ControlWidget[] {
  const bound = new Set(registry?.controls.map((item) => item.command));
  return [
    { id: "builtin-entry", kind: "entry", title: "开仓权限与风控" },
    { id: "builtin-program", kind: "program", title: "程序状态" },
    ...(registry?.controls.filter((item) => !entryBinding(item.command)).map((item): ControlWidget =>
      ({ id: referenceId("control", item.id), kind: "control", ref: item.id, title: item.label })) ?? []),
    ...strategy.capabilities.filter((cap) => !entryBinding(cap.id) && !bound.has(cap.id)).map((cap): ControlWidget =>
      ({ id: referenceId("action", cap.id), kind: "capability", ref: cap.id, title: cap.label })),
  ];
}

export function WorkbenchControl({ widget, strategy, registry, ready, expanded }: {
  widget: ControlWidget; strategy: Detail; registry?: ControlRegistryView; ready: boolean; expanded: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (widget.kind === "entry") return <EntryControl {...{ strategy, registry, ready }} />;
  if (widget.kind === "program") {
    const agent = strategy.instances.find((item) => item.instance_id === strategy.executor_id) ?? strategy.instances[0];
    const connected = strategy.status !== "offline" ? agent?.runtime.broker_connected : null;
    return <div className="stack"><StatusBadge status={strategy.status} />
      <div>券商连接 · {connected == null ? "未知" : connected ? "已连接" : "未连接"}</div>
      {expanded && agent && <span className="subtle">实例 {agent.instance_id}</span>}
    </div>;
  }
  if (widget.kind === "control") {
    const definition = registry?.controls.find((item) => item.id === widget.ref && !entryBinding(item.command));
    return definition && registry ? <DynamicControl {...{ strategy, registry, definition, expanded }}
      operation={(command, close) => <OperationView command={command} strategy={strategy.name} close={close} />} /> :
      <Empty title="当前执行实例未提供此控件" />;
  }
  const capability = strategy.capabilities.find((item) => item.id === widget.ref &&
    !entryBinding(item.id) && !registry?.controls.some((control) => control.command === item.id));
  if (!capability) return <Empty title="当前执行实例未提供此独立操作" />;
  const risky = capability.high_risk || capability.id !== "refresh";
  return <>
    <button type="button" className="button secondary" onClick={() => setOpen(true)}
      disabled={!ready || !!strategy.archived_at || !strategy.executor_online ||
        (strategy.mode === "live" && risky && !strategy.live_trading_enabled)}>
      执行 {capability.label}
    </button>
    {open && <CommandDialog {...{ capability, strategy }} close={() => setOpen(false)} />}
  </>;
}
