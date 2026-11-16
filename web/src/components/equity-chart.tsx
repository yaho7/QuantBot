import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  TickMarkType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { chartColors } from "../shared/chart-colors";
import type { Point } from "../shared/api";

// Resolve modern CSS colors before passing an alpha gradient to the renderer.
function translucent(color: string, opacity: number) {
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export default function EquityChart({ points, lang, valueLabel }: {
  points: Point[];
  lang: string;
  valueLabel: string;
}) {
  const host = useRef<HTMLElement>(null);
  const readout = useRef<HTMLOutputElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  const fitted = useRef(false);
  const updateReadout = useRef<(point?: Point) => void>(() => {});
  const [colors, setColors] = useState("");
  const samples = useMemo(
    () => [...new Map(points.map((point) => [point.at, point])).values()]
      .filter((point) => Number.isFinite(point.at) && Number.isFinite(Number(point.close)))
      .sort((a, b) => a.at - b.at),
    [points],
  );
  const byTime = useMemo(
    () => new Map(samples.map((point) => [point.at / 1000, point])),
    [samples],
  );
  const latest = useRef({ samples, byTime });
  latest.current = { samples, byTime };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const read = () => setColors(chartColors(element));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-appearance", "data-palette"],
    });
    const scope = element.closest("[data-theme]");
    if (scope) observer.observe(scope, { attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element || !colors) return;
    const [accent, label, grid] = colors.split("|") as [string, string, string];
    const locale = lang === "zh" ? "zh-CN" : "en-US";
    const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    const prices = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const typography = getComputedStyle(element);
    const instance = createChart(element, {
      autoSize: true,
      layout: {
        attributionLogo: true,
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: label,
        fontFamily: typography.fontFamily,
        fontSize: Math.round(parseFloat(typography.fontSize)),
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: translucent(grid, 0.5) },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: translucent(label, 0.45), labelBackgroundColor: accent },
        horzLine: { color: translucent(label, 0.25), labelBackgroundColor: accent },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.16, bottom: 0.12 },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        tickMarkFormatter: (time: Time, kind: TickMarkType) => {
          if (typeof time !== "number") return null;
          const value = new Date(time * 1000);
          return kind === TickMarkType.Time || kind === TickMarkType.TimeWithSeconds
            ? clock.format(value)
            : date.format(value);
        },
      },
      localization: {
        locale,
        priceFormatter: (value: number) => prices.format(value),
        timeFormatter: (time: Time) => typeof time === "number" ? new Date(time * 1000).toLocaleString(locale) : "",
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });
    const area = instance.addSeries(AreaSeries, {
      lineColor: accent,
      lineWidth: 2,
      topColor: translucent(accent, 0.22),
      bottomColor: translucent(accent, 0),
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
      priceFormat: { type: "custom", minMove: 0.01, formatter: (value: number) => prices.format(value) },
    });
    instance.subscribeCrosshairMove((event) => {
      const point = typeof event.time === "number" ? latest.current.byTime.get(event.time) : undefined;
      showPoint(point ?? latest.current.samples.at(-1));
    });
    const showPoint = (point?: Point) => {
      if (!readout.current) return;
      if (!point) { readout.current.textContent = "—"; return; }
      // Canvas uses numbers; the readout retains the server's exact decimal text.
      const [whole = "", fraction] = point.close.split(".");
      const value = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : "." + fraction);
      readout.current.textContent = new Date(point.at).toLocaleString(locale) + " · " + valueLabel + " " + value;
    };
    chart.current = instance;
    series.current = area;
    updateReadout.current = showPoint;
    fitted.current = false;
    element.addEventListener("pointerleave", resetReadout);
    function resetReadout() { showPoint(latest.current.samples.at(-1)); }
    resetReadout();
    return () => {
      element.removeEventListener("pointerleave", resetReadout);
      chart.current = null;
      series.current = null;
      updateReadout.current = () => {};
      instance.remove();
    };
  }, [colors, lang, valueLabel]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    series.current.setData(samples.map((point) => ({
      time: (point.at / 1000) as UTCTimestamp,
      value: Number(point.close),
    })));
    if (!fitted.current && samples.length) {
      chart.current.timeScale().fitContent();
      fitted.current = true;
    }
    updateReadout.current(samples.at(-1));
  }, [samples, colors, lang, valueLabel]);

  return (
    <VStack gap={2} className="chart-with-values min-w-0">
      <output ref={readout} className="chart-value-readout block min-h-6 text-secondary text-sm tabular-nums">—</output>
      <VStack ref={host} height="clamp(16rem, 28vw, 20rem)" className="chart portfolio-plot shrink-0 min-w-0 text-xs" />
    </VStack>
  );
}
