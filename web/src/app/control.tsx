import { CommandProgress } from "../components/command-progress";
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Slider } from "@astryxdesign/core/Slider";
import { Switch } from "@astryxdesign/core/Switch";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  client,
  resource,
  activeStates,
  type Control,
  type Definition,
  type Registry,
  type Command,
} from "../shared/api";
import { Badge, ErrorView, Loading, Modal } from "../shared/ui";
import { useDisplay } from "../shared/display";
import { useLanguage } from "../shared/i18n";

function submitPendingGuard(command: Command | undefined, control: Control) {
  const status = control.desired?.commandId === command?.id ? control.desired?.status : command?.status;
  return status === "unknown" || control.desired?.status === "unknown" || !!(status && activeStates.includes(status));
}
export function ControlPanel({
  strategyId,
  editing = false,
  exclude,
}: {
  strategyId: string;
  editing?: boolean;
  exclude?: ReadonlySet<string>;
}) {
  const query = useQuery(
    resource<Registry>("/strategies/" + strategyId + "/controls"),
  );
  const { t } = useLanguage();
  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorView error={query.error} retry={() => void query.refetch()} />;
  const controls = query.data.controls.filter(
    (control) => !exclude?.has(control.id),
  );
  return (
    <div className="controls-grid">
      {!controls.length && <p className="empty-inline">{t("noControls")}</p>}
      {controls.map((control) => (
        <ControlCard
          key={control.id}
          control={control}
          strategyId={strategyId}
          registry={query.data}
          editing={editing}
        />
      ))}
    </div>
  );
}
export function ControlCard({
  control,
  strategyId,
  registry,
  editing = false,
  embedded = false,
}: {
  control: Control;
  strategyId: string;
  registry: Registry;
  editing?: boolean;
  embedded?: boolean;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<unknown>(
    editValue(control, control.actual?.value),
  );
  const [key, setKey] = useState(crypto.randomUUID());
  const [inputError, setInputError] = useState(false);
  const [command, setCommand] = useState<Command>();
  const readOnly =
    control.readOnly ||
    control.kind === "status" ||
    control.kind === "metricDisplay";
  // Render declared parameters in the widget itself; preserve trusted command confirmation.
  const inlineParameter = embedded && control.capability?.kind === "parameter" && !readOnly;
  const blocked =
    editing ||
    submitPendingGuard(command, control) ||
    readOnly ||
    !registry.current ||
    control.disabled ||
    !control.actual?.available ||
    !!(
      control.capability?.stale_after_seconds &&
      Date.now() - control.actual.observedAt >=
        control.capability.stale_after_seconds * 1000
    ) ||
    !!(control.desired && activeStates.includes(control.desired.status));
  const submit = useMutation({
    mutationFn: (input: unknown) =>
      api<Command>(
        "/strategies/" + strategyId + "/commands",
        "POST",
        { controlId: control.id, revision: registry.revision, input },
        key,
      ),
    onSuccess: (data) => {
      setCommand(data);
      void client.invalidateQueries({
        queryKey: ["/strategies/" + strategyId + "/controls"],
      });
      if (data.status !== "confirmation_required") {
        toast.success(t("submitted"));
        setOpen(false);
      }
    },
  });
  const confirm = useMutation({
    mutationFn: () =>
      api<Command>("/commands/" + command!.id + "/confirm", "POST"),
    onSuccess: () => {
      toast.success(t("submitted"));
      setOpen(false);
      void client.invalidateQueries();
    },
  });
  return (
    <article className="control-card">
      {(!embedded || control.risk) && (
        <header>
          {!embedded && <h3>{control.title}</h3>}
          {control.risk && (
            <Badge
              tone={
                ["high", "critical"].includes(control.risk) ? "warning" : ""
              }
            >
              {display.risk(control.risk)}
            </Badge>
          )}
        </header>
      )}
      {control.description && <p className="muted">{control.description}</p>}
      <dl className="control-values">
        <dt>{t("actual")}</dt>
        <dd>{display.value(control.actual?.value, control)}</dd>
        <dt>{t("desired")}</dt>
        <dd>{display.value(control.desired?.value, control)}</dd>
      </dl>
      {control.actual?.reason && (
        <p className="warning">{control.actual.reason}</p>
      )}
      {control.desired && <CommandProgress desired={control.desired} />}
      {inlineParameter && (
        <fieldset className="qb-inline-parameter" disabled={blocked}>
          <ControlInput definition={control} value={value} disabled={blocked} onChange={setValue} />
        </fieldset>
      )}
      {!readOnly && (
        <button
          disabled={blocked}
          onClick={() => {
            if (!inlineParameter) setValue(
              editValue(
                control,
                control.capability?.kind === "action"
                  ? undefined
                  : control.actual?.value,
              ),
            );
            setInputError(false);
            setKey(crypto.randomUUID());
            setCommand(undefined);
            submit.reset();
            confirm.reset();
            setOpen(true);
          }}
        >
          {inlineParameter ? t("confirm") : t("execute")}
          <ArrowUpRight size={15} />
        </button>
      )}
      {!registry.current && <small className="muted">{t("unavailable")}</small>}
      <Modal
        title={control.title}
        purpose="form"
        open={open}
        onOpenChange={(value) => {
          if (!submit.isPending && !confirm.isPending) setOpen(value);
        }}
      >
        {command?.status === "confirmation_required" ? (
          <>
            <p className="warning">
              <AlertTriangle size={18} />
              {t("confirmationRequired")}
            </p>
            <p>{t("confirmHint")}</p>
            <dl className="compact-dl">
              <dt>{t("strategy")}</dt>
              <dd>{strategyId}</dd>
              <dt>{t("desired")}</dt>
              <dd>{display.value(command.input, control)}</dd>
            </dl>
            <Button label={t("confirm")} variant="primary" isLoading={confirm.isPending} onClick={() => confirm.mutate()} />
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (submit.isPending) return;
              try {
                const input = submittedValue(control, value);
                setInputError(false);
                submit.mutate(input);
              } catch {
                setInputError(true);
              }
            }}
          >
            {control.description && <p>{control.description}</p>}
            <ControlInput
              definition={control}
              value={value}
              onChange={setValue}
            />
            {inputError && (
              <span className="error-text" role="alert">
                {t("invalidJSON")}
              </span>
            )}
            {control.capability?.unit && (
              <small className="muted">{control.capability.unit}</small>
            )}
            <div className="dialog-actions">
              <Button label={t("cancel")} isDisabled={submit.isPending} onClick={() => setOpen(false)} />
              <Button type="submit" label={t("execute")} variant="primary" isLoading={submit.isPending} />
            </div>
          </form>
        )}
        {(submit.error || confirm.error) && (
          <p className="error-text" role="alert">
            {(submit.error || confirm.error)?.message}
          </p>
        )}
      </Modal>
    </article>
  );
}
function usesJSONInput(definition: Definition) {
  const capability = definition.capability;
  if (
    !capability ||
    capability.atomic_parameters?.length ||
    definition.kind !== "form"
  )
    return false;
  const schema = capability.input_schema ?? capability.value_schema;
  return (
    !!schema &&
    (schema.type !== "object" ||
      Object.keys(schema.properties ?? {}).length !==
        (definition.fields?.length ?? 0) ||
      (schema.required?.length ?? 0) !== (definition.fields?.length ?? 0))
  );
}

