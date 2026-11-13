import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { useEffect, useRef } from "react";
import type { Chart, Point } from "./dashboard-types";
import { useChartPalette } from "./theme";
import { Empty } from "./ui";

use([CanvasRenderer, BarChart, LineChart, PieChart, ScatterChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent]);

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
  const palette = useChartPalette();
  const data = series.filter((entry) => entry.points.filter((point) => Number.isFinite(Number(point.value))).length >= minimum);
  if (!data.length) return <Empty title="所选范围数据不足" text={minimum > 1 ? "曲线至少需要两个实际观测点。" : "等待策略上报数据。"} />;
  const axis = { axisLine: { lineStyle: { color: palette.border } }, axisLabel: { color: palette.muted } };
  return <Graphic height={height} label="历史时间序列" option={{
    color: palette.series, textStyle: { color: palette.ink }, animation: false,
    legend: { top: 0, type: "scroll", textStyle: { color: palette.ink } },
    grid: { top: 42, left: "4%", right: "4%", bottom: 42, containLabel: true },
    tooltip: { trigger: "axis", renderMode: "richText", backgroundColor: palette.surface, textStyle: { color: palette.ink } },
    dataZoom: [{ type: "inside", filterMode: "none" }, { type: "slider", height: 16, bottom: 4,
      borderColor: palette.border, backgroundColor: palette.surface, textStyle: { color: palette.muted } }],
    xAxis: { type: "time", ...axis },
    yAxis: { type: "value", scale: true, name: unit, nameTextStyle: { color: palette.muted },
      splitLine: { lineStyle: { color: palette.border } }, ...axis },
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
  const palette = useChartPalette();
  if (!data.length) return <Empty title="没有可统计的上报数据" />;
  const tooltip = { renderMode: "richText" as const, backgroundColor: palette.surface, textStyle: { color: palette.ink } };
  const option: EChartsOption = chart === "pie" ? {
    legend: { bottom: 3, type: "scroll", textStyle: { color: palette.ink } }, tooltip: { trigger: "item", ...tooltip },
    series: [{ type: "pie", name: label, radius: ["36%", "64%"], center: ["50%", "45%"], data, label: { show: false } }],
  } : {
    grid: { top: 16, bottom: 22, left: "6%", right: "9%", containLabel: true },
    tooltip: { trigger: "axis", ...tooltip },
    xAxis: { type: "value", axisLabel: { color: palette.muted }, splitLine: { lineStyle: { color: palette.border } } },
    yAxis: { type: "category", axisLabel: { color: palette.muted }, data: data.map((item) => item.name) },
    series: [{ type: "bar", data: data.map((item) => item.value), barMaxWidth: 20 }],
  };
  return <Graphic height={height} label={label} option={{ color: palette.series, animation: false, ...option }} />;
}
