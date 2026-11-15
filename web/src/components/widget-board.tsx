import { useState, useEffect, useSyncExternalStore, useRef, createContext, useContext } from "react";
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
import { decimalText, ErrorView, Loading, Modal, Badge } from "../shared/ui";
import { ControlCard } from "../app/control";
import { DataTable, History, useTelemetryValues } from "../app/strategy";
import { capabilityCatalog, CapabilityWidget } from "./capability-widget";

import { ScrollHints } from "./scroll-hints";
import "./workbench-ux.css";

const Density = createContext("full");

import { WidgetResize } from "./widget-resize";

const icons = { Activity, Bell, ChartNoAxesCombined, SlidersHorizontal };

const mobileLayout = matchMedia("(max-width: 600px)");
export default function WidgetBoard({ strategyId }: { strategyId?: string }) {
  const viewport = useSyncExternalStore(
    (listener) => { mobileLayout.addEventListener("change", listener); return () => mobileLayout.removeEventListener("change", listener); },
    () => mobileLayout.matches ? "mobile" : "desktop",
  );
  const { t } = useLanguage();
  const [preview, setPreview] = useState<string>();
  const [lockedDevice, setLockedDevice] = useState<string>();
  const device = lockedDevice ?? preview ?? viewport;
  return <>
    <div className="layout-device-switch segmented" role="group" aria-label={t("layoutPreview")}>
      {["desktop", "mobile"].map(value => <button key={value} aria-pressed={device === value}
        disabled={!!lockedDevice} onClick={() => setPreview(value)}>
        {t(value === "mobile" ? "mobileLayout" : "desktopLayout")}
      </button>)}
    </div>
    <div className={device === "mobile" ? "mobile-layout-preview" : ""}>
      <DeviceWidgetBoard key={(strategyId ?? "overview") + device} strategyId={strategyId} device={device}
        onEditing={(active) => setLockedDevice(active ? device : undefined)} />
    </div>
  </>;

}
function DeviceWidgetBoard({ strategyId, device, onEditing }: { strategyId?: string; device: string; onEditing: (active: boolean) => void }) {
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
    const timer = setTimeout(() => save.mutate({ revision, widgets: draft }), 500);
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
    setCopying(true); setCopyError(undefined);
    try {
      const source = await api<Layout>(layoutResource(strategyId).queryKey[0]!);
      change(effectiveWidgets(source, suggestions).map(widget => ({ ...widget, width: 100, height: undefined })));
    } catch (error) { setCopyError(error as Error); }
    finally { setCopying(false); }
  }
  function update(id: string, next: Partial<Widget>) {
    change(
      draft.map((widget) =>
        widget.id === id ? { ...widget, ...next } : widget,
      ),
    );
  }
  return (
    <section className="section widget-section">
      <div className="section-heading">
        <h2>{t("widgets")} <small className="muted">{t(device === "mobile" ? "mobileLayout" : "desktopLayout")}</small></h2>
        <div className="actions">
          {editing ? (
            <>
              <button
                className="icon-button"
                aria-label={t("undo")}
                disabled={!history.length || save.isPending}
                onClick={() => {
                  save.reset();
                  setDraft(history.at(-1)!);
                  setHistory(history.slice(0, -1));
                }}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={t("reset")}
                disabled={save.isPending}
                onClick={() => change(suggestions)}
              >
                <RotateCcw size={17} />
              </button>
              <button onClick={() => setAdding(true)} disabled={save.isPending}>
                <Plus size={16} />
                {t("add")}
              </button>
              {device === "mobile" && <button disabled={copying || save.isPending} onClick={() => void copyDesktop()}>{t("copyDesktop")}</button>}
              <button
                className="primary"
                disabled={save.isPending || dirty || copying}
                onClick={() => {
                  setEditing(false);
                  onEditing(false);
                  setSettings("");
                  setAdding(false);
                }}
              >
                {t("done")}
              </button>
              <span className="muted layout-save-status" role="status" aria-live="polite">
                {save.isError ? t("saveFailed") : save.isPending || dirty ? t("savingLayout") : t("savedLayout")}
              </span>
              {save.isError && <button onClick={() => save.mutate({ revision, widgets: draft })}>{t("retrySave")}</button>}

            </>
          ) : (
            <button
              disabled={
                saved.isPending ||
                !!saved.error ||
                catalogs.some((catalog) => catalog.isPending)
              }
              onClick={beginEdit}
            >
              <Pencil size={15} />
              {t("edit")}
            </button>
          )}
        </div>
      </div>
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
            <div className={"widget-grid " + (editing ? "editing" : "")}>
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
                <button className="widget-add" onClick={() => setAdding(true)}>
                  <Plus />
                  {t("add")}
                </button>
              )}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {!editing && !widgets.length && !saved.isPending && (
        <div className="surface empty-inline">{t("widgetsHint")}</div>
      )}
      {copyError && <ErrorView error={copyError} />}
      {save.error && (
        <p className="error-text" role="alert">
          {save.error.message}
        </p>
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
                <label>
                  {t("displayName")}
                  <input
                    maxLength={160}
                    value={widget.label ?? ""}
                    onChange={(e) =>
                      update(widget.id, { label: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("size")}
                  <select
                    value={widget.size}
                    onChange={(e) =>
                      update(widget.id, {
                        size: e.target.value as Widget["size"],
                        width: undefined,
                      })
                    }
                  >
                    {["small", "medium", "large", "full"].map((size) => (
                      <option key={size}>{size}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("color")}
                  <input
                    type="color"
                    value={widget.color ?? "#4b76d8"}
                    onChange={(e) =>
                      update(widget.id, { color: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("icon")}
                  <select
                    value={widget.icon ?? "Activity"}
                    onChange={(e) =>
                      update(widget.id, { icon: e.target.value })
                    }
                  >
                    {Object.keys(icons).map((icon) => (
                      <option key={icon}>{icon}</option>
                    ))}
                  </select>
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={widget.description}
                    onChange={(e) =>
                      update(widget.id, { description: e.target.checked })
                    }
                  />
                  {t("showDescription")}
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={widget.detailed}
                    onChange={(e) =>
                      update(widget.id, { detailed: e.target.checked })
                    }
                  />
                  {t("detailed")}
                </label>
                <button>{t("close")}</button>
              </form>
            ))}
        </Modal>
      )}
    </section>
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
  const body = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState("full");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      const next = width < 260 || height < 140 ? "compact" : width < 420 || height < 240 ? "medium" : "full";
      setDensity(previous => previous === next ? previous : next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const sortable = useSortable({ id: widget.id, disabled: !editing });
  const Icon = icons[widget.icon as keyof typeof icons] ?? Activity;
  return (
    <article
      ref={sortable.setNodeRef}
      className={
        "surface widget size-" +
        widget.size +
        (widget.height ? " widget-height-set" : "") +
        (sortable.isDragging ? " dragging" : "")
      }
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        borderTopColor: widget.color,
        height: widget.height ? widget.height + "px" : undefined,
        ...({ "--widget-width": widget.width } as import("react").CSSProperties),
      }}
      data-widget={widget.id}
      data-density={density}
    >
      <header className="widget-header">
        <Icon size={16} />
        <h3>
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
                        : "activity",
            )}
        </h3>
        {!editing && <button className="icon-button" aria-label={t("expandWidget")} onClick={() => setExpanded(true)}><Maximize2 size={15} /></button>}
        {editing && (
          <>
            <button
              className="icon-button drag-handle"
              aria-label={t("dragWidget")}
              {...sortable.attributes}
              {...sortable.listeners}
            >
              <GripVertical size={17} />
            </button>
            <button
              className="icon-button"
              aria-label={t("widgetSettings")}
              onClick={configure}
            >
              <Settings2 size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t("remove")}
              onClick={remove}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}
      </header>
      <div className="widget-body" ref={body}><Density.Provider value={density}>{children}</Density.Provider></div>
      <ScrollHints target={body} />
      {expanded && <Modal title={widget.label || title || t("details")} open onOpenChange={setExpanded}>
        <Density.Provider value="full">{children}</Density.Provider>
      </Modal>}
      {editing && <WidgetResize widget={widget} commit={resize} />}
    </article>
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
  widget = { ...widget, description: widget.description && density === "full", detailed: widget.detailed && density === "full" };
  if (density === "compact" && widget.type === "chart")
    return <p className="muted compact-widget-summary">{t("expandForDetails")}</p>;
  if (widget.type === "capability") {
    if (catalogError) return <ErrorView error={catalogError} />;
    if (!catalog) return <p className="empty-inline">{t("unavailable")}</p>;
    const capability = catalog.capabilities.find(
      (entry) => entry.id === widget.controlId,
    );
    if (!capability)
      return <p className="empty-inline">{t("capabilityMissing")}</p>;
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
    const count = values.records.filter(r => r.kind === "position").reduce((n, r) => n + (Array.isArray(r.data.positions) ? r.data.positions.length : 0), 0);
    return <div className="equity-widget"><strong>{values.query.isPending ? "—" : count}</strong><span className="muted">{t("positions")}</span></div>;
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
    <div className="equity-widget">
      <span className="muted">
        {String(values.equity?.data.currency ?? t("missing"))}
      </span>
      <strong>{decimalText(values.equity?.data.value)}</strong>
      {widget.detailed && (
        <dl className="compact-dl">
          <dt>{t("dailyPnl")}</dt>
          <dd>{decimalText(values.performance?.data.dailyPnl)}</dd>
          <dt>{t("drawdown")}</dt>
          <dd>{decimalText(values.equity?.data.drawdown)}</dd>
        </dl>
      )}
    </div>
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
  if (!control) return <p className="empty-inline">{t("noControls")}</p>;
  return (
    <div className={widget.detailed ? "" : "widget-compact"}>
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
    </div>
  );
}
function ActivityWidget({ strategyId }: { strategyId: string }) {
  const density = useContext(Density);
  const { t } = useLanguage();
  const query = useQuery(
    resource<Command[]>("/commands?strategyId=" + strategyId),
  );
  return (
    <div>
      {query.data?.slice(0, density === "compact" ? 1 : density === "medium" ? 3 : 5).map((cmd) => (
        <div className="event-line" key={cmd.id}>
          <span>{cmd.controlId}</span>
          <Badge>{t(cmd.status as "pending")}</Badge>
        </div>
      ))}
      {!query.data?.length && <p className="empty-inline">{t("noEvents")}</p>}
    </div>
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
        <label>
          {t("strategies")}
          <select
            required
            value={strategyId}
            onChange={(e) => {
              setStrategyId(e.target.value);
              setControlId("");
            }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("widgetType")}
          <select
            value={type}
            onChange={(e) => setType(e.target.value as Widget["type"])}
          >
            {[
              ["equity", t("equity")],
              ["control", t("controls")],
              ["capability", t("capability")],
              ["chart", t("charts")],
              ["positions", t("positions")],
              ["activity", t("activity")],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {hasSource && (
          <label>
            {t(type === "capability" ? "capability" : "controls")}
            <select
              required
              value={selected}
              onChange={(e) => setControlId(e.target.value)}
            >
              {sources?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="primary"
          disabled={!strategyId || (hasSource && !selected)}
        >
          {t("add")}
        </button>
      </form>
    </Modal>
  );
}