function editValue(d: Definition, actual: unknown): unknown {
  const schema = d.capability?.input_schema ?? d.capability?.value_schema;
  if (usesJSONInput(d)) {
    const fallback =
      schema?.type === "null"
        ? null
        : schema?.type === "boolean"
          ? false
          : schema?.type === "array" || schema?.type === "string_list"
            ? []
            : schema?.type === "object"
              ? {}
              : "";
    return JSON.stringify(actual ?? fallback, null, 2);
  }
  if (d.kind === "form") {
    const fields = (actual ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      (d.fields ?? []).map((field) => [
        field.id,
        editValue(field, fields[field.id]),
      ]),
    );
  }
  if (actual !== undefined && actual !== null) return actual;
  if (d.kind === "button") return null;
  if (d.kind === "toggle") return false;
  if (d.kind === "multiSelect") return [];
  return d.min ?? d.options?.[0]?.value ?? "";
}

function submittedValue(d: Definition, value: unknown): unknown {
  if (usesJSONInput(d)) return JSON.parse(String(value));
  if (d.kind === "form") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      (d.fields ?? []).map((field) => [
        field.id,
        submittedValue(field, fields[field.id]),
      ]),
    );
  }
  return value;
}
function ControlInput({
  definition: d,
  value,
  disabled,
  onChange,
}: {
  definition: Definition;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useLanguage();
  if (d.kind === "button") return null;
  if (usesJSONInput(d)) {
    return (
      <label>
        {d.capability?.kind === "parameter" ? d.title : t("commandInput")}
        <textarea
          rows={6}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  if (d.kind === "toggle") {
    return <Switch label={d.title} labelPosition="start" labelSpacing="spread" width="100%"
      value={value === true} isDisabled={disabled} onChange={onChange} />;
  }
  if (d.kind === "slider") {
    const min = Number(d.min ?? 0);
    const max = Number(d.max ?? 100);
    const current = value == null || value === "" ? min : Number(value);
    if (Number.isFinite(min) && Number.isFinite(max) && min < max && Number.isFinite(current)) {
      return <Slider label={d.title} min={min} max={max} step={Number(d.step ?? 1)} width="100%"
        value={Math.min(max, Math.max(min, current))} valueDisplay="text" isDisabled={disabled}
        onChange={(next: number) => onChange(String(next))} />;
    }
  }
  if (d.kind === "form")
    return (
      <VStack className="form-fields" gap={3}>
        {d.fields?.map((field) => (
          <ControlInput
            key={field.id}
            definition={field}
            disabled={disabled}
            value={
              (value as Record<string, unknown> | null)?.[field.id] ??
              editValue(field, undefined)
            }
            onChange={(next) =>
              onChange({ ...(value as object), [field.id]: next })
            }
          />
        ))}
      </VStack>
    );
  if (d.kind === "select" || d.kind === "multiSelect")
    return (
      <label>
        {d.title}
        <select
          multiple={d.kind === "multiSelect"}
          value={value as string | string[]}
          onChange={(e) =>
            onChange(
              d.kind === "multiSelect"
                ? Array.from(e.target.selectedOptions, (option) => option.value)
                : e.target.value,
            )
          }
        >
          {d.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  // Keep decimals as strings through the entire control request.
  return (
    <label>
      {d.title}
      <input
        required
        type="text"
        inputMode={d.kind === "textInput" ? "text" : "decimal"}
        min={d.min}
        max={d.max}
        step={d.step}
        maxLength={d.maxLength || 4096}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function CommandDialog({
  commandId,
  close,
}: {
  commandId: string;
  close: () => void;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const query = useQuery(resource<Command>("/commands/" + commandId));
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState("succeeded");
  const action = useMutation({
    mutationFn: (name: string) =>
      api(
        "/commands/" + commandId + "/" + name,
        "POST",
        name === "reconcile" ? { status: outcome, note } : undefined,
      ),
    onSuccess: () => {
      void client.invalidateQueries();
    },
  });
  useEffect(() => {
    setNote("");
  }, [commandId]);
  return (
    <Modal
      title={t("activity")}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <>
          <p>
            <strong>{query.data.controlId}</strong>{" "}
            <Badge>{t(query.data.status as "pending")}</Badge>
          </p>
          <dl className="compact-dl">
            <dt>{t("desired")}</dt>
            <dd>{display.value(query.data.input)}</dd>
            <dt>ID</dt>
            <dd>{query.data.id}</dd>
          </dl>
          <ol className="timeline">
            {query.data.transitions?.map((entry, i) => (
              <li key={i}>
                <strong>{t(entry.status as "pending")}</strong>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <p>{display.reason(entry.reason)}</p>
              </li>
            ))}
          </ol>
          {query.data.receipt && (
            <p>{query.data.receipt.message ?? t(query.data.receipt.status as "succeeded")}</p>
          )}
          {query.data.status === "confirmation_required" && (
            <button
              className="primary"
              onClick={() => action.mutate("confirm")}
            >
              {t("confirm")}
            </button>
          )}
          {["confirmation_required", "pending", "accepted"].includes(
            query.data.status,
          ) && (
            <button onClick={() => action.mutate("cancel")}>
              {t("cancel")}
            </button>
          )}
          {query.data.status === "unknown" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.mutate("reconcile");
              }}
            >
              <label>
                {t("reconcile")}
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  <option value="succeeded">{t("succeeded")}</option>
                  <option value="failed">{t("failed")}</option>
                </select>
              </label>
              <label>
                {t("note")}
                <textarea
                  required
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button disabled={action.isPending}>{t("save")}</button>
            </form>
          )}
        </>
      )}
      {action.error && (
        <p role="alert" className="error-text">
          {action.error.message}
        </p>
      )}
    </Modal>
  );
}
