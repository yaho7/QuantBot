import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChartNoAxesCombined, GripVertical, PencilLine, Plus, Save, Trash2 } from "lucide-react";
import { lazy, Suspense, useRef, useState, type PointerEvent } from "react";
import { api, strategyApi, strategyPath, type Detail, type Strategy } from "./api";
import { availabilityLabel, bucketOptions, candleKey, candleSelection, candleSource, chartName, marketComponent, metricSource, seriesComponent, seriesKey, seriesSelection, timeOptions, type Candidate, type ChartCatalog, type Dashboard, type Series, type Widget } from "./dashboard-types";
import { Dialog, Empty, ErrorNotice, Field, Loading, Panel, useData, when } from "./ui";

const WidgetData = lazy(() => import("./widget-data"));

const eligible = (item: Candidate) => item.state === "ready" || item.state === "stale";
const EMPTY: Dashboard = { revision: 0, widgets: [] };

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

export default function DashboardBuilder({ strategy }: { strategy: Detail }) {
  const sid = strategy.id;
  const client = useQueryClient();
  const catalog = useData<ChartCatalog>(strategyApi(sid, "components"));
  const board = useData<Dashboard>(strategyApi(sid, "dashboard"));
  const strategies = useData<Strategy[]>("strategies");
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [add, setAdd] = useState(false);
  const [config, setConfig] = useState<Widget>();
  const [dragged, setDragged] = useState<string>();
  const target = useRef<string | null>(null);
  const current = draft ?? board.data ?? EMPTY;
  const widgets = current.widgets;
  const components = catalog.data?.components ?? [];
  const newCount = components.filter((item) => eligible(item) && !widgets.some((widget) => widget.component === item.id)).length;
  const names = Object.fromEntries([...(strategies.data ?? []), strategy].map((item) => [item.id, item.name]));
  const save = useMutation({
    mutationFn: () => api<Dashboard>(strategyApi(sid, "dashboard"), "PUT", current),
    onSuccess: (data) => {
      client.setQueryData(["live", strategyApi(sid, "dashboard")], data);
      setDraft(null); setAdd(false); setConfig(undefined);
    },
  });

  function edit(next: Widget[]) {
    setDraft({ revision: current.revision, widgets: next });
  }
  function move(from: string, to: string) {
    const a = widgets.findIndex((item) => item.id === from);
    const b = widgets.findIndex((item) => item.id === to);
    if (a === b || a < 0 || b < 0) return;
    const result = [...widgets];
    const [moved] = result.splice(a, 1);
    if (!moved) return;
    result.splice(b, 0, moved);
    edit(result);
  }
  function beginDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    target.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragged(id);
  }
  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragged) return;
    target.current = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-widget]")?.dataset.widget ?? null;
  }
  function endDrag() {
    if (dragged && target.current) move(dragged, target.current);
    setDragged(undefined);
    target.current = null;
  }

  if (board.isPending || catalog.isPending) return <Loading />;
  return <div className="stack">
    <Panel title="动态仪表盘" hint={newCount ? `发现 ${newCount} 种可添加组件` : `已保存 ${board.data?.widgets.length ?? 0} 个组件`}
      action={<ChartNoAxesCombined size={21} />}>
      <ErrorNotice error={board.error ?? catalog.error ?? save.error} />
      <div className="toolbar">
        <button type="button" className="button primary" disabled={widgets.length >= 24 || !components.some(eligible)}
          onClick={() => setAdd(true)}><Plus size={17} /> 添加组件</button>
        {draft ? <>
          <button type="button" className="button secondary" disabled={save.isPending}
            onClick={() => save.mutate()}><Save size={16} /> 保存布局</button>
          <button type="button" className="button quiet" onClick={() => { setDraft(null); setConfig(undefined); save.reset(); }}>放弃修改</button>
        </> : !!widgets.length && <button type="button" className="button secondary"
          onClick={() => setDraft(current)}><PencilLine size={15} /> 编辑布局</button>}
      </div>
      {catalog.data?.schema_failures.some((item) => item.active) && <div className="notice warn">
        部分上报记录与标准 Schema 不兼容。<a href={strategyPath(sid, "api")}>查看连接诊断</a>
      </div>}
      {!widgets.length && <Empty title={components.length ? "仪表盘尚未添加组件" : "等待标准数据上报"}
        text={components.length ? "从已识别的数据类型中选择展示组件。"
          : "策略成功上报后，这里会显示可用的表格、指标和图表。"} />}
      {!!components.length && <details className="form-detail">
        <summary>已识别组件与数据状态</summary><div className="catalog-list">{components.map((item) =>
          <span className="chip" key={item.id}>{item.label} · {availabilityLabel[item.state]}</span>)}</div>
      </details>}
    </Panel>
    {!!widgets.length && <div className="widget-grid">{widgets.map((widget, index) => {
      const item = components.find((candidate) => candidate.id === widget.component);
      return <article className={`panel widget width-${widget.width}${dragged === widget.id ? " dragging" : ""}`}
        data-widget={widget.id} key={widget.id}>
        <header className="panel-heading widget-header"><div><h2>{widget.title}</h2>
          <p>{chartName[widget.chart]}{item ? ` · ${availabilityLabel[item.state]} · ${when(item.last_observed_at)}` : " · 暂无数据"}</p>
        </div>{draft && <div className="widget-actions">
          <button type="button" className="icon-button drag-handle" aria-label={`拖动 ${widget.title}`}
            onPointerDown={(e) => beginDrag(e, widget.id)} onPointerMove={updateDrag}
            onPointerUp={endDrag} onPointerCancel={() => setDragged(undefined)}><GripVertical size={17} /></button>
          <button type="button" className="icon-button" aria-label={`上移 ${widget.title}`} disabled={index === 0}
            onClick={() => move(widget.id, widgets[index - 1]!.id)}><ArrowUp size={16} /></button>
          <button type="button" className="icon-button" aria-label={`下移 ${widget.title}`} disabled={index === widgets.length - 1}
            onClick={() => move(widget.id, widgets[index + 1]!.id)}><ArrowDown size={16} /></button>
          <button type="button" className="icon-button" aria-label={`配置 ${widget.title}`}
            onClick={() => setConfig(widget)}><PencilLine size={15} /></button>
          <button type="button" className="icon-button danger-text" aria-label={`删除 ${widget.title}`}
            onClick={() => edit(widgets.filter((entry) => entry.id !== widget.id))}><Trash2 size={15} /></button>
        </div>}</header>
        {item?.state === "incompatible" && <div className="notice warn">最近的上报不符合 Schema。下方保留已验证的历史数据。</div>}
        {!item ? <Empty title="暂无可展示的数据" /> : <Suspense fallback={<Loading />}><WidgetData {...{ widget, names }} strategyId={sid} /></Suspense>}
      </article>;
    })}</div>}
    {add && <Dialog title="选择已上报的组件" close={() => setAdd(false)}>
      <div className="stack">{components.map((item) => <div className="component-option" key={item.id}>
        <div><strong>{item.label}</strong><small>{item.type} · {availabilityLabel[item.state]} · {chartName[item.recommended_chart]}</small></div>
        <button type="button" className="button secondary" disabled={!eligible(item)} onClick={() => {
          const widget = newWidget(item);
          edit([...widgets, widget]); setAdd(false); setConfig(widget);
        }}>添加 {item.label}</button>
      </div>)}</div>
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
      <Field label="组件宽度"><select value={form.width} onChange={(e) => set({ ...form, width: Number(e.target.value) as Widget["width"] })}>
        <option value={1}>单列</option><option value={2}>双列</option></select></Field>
      <Field label="图表高度（像素）"><input type="number" min={220} max={720} required value={form.height}
        onChange={(e) => set({ ...form, height: Number(e.target.value) })} /></Field>
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
