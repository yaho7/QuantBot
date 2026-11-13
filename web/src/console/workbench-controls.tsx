import { t } from "../i18n";
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
    { id: "builtin-entry", kind: "entry", title: t("operations.entryPermissionsAndRiskControls") },
    { id: "builtin-program", kind: "program", title: t("workbenchControls.agentStatus") },
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
      <div>{t("workbenchControls.brokerConnection")}{" "}{connected == null ? t("operations.unknown") : connected ? t("settings.connected") : t("strategy.disconnected")}</div>
      {expanded && agent && <span className="subtle">{t("onboarding.instance")}{" "}{agent.instance_id}</span>}
    </div>;
  }
  if (widget.kind === "control") {
    const definition = registry?.controls.find((item) => item.id === widget.ref && !entryBinding(item.command));
    return definition && registry ? <DynamicControl {...{ strategy, registry, definition, expanded }}
      operation={(command, close) => <OperationView command={command} strategy={strategy.name} close={close} />} /> :
      <Empty title={t("workbenchControls.theCurrentExecutorDoesNotProvideThis")} />;
  }
  const capability = strategy.capabilities.find((item) => item.id === widget.ref &&
    !entryBinding(item.id) && !registry?.controls.some((control) => control.command === item.id));
  if (!capability) return <Empty title={t("workbenchControls.theCurrentExecutorDoesNotProvideThisText")} />;
  const risky = capability.high_risk || capability.id !== "refresh";
  return <>
    <button type="button" className="button secondary" onClick={() => setOpen(true)}
      disabled={!ready || !!strategy.archived_at || !strategy.executor_online ||
        (strategy.mode === "live" && risky && !strategy.live_trading_enabled)}>
      {t("dynamicControls.run")}{" "}{capability.label}
    </button>
    {open && <CommandDialog {...{ capability, strategy }} close={() => setOpen(false)} />}
  </>;
}
