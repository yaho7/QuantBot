import { useId, useMemo, useRef } from "react";
import { Area, AreaChart, Brush, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { Point } from "../../../src/shared/api";

type Sample = { at: number; equity: number; exact: string };

export function formatDecimal(value?: string) {
  if (value === undefined) return "—";
  const [whole = "", fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : "." + fraction);
}

const day = 24 * 60 * 60 * 1000;
const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 };
const xDomain: [string, string] = ["dataMin", "dataMax"];
const yDomain: [string, string] = ["auto", "auto"];

export default function EquityChart({ points, lang, valueLabel, periodLabel }: {
  points: Point[];
  lang: string;
  valueLabel: string;
  periodLabel: string;
}) {
  const gradient = useId();
  const readout = useRef<HTMLOutputElement>(null);
  const data = useMemo(() => {
    const byTime = new Map<number, Sample>();
    for (const point of points) {
      const equity = Number(point.close);
      if (Number.isFinite(point.at) && Number.isFinite(equity)) {
        byTime.set(point.at, { at: point.at, equity, exact: point.close });
      }
    }
    return [...byTime.values()].sort((a, b) => a.at - b.at);
  }, [points]);
  const byTime = useMemo(() => new Map(data.map(sample => [sample.at, sample])), [data]);
  const config = useMemo(() => ({
    equity: { label: valueLabel, color: "var(--foreground)" },
  }) satisfies ChartConfig, [valueLabel]);
  const first = data[0];
  const last = data.at(-1);
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const formatTick = new Intl.DateTimeFormat(locale, first && last && last.at - first.at > 2 * day
    ? { month: "short", day: "numeric" }
    : { hour: "2-digit", minute: "2-digit", hour12: false });
  const formatAxisValue = new Intl.NumberFormat(locale, { maximumSignificantDigits: 7 });
  const formatLargeAxisValue = new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 5 });
  const tickDate = (value: number) => formatTick.format(value);
  const describe = (sample?: Sample) => sample
    ? `${formatDate.format(sample.at)} · ${valueLabel} ${formatDecimal(sample.exact)}`
    : "—";
  const show = (sample = last) => {
    if (readout.current) readout.current.textContent = describe(sample);
  };

  return (
    <figure className="grid min-w-0 gap-2" aria-label={valueLabel}>
      <output ref={readout} className="break-all text-xs text-muted-foreground tabular-nums">{describe(last)}</output>
      {data.length > 0 && (
        <ChartContainer config={config} className="aspect-auto h-[clamp(16rem,28vw,20rem)] w-full min-w-0">
          <AreaChart
            accessibilityLayer
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseMove={({ activeLabel }) => show(activeLabel == null ? undefined : byTime.get(Number(activeLabel)))}
            onMouseLeave={() => show()}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-equity)" stopOpacity={0.16} />
                <stop offset="100%" stopColor="var(--color-equity)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="at" type="number" domain={xDomain} tick={axisTick} tickLine={false} axisLine={false}
              minTickGap={24} tickMargin={8} tickFormatter={tickDate} />
            <YAxis orientation="right" domain={yDomain} tick={axisTick} tickLine={false} axisLine={false}
              width={72} tickCount={5} tickMargin={6}
              tickFormatter={value => (Math.abs(value) >= 1e7 ? formatLargeAxisValue : formatAxisValue).format(value)} />
            <ChartTooltip isAnimationActive={false} content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) => {
                  const sample = payload[0]?.payload as Sample | undefined;
                  return sample && formatDate.format(sample.at);
                }}
                formatter={(_value, _name, item) => {
                  const sample = item.payload as Sample | undefined;
                  return sample && (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{valueLabel}</span>
                      <span className="font-mono font-medium tabular-nums">{formatDecimal(sample.exact)}</span>
                    </div>
                  );
                }}
              />
            } />
            <Area dataKey="equity" stroke="var(--color-equity)" strokeWidth={2}
              fill={`url(#${gradient})`} baseValue="dataMin" dot={data.length === 1} isAnimationActive={false} />
            {data.length >= 12 && (
              <Brush dataKey="at" ariaLabel={periodLabel} tickFormatter={tickDate}
                height={24} travellerWidth={8} stroke="var(--muted-foreground)" fill="var(--background)" />
            )}
          </AreaChart>
        </ChartContainer>
      )}
    </figure>
  );
}
