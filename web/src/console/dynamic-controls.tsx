import { t, controlReason } from "../i18n";
import * as Switch from "@radix-ui/react-switch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot, ListChecks, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { submitted } from "./command-feedback";
import { api, strategyApi, type Command, type Detail, type Parameter, type Scalar } from "./api";
import { Dialog, Empty, ErrorNotice, Field, Loading, Panel, ParameterInput, useData, when } from "./ui";

type Kind = "button" | "toggle" | "select" | "number" | "slider" | "text" | "form" | "readonly";
interface Definition {
  id: string;
  type: Kind;
  label: string;
  description: string;
  group: string | null;
  order: number;
  command?: string;
  unit?: string | null;
  default?: Scalar;
  options?: { value: string; label: string }[];
  min?: number | string | null;
  max?: number | string | null;
  step?: number | string | null;
  max_length?: number;
  integer?: boolean;
  fields?: Record<string, Parameter>;
}
interface Report {
  value?: Scalar | Record<string, Scalar>;
  value_observed_at?: string;
  value_stale?: boolean;
  available: boolean;
  unavailable_reason?: string | null;
  confirmation_required?: boolean;
}
export interface ControlRegistryView {
  revision: number;
  groups: { id: string; label: string; order: number }[];
  controls: Definition[];
  states: Record<string, Report>;
}

