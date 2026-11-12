import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Market } from "./dashboard-types";
import { Empty, Table, when } from "./ui";

const markerLabels = { order: "订单", fill: "成交", signal: "信号", risk: "风控" };

export default function MarketChart({ market, interval, height, showMarkers }: {
  market: Market; interval: number; height: number; showMarkers: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(null);
  const candles = useRef<ISeriesApi<"Candlestick">>(null);
  const marks = useRef<ISeriesMarkersPluginApi<UTCTimestamp>>(null);
  const fitted = useRef(false);
  const hasData = market.candles.length > 0;
  useEffect(() => {
    if (!container.current) return;
    const view = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: "#50645a", attributionLogo: true },
      grid: { vertLines: { color: "#edf2ed" }, horzLines: { color: "#edf2ed" } },
      timeScale: { timeVisible: true, secondsVisible: interval < 60, rightOffset: 4, borderColor: "#dfe8e2" },
      rightPriceScale: { borderColor: "#dfe8e2" },
    });
    chart.current = view;
    candles.current = view.addSeries(CandlestickSeries, {
      upColor: "#258063", downColor: "#b64d4d", wickUpColor: "#258063", wickDownColor: "#b64d4d", borderVisible: false,
    });
    marks.current = createSeriesMarkers(candles.current) as ISeriesMarkersPluginApi<UTCTimestamp>;
    return () => {
      view.remove(); chart.current = null; candles.current = null; marks.current = null; fitted.current = false;
    };
  }, [interval, hasData]);
  useEffect(() => {
    const series = market.candles.map((item) => ({
      time: Math.floor(Date.parse(item.observed_at) / 1000) as UTCTimestamp,
      open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close),
    }));
    candles.current?.setData(series);
    const labels: SeriesMarker<UTCTimestamp>[] = [];
    if (showMarkers) for (const event of market.markers) {
      const time = Date.parse(event.occurred_at) / 1000;
      let low = 0, high = series.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Number(series[middle]?.time) <= time) low = middle + 1; else high = middle;
      }
      const candle = series[low - 1];
      if (!candle || time >= candle.time + interval) continue;
      const sell = event.side === "sell";
      labels.push({
        time: candle.time, position: sell || event.kind === "risk" ? "aboveBar" : "belowBar",
        color: event.kind === "risk" ? "#a86620" : event.kind === "signal" ? "#426fb1" : sell ? "#b64d4d" : "#258063",
        shape: event.side ? sell ? "arrowDown" : "arrowUp" : event.kind === "risk" ? "square" : "circle",
        text: markerLabels[event.kind],
      });
    }
    marks.current?.setMarkers(labels);
    if (!fitted.current && series.length) { chart.current?.timeScale().fitContent(); fitted.current = true; }
  }, [market, showMarkers, interval]);
  if (!hasData) return <Empty title="所选范围没有 K 线" text="等待策略上报该标的和周期的 OHLCV。" />;
  return <><div ref={container} style={{ height }} className="chart-canvas" role="img" aria-label="交易 K 线" />
    {showMarkers && market.markers.length > 0 && <details className="form-detail market-markers">
      <summary>订单、成交、信号与风控标记（{market.markers.length}）</summary>
      <Table columns={["时间", "类型", "方向", "价格", "内容"]}>
        {[...market.markers].reverse().slice(0, 30).map((marker, index) => <tr key={`${marker.id}/${index}`}>
          <td>{when(marker.occurred_at)}</td><td>{markerLabels[marker.kind]}</td><td>{marker.side ?? "—"}</td>
          <td className="mono">{marker.price ?? "—"}</td><td className="wrap">{marker.message}</td>
        </tr>)}
      </Table>
    </details>}
  </>;
}
