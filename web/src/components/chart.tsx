import { useId, useMemo, useRef } from "react";
import { Area, Bar, Brush, CartesianGrid, ComposedChart, Line, XAxis, YAxis, type BarShapeProps } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart";
import type { Point } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { decimalText } from "../shared/ui";
import "./chart.css";

type Sample = {
  at: number;
  value: number;
  range: [number, number];
  point: Point;
};

function toSamples(points: Point[], candle: boolean): Sample[] {
  const samples = new Map<number, Sample>();
  for (const point of points) {
    const value = Number(point.close);
    if (!Number.isFinite(point.at) || !Number.isFinite(value)) continue;
    const range: [number, number] = [Number(point.low), Number(point.high)];
    if (candle && (!range.every(Number.isFinite) || !Number.isFinite(Number(point.open)))) continue;
    samples.set(point.at, { at: point.at, value, range, point });
  }
  return [...samples.values()].sort((a, b) => a.at - b.at);
}

function Candle({ x, y, width, height, payload }: BarShapeProps) {
  const sample = payload as Sample | undefined;
  if (!sample) return null;
  const [low, high] = sample.range;
  const open = Number(sample.point.open);
  const close = sample.value;
  const top = Math.min(y, y + height);
  const bottom = Math.max(y, y + height);
  const position = (price: number) => high > low ? top + (bottom - top) * (high - price) / (high - low) : top;
  const bodyTop = position(Math.max(open, close));
  const bodyBottom = position(Math.min(open, close));
  const rising = close >= open;
  const color = "var(--foreground)";
  const center = x + width / 2;
  return (
    <g data-slot="candle" data-direction={rising ? "up" : "down"}>
      <line x1={center} x2={center} y1={top} y2={bottom} stroke={color} />
      <rect x={x} y={bodyTop} width={width} height={Math.max(1, bodyBottom - bodyTop)}
        stroke={color} fill={rising ? "var(--card)" : color} />
    </g>
  );
}

const day = 24 * 60 * 60 * 1000;
const axisPadding = 8;
const lineColor = "var(--theme-chart, var(--chart-1))";
const xDomain: [string, string] = ["dataMin", "dataMax"];
const yDomain: [string, string] = ["auto", "auto"];
const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 };

function exactText(value: string) {
  const text = decimalText(value);
  // Host telemetry uses JSON numbers and can legitimately serialize in scientific notation.
  return text === "—" && Number.isFinite(Number(value)) ? value : text;
}

export default function Chart({ points, candle = false, featured = false, valueLabel }: {
  points: Point[];
  candle?: boolean;
  featured?: boolean;
  valueLabel?: string;
}) {
  const { t, lang } = useLanguage();
  const label = valueLabel ?? t("chartValue");
  const gradient = useId();
  const readout = useRef<HTMLOutputElement>(null);
  const samples = useMemo(() => toSamples(points, candle), [points, candle]);
  const byTime = useMemo(() => new Map(samples.map(sample => [sample.at, sample])), [samples]);
  const config = useMemo(() => ({
    value: { label, color: lineColor },
    range: { label, color: lineColor },
  }) satisfies ChartConfig, [label]);
  const earliest = samples[0];
  const latest = samples.at(-1);
  const span = earliest && latest ? latest.at - earliest.at : 0;
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const axisDate = new Intl.DateTimeFormat(locale, span > 2 * day
    ? { month: "short", day: "numeric" }
    : { hour: "2-digit", minute: "2-digit", second: span < 120_000 ? "2-digit" : undefined, hour12: false });
  const axisValue = new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 });
  const compactValue = new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 5 });
  const tickDate = (value: number) => axisDate.format(value);
  const candleFields = lang === "zh" ? ["开盘", "最高", "最低", "收盘"] : ["Open", "High", "Low", "Close"];
  const entries = ({ point }: Sample) => candle
    ? [point.open, point.high, point.low, point.close].map((value, index) => [candleFields[index], exactText(value)] as const)
    : [[label, exactText(point.close)] as const];
  const describe = (sample?: Sample) => sample
    ? [date.format(sample.at), ...entries(sample).map(([key, value]) => `${key} ${value}`)].join(" · ")
    : "—";
  const showPoint = (point = latest) => {
    if (readout.current) readout.current.textContent = describe(point);
  };
  return (
    <figure className="chart-with-values min-w-0" aria-label={label}>
      <output ref={readout} className="chart-value-readout" aria-live="off">{describe(latest)}</output>
      {samples.length > 0 && (
        <ChartContainer config={config} className={"chart chart-recharts" + (featured ? " portfolio-plot" : "")}>
          <ComposedChart
            accessibilityLayer
            data={samples}
            margin={{ top: axisPadding, right: axisPadding, bottom: 0, left: 0 }}
            onMouseMove={({ activeLabel }) => showPoint(activeLabel == null ? undefined : byTime.get(Number(activeLabel)))}
            onMouseLeave={() => showPoint()}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="at" type={candle ? "category" : "number"} domain={xDomain}
              tick={axisTick} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={tickDate} />
            <YAxis orientation="right" domain={yDomain} width={76} tickCount={5}
              tick={axisTick} tickLine={false} axisLine={false} tickMargin={8}
              tickFormatter={value => (Math.abs(value) >= 1e7 ? compactValue : axisValue).format(value)} />
            <ChartTooltip allowEscapeViewBox={{ y: false, x: false }} isAnimationActive={false} content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) => {
                  const sample = payload[0]?.payload as Sample | undefined;
                  return sample ? date.format(sample.at) : undefined;
                }}
                formatter={(_value, _name, item) => {
                  const sample = item.payload as Sample | undefined;
                  return sample && (
                    <dl className="grid w-full grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      {entries(sample).map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{key}</dt>
                          <dd className="text-right font-mono font-medium tabular-nums">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  );
                }}
              />
            } />
            {candle ? (
              <Bar dataKey="range" name={label} shape={Candle} maxBarSize={12} isAnimationActive={false} />
            ) : featured ? (
              <>
                <defs>
                  <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <Area dataKey="value" name={label} stroke="var(--color-value)" strokeWidth={2}
                  fill={`url(#${gradient})`} baseValue="dataMin" dot={samples.length === 1} isAnimationActive={false} />
              </>
            ) : (
              <Line dataKey="value" name={label} stroke="var(--color-value)" strokeWidth={2}
                dot={samples.length === 1} isAnimationActive={false} />
            )}
            {samples.length >= 12 && (
              <Brush dataKey="at" ariaLabel={t("timeRange")} tickFormatter={tickDate}
                height={24} travellerWidth={8} stroke="var(--muted-foreground)" fill="var(--background)" />
            )}
          </ComposedChart>
        </ChartContainer>
      )}
    </figure>
  );
}
