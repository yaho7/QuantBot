import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { useEffect, useRef } from "react";
import type { Chart, Point } from "./dashboard-types";
import { Empty } from "./ui";

use([CanvasRenderer, BarChart, LineChart, PieChart, ScatterChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent]);

const colors = ["#247e63", "#4075b4", "#b36c21", "#7e62a5", "#b14b59", "#6b7b42"];

function Graphic({ option, height, label }: { option: EChartsOption; height: number; label: string }) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = init(container.current, undefined, { renderer: "canvas" });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); chart.dispose(); instance.current = null; };
  }, []);
  useEffect(() => { instance.current?.setOption(option, { replaceMerge: ["series"] }); }, [option]);
  return <div className="chart-canvas" ref={container} style={{ height }} role="img" aria-label={label} />;
}

export function TimeSeries({ series, chart, unit, height, minimum = 2 }: {
  series: { name: string; points: Point[] }[]; chart: Chart; unit: string; height: number; minimum?: number;
}) {
  const data = series.filter((entry) => entry.points.filter((point) => Number.isFinite(Number(point.value))).length >= minimum);
  if (!data.length) return <Empty title="所选范围数据不足" text={minimum > 1 ? "曲线至少需要两个实际观测点。" : "等待策略上报数据。"} />;
  const axis = { axisLine: { lineStyle: { color: "#d7e3d9" } }, axisLabel: { color: "#5c6d65" } };
  return <Graphic height={height} label="历史时间序列" option={{
    color: colors, animation: false, legend: { top: 0, type: "scroll", textStyle: { color: "#41584c" } },
    grid: { top: 42, left: "4%", right: "4%", bottom: 42, containLabel: true },
    tooltip: { trigger: "axis", renderMode: "richText" },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 4 }],
    xAxis: { type: "time", ...axis },
    yAxis: { type: "value", scale: true, name: unit, splitLine: { lineStyle: { color: "#edf2ed" } }, ...axis },
    series: data.map((entry) => {
      const points: [number, number][] = entry.points.map((point) => [Date.parse(point.observed_at), Number(point.value)]);
      const base = { name: entry.name, data: points };
      if (chart === "bar") return { ...base, type: "bar" as const, barMaxWidth: 24 };
      if (chart === "scatter") return { ...base, type: "scatter" as const, symbolSize: 6 };
      return { ...base, type: "line" as const, showSymbol: points.length < 10,
        lineStyle: { width: 2 }, ...(chart === "area" ? { areaStyle: { opacity: .13 } } : {}) };
    }),
  }} />;
}

export function Distribution({ data, chart, height, label }: {
  data: { name: string; value: number }[]; chart: Chart; height: number; label: string;
}) {
  if (!data.length) return <Empty title="没有可统计的上报数据" />;
  const option: EChartsOption = chart === "pie" ? {
    legend: { bottom: 3, type: "scroll" }, tooltip: { trigger: "item", renderMode: "richText" },
    series: [{ type: "pie", name: label, radius: ["36%", "64%"], center: ["50%", "45%"], data, label: { show: false } }],
  } : {
    grid: { top: 16, bottom: 22, left: "6%", right: "9%", containLabel: true },
    tooltip: { trigger: "axis", renderMode: "richText" },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#edf2ed" } } },
    yAxis: { type: "category", data: data.map((item) => item.name) },
    series: [{ type: "bar", data: data.map((item) => item.value), barMaxWidth: 20 }],
  };
  return <Graphic height={height} label={label} option={{ color: colors, animation: false, ...option }} />;
}
