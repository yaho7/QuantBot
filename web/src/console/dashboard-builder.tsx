import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChartNoAxesCombined, GripVertical, PencilLine, Plus, Save, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import GridLayout, { collides, useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { api, strategyApi, strategyPath, type Detail, type Strategy } from "./api";
import { availabilityLabel, bucketOptions, candleKey, candleSelection, candleSource, chartName, marketComponent, metricSource, seriesComponent, seriesKey, seriesSelection, timeOptions, type BoardWidget, type Breakpoint, type Candidate, type ChartCatalog, type Dashboard, type GridPosition, type Series, type Widget } from "./dashboard-types";
import { type ControlRegistryView } from "./dynamic-controls";
import { controlWidgets, WorkbenchControl } from "./workbench-controls";
import { Dialog, Empty, ErrorNotice, Field, Loading, Panel, useData, when } from "./ui";

const WidgetData = lazy(() => import("./widget-data"));

const eligible = (item: Candidate) => item.state === "ready" || item.state === "stale";
const EMPTY: Dashboard = { revision: 0, widgets: [] };
const DEFAULT_COMPONENTS = ["accounts", "equity", "returns", "drawdown", "orders", "positions", "metric_cards"];
const ROW_HEIGHT = 104;
const GAP = 12;
const sizes = [
  ["小", 2, 1], ["中", 4, 2], ["大", 6, 3], ["宽屏", 8, 3],
] as const;

function gridItems(widgets: BoardWidget[], breakpoint: Breakpoint, cols: number): Layout {
  const layout: Layout[number][] = [];
  for (const widget of widgets) {
    const saved = widget.placement?.[breakpoint];
    const w = saved?.w ?? ("kind" in widget ? widget.kind === "entry" ? cols : Math.min(4, cols) :
      breakpoint === "mobile" ? cols : widget.width * 4);
    const h = saved?.h ?? ("kind" in widget ? widget.kind === "entry" ? 3 : 2 :
      Math.ceil((widget.height + 86) / (ROW_HEIGHT + GAP)));
    let item = { i: widget.id, x: saved?.x ?? 0, y: saved?.y ?? 0, w, h, maxH: 10 };
    if (!saved) {
      const bottom = Math.max(0, ...layout.map((entry) => entry.y + entry.h));
      place: for (let y = 0; y <= bottom; y++) {
        for (let x = 0; x <= cols - w; x++) {
          item = { ...item, x, y };
          if (!layout.some((entry) => collides(entry, item))) break place;
        }
      }
    }
    layout.push(item);
  }
  return verticalCompactor.compact(layout, cols);
}

function withPlacements(widgets: BoardWidget[]) {
  const desktop = new Map(gridItems(widgets, "desktop", 8).map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));
  const mobile = new Map(gridItems(widgets, "mobile", 4).map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));
  return widgets.map((widget) => ({ ...widget, placement: { desktop: desktop.get(widget.id), mobile: mobile.get(widget.id) } }));
}

function newWidget(item: Candidate): Widget {
  const first = item.sources.find((source) => source.samples > 1) ?? item.sources[0];
  return {
    id: crypto.randomUUID(), component: item.id, title: item.label,
    chart: item.recommended_chart, width: marketComponent(item.id) ? 2 : 1,
    height: 320, hours: 24, bucket_seconds: 0, aggregation: "last", markers: true,
    start_at: null, end_at: null,
    sources: first && metricSource(first) ? [seriesSelection(first)] : [],
    candle: first && candleSource(first) ? candleSelection(first) : null,
  };
}

