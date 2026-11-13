import { i18n, label, t } from "../i18n";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Market } from "./dashboard-types";
import { useChartPalette } from "./theme";
import { Empty, Table, when } from "./ui";

const markerLabels = { order: "marketChart.orders", fill: "marketChart.fills", signal: "marketChart.signals", risk: "marketChart.riskControls" } as const;

export default function MarketChart({ market, interval, height, showMarkers }: {
  market: Market; interval: number; height: number; showMarkers: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(null);
  const candles = useRef<ISeriesApi<"Candlestick">>(null);
  const marks = useRef<ISeriesMarkersPluginApi<UTCTimestamp>>(null);
  const fitted = useRef(false);
  const hasData = market.candles.length > 0;
  const palette = useChartPalette();
  const locale = i18n.language;
  useEffect(() => {
    if (!container.current) return;
    const view = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: true },
      timeScale: { timeVisible: true, secondsVisible: interval < 60, rightOffset: 4 },
    });
    chart.current = view;
    candles.current = view.addSeries(CandlestickSeries, { borderVisible: false });
    marks.current = createSeriesMarkers(candles.current) as ISeriesMarkersPluginApi<UTCTimestamp>;
    return () => {
      view.remove(); chart.current = null; candles.current = null; marks.current = null; fitted.current = false;
    };
  }, [interval, hasData]);
  useEffect(() => {
    const line = { color: palette.border };
    chart.current?.applyOptions({
      localization: { locale },
      layout: { background: { type: ColorType.Solid, color: palette.surface }, textColor: palette.muted },
      grid: { vertLines: line, horzLines: line },
      timeScale: { borderColor: palette.border }, rightPriceScale: { borderColor: palette.border },
    });
    candles.current?.applyOptions({
      upColor: palette.gain, downColor: palette.loss, wickUpColor: palette.gain, wickDownColor: palette.loss,
    });
  }, [palette, interval, hasData, locale]);
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
        color: event.kind === "risk" ? palette.warning : event.kind === "signal" ? palette.signal : sell ? palette.loss : palette.gain,
        shape: event.side ? sell ? "arrowDown" : "arrowUp" : event.kind === "risk" ? "square" : "circle",
        text: label(markerLabels[event.kind]),
      });
    }
    marks.current?.setMarkers(labels);
    if (!fitted.current && series.length) { chart.current?.timeScale().fitContent(); fitted.current = true; }
  }, [market, showMarkers, interval, palette, locale]);
  if (!hasData) return <Empty title={t("marketChart.noCandlesInThisRange")} text={t("marketChart.waitingForOhlcvReportsForThisSymbol")} />;
  return <><div ref={container} style={{ height }} className="chart-canvas" role="img" aria-label={t("marketChart.tradingCandlesticks")} />
    {showMarkers && market.markers.length > 0 && <details className="form-detail market-markers">
      <summary>{t("marketChart.markerCount", { total: market.markers.length })}</summary>
      <Table columns={[t("marketChart.time"), t("marketChart.type"), t("marketChart.side"), t("marketChart.price"), t("marketChart.content")]}>
        {[...market.markers].reverse().slice(0, 30).map((marker, index) => <tr key={`${marker.id}/${index}`}>
          <td>{when(marker.occurred_at)}</td><td>{label(markerLabels[marker.kind])}</td><td>{marker.side ?? "—"}</td>
          <td className="mono">{marker.price ?? "—"}</td><td className="wrap">{marker.message}</td>
        </tr>)}
      </Table>
    </details>}
  </>;
}
