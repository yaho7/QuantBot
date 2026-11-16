import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { useLayoutEditing } from "../shared/layout-editing";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Card } from "@astryxdesign/core/Card";
import { TextArea } from "@astryxdesign/core/TextArea";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
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
  const status =
    control.desired?.commandId === command?.id
      ? control.desired?.status
      : command?.status;
  return (
    status === "unknown" ||
    control.desired?.status === "unknown" ||
    !!(status && activeStates.includes(status))
  );
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
    <VStack
      gap={3}
      className={
        "controls-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" +
        "   grid"
      }
    >
      {!controls.length && (
        <Text as="p" className="empty-inline text-secondary text-center p-6">
          {t("noControls")}
        </Text>
      )}
      {controls.map((control) => (
        <ControlCard
          key={control.id}
          control={control}
          strategyId={strategyId}
          registry={query.data}
          editing={editing}
        />
      ))}
    </VStack>
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
  const { editing: layoutEditing } = useLayoutEditing();
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
  const inlineParameter =
    embedded && control.capability?.kind === "parameter" && !readOnly;
  const blocked =
    editing ||
    layoutEditing ||
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
    <Card
      padding={embedded ? 0 : 4}
      variant={embedded ? "transparent" : "default"}
    >
      <VStack as="article" className="control-card h-full" gap={4}>
        {(!embedded || control.risk) && (
          <HStack as="header" gap={2} hAlign="between" vAlign="center">
            {!embedded && <Heading level={3}>{control.title}</Heading>}
            {control.risk && (
              <Badge
                tone={
                  ["high", "critical"].includes(control.risk) ? "warning" : ""
                }
              >
                {display.risk(control.risk)}
              </Badge>
            )}
          </HStack>
        )}
        {control.description && (
          <Text as="p" className="muted text-secondary">
            {control.description}
          </Text>
        )}
        <dl className="control-values grid grid-cols-2 gap-x-4 gap-y-2 tabular-nums">
          <dt>
            <Text type="supporting">{t("actual")}</Text>
          </dt>
          <dd className="m-0">
            <Text hasTabularNumbers>
              {display.value(control.actual?.value, control)}
            </Text>
          </dd>
          <dt>
            <Text type="supporting">{t("desired")}</Text>
          </dt>
          <dd className="m-0">
            <Text hasTabularNumbers>
              {display.value(control.desired?.value, control)}
            </Text>
          </dd>
        </dl>
        {control.actual?.reason && (
          <Text as="p" className="warning text-warning">
            {control.actual.reason}
          </Text>
        )}
        {control.desired && <CommandProgress desired={control.desired} />}
        {inlineParameter && (
          <fieldset className="qb-inline-parameter" disabled={blocked}>
            <ControlInput
              definition={control}
              value={value}
              disabled={blocked}
              onChange={setValue}
            />
          </fieldset>
        )}
        {!readOnly && (
          <Button
            label={inlineParameter ? t("confirm") : t("execute")}
            endContent={<AstryxIcon icon={ArrowUpRight} size="sm" />}
            isDisabled={blocked}
            onClick={() => {
              if (!inlineParameter)
                setValue(
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
          ></Button>
        )}
        {!registry.current && (
          <Text type="supporting" className="muted text-secondary">
            {t("unavailable")}
          </Text>
        )}
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
              <Text as="p" className="warning text-warning">
                <AstryxIcon icon={AlertTriangle} size="md" />
                {t("confirmationRequired")}
              </Text>
              <Text as="p">{t("confirmHint")}</Text>
              <dl className="compact-dl grid grid-cols-2 gap-x-4 gap-y-2 tabular-nums">
                <dt>
                  <Text type="supporting">{t("strategy")}</Text>
                </dt>
                <dd className="m-0">
                  <Text hasTabularNumbers>{strategyId}</Text>
                </dd>
                <dt>
                  <Text type="supporting">{t("desired")}</Text>
                </dt>
                <dd className="m-0">
                  <Text hasTabularNumbers>
                    {display.value(command.input, control)}
                  </Text>
                </dd>
              </dl>
              <Button
                label={t("confirm")}
                variant="primary"
                isLoading={confirm.isPending}
                onClick={() => confirm.mutate()}
              />
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
              {control.description && <Text as="p">{control.description}</Text>}
              <ControlInput
                definition={control}
                value={value}
                onChange={setValue}
              />
              {inputError && (
                <Text className="error-text text-error" role="alert">
                  {t("invalidJSON")}
                </Text>
              )}
              {control.capability?.unit && (
                <Text type="supporting" className="muted text-secondary">
                  {control.capability.unit}
                </Text>
              )}
              <HStack
                gap={3}
                wrap="wrap"
                vAlign="center"
                className="dialog-actions flex flex-wrap items-center justify-end gap-2"
              >
                <Button
                  label={t("cancel")}
                  isDisabled={submit.isPending}
                  onClick={() => setOpen(false)}
                />
                <Button
                  type="submit"
                  label={t("execute")}
                  variant="primary"
                  isLoading={submit.isPending}
                />
              </HStack>
            </form>
          )}
          {(submit.error || confirm.error) && (
            <Text as="p" className="error-text text-error" role="alert">
              {(submit.error || confirm.error)?.message}
            </Text>
          )}
        </Modal>
      </VStack>
    </Card>
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
      <VStack gap={2}>
        {d.capability?.kind === "parameter" ? d.title : t("commandInput")}
        <TextArea
          label={
            d.capability?.kind === "parameter" ? d.title : t("commandInput")
          }
          isDisabled={disabled}
          rows={6}
          value={String(value)}
          onChange={(event) => onChange(event)}
        />
      </VStack>
    );
  }
  if (d.kind === "toggle") {
    return (
      <Switch
        label={d.title}
        labelPosition="start"
        labelSpacing="spread"
        width="100%"
        value={value === true}
        isDisabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (d.kind === "slider") {
    const min = Number(d.min ?? 0);
    const max = Number(d.max ?? 100);
    const current = value == null || value === "" ? min : Number(value);
    if (
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      min < max &&
      Number.isFinite(current)
    ) {
      return (
        <Slider
          label={d.title}
          min={min}
          max={max}
          step={Number(d.step ?? 1)}
          width="100%"
          value={Math.min(max, Math.max(min, current))}
          valueDisplay="text"
          isDisabled={disabled}
          onChange={(next: number) => onChange(String(next))}
        />
      );
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
  if (d.kind === "select" || d.kind === "multiSelect") {
    const options = d.options ?? [];
    return d.kind === "multiSelect" ? (
      <MultiSelector
        label={d.title}
        options={options}
        value={Array.isArray(value) ? (value as string[]) : []}
        onChange={onChange}
        isDisabled={disabled}
      />
    ) : (
      <Selector
        label={d.title}
        options={options}
        value={String(value ?? "")}
        onChange={onChange}
        isDisabled={disabled}
      />
    );
  }
  // Keep decimals as strings through the entire control request.
  return (
    <VStack gap={2}>
      {d.title}
      <TextInput
        label={d.title}
        isDisabled={disabled}
        isRequired
        type="text"
        inputMode={d.kind === "textInput" ? "text" : "decimal"}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.slice(0, d.maxLength || 4096))}
      />
    </VStack>
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
          <Text as="p">
            <Text weight="semibold">{query.data.controlId}</Text>{" "}
            <Badge>{t(query.data.status as "pending")}</Badge>
          </Text>
          <dl className="compact-dl grid grid-cols-2 gap-x-4 gap-y-2 tabular-nums">
            <dt>
              <Text type="supporting">{t("desired")}</Text>
            </dt>
            <dd className="m-0">
              <Text hasTabularNumbers>{display.value(query.data.input)}</Text>
            </dd>
            <dt>
              <Text type="supporting">ID</Text>
            </dt>
            <dd className="m-0">
              <Text hasTabularNumbers>{query.data.id}</Text>
            </dd>
          </dl>
          <ol className="timeline">
            {query.data.transitions?.map((entry, i) => (
              <li key={i}>
                <Text weight="semibold">{t(entry.status as "pending")}</Text>
                <time>
                  <Text type="supporting">
                    {new Date(entry.at).toLocaleTimeString()}
                  </Text>
                </time>
                <Text as="p">{display.reason(entry.reason)}</Text>
              </li>
            ))}
          </ol>
          {query.data.receipt && (
            <Text as="p">
              {query.data.receipt.message ??
                t(query.data.receipt.status as "succeeded")}
            </Text>
          )}
          {query.data.status === "confirmation_required" && (
            <Button
              label={t("confirm")}
              variant="primary"
              className="primary"
              onClick={() => action.mutate("confirm")}
            >
              {t("confirm")}
            </Button>
          )}
          {["confirmation_required", "pending", "accepted"].includes(
            query.data.status,
          ) && (
            <Button label={t("cancel")} onClick={() => action.mutate("cancel")}>
              {t("cancel")}
            </Button>
          )}
          {query.data.status === "unknown" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.mutate("reconcile");
              }}
            >
              <VStack gap={2}>
                {t("reconcile")}
                <Selector
                  label={t("status")}
                  isLabelHidden
                  value={String(outcome)}
                  onChange={(e) => setOutcome(e)}
                  options={[
                    {
                      value: String("succeeded"),
                      label: String(t("succeeded")),
                    },
                    { value: String("failed"), label: String(t("failed")) },
                  ]}
                />
              </VStack>
              <VStack gap={2}>
                {t("note")}
                <TextArea
                  label={t("note")}
                  isLabelHidden
                  isRequired
                  value={note}
                  onChange={(e) => setNote(e)}
                />
              </VStack>
              <Button
                label={t("save")}
                type="submit"
                isDisabled={action.isPending}
              >
                {t("save")}
              </Button>
            </form>
          )}
        </>
      )}
      {action.error && (
        <Text as="p" role="alert" className="error-text text-error">
          {action.error.message}
        </Text>
      )}
    </Modal>
  );
}