function actual(definition: Definition, value: Report["value"]) {
  if (value == null) return t("dynamicControls.notReported");
  if (typeof value === "boolean") return value ? t("dynamicControls.on") : t("dynamicControls.off");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${definition.fields?.[key]?.label ?? key} ${item}`).join(" · ");
  return definition.options?.find((option) => option.value === value)?.label ??
    `${value}${definition.unit ? ` ${definition.unit}` : ""}`;
}

export function DynamicControls({ strategy, registry, error, loading, operation }: {
  strategy: Detail; registry?: ControlRegistryView; error: unknown; loading: boolean;
  operation: (command: Command, close: () => void) => ReactNode;
}) {
  const groups = registry ? [{ id: null, label: t("dynamicControls.general"), order: -1 }, ...registry.groups]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((group) => ({ ...group, controls: registry.controls.filter((item) => item.group === group.id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) }))
    .filter((group) => group.controls.length) : [];
  return <Panel title={t("dynamicControls.controlPanel")} hint={registry?.revision ? t("dynamicControls.registryRevision", { revision: registry.revision }) : undefined}
    action={<SlidersHorizontal size={20} />}>
    <ErrorNotice error={error} />
    {loading ? <Loading /> : !registry?.controls.length ? <Empty title={t("dynamicControls.noDynamicControlsRegistered")}
      text={t("dynamicControls.theAgentCanPublishControlsWithPut")} /> :
      <div className="stack">{groups.map((group) => <section key={group.id ?? "general"} className="stack control-group">
        <h3>{group.label}</h3><div className="control-grid">{group.controls.map((definition) => {
          return <DynamicControl key={definition.id} strategy={strategy} registry={registry} definition={definition}
            operation={operation} />;
        })}</div>
      </section>)}</div>}
  </Panel>;
}

export function DynamicControl({ strategy, registry, definition, operation, expanded = false }: {
  strategy: Detail; registry: ControlRegistryView; definition: Definition; expanded?: boolean;
  operation: (command: Command, close: () => void) => ReactNode;
}) {
  const [selected, setSelected] = useState<number>();
  const report = registry.states[definition.id];
  const close = () => setSelected(undefined);
  const inline = expanded && report?.available && report.confirmation_required === false &&
    ["slider", "select", "number", "toggle", "text"].includes(definition.type);
  return <article className="control-card">
    <div><span className="control-icon">{definition.type === "form" ? <ListChecks size={17} /> : <CircleDot size={17} />}</span>
      <h4>{definition.label}</h4></div>
    {definition.description && <p>{definition.description}</p>}
    {definition.type !== "button" && <p className="actual-value">
      {report?.value_stale ? t("dynamicControls.lastReported") : t("dynamicControls.actualValue")} <strong>{actual(definition, report?.value)}</strong>
    </p>}
    {report?.unavailable_reason && <p role="status">{controlReason(report.unavailable_reason)}</p>}
    {inline && selected === undefined ? <Invocation key={registry.revision} {...{ strategy, definition, report, operation, close }}
      revision={registry.revision} inline /> : definition.type !== "readonly" && <button type="button" className="button secondary"
      aria-label={`${definition.type === "button" ? t("dynamicControls.run") : t("dynamicControls.edit")} ${definition.label}`}
      disabled={!report?.available} onClick={() => setSelected(registry.revision)}>
      {definition.type === "button" ? t("dynamicControls.run") : t("dynamicControls.edit")}{report?.confirmation_required ? t("dynamicControls.confirmationRequired") : ""}
    </button>}
    {selected !== undefined && (selected !== registry.revision ?
      <Dialog title={t("dynamicControls.controlDefinitionUpdated")} close={close}><p>{t("dynamicControls.reopenThisControlAndReviewItsCurrent")}</p></Dialog> :
      report && <Invocation {...{ strategy, definition, report, operation, close }} revision={selected} />)}
  </article>;
}

function Invocation({ strategy, definition, report, revision, close, operation, inline = false }: {
  strategy: Detail; definition: Definition; report: Report; revision: number;
  inline?: boolean; close: () => void; operation: (command: Command, close: () => void) => ReactNode;
}) {
  const client = useQueryClient();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const starting = report.value != null && typeof report.value !== "object" ? report.value : definition.default;
  const [value, setValue] = useState<Scalar | undefined>(starting ?? (
    definition.type === "toggle" ? false : definition.type === "slider" ? String(definition.min) : undefined));
  const [fields, setFields] = useState<Record<string, Scalar | undefined>>(() =>
    Object.fromEntries(Object.entries(definition.fields ?? {}).map(([key, param]) =>
      [key, (report.value && typeof report.value === "object" ? report.value[key] : undefined) ?? param.default ?? undefined])));
  const [command, setCommand] = useState<Command>();
  const latest = useData<Command>(`commands/${command?.id ?? ""}`, !!command?.id, 3_000);
  const create = useMutation({
    mutationFn: () => api<Command>(strategyApi(strategy.id, `controls/${definition.id}/invoke`), "POST", {
      revision, request_id: requestId,
      ...(definition.type === "form" ? { arguments: fields } : definition.type !== "button" ? { value } : {}),
    }),
    onSuccess: (result) => { setCommand(result); submitted(result); void client.invalidateQueries({ queryKey: ["live"] }); },
  });
  const currentCommand = latest.data ?? command;
  const dismiss = () => {
    setCommand(undefined);
    setRequestId(crypto.randomUUID());
    setValue(starting);
    close();
  };
  const content = currentCommand ? operation(currentCommand, inline ? dismiss : close) : <form className="stack"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      {!inline && <p className="subtle">{t("dynamicControls.targetStrategy")}{" "}{strategy.name} {t("dynamicControls.registryRevisionText")}{" "}{revision}</p>}
      {!inline && definition.type !== "button" && <div className="notice">
        {report.value_stale ? t("dynamicControls.lastReported") : t("dynamicControls.valueReportedByStrategy")} {actual(definition, report.value)}
        {report.value_observed_at && ` · ${when(report.value_observed_at)}`}
      </div>}
      {definition.type === "toggle" && <label className="checkbox"><Switch.Root className="parameter-switch" checked={value === true} onCheckedChange={setValue}><Switch.Thumb /></Switch.Root> {t("dynamicControls.requestEnabled")}</label>}
      {definition.type === "select" && <Field label={t("dynamicControls.requestedOption")}><select required value={String(value ?? "")} onChange={(e) => setValue(e.target.value)}>
        <option value="">{t("dashboardBuilder.selectAnOption")}</option>{definition.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select></Field>}
      {definition.type === "number" && <Field label={t("dynamicControls.requestedValue")} hint={[definition.unit, definition.default == null ? "" : t("dynamicControls.default", { value: definition.default })].filter(Boolean).join(" · ")}>
        <input type="number" required min={definition.min ?? undefined} max={definition.max ?? undefined}
          step={definition.step ?? (definition.integer ? 1 : "any")} value={String(value ?? "")}
          onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "slider" && <Field label={t("dynamicControls.requestedValueText", { value: value ?? "", unit: definition.unit ?? "" })}>
        <input type="range" min={definition.min ?? undefined} max={definition.max ?? undefined}
          step={definition.step ?? undefined} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "text" && <Field label={t("dynamicControls.requestedText")} hint={t("dynamicControls.upToCharacters", { maximum: definition.max_length })}>
        <input required maxLength={definition.max_length} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "form" && Object.entries(definition.fields ?? {}).map(([name, parameter]) =>
        <ParameterInput key={name} {...{ name, parameter }} value={fields[name]} set={(value) => setFields({ ...fields, [name]: value })} />)}
      {report.confirmation_required && <>
        {definition.type !== "button" && <div className="notice">{t("dynamicControls.before")}{" "}{actual(definition, report.value)} {t("dynamicControls.after")}{" "}{actual(definition, definition.type === "form" ?
          Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, Scalar] => entry[1] !== undefined)) : value)}</div>}
        <div className="notice warn">{t("dynamicControls.confirmTheRequestBeforeTheStrategyCan")}</div>
      </>}
      <ErrorNotice error={create.error} />
      <div className="dialog-actions">{!inline && <button className="button secondary" type="button" onClick={close}>{t("dashboardBuilder.cancel")}</button>}
        <button className="button primary" disabled={create.isPending || !report.available}>{inline ? t("dynamicControls.apply") : t("dynamicControls.submitRequest")}</button></div>
    </form>;
  return inline && !currentCommand ? content : <Dialog title={definition.label} close={inline ? dismiss : close}>{content}</Dialog>;
}
