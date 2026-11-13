import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot, ListChecks, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
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
  if (value == null) return "未上报";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${definition.fields?.[key]?.label ?? key} ${item}`).join(" · ");
  return definition.options?.find((option) => option.value === value)?.label ??
    `${value}${definition.unit ? ` ${definition.unit}` : ""}`;
}

export function DynamicControls({ strategy, registry, error, loading, operation }: {
  strategy: Detail; registry?: ControlRegistryView; error: unknown; loading: boolean;
  operation: (command: Command, close: () => void) => ReactNode;
}) {
  const [selected, setSelected] = useState<{ definition: Definition; revision: number }>();
  const groups = registry ? [{ id: null, label: "常规", order: -1 }, ...registry.groups]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((group) => ({ ...group, controls: registry.controls.filter((item) => item.group === group.id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) }))
    .filter((group) => group.controls.length) : [];
  const state = selected && registry?.states[selected.definition.id];
  return <Panel title="控制面板" hint={registry?.revision ? `注册版本 ${registry.revision}` : undefined}
    action={<SlidersHorizontal size={20} />}>
    <ErrorNotice error={error} />
    {loading ? <Loading /> : !registry?.controls.length ? <Empty title="策略尚未注册动态控件"
      text="程序可以通过 PUT /api/agent/controls 声明控制组件。" /> :
      <div className="stack">{groups.map((group) => <section key={group.id ?? "general"} className="stack control-group">
        <h3>{group.label}</h3><div className="control-grid">{group.controls.map((definition) => {
          const report = registry.states[definition.id];
          const disabled = !report?.available;
          return <article key={definition.id} className="control-card">
            <div><span className="control-icon">{definition.type === "form" ? <ListChecks size={17} /> : <CircleDot size={17} />}</span>
              <h4>{definition.label}</h4></div>
            {definition.description && <p>{definition.description}</p>}
            {definition.type !== "button" && <p className="actual-value">
              {report?.value_stale ? "上次上报" : "实际值"} <strong>{actual(definition, report?.value)}</strong>
            </p>}
            {report?.unavailable_reason && <p role="status">{report.unavailable_reason}</p>}
            {definition.type !== "readonly" && <button type="button" className="button secondary"
              aria-label={`${definition.type === "button" ? "执行" : "修改"} ${definition.label}`}
              disabled={disabled} onClick={() => setSelected({ definition, revision: registry.revision })}>
              {definition.type === "button" ? "执行" : "修改"}{report?.confirmation_required ? " · 需确认" : ""}
            </button>}
          </article>;
        })}</div>
      </section>)}</div>}
    {selected && selected.revision !== registry?.revision &&
      <Dialog title="控制定义已更新" close={() => setSelected(undefined)}>
        <p className="notice warn">请关闭并重新打开控件，检查当前定义后再提交。</p>
      </Dialog>}
    {selected && state && selected.revision === registry?.revision &&
      <Invocation key={`${selected.definition.id}/${selected.revision}`}
        strategy={strategy} definition={selected.definition} report={state} revision={selected.revision}
        close={() => setSelected(undefined)} operation={operation} />}
  </Panel>;
}

function Invocation({ strategy, definition, report, revision, close, operation }: {
  strategy: Detail; definition: Definition; report: Report; revision: number;
  close: () => void; operation: (command: Command, close: () => void) => ReactNode;
}) {
  const client = useQueryClient();
  const [requestId] = useState(() => crypto.randomUUID());
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
    onSuccess: (result) => { setCommand(result); void client.invalidateQueries({ queryKey: ["live"] }); },
  });
  const currentCommand = latest.data ?? command;
  return <Dialog title={definition.label} close={close}>
    {currentCommand ? operation(currentCommand, close) : <form className="stack"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <p className="subtle">目标策略 {strategy.name} · 注册版本 {revision}</p>
      {definition.type !== "button" && <div className="notice">
        {report.value_stale ? "上次上报" : "策略实际值"} {actual(definition, report.value)}
        {report.value_observed_at && ` · ${when(report.value_observed_at)}`}
      </div>}
      {definition.type === "toggle" && <label className="checkbox"><input type="checkbox" role="switch"
        checked={value === true} onChange={(e) => setValue(e.target.checked)} /> 请求开启</label>}
      {definition.type === "select" && <Field label="请求选项"><select required value={String(value ?? "")} onChange={(e) => setValue(e.target.value)}>
        <option value="">请选择</option>{definition.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select></Field>}
      {definition.type === "number" && <Field label="请求数值" hint={[definition.unit, definition.default == null ? "" : `默认 ${definition.default}`].filter(Boolean).join(" · ")}>
        <input type="number" required min={definition.min ?? undefined} max={definition.max ?? undefined}
          step={definition.step ?? (definition.integer ? 1 : "any")} value={String(value ?? "")}
          onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "slider" && <Field label={`请求数值 ${value ?? ""} ${definition.unit ?? ""}`}>
        <input type="range" min={definition.min ?? undefined} max={definition.max ?? undefined}
          step={definition.step ?? undefined} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "text" && <Field label="请求文本" hint={`最多 ${definition.max_length} 个字符`}>
        <input required maxLength={definition.max_length} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
      </Field>}
      {definition.type === "form" && Object.entries(definition.fields ?? {}).map(([name, parameter]) =>
        <ParameterInput key={name} {...{ name, parameter }} value={fields[name]} set={(value) => setFields({ ...fields, [name]: value })} />)}
      {report.confirmation_required && <div className="notice warn">提交后需要再次确认，策略才可领取执行许可。</div>}
      <ErrorNotice error={create.error} />
      <div className="dialog-actions"><button className="button secondary" type="button" onClick={close}>取消</button>
        <button className="button primary" disabled={create.isPending || !report.available}>提交请求</button></div>
    </form>}
  </Dialog>;
}
