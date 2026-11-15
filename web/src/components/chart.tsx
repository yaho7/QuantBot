import { useEffect, useRef } from "react";
import uPlot from "uplot";
import {
  createChart,
  CandlestickSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import "uplot/dist/uPlot.min.css";
import type { Point } from "../shared/api";
import { useLanguage } from "../shared/i18n";

export default function Chart({
  points,
  candle = false,
  featured = false,
}: {
  points: Point[];
  candle?: boolean;
  featured?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLOutputElement>(null);
  const { t, lang } = useLanguage();
  const valueLabel = t("chartValue");
  useEffect(() => {
    if (!ref.current || !points.length) return;
    const element = ref.current;
    const format = (value: string) => {
      const [whole, fraction] = value.split(".");
      return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : "." + fraction);
    };
    const showPoint = (point = points[points.length - 1]!) => {
      if (!readout.current) return;
      const date = new Date(point.at).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
      const values = candle
        ? (lang === "zh" ? ["开", "高", "低", "收"] : ["O", "H", "L", "C"]).map((label, index) =>
            label + " " + format([point.open, point.high, point.low, point.close][index]!)).join(" · ")
        : valueLabel + " " + format(point.close);
      readout.current.textContent = date + " · " + values;
    };
    showPoint();
    const chartColor =
      getComputedStyle(element).getPropertyValue("--theme-chart").trim() ||
      "#638ded";
    if (candle) {
      const chart = createChart(element, {
        autoSize: true,
        height: 260,
        layout: {
          attributionLogo: true,
          background: { color: "transparent" },
          textColor: "#8994a7",
        },
        grid: {
          vertLines: { color: "#8994a720" },
          horzLines: { color: "#8994a720" },
        },
        rightPriceScale: { borderVisible: false },
        timeScale: { timeVisible: true, borderVisible: false },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: "#41ad87",
        downColor: "#df6a72",
        borderVisible: false,
        wickUpColor: "#41ad87",
        wickDownColor: "#df6a72",
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
      const byTime = new Map(points.map(point => [Math.floor(point.at / 1000), point]));
      chart.subscribeCrosshairMove(event => {
        showPoint(typeof event.time === "number" ? byTime.get(event.time) : undefined);
      });
      chart.timeScale().fitContent();
      return () => chart.remove();
    }
    const plotHeight = () => featured ? 280 : 230;
    const grid = { stroke: "#8994a71a", show: true };
    const plot = new uPlot(
      {
        width: element.clientWidth,
        height: plotHeight(),
        legend: { show: false },
        cursor: { drag: { x: true, y: false } },
        axes: [
          { stroke: "#8994a7", grid: { ...grid, show: false }, show: true },
          { stroke: "#8994a7", grid, size: 80, show: true,
            values: (_self, values) => values.map(value => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", { maximumSignificantDigits: 6, notation: Math.abs(value) >= 1e7 ? "compact" : "standard" }).format(value)),
          },
        ],
        hooks: { setCursor: [self => showPoint(self.cursor.idx == null ? undefined : points[self.cursor.idx])] },
        series: [
          {},
          {
            label: valueLabel,
            stroke: chartColor,
            width: featured ? 1.5 : 2,
            fill: featured
              ? (self) => {
                  const { top, height } = self.bbox;
                  const gradient = self.ctx.createLinearGradient(0, top, 0, top + height);
                  gradient.addColorStop(0, `color-mix(in srgb, ${chartColor} 28%, transparent)`);
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
  }, [points, candle, featured, valueLabel, lang]);
  return <div className="chart-with-values">
    <output ref={readout} className="chart-value-readout">{points.length ? "" : "—"}</output>
    <div className={"chart" + (featured ? " portfolio-plot" : "")} ref={ref} />
  </div>;
}
