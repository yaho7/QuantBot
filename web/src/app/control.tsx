import { useEffect, useState } from "react";
import * as Switch from "@radix-ui/react-switch";
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
import { Badge, ErrorView, Loading, Modal, shown } from "../shared/ui";
import { useLanguage } from "../shared/i18n";

export function ControlPanel({
  strategyId,
  editing = false,
}: {
  strategyId: string;
  editing?: boolean;
}) {
  const query = useQuery(
    resource<Registry>("/strategies/" + strategyId + "/controls"),
  );
  const { t } = useLanguage();
  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorView error={query.error} retry={() => void query.refetch()} />;
  return (
    <div className="controls-grid">
      {!query.data.controls.length && (
        <p className="empty-inline">{t("noControls")}</p>
      )}
      {query.data.controls.map((control) => (
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
}: {
  control: Control;
  strategyId: string;
  registry: Registry;
  editing?: boolean;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<unknown>(
    initialValue(control, control.actual?.value),
  );
  const [key, setKey] = useState(crypto.randomUUID());
  const [command, setCommand] = useState<Command>();
  const readOnly =
    control.readOnly ||
    control.kind === "status" ||
    control.kind === "metricDisplay";
  const blocked =
    editing ||
    readOnly ||
    !registry.current ||
    control.disabled ||
    !control.actual?.available ||
    !!(control.desired && activeStates.includes(control.desired.status));
  const submit = useMutation({
    mutationFn: () =>
      api<Command>(
        "/strategies/" + strategyId + "/commands",
        "POST",
        { controlId: control.id, revision: registry.revision, input: value },
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
      <header>
        <h3>{control.title}</h3>
        {control.risk && (
          <Badge
            tone={["high", "critical"].includes(control.risk) ? "warning" : ""}
          >
            {control.risk}
          </Badge>
        )}
      </header>
      {control.description && <p className="muted">{control.description}</p>}
      <dl className="control-values">
        <dt>{t("actual")}</dt>
        <dd>{shown(control.actual?.value)}</dd>
        <dt>{t("desired")}</dt>
        <dd>{shown(control.desired?.value)}</dd>
      </dl>
      {control.actual?.reason && (
        <p className="warning">{control.actual.reason}</p>
      )}
      {control.desired && (
        <Badge tone={control.desired.status === "unknown" ? "danger" : ""}>
          {t(control.desired.status as "pending")}
        </Badge>
      )}
      {!readOnly && (
        <button
          disabled={blocked}
          onClick={() => {
            setValue(initialValue(control, control.actual?.value));
            setKey(crypto.randomUUID());
            setCommand(undefined);
            submit.reset();
            confirm.reset();
            setOpen(true);
          }}
        >
          {t("execute")}
          <ArrowUpRight size={15} />
        </button>
      )}
      {!registry.current && <small className="muted">{t("unavailable")}</small>}
      <Modal
        title={control.title}
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
              <dt>Strategy</dt>
              <dd>{strategyId}</dd>
              <dt>{t("desired")}</dt>
              <dd>{shown(command.input)}</dd>
            </dl>
            <button
              className="primary"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              {t("confirm")}
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            {control.description && <p>{control.description}</p>}
            <ControlInput
              definition={control}
              value={value}
              onChange={setValue}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </button>
              <button className="primary" disabled={submit.isPending}>
                {t("execute")}
              </button>
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
function initialValue(d: Definition, actual: unknown): unknown {
  if (actual !== undefined && actual !== null) return actual;
  if (d.kind === "button") return null;
  if (d.kind === "toggle") return false;
  if (d.kind === "multiSelect") return [];
  if (d.kind === "form")
    return Object.fromEntries(
      (d.fields ?? []).map((f) => [f.id, initialValue(f, undefined)]),
    );
  return d.min ?? d.options?.[0]?.value ?? "";
}
function ControlInput({
  definition: d,
  value,
  onChange,
}: {
  definition: Definition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (d.kind === "button") return null;
  if (d.kind === "toggle")
    return (
      <label className="switch-label">
        {d.title}
        <Switch.Root
          className="switch"
          checked={value === true}
          onCheckedChange={onChange}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </label>
    );
  if (d.kind === "form")
    return (
      <div className="form-fields">
        {d.fields?.map((field) => (
          <ControlInput
            key={field.id}
            definition={field}
            value={(value as Record<string, unknown>)[field.id]}
            onChange={(next) =>
              onChange({ ...(value as object), [field.id]: next })
            }
          />
        ))}
      </div>
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
        type={d.kind === "slider" ? "range" : "text"}
        inputMode={d.kind === "textInput" ? "text" : "decimal"}
        min={d.min}
        max={d.max}
        step={d.step}
        maxLength={d.maxLength || 4096}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
      {d.kind === "slider" && <output>{String(value)}</output>}
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
            <dd>{shown(query.data.input)}</dd>
            <dt>ID</dt>
            <dd>{query.data.id}</dd>
          </dl>
          <ol className="timeline">
            {query.data.transitions?.map((entry, i) => (
              <li key={i}>
                <strong>{t(entry.status as "pending")}</strong>
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <p>{entry.reason}</p>
              </li>
            ))}
          </ol>
          {query.data.receipt && (
            <p>{query.data.receipt.message ?? query.data.receipt.status}</p>
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
