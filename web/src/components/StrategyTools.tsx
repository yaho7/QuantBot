import { useMutation, useQuery } from "@tanstack/react-query";
import { ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { api, type StrategyAction, type StrategyView } from "@/lib/api";
import { locale, tr } from "@/lib/i18n";

type Point = { time: number; value: number };

function chartColor(container: HTMLElement, property: string): string {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return "#777";
  context.fillStyle = getComputedStyle(container).getPropertyValue(property).trim();
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${r},${g},${b})`;
}

function MetricChart({ points, title }: { points: Point[]; title: string }) {
  const parent = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const lineRef = useRef<ISeriesApi<"Line">>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (!parent.current) return;
    const element = parent.current;
    const border = chartColor(element, "--border");
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        textColor: chartColor(element, "--muted-foreground"),
        background: { type: ColorType.Solid, color: chartColor(element, "--background") },
        attributionLogo: true,
      },
      grid: { horzLines: { color: border }, vertLines: { visible: false } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: true },
      localization: { locale },
    });
    chartRef.current = chart;
    lineRef.current = chart.addSeries(LineSeries, {
      color: chartColor(element, "--primary"),
      lineWidth: 2,
      priceLineVisible: false,
      pointMarkersVisible: true,
    });
    fitted.current = false;
    return () => {
      chartRef.current = null;
      lineRef.current = null;
      chart.remove();
    };
  }, []);
  useEffect(() => {
    lineRef.current?.setData(points.map(({ time, value }) => ({ time: time as UTCTimestamp, value })));
    if (points.length && !fitted.current) {
      chartRef.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [points]);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div ref={parent} role="img" aria-label={title} className="h-64 w-full sm:h-80" />
      <p className="px-2 py-1 text-[10px] text-muted-foreground">
        TradingView Lightweight Charts™ · Copyright © 2025 <a href="https://www.tradingview.com/"
          target="_blank" rel="noreferrer" className="hover:underline">TradingView, Inc.</a>
      </p>
    </div>
  );
}

function Metrics({ strategy }: { strategy: StrategyView }) {
  const id = useId();
  const summaries = strategy.metrics ?? [];
  const [metric, setMetric] = useState(summaries[0]?.id ?? "");
  const view = useQuery({
    queryKey: ["strategy-metric", strategy.id, metric],
    queryFn: () => api.strategyMetric(strategy.id, metric),
    enabled: !!metric,
    refetchInterval: 5_000,
  });
  return (
    <div className="grid gap-3">
      <Field label={tr("指标")} htmlFor={id}>
        <Select id={id} value={metric} onChange={(event) => setMetric(event.target.value)}>
          {summaries.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </Select>
      </Field>
      <QueryBoundary query={view}>
        {(data) => <>
          <p className="font-display text-2xl tabular-nums">
            {new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(data.value)}
            {data.unit && <span className="ml-2 font-sans text-sm text-muted-foreground">{data.unit}</span>}
          </p>
          <MetricChart key={data.id} points={data.points} title={data.label} />
        </>}
      </QueryBoundary>
    </div>
  );
}

function ActionForm({ strategy, action }: { strategy: StrategyView; action: StrategyAction }) {
  const prefix = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [confirmation, setConfirmation] = useState<{ args: Record<string, unknown>; ticket: string }>();
  const prepare = useMutation({
    mutationFn: async (args: Record<string, unknown>) => {
      const { ticket } = await api.prepareAction(strategy.id, action.id, args);
      return { ticket, args };
    },
    onSuccess: setConfirmation,
  });
  const run = useMutation({
    mutationFn: async ({ args, ticket }: { args: Record<string, unknown>; ticket?: string }) => {
      const result = await api.strategyAction(strategy.id, action.id, args, ticket);
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSettled: () => setConfirmation(undefined),
  });
  return (
    <>
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (!strategy.online || run.isPending || prepare.isPending || confirmation) return;
        const args: Record<string, unknown> = Object.create(null);
        for (const [name, field] of Object.entries(action.fields)) {
          const value = Object.hasOwn(values, name) ? values[name] : undefined;
          if (field.type === "boolean") args[name] = value === true;
          else if (value !== undefined && value !== "") args[name] = field.type === "number" ? Number(value) : value;
        }
        if (action.confirm) prepare.mutate(args);
        else run.mutate({ args });
      }}>
        <fieldset disabled={!!confirmation || prepare.isPending || run.isPending} className="grid gap-3">
        {Object.entries(action.fields).map(([name, field]) => {
          const id = prefix + name;
          const value = Object.hasOwn(values, name) ? values[name] : undefined;
          const set = (next: string | boolean) => setValues((previous) => ({ ...previous, [name]: next }));
          if (field.type === "boolean") {
            return <label key={name} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
              {field.label}
            </label>;
          }
          return (
            <Field key={name} label={field.label} htmlFor={id}>
              {field.type === "select" ? (
                <Select id={id} value={String(value ?? "")} required={field.required}
                  onChange={(event) => set(event.target.value)}>
                  <option value="">{tr("请选择")}</option>
                  {field.options.map((option) => <option value={option} key={option}>{option}</option>)}
                </Select>
              ) : (
                <Input id={id} value={String(value ?? "")} type={field.type} step={field.type === "number" ? "any" : undefined}
                  maxLength={1_000} required={field.required} onChange={(event) => set(event.target.value)} />
              )}
            </Field>
          );
        })}
        </fieldset>
        {prepare.error && <Alert tone="loss">{prepare.error.message}</Alert>}
        {run.error && <Alert tone="loss">{run.error.message}</Alert>}
        {run.data && <Alert tone="info">{run.data.message}</Alert>}
        {run.data?.data != null && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-2 text-xs">
            {JSON.stringify(run.data.data, null, 2)}
          </pre>
        )}
        {confirmation ? (
          <Alert tone="warning" className="grid gap-2">
            <p>{tr("执行 {0}？", action.label)}</p>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={run.isPending} onClick={() => setConfirmation(undefined)}>{tr("取消")}</Button>
              <Button type="button" loading={run.isPending} disabled={!strategy.online} onClick={() => run.mutate(confirmation)}>
                <Play /> {tr("执行")}
              </Button>
            </DialogFooter>
          </Alert>
        ) : (
          <DialogFooter>
            <Button type="submit" disabled={!strategy.online} loading={run.isPending || prepare.isPending}><Play /> {action.label}</Button>
          </DialogFooter>
        )}
      </form>
    </>
  );
}

function Actions({ strategy }: { strategy: StrategyView }) {
  const id = useId();
  const actions = strategy.actions ?? [];
  const [selected, setSelected] = useState(actions[0]?.id ?? "");
  const action = actions.find((item) => item.id === selected) ?? actions[0];
  return (
    <div className="grid gap-3">
      <Field label={tr("策略操作")} htmlFor={id}>
        <Select id={id} value={action?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
          {actions.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
        </Select>
      </Field>
      {!strategy.online && <Alert tone="warning">{tr("请等策略上线后再执行此操作。")}</Alert>}
      {action && <ActionForm key={action.id} strategy={strategy} action={action} />}
    </div>
  );
}

export default function StrategyTools({ strategy, mode, onClose }: {
  strategy: StrategyView; mode: "metrics" | "actions"; onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={tr(mode === "metrics" ? "策略指标" : "策略操作")}
        description={strategy.name} className={mode === "metrics" ? "max-w-3xl" : undefined}>
        {mode === "metrics" ? <Metrics strategy={strategy} /> : <Actions strategy={strategy} />}
      </DialogContent>
    </Dialog>
  );
}
