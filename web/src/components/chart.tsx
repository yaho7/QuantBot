import { useEffect, useRef } from "react";
import uPlot from "uplot";
import {
  createChart,
  CandlestickSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import "uplot/dist/uPlot.min.css";
import type { Point } from "../shared/api";

export default function Chart({
  points,
  candle = false,
}: {
  points: Point[];
  candle?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !points.length) return;
    const element = ref.current;
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
      chart.timeScale().fitContent();
      return () => chart.remove();
    }
    const plot = new uPlot(
      {
        width: element.clientWidth,
        height: 230,
        legend: { show: false },
        cursor: { drag: { x: true, y: false } },
        axes: [
          { stroke: "#8994a7", grid: { stroke: "#8994a71a" } },
          { stroke: "#8994a7", grid: { stroke: "#8994a71a" }, size: 72 },
        ],
        series: [
          {},
          {
            label: "Value",
            stroke: "#638ded",
            width: 2,
            fill: "#638ded12",
            points: { show: false },
          },
        ],
      },
      [points.map((p) => p.at / 1000), points.map((p) => Number(p.close))],
      element,
    );
    const observer = new ResizeObserver(() =>
      plot.setSize({ width: element.clientWidth, height: 230 }),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      plot.destroy();
    };
  }, [points, candle]);
  return <div className="chart" ref={ref} />;
}