export default function DashboardBuilder({ strategy, workbench = false, focus }: { strategy: Detail; workbench?: boolean; focus?: string }) {
  const sid = strategy.id;
  const client = useQueryClient();
  const { width, containerRef, mounted } = useContainerWidth();
  const breakpoint: Breakpoint = width < 640 ? "mobile" : "desktop";
  const cols = breakpoint === "desktop" ? 8 : 4;
  const catalog = useData<ChartCatalog>(strategyApi(sid, "components"));
  const board = useData<Dashboard>(strategyApi(sid, "dashboard"));
  const registry = useData<ControlRegistryView>(strategyApi(sid, "controls"), true, 6_000);
  const strategies = useData<Strategy[]>("strategies");
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [undo, setUndo] = useState<Dashboard[]>([]);
  const [add, setAdd] = useState(false);
  const [config, setConfig] = useState<Widget>();
  const components = catalog.data?.components ?? [];
  const controls = controlWidgets(strategy, registry.data);
  const charts = DEFAULT_COMPONENTS.flatMap((id) => {
    const item = components.find((candidate) => candidate.id === id && eligible(candidate));
    return item ? [{ ...newWidget(item), id: `default-${id}` }] : [];
  });
  const defaults = workbench ? [...controls.slice(0, 2), ...charts, ...controls.slice(2)].slice(0, 24) : charts;
  const persisted = board.data ?? EMPTY;
  const legacy = workbench && persisted.widgets.length > 0 &&
    persisted.widgets.every((widget) => !("kind" in widget) && !widget.placement);
  const initial = persisted.revision === 0 ? defaults : legacy ?
    [...controls.slice(0, Math.min(2, 24 - persisted.widgets.length)), ...persisted.widgets] : persisted.widgets;
  const current = draft ?? { ...persisted, widgets: initial };
  const widgets = current.widgets;
  const layout = gridItems(widgets, breakpoint, cols);
  const names = Object.fromEntries([...(strategies.data ?? []), strategy].map((item) => [item.id, item.name]));
  const save = useMutation({
    mutationFn: () => api<Dashboard>(strategyApi(sid, "dashboard"), "PUT", { ...current, widgets: withPlacements(widgets) }),
    onSuccess: (data) => {
      client.setQueryData(["live", strategyApi(sid, "dashboard")], data);
      setDraft(null);
      setUndo([]);
      setAdd(false);
      setConfig(undefined);
    },
  });

  function edit(next: BoardWidget[]) {
    if (draft) setUndo((previous) => [...previous, draft]);
    setDraft({ revision: current.revision, widgets: next });
  }
  function placed(next: Layout) {
    return widgets.map((widget) => {
      const item = next.find((entry) => entry.i === widget.id);
      if (!item) return widget;
      const { x, y, w, h } = item;
      return { ...widget, placement: { ...widget.placement, [breakpoint]: { x, y, w, h } } };
    });
  }
  function updateLayout(next: Layout) {
    if (draft && !save.isPending) edit(placed(next));
  }
  function move(index: number, offset: number) {
    const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
    const a = ordered[index];
    const b = ordered[index + offset];
    if (!a || !b) return;
    const order = ordered.map((item) => item.i === a.i ? b.i : item.i === b.i ? a.i : item.i);
    const positions = order.map((id, slot) => {
      const previous = layout.find((entry) => entry.i === id)!;
      const target = ordered[slot]!;
      return { ...previous, x: Math.min(target.x, cols - previous.w), y: target.y };
    });
    const updated = placed(verticalCompactor.compact(positions, cols));
    edit(order.map((id) => updated.find((item) => item.id === id)!));
  }
  function resize(id: string, position: GridPosition, w: number, h: number) {
    updateLayout(verticalCompactor.compact(layout.map((item) => item.i === id ?
      { ...item, x: Math.min(position.x, cols - w), w, h } : item), cols));
  }

  const addableControls = controls.filter((item) => !widgets.some((widget) => "kind" in widget &&
    widget.kind === item.kind && widget.ref === item.ref));
  const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const editable = !!draft && !save.isPending;
  const focused = focus && widgets.find((widget) => "kind" in widget && (widget.ref ?? widget.kind) === focus);
  const focusedId = focused && focused.id;
  useEffect(() => {
    if (!focusedId || !mounted || draft) return;
    const target = document.getElementById(`widget-${focusedId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [focusedId, mounted, draft]);
  return <div className="stack" ref={containerRef}>
    <Panel title={workbench ? "策略组件" : "动态仪表盘"} action={<ChartNoAxesCombined size={21} />}>
      <ErrorNotice error={board.error ?? catalog.error ?? registry.error ?? save.error} />
      <div className="toolbar">
        {draft ? <>
          <button type="button" className="button secondary" disabled={!editable || widgets.length >= 24 ||
            (!components.some(eligible) && !addableControls.length)} onClick={() => setAdd(true)}><Plus size={17} /> 添加组件</button>
          <button type="button" className="button secondary" disabled={!editable || !undo.length} onClick={() => {
            setDraft(undo.at(-1) ?? null);
            setUndo(undo.slice(0, -1));
          }}>撤销</button>
          <select aria-label="应用布局模板" value="" disabled={!editable} onChange={(event) => {
            const template = event.target.value;
            edit(template === "监控" ? [...controls.slice(0, 2), ...charts] :
              [...controls, ...charts.filter((widget) => widget.component === "accounts")].slice(0, 24));
          }}><option value="" disabled>布局模板</option><option>监控</option><option>控制</option></select>
          <button type="button" className="button secondary" disabled={!editable} onClick={() => edit(defaults)}>恢复默认</button>
          <button type="button" className="button primary" disabled={!editable} onClick={() => save.mutate()}><Save size={16} /> 保存布局</button>
          <button type="button" className="button quiet" disabled={!editable} onClick={() => {
            setDraft(null); setUndo([]); setConfig(undefined); save.reset();
          }}>放弃修改</button>
        </> : <button type="button" className="button secondary" disabled={!board.data || catalog.isPending}
          onClick={() => setDraft({ ...current, widgets: withPlacements(widgets) })}><PencilLine size={15} /> 编辑布局</button>}
      </div>
      {draft && <p className="subtle">{breakpoint === "mobile" ? "手机布局" : "桌面布局"} · 拖动手柄或使用移动按钮调整位置</p>}
      {catalog.data?.schema_failures.some((item) => item.active) && <div className="notice warn">
        部分上报记录与标准 Schema 不兼容。<a href={strategyPath(sid, "api")}>查看连接诊断</a>
      </div>}
      {!!components.length && <details className="form-detail">
        <summary>已识别组件与数据状态</summary><div className="catalog-list">{components.map((item) =>
          <span className="chip" key={item.id}>{item.label} · {availabilityLabel[item.state]}</span>)}</div>
      </details>}
    </Panel>
    {board.isPending || catalog.isPending ? <Loading /> : !widgets.length ?
      <Empty title={components.length ? "仪表盘尚未添加组件" : "等待标准数据上报"} /> : mounted &&
      <GridLayout key={breakpoint} width={width} layout={layout} compactor={verticalCompactor}
        className={draft ? "workbench-grid editing" : "workbench-grid"}
        gridConfig={{ cols, rowHeight: ROW_HEIGHT, margin: [GAP, GAP], containerPadding: [0, 0] }}
        dragConfig={{ enabled: editable, handle: ".drag-handle", allowMobileScroll: true }}
        resizeConfig={{ enabled: editable }} onDragStop={updateLayout} onResizeStop={updateLayout}>
        {sorted.map((position, index) => {
          const widget = widgets.find((item) => item.id === position.i)!;
          const item = "kind" in widget ? undefined : components.find((candidate) => candidate.id === widget.component);
          const compact = position.h === 1;
          const expanded = position.h >= 3 && position.w >= Math.min(4, cols);
          return <article className="panel widget" data-widget={widget.id} id={`widget-${widget.id}`} tabIndex={-1} key={widget.id}>
            <header className="panel-heading widget-header"><div><h2>{widget.title}</h2>
              {!compact && item && !("kind" in widget) && <p>{chartName[widget.chart]} · {availabilityLabel[item.state]} · {when(item.last_observed_at)}</p>}
            </div>{draft && <div className="widget-actions">
              <button type="button" className="icon-button drag-handle" aria-label={`拖动 ${widget.title}`} disabled={!editable}><GripVertical size={17} /></button>
              <button type="button" className="icon-button" aria-label={`上移 ${widget.title}`} disabled={!editable || index === 0}
                onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
              <button type="button" className="icon-button" aria-label={`下移 ${widget.title}`} disabled={!editable || index === sorted.length - 1}
                onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
              {!("kind" in widget) && <button type="button" className="icon-button" aria-label={`配置 ${widget.title}`} disabled={!editable}
                onClick={() => setConfig(widget)}><PencilLine size={15} /></button>}
              <button type="button" className="icon-button danger-text" aria-label={`删除 ${widget.title}`} disabled={!editable}
                onClick={() => edit(widgets.filter((entry) => entry.id !== widget.id))}><Trash2 size={15} /></button>
            </div>}</header>
            {draft && <select aria-label={`尺寸 ${widget.title}`} disabled={!editable} value=""
              onChange={(event) => {
                const size = sizes.find(([label]) => label === event.target.value);
                if (size) resize(widget.id, position, Math.min(size[1], cols), size[2]);
              }}>
              <option value="">{position.w} × {position.h}</option>
              {sizes.map(([label]) => <option key={label}>{label}</option>)}
            </select>}
            <div className="widget-content">
            {item?.state === "incompatible" && <div className="notice warn">最近的上报不符合 Schema。下方保留已验证的历史数据。</div>}
            {"kind" in widget ? (draft ? null : <WorkbenchControl key={widget.id} {...{ widget, strategy, expanded }}
              registry={registry.data} ready={registry.isSuccess} />) : <div inert={!!draft}>
              {!item ? <Empty title="暂无可展示的数据" /> : <Suspense fallback={<Loading />}><WidgetData
                widget={widget} names={names} strategyId={sid} compact={compact}
                chartHeight={Math.max(100, position.h * (ROW_HEIGHT + GAP) - 105)} /></Suspense>}
            </div>}
            </div>
          </article>;
        })}
      </GridLayout>}
    {add && <Dialog title="添加组件" close={() => setAdd(false)}>
      <div className="stack">
        {addableControls.map((widget) => <div className="component-option" key={widget.id}>
          <strong>{widget.title}</strong><button type="button" className="button secondary" onClick={() => {
            edit([...widgets, { ...widget, id: crypto.randomUUID() }]); setAdd(false);
          }}>添加 {widget.title}</button>
        </div>)}
        {components.filter(eligible).map((item) => <div className="component-option" key={item.id}>
          <div><strong>{item.label}</strong><small>{availabilityLabel[item.state]} · {chartName[item.recommended_chart]}</small></div>
          <button type="button" className="button secondary" onClick={() => {
            const widget = newWidget(item);
            edit([...widgets, widget]); setAdd(false); setConfig(widget);
          }}>添加 {item.label}</button>
        </div>)}
      </div>
    </Dialog>}
    {config && <WidgetConfig widget={config} candidate={components.find((item) => item.id === config.component)}
      strategies={strategies.data ?? []} strategyId={sid} names={names}
      close={() => setConfig(undefined)} done={(widget) => {
        edit(widgets.map((item) => item.id === widget.id ? widget : item)); setConfig(undefined);
      }} />}
  </div>;
}

function localInput(value?: string | null) {
  if (!value) return "";
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function WidgetConfig({ widget, candidate, strategies, strategyId, names, close, done }: {
  widget: Widget; candidate?: Candidate; strategies: Strategy[]; strategyId: string; names: Record<string, string>;
  close: () => void; done: (widget: Widget) => void;
}) {
  const [form, set] = useState(widget);
  const [compare, setCompare] = useState("");
  const [start, setStart] = useState(localInput(widget.start_at));
  const [end, setEnd] = useState(localInput(widget.end_at));
  const [custom, setCustom] = useState(!!widget.start_at);
  const [error, setError] = useState("");
  const comparison = useData<ChartCatalog>(strategyApi(compare, "components"), !!compare);
  const other = comparison.data?.components.find((entry) => entry.id === widget.component);
  const sources = [...(candidate?.sources ?? []), ...(other?.sources ?? [])].filter(metricSource);
  const markets = (candidate?.sources ?? []).filter(candleSource);
  const graph = seriesComponent(form.component);
  const counts = form.component === "fill_count";
  const history = graph || marketComponent(form.component) ||
    ["fill_count", "fills", "risk", "signals", "logs", "alerts", "connections", "status_history"].includes(form.component);
  function addSeries(source: Series) {
    const selected = form.sources.some((item) => seriesKey(item) === seriesKey(source));
    const items = selected ? form.sources.filter((item) => seriesKey(item) !== seriesKey(source)) : [...form.sources, seriesSelection(source)];
    set({ ...form, sources: items });
  }
  return <Dialog title={`配置 ${widget.title}`} close={close}><form className="stack" onSubmit={(event) => {
    event.preventDefault();
    if (graph && !form.sources.length) { setError("请选择至少一个指标数据源"); return; }
    if (custom && (!start || !end || Date.parse(start) >= Date.parse(end))) { setError("请选择有效的起止时间"); return; }
    if (form.chart !== "cards" && form.chart !== "table" && new Set(form.sources.map((item) => item.unit)).size > 1) {
      setError("对比图表需要相同单位的数据源"); return;
    }
    done({ ...form, start_at: custom ? new Date(start).toISOString() : null, end_at: custom ? new Date(end).toISOString() : null });
  }}>
    <div className="form-grid">
      <Field label="组件标题"><input required maxLength={100} value={form.title} onChange={(e) => set({ ...form, title: e.target.value })} /></Field>
      <Field label="图表类型"><select value={form.chart} onChange={(e) => set({ ...form, chart: e.target.value as Widget["chart"] })}>
        {(candidate?.charts ?? [form.chart]).map((chart) => <option key={chart} value={chart}>{chartName[chart]}</option>)}</select></Field>
      {history && <Field label="时间范围"><select value={custom ? "custom" : form.hours} onChange={(e) => {
        setCustom(e.target.value === "custom");
        if (e.target.value !== "custom") set({ ...form, hours: Number(e.target.value) as Widget["hours"] });
      }}>{timeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="custom">自定义起止时间</option></select></Field>}
      {(graph || counts) && <Field label="聚合周期"><select value={form.bucket_seconds}
        onChange={(e) => set({ ...form, bucket_seconds: Number(e.target.value) as Widget["bucket_seconds"] })}>
        {bucketOptions.map(([value, label]) => <option key={value} value={value}>{counts && value === 0 ? "默认 1 小时" : label}</option>)}</select></Field>}
      {graph && form.bucket_seconds > 0 && <Field label="聚合方式"><select value={form.aggregation}
        onChange={(e) => set({ ...form, aggregation: e.target.value as Widget["aggregation"] })}>
        <option value="last">最后值</option><option value="mean">平均值</option><option value="min">最小值</option>
        <option value="max">最大值</option><option value="sum">总和</option></select></Field>}
      {history && custom && <>
        <Field label="起始时间"><input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="结束时间"><input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </>}
    </div>
    {marketComponent(form.component) && <Field label="K 线数据源">
      <select value={form.candle ? candleKey(form.candle) : ""} onChange={(e) => {
        const selected = markets.find((item) => candleKey(item) === e.target.value);
        set({ ...form, candle: selected ? candleSelection(selected) : null });
      }}><option value="">请选择</option>{markets.map((item) => <option key={candleKey(item)} value={candleKey(item)}>
        {item.symbol} · {item.interval_seconds} 秒 · {item.instance_id}</option>)}</select>
    </Field>}
    {form.component === "candles" && <label className="checkbox"><input type="checkbox" checked={form.markers}
      onChange={(e) => set({ ...form, markers: e.target.checked })} /> 显示订单、成交、信号与风控标记</label>}
    {graph && <>
      <Field label="加入对比策略"><select value={compare} onChange={(e) => setCompare(e.target.value)}>
        <option value="">只看当前策略</option>{strategies.filter((item) => item.id !== strategyId).map((item) =>
          <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <ErrorNotice error={comparison.error} />
      {compare && !comparison.isPending && !other && <div className="notice">对比策略尚无可用的同类数据。</div>}
      <div className="field"><span>已选数据源（{form.sources.length}/10）</span><div className="chips">{form.sources.map((item) =>
        <button className="button quiet chip" type="button" key={seriesKey(item)} onClick={() => addSeries(item)}>
          移除 {[names[item.strategy_id], item.name, item.account_id, item.unit].filter(Boolean).join(" · ")}</button>)}</div></div>
      <div className="field"><span>可用数据源</span><div className="source-list">{sources.map((item) => {
        const checked = form.sources.some((entry) => seriesKey(entry) === seriesKey(item));
        return <label key={seriesKey(item)} className="checkbox"><input type="checkbox" checked={checked}
          disabled={!checked && form.sources.length >= 10} onChange={() => addSeries(item)} />
          <span>{[names[item.strategy_id], item.label, item.account_id, item.unit, item.instance_id].filter(Boolean).join(" · ")}
            <small>（{item.samples} 个观测）</small></span></label>;
      })}</div></div>
    </>}
    <ErrorNotice error={error} />
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>取消</button>
      <button className="button primary">应用组件配置</button></div>
  </form></Dialog>;
}
