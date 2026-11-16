import { chartColors } from "../shared/chart-colors";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import {
  createChart,
  CandlestickSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Point } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import EquityChart from "./equity-chart";

export default function Chart({
  points,
  candle = false,
  featured = false,
}: {
  points: Point[];
  candle?: boolean;
  featured?: boolean;
}) {
  const { lang, t } = useLanguage();
  return featured && !candle
    ? <EquityChart points={points} lang={lang} valueLabel={t("chartValue")} />
    : <MetricChart points={points} candle={candle} featured={featured} />;
}

function MetricChart({
  points,
  candle = false,
  featured = false,
}: {
  points: Point[];
  candle?: boolean;
  featured?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const readout = useRef<HTMLOutputElement>(null);
  const { t, lang } = useLanguage();
  const valueLabel = t("chartValue");
  const [colors, setColors] = useState("");
  useEffect(() => {
    const read = () => {
      if (ref.current) setColors(chartColors(ref.current));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-appearance", "data-palette"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current || !points.length) return;
    const element = ref.current;
    const format = (value: string) => {
      const [whole, fraction] = value.split(".");
      return (
        whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
        (fraction === undefined ? "" : "." + fraction)
      );
    };
    const showPoint = (point = points[points.length - 1]!) => {
      if (!readout.current) return;
      const date = new Date(point.at).toLocaleString(
        lang === "zh" ? "zh-CN" : "en-US",
      );
      const values = candle
        ? (lang === "zh" ? ["开", "高", "低", "收"] : ["O", "H", "L", "C"])
            .map(
              (label, index) =>
                label +
                " " +
                format(
                  [point.open, point.high, point.low, point.close][index]!,
                ),
            )
            .join(" · ")
        : valueLabel + " " + format(point.close);
      readout.current.textContent = date + " · " + values;
    };
    showPoint();
    if (!colors) return;
    const [
      chartColor = "currentColor",
      labelColor = "currentColor",
      gridColor = "transparent",
      positive = chartColor,
      negative = labelColor,
    ] = colors.split("|");
    if (candle) {
      const chart = createChart(element, {
        autoSize: true,
        height: element.clientHeight || 260,
        layout: {
          attributionLogo: true,
          background: { color: "transparent" },
          textColor: labelColor,
        },
        grid: {
          vertLines: { color: gridColor },
          horzLines: { color: gridColor },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { timeVisible: true, borderVisible: false },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: positive,
        downColor: negative,
        borderVisible: false,
        wickUpColor: positive,
        wickDownColor: negative,
      });
      series.setData(
        points.map((p) => ({
          time: Math.floor(p.at / 1000) as UTCTimestamp,
          open: Number(p.open),
          high: Number(p.high),
          low: Number(p.low),
          close: Number(p.close),
        })),
      );
      const byTime = new Map(
        points.map((point) => [Math.floor(point.at / 1000), point]),
      );
      chart.subscribeCrosshairMove((event) => {
        showPoint(
          typeof event.time === "number" ? byTime.get(event.time) : undefined,
        );
      });
      chart.timeScale().fitContent();
      return () => chart.remove();
    }
    const plotHeight = () => Math.max(180, element.clientHeight || 256);
    const grid = { stroke: gridColor, show: true };
    const plot = new uPlot(
      {
        width: element.clientWidth,
        height: plotHeight(),
        legend: { show: false },
        cursor: { drag: { x: true, y: false } },
        axes: [
          { stroke: labelColor, grid: { ...grid, show: false }, show: true },
          {
            stroke: labelColor,
            grid,
            size: 80,
            show: true,
            values: (_self, values) =>
              values.map((value) =>
                new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
                  maximumSignificantDigits: 6,
                  notation: Math.abs(value) >= 1e7 ? "compact" : "standard",
                }).format(value),
              ),
          },
        ],
        hooks: {
          setCursor: [
            (self) =>
              showPoint(
                self.cursor.idx == null ? undefined : points[self.cursor.idx],
              ),
          ],
        },
        series: [
          {},
          {
            label: valueLabel,
            stroke: chartColor,
            width: featured ? 1.5 : 2,
            fill: featured
              ? (self) => {
                  const { top, height } = self.bbox;
                  const gradient = self.ctx.createLinearGradient(
                    0,
                    top,
                    0,
                    top + height,
                  );
                  gradient.addColorStop(
                    0,
                    `color-mix(in srgb, ${chartColor} 28%, transparent)`,
                  );
                  gradient.addColorStop(1, "transparent");
                  return gradient;
                }
              : `color-mix(in srgb, ${chartColor} 9%, transparent)`,
            points: { show: false },
          },
        ],
      },
      [points.map((p) => p.at / 1000), points.map((p) => Number(p.close))],
      element,
    );
    const observer = new ResizeObserver(() =>
      plot.setSize({ width: element.clientWidth, height: plotHeight() }),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      plot.destroy();
    };
  }, [points, candle, featured, valueLabel, lang, colors]);
  return (
    <VStack className="chart-with-values min-w-0">
      <output
        ref={readout}
        className="chart-value-readout block min-h-6 py-1 px-3 text-secondary text-sm tabular-nums"
      >
        {points.length ? "" : "—"}
      </output>
      <VStack
        className={"chart" + (featured ? "   portfolio-plot" : "")}
        ref={ref}
      />
    </VStack>
  );
}
