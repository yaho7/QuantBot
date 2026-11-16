import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { useLayoutEditing } from "../shared/layout-editing";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  useState,
  useEffect,
  useSyncExternalStore,
  useRef,
  createContext,
  useContext,
} from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  Maximize2,
  Bell,
  ChartNoAxesCombined,
  GripVertical,
  LayoutGrid as LayoutGridIcon,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  api,
  client,
  resource,
  layoutResource,
  type Layout,
  type Widget,
  type CapabilityCatalog,
  type Command,
  type Registry,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { effectiveWidgets, suggestedWidgets } from "../shared/layout-defaults";
import {
  Choices,
  decimalText,
  ErrorView,
  Loading,
  Modal,
  Badge,
} from "../shared/ui";
import { ControlCard } from "../app/control";
import { DataTable, History, useTelemetryValues } from "../app/strategy";
import { capabilityCatalog, CapabilityWidget } from "./capability-widget";

import { StrategyPerformance } from "./host-performance";
import { ScrollHints } from "./scroll-hints";

const Density = createContext("full");

import { WidgetResize } from "./widget-resize";

const icons = { Activity, Bell, ChartNoAxesCombined, SlidersHorizontal };

const mobileLayout = matchMedia("(max-width: 600px)");
export default function WidgetBoard({ strategyId }: { strategyId?: string }) {
  const { setEditing } = useLayoutEditing();
  useEffect(() => () => setEditing(false), [setEditing]);
  const viewport = useSyncExternalStore(
    (listener) => {
      mobileLayout.addEventListener("change", listener);
      return () => mobileLayout.removeEventListener("change", listener);
    },
    () => (mobileLayout.matches ? "mobile" : "desktop"),
  );
  const { t } = useLanguage();
  const [preview, setPreview] = useState<string>();
  const [lockedDevice, setLockedDevice] = useState<string>();
  const device = lockedDevice ?? preview ?? viewport;
  const deviceTools = (
    <HStack className="layout-device-switch w-fit">
      <Choices
        label={t("layoutPreview")}
        value={device}
        size="sm"
        disabled={!!lockedDevice}
        select={setPreview}
        options={["desktop", "mobile"].map((value) => ({
          value,
          label: t(value === "mobile" ? "mobileLayout" : "desktopLayout"),
        }))}
      />
    </HStack>
  );
  return (
    <>
      <VStack
        gap={3}
        width="100%"
        maxWidth={device === "mobile" ? 430 : undefined}
        className={device === "mobile" ? "mobile-layout-preview mx-auto" : ""}
      >
        <DeviceWidgetBoard
          key={(strategyId ?? "overview") + device}
          strategyId={strategyId}
          device={device}
          deviceTools={deviceTools}
          onEditing={(active) => {
            setEditing(active);
            setLockedDevice(active ? device : undefined);
          }}
        />
      </VStack>
    </>
  );
}
function DeviceWidgetBoard({
  strategyId,
  device,
  deviceTools,
  onEditing,
}: {
  strategyId?: string;
  device: string;
  deviceTools: ReactNode;
  onEditing: (active: boolean) => void;
}) {
  const { t } = useLanguage();
  const surface = strategyId ? "strategy" : "overview";
  const layout = layoutResource(strategyId, device);
  const saved = useQuery(layout);
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const available = (strategies.data ?? []).filter(
    (strategy) => !strategyId || strategy.id === strategyId,
  );
  const catalogs = useQueries({
    queries: available.map((strategy) => capabilityCatalog(strategy.id)),
  });
  const catalogByStrategy = new Map(
    available.map((strategy, index) => [strategy.id, catalogs[index]]),
  );
  const suggestions = suggestedWidgets(
    available.map(({ id }) => ({
      strategyId: id,
      catalog: catalogByStrategy.get(id)?.data,
    })),
    surface,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[]>([]);
  const [revision, setRevision] = useState(0);
  const [acknowledged, setAcknowledged] = useState("");
  const [history, setHistory] = useState<Widget[][]>([]);
  const [copyError, setCopyError] = useState<Error>();
  const [copying, setCopying] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState("");
  const effective = effectiveWidgets(saved.data, suggestions);
  const widgets = (editing ? draft : effective).filter(
    (widget) => !widget.hidden,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const save = useMutation({
    mutationFn: (input: { revision: number; widgets: Widget[] }) =>
      api<Layout>(layout.queryKey[0]!, "PUT", { version: 1, ...input }),
    onSuccess: (value, input) => {
      setAcknowledged(JSON.stringify(input.widgets));
      client.setQueryData(layout.queryKey, value);
      setRevision(value.revision);
    },
  });
  const dirty = JSON.stringify(draft) !== acknowledged;
  useEffect(() => {
    if (!editing || !dirty || save.isPending || save.isError) return;
    const timer = setTimeout(
      () => save.mutate({ revision, widgets: draft }),
      500,
    );
    return () => clearTimeout(timer);
  }, [editing, dirty, draft, revision, save.isPending, save.isError]);
  const change = (next: Widget[]) => {
    if (!save.isPending) save.reset();
    setHistory((previous) => [...previous.slice(-29), draft]);
    setDraft(next);
  };
  function beginEdit() {
    onEditing(true);
    setDraft(structuredClone(effective));
    setAcknowledged(JSON.stringify(effective));
    setRevision(saved.data?.revision ?? 0);
    setHistory([]);
    setEditing(true);
    save.reset();
  }
  async function copyDesktop() {
    if (draft.length && !window.confirm(t("copyLayoutConfirm"))) return;
    setCopying(true);
    setCopyError(undefined);
    try {
      const source = await api<Layout>(layoutResource(strategyId).queryKey[0]!);
      change(
        effectiveWidgets(source, suggestions).map((widget) => ({
          ...widget,
          width: 100,
          height: undefined,
        })),
      );
    } catch (error) {
      setCopyError(error as Error);
    } finally {
      setCopying(false);
    }
  }
  function update(id: string, next: Partial<Widget>) {
    change(
      draft.map((widget) =>
        widget.id === id ? { ...widget, ...next } : widget,
      ),
    );
  }
  return (
    <VStack
      as="section"
      gap={4}
      className="section flex flex-col gap-4 min-w-0   widget-section"
    >
      <HStack
        gap={3}
        wrap="wrap"
        vAlign="center"
        hAlign="between"
        className="section-heading"
      >
        <Heading level={2}>{t("widgets")}</Heading>
        {deviceTools}
        <HStack
          className="widget-edit-tools"
          gap={2}
          wrap="wrap"
          vAlign="center"
        >
          {editing ? (
            <>
              <IconButton
                variant="ghost"
                label={t("undo")}
                tooltip={t("undo")}
                icon={<AstryxIcon icon={Undo2} size="sm" />}
                isDisabled={!history.length || save.isPending}
                onClick={() => {
                  save.reset();
                  setDraft(history.at(-1)!);
                  setHistory(history.slice(0, -1));
                }}
              />
              <IconButton
                variant="ghost"
                label={t("reset")}
                tooltip={t("reset")}
                icon={<AstryxIcon icon={RotateCcw} size="sm" />}
                isDisabled={save.isPending}
                onClick={() => change(suggestions)}
              />
              <Button
                label={t("add")}
                icon={<AstryxIcon icon={Plus} size="sm" />}
                onClick={() => setAdding(true)}
                isDisabled={save.isPending}
              />
              {device === "mobile" && (
                <Button
                  label={t("copyDesktop")}
                  isLoading={copying}
                  isDisabled={save.isPending}
                  onClick={() => void copyDesktop()}
                />
              )}
              <Button
                label={t("done")}
                variant="primary"
                isDisabled={save.isPending || dirty || copying}
                onClick={() => {
                  setEditing(false);
                  onEditing(false);
                  setSettings("");
                  setAdding(false);
                }}
              />
              <Text
                className="muted text-secondary   layout-save-status text-secondary text-sm"
                role="status"
                aria-live="polite"
              >
                {save.isError
                  ? t("saveFailed")
                  : save.isPending || dirty
                    ? t("savingLayout")
                    : t("savedLayout")}
              </Text>
              {save.isError && (
                <Button
                  label={t("retrySave")}
                  onClick={() => save.mutate({ revision, widgets: draft })}
                />
              )}
            </>
          ) : (
            <Button
              label={t("edit")}
              icon={<AstryxIcon icon={Pencil} size="sm" />}
              onClick={beginEdit}
              isDisabled={
                saved.isPending ||
                !!saved.error ||
                catalogs.some((catalog) => catalog.isPending)
              }
            />
          )}
        </HStack>
      </HStack>
      {saved.isPending ? (
        <Loading />
      ) : saved.error ? (
        <ErrorView error={saved.error} retry={() => void saved.refetch()} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => {
            if (!editing || !over || active.id === over.id) return;
            change(
              arrayMove(
                draft,
                draft.findIndex((widget) => widget.id === active.id),
                draft.findIndex((widget) => widget.id === over.id),
              ),
            );
          }}
        >
          <SortableContext items={widgets.map((w) => w.id)}>
            <VStack
              gap={4}
              className={
                "widget-grid   " + (editing ? "editing" : "") + "   grid"
              }
            >
              {widgets.map((widget) => (
                <SortableWidget
                  key={widget.id}
                  widget={widget}
                  editing={editing}
                  title={
                    catalogByStrategy
                      .get(widget.strategyId)
                      ?.data?.capabilities.find(
                        (entry) => entry.id === widget.controlId,
                      )?.title
                  }
                  resize={(value) => update(widget.id, value)}
                  configure={() => setSettings(widget.id)}
                  remove={() =>
                    change(
                      draft.flatMap((entry) => {
                        if (entry.id !== widget.id) return [entry];
                        if (
                          entry.type === "capability" ||
                          entry.type === "control"
                        )
                          return [{ ...entry, hidden: true }];
                        return [];
                      }),
                    )
                  }
                >
                  <WidgetContent
                    widget={widget}
                    editing={editing}
                    catalog={catalogByStrategy.get(widget.strategyId)?.data}
                    catalogError={
                      catalogByStrategy.get(widget.strategyId)?.error
                    }
                  />
                </SortableWidget>
              ))}
              {editing && !widgets.length && (
                <Button
                  label={t("add")}
                  className="widget-add"
                  onClick={() => setAdding(true)}
                >
                  <AstryxIcon icon={Plus} size="md" />
                  {t("add")}
                </Button>
              )}
            </VStack>
          </SortableContext>
        </DndContext>
      )}
      {!editing && !widgets.length && !saved.isPending && (
        <EmptyState
          isCompact
          headingLevel={3}
          title={t("widgets")}
          description={t("widgetsHint")}
          icon={<AstryxIcon icon={LayoutGridIcon} size="md" />}
        />
      )}
      {copyError && <ErrorView error={copyError} />}
      {save.error && (
        <Text as="p" className="error-text text-error" role="alert">
          {save.error.message}
        </Text>
      )}
      {adding && (
        <AddWidget
          strategies={available}
          close={() => setAdding(false)}
          add={(widget) => {
            const hidden = draft.find(
              (item) =>
                item.hidden &&
                item.strategyId === widget.strategyId &&
                item.controlId === widget.controlId,
            );
            change(
              hidden
                ? draft.map((item) =>
                    item.id === hidden.id ? { ...hidden, hidden: false } : item,
                  )
                : [...draft, widget],
            );
            setAdding(false);
          }}
        />
      )}
      {settings && (
        <Modal
          title={t("widgetSettings")}
          open
          onOpenChange={(open) => {
            if (!open) setSettings("");
          }}
        >
          {draft
            .filter((w) => w.id === settings)
            .map((widget) => (
              <form
                key={widget.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  setSettings("");
                }}
              >
                <VStack gap={2}>
                  {t("displayName")}
                  <TextInput
                    label={t("displayName")}
                    isLabelHidden
                    value={widget.label ?? ""}
                    onChange={(e) =>
                      update(widget.id, { label: e.slice(0, 160) })
                    }
                  />
                </VStack>
                <VStack gap={2}>
                  {t("size")}
                  <Selector
                    label={t("size")}
                    isLabelHidden
                    value={String(widget.size)}
                    onChange={(e) =>
                      update(widget.id, {
                        size: e as Widget["size"],
                        width: undefined,
                      })
                    }
                    options={[
                      ...["small", "medium", "large", "full"].map((size) => ({
                        value: String(size),
                        label: String(size),
                      })),
                    ]}
                  />
                </VStack>
                <VStack gap={2}>
                  {t("color")}
                  <WidgetColor
                    value={widget.color}
                    commit={(color) => update(widget.id, { color })}
                  />
                </VStack>
                <VStack gap={2}>
                  {t("icon")}
                  <Selector
                    label={t("icon")}
                    isLabelHidden
                    value={String(widget.icon ?? "Activity")}
                    onChange={(e) => update(widget.id, { icon: e })}
                    options={[
                      ...Object.keys(icons).map((icon) => ({
                        value: String(icon),
                        label: String(icon),
                      })),
                    ]}
                  />
                </VStack>
                <VStack
                  gap={2}
                  className="check-label flex flex-row items-center gap-2"
                >
                  <CheckboxInput
                    label={t("showDescription")}
                    isLabelHidden
                    value={widget.description}
                    onChange={(e) => update(widget.id, { description: e })}
                  />
                  {t("showDescription")}
                </VStack>
                <VStack
                  gap={2}
                  className="check-label flex flex-row items-center gap-2"
                >
                  <CheckboxInput
                    label={t("detailed")}
                    isLabelHidden
                    value={widget.detailed}
                    onChange={(e) => update(widget.id, { detailed: e })}
                  />
                  {t("detailed")}
                </VStack>
                <Button label={t("close")} type="submit">
                  {t("close")}
                </Button>
              </form>
            ))}
        </Modal>
      )}
    </VStack>
  );
}
function SortableWidget({
  widget,
  editing,
  title,
  configure,
  resize,
  remove,
  children,
}: {
  widget: Widget;
  editing: boolean;
  title?: string;
  configure: () => void;
  resize: (value: Partial<Widget>) => void;
  remove: () => void;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const body = useRef<HTMLElement>(null);
  const [density, setDensity] = useState("full");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      const next =
        width < 260 || height < 140
          ? "compact"
          : width < 420 || height < 240
            ? "medium"
            : "full";
      setDensity((previous) => (previous === next ? previous : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const sortable = useSortable({ id: widget.id, disabled: !editing });
  const Icon = icons[widget.icon as keyof typeof icons] ?? Activity;
  return (
    <VStack
      as="article"
      ref={sortable.setNodeRef}
      className={
        "surface bg-surface border border-border rounded-lg relative min-w-0 overflow-hidden widget   size-" +
        widget.size +
        (widget.height ? "   widget-height-set" : "") +
        (sortable.isDragging ? "   dragging" : "")
      }
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        borderTopColor: widget.color,
        height: widget.height ? widget.height + "px" : undefined,
        ...({
          "--widget-span-desktop": widget.width
            ? Math.max(1, Math.round((widget.width * 12) / 100))
            : undefined,
          "--widget-span-tablet": widget.width
            ? Math.max(1, Math.round((widget.width * 8) / 100))
            : undefined,
          "--widget-span-phone": widget.width
            ? Math.max(1, Math.round((widget.width * 4) / 100))
            : undefined,
        } as import("react").CSSProperties),
      }}
      data-widget={widget.id}
      data-density={density}
    >
      <HStack
        as="header"
        className="widget-header"
        padding={4}
        gap={2}
        vAlign="center"
      >
        <AstryxIcon icon={Icon} size="sm" />
        <Heading level={3} className="flex-1 min-w-0">
          {widget.label ||
            title ||
            t(
              widget.type === "capability"
                ? "capability"
                : widget.type === "control"
                  ? "controls"
                  : widget.type === "equity"
                    ? "equity"
                    : widget.type === "chart"
                      ? "charts"
                      : widget.type === "positions"
                        ? "positions"
                        : widget.type === "performance"
                          ? "hostPerformance"
                          : "activity",
            )}
        </Heading>
        {!editing && (
          <IconButton
            size="sm"
            label={t("expandWidget")}
            tooltip={t("expandWidget")}
            variant="ghost"
            icon={<AstryxIcon icon={Maximize2} size="sm" />}
            onClick={() => setExpanded(true)}
          />
        )}
        {editing && (
          <>
            <Button
              label={t("dragWidget")}
              type="button"
              isIconOnly
              icon={<AstryxIcon icon={GripVertical} size="sm" />}
              className="icon-button   drag-handle"
              aria-label={t("dragWidget")}
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <AstryxIcon icon={GripVertical} size="md" />
            </Button>
            <IconButton
              size="sm"
              label={t("widgetSettings")}
              tooltip={t("widgetSettings")}
              variant="ghost"
              icon={<AstryxIcon icon={Settings2} size="sm" />}
              onClick={configure}
            />
            <IconButton
              size="sm"
              label={t("remove")}
              tooltip={t("remove")}
              variant="ghost"
              icon={<AstryxIcon icon={Trash2} size="sm" />}
              onClick={remove}
            />
          </>
        )}
      </HStack>
      <VStack
        gap={3}
        className={
          "widget-body min-w-0 flex-1 px-4 pb-4 " +
          (widget.height ? "min-h-0 overflow-auto " : "") +
          (editing ? "pb-12" : "")
        }
        ref={body}
      >
        <Density.Provider value={density}>{children}</Density.Provider>
      </VStack>
      <ScrollHints target={body} />
      {expanded && (
        <Modal
          title={widget.label || title || t("details")}
          open
          onOpenChange={setExpanded}
        >
          <Density.Provider value="full">{children}</Density.Provider>
        </Modal>
      )}
      {editing && <WidgetResize widget={widget} commit={resize} />}
    </VStack>
  );
}
function WidgetContent({
  widget,
  editing,
  catalog,
  catalogError,
}: {
  widget: Widget;
  editing: boolean;
  catalog?: CapabilityCatalog;
  catalogError?: Error | null;
}) {
  const { t } = useLanguage();
  const density = useContext(Density);
  widget = {
    ...widget,
    description: widget.description && density === "full",
    detailed: widget.detailed && density === "full",
  };
  if (density === "compact" && widget.type === "chart")
    return (
      <Text as="p" className="muted text-secondary   compact-widget-summary">
        {t("expandForDetails")}
      </Text>
    );
  if (widget.type === "capability") {
    if (catalogError) return <ErrorView error={catalogError} />;
    if (!catalog)
      return (
        <Text as="p" className="empty-inline text-secondary text-center p-6">
          {t("unavailable")}
        </Text>
      );
    const capability = catalog.capabilities.find(
      (entry) => entry.id === widget.controlId,
    );
    if (!capability)
      return (
        <Text as="p" className="empty-inline text-secondary text-center p-6">
          {t("capabilityMissing")}
        </Text>
      );
    if (capability.kind === "parameter" || capability.kind === "action")
      return <ControlWidget widget={widget} editing={editing} />;
    return (
      <CapabilityWidget
        strategyId={widget.strategyId}
        revision={catalog.revision}
        capability={capability}
        description={widget.description}
        detailed={widget.detailed}
        compact={density === "compact"}
      />
    );
  }
  if (widget.type === "control")
    return <ControlWidget widget={widget} editing={editing} />;
  if (widget.type === "chart")
    return <History strategyId={widget.strategyId} embedded />;
  if (widget.type === "performance")
    return (
      <StrategyPerformance
        widget
        compact={density === "compact"}
        strategyId={widget.strategyId}
      />
    );
  if (widget.type === "activity")
    return <ActivityWidget strategyId={widget.strategyId} />;
  return <TelemetryWidget widget={widget} />;
}
function TelemetryWidget({ widget }: { widget: Widget }) {
  const { t } = useLanguage();
  const density = useContext(Density);
  const values = useTelemetryValues(widget.strategyId);
  if (values.query.error) return <ErrorView error={values.query.error} />;
  if (widget.type === "positions" && density === "compact") {
    const count = values.records
      .filter((r) => r.kind === "position")
      .reduce(
        (n, r) =>
          n + (Array.isArray(r.data.positions) ? r.data.positions.length : 0),
        0,
      );
    return (
      <VStack
        gap={3}
        className="equity-widget flex flex-col gap-2 tabular-nums"
      >
        <Text weight="semibold">{values.query.isPending ? "—" : count}</Text>
        <Text className="muted text-secondary">{t("positions")}</Text>
      </VStack>
    );
  }
  if (widget.type === "positions")
    return (
      <DataTable
        fields="standard"
        title=""
        rows={values.records
          .filter((r) => r.kind === "position")
          .flatMap(
            (r) => (r.data.positions ?? []) as Record<string, unknown>[],
          )}
      />
    );
  return (
    <VStack gap={3} className="equity-widget flex flex-col gap-2 tabular-nums">
      <Text className="muted text-secondary">
        {String(values.equity?.data.currency ?? t("missing"))}
      </Text>
      <Text weight="semibold">{decimalText(values.equity?.data.value)}</Text>
      {widget.detailed && (
        <dl className="compact-dl grid grid-cols-2 gap-x-4 gap-y-2 tabular-nums">
          <dt>
            <Text type="supporting">{t("dailyPnl")}</Text>
          </dt>
          <dd className="m-0">
            <Text hasTabularNumbers>
              {decimalText(values.performance?.data.dailyPnl)}
            </Text>
          </dd>
          <dt>
            <Text type="supporting">{t("drawdown")}</Text>
          </dt>
          <dd className="m-0">
            <Text hasTabularNumbers>
              {decimalText(values.equity?.data.drawdown)}
            </Text>
          </dd>
        </dl>
      )}
    </VStack>
  );
}
function ControlWidget({
  widget,
  editing,
}: {
  widget: Widget;
  editing: boolean;
}) {
  const { t } = useLanguage();
  const query = useQuery(
    resource<Registry>("/strategies/" + widget.strategyId + "/controls"),
  );
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorView error={query.error} />;
  const control = query.data.controls.find((c) => c.id === widget.controlId);
  if (!control)
    return (
      <Text as="p" className="empty-inline text-secondary text-center p-6">
        {t("noControls")}
      </Text>
    );
  return (
    <VStack gap={3} className={widget.detailed ? "" : "widget-compact"}>
      <ControlCard
        strategyId={widget.strategyId}
        registry={query.data}
        editing={editing}
        embedded={widget.type === "capability"}
        control={{
          ...control,
          title: widget.label || control.title,
          description: widget.description ? control.description : undefined,
        }}
      />
    </VStack>
  );
}
function ActivityWidget({ strategyId }: { strategyId: string }) {
  const density = useContext(Density);
  const { t } = useLanguage();
  const query = useQuery(
    resource<Command[]>("/commands?strategyId=" + strategyId),
  );
  return (
    <VStack gap={3}>
      {query.data
        ?.slice(0, density === "compact" ? 1 : density === "medium" ? 3 : 5)
        .map((cmd) => (
          <HStack
            gap={3}
            wrap="wrap"
            vAlign="center"
            className="event-line"
            key={cmd.id}
          >
            <Text>{cmd.controlId}</Text>
            <Badge>{t(cmd.status as "pending")}</Badge>
          </HStack>
        ))}
      {!query.data?.length && (
        <Text as="p" className="empty-inline text-secondary text-center p-6">
          {t("noEvents")}
        </Text>
      )}
    </VStack>
  );
}
function AddWidget({
  strategies,
  close,
  add,
}: {
  strategies: Strategy[];
  close: () => void;
  add: (widget: Widget) => void;
}) {
  const { t } = useLanguage();
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? "");
  const [type, setType] = useState<Widget["type"]>("equity");
  const [controlId, setControlId] = useState("");
  const controls = useQuery({
    ...resource<Registry>("/strategies/" + strategyId + "/controls"),
    enabled: !!strategyId,
  });
  const catalog = useQuery({
    ...capabilityCatalog(strategyId),
    enabled: !!strategyId && type === "capability",
  });
  const sources =
    type === "capability"
      ? catalog.data?.capabilities
      : controls.data?.controls;
  const hasSource = type === "control" || type === "capability";
  const selected =
    sources?.find((source) => source.id === controlId)?.id ??
    sources?.[0]?.id ??
    "";
  return (
    <Modal
      title={t("add")}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add({
            id: crypto.randomUUID(),
            type,
            strategyId,
            size: "medium",
            description: true,
            detailed: true,
            ...(hasSource ? { controlId: selected } : {}),
          });
        }}
      >
        <VStack gap={2}>
          {t("strategies")}
          <Selector
            label={t("strategy")}
            isLabelHidden
            value={String(strategyId)}
            onChange={(e) => {
              setStrategyId(e);
              setControlId("");
            }}
            options={[
              ...strategies.map((s) => ({
                value: String(s.id),
                label: String(s.name),
              })),
            ]}
          />
        </VStack>
        <VStack gap={2}>
          {t("widgetType")}
          <Selector
            label={t("widgetType")}
            isLabelHidden
            value={String(type)}
            onChange={(e) => setType(e as Widget["type"])}
            options={[
              ...[
                ["equity", t("equity")],
                ["control", t("controls")],
                ["capability", t("capability")],
                ["chart", t("charts")],
                ["positions", t("positions")],
                ["activity", t("activity")],
                ["performance", t("hostPerformance")],
              ].map(([value, label]) => ({
                value: String(value),
                label: String(label),
              })),
            ]}
          />
        </VStack>
        {hasSource && (
          <VStack gap={2}>
            {t(type === "capability" ? "capability" : "controls")}
            <Selector
              label={t(type === "capability" ? "capability" : "controls")}
              isLabelHidden
              value={String(selected)}
              onChange={(e) => setControlId(e)}
              options={[
                ...(sources ?? []).map((c) => ({
                  value: String(c.id),
                  label: String(c.title),
                })),
              ]}
            />
          </VStack>
        )}
        <Button
          label={t("add")}
          type="submit"
          variant="primary"
          className="primary"
          isDisabled={!strategyId || (hasSource && !selected)}
        >
          {t("add")}
        </Button>
      </form>
    </Modal>
  );
}

function WidgetColor({
  value,
  commit,
}: {
  value?: string;
  commit: (value: string | undefined) => void;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(value ?? "");
  const valid = draft === "" || /^#[a-f\d]{6}$/i.test(draft);
  return (
    <TextInput
      label={t("color")}
      isLabelHidden
      value={draft}
      onChange={setDraft}
      status={!valid ? { type: "error", message: "#RRGGBB" } : undefined}
      onBlur={() => {
        if (valid) commit(draft || undefined);
      }}
    />
  );
}
