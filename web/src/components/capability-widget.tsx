import { lazy, Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  resource,
  type Capability,
  type CapabilityCatalog,
  type CapabilityRecord,
  type Point,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, ErrorView, Loading, shown, timestamp } from "../shared/ui";
import { DataTable } from "../app/strategy";

const Chart = lazy(() => import("./chart"));
const emptyRecords: CapabilityRecord[] = [];

export function capabilityCatalog(id: string) {
  return {
    ...resource<CapabilityCatalog>("/strategies/" + id + "/capabilities"),
    refetchInterval: 5000,
  };
}

export function CapabilityWidget({
  strategyId,
  revision,
  capability,
  description,
  detailed,
}: {
  strategyId: string;
  revision: number;
  capability: Capability;
  description: boolean;
  detailed: boolean;
}) {
  const { t } = useLanguage();
  const base = "/strategies/" + strategyId;
  const chart =
    capability.renderer === "line" || capability.renderer === "candlestick";
  const table = capability.renderer === "table";
  const current = useQuery({
    ...resource<CapabilityRecord[]>(base + "/capability-data"),
    enabled:
      capability.kind === "metric" ||
      capability.kind === "resource" ||
      capability.kind === "event",
  });
  const historyPath =
    base + "/capabilities/" + capability.id + "/history?limit=200";
  const history = useQuery({
    ...resource<CapabilityRecord[]>(historyPath),
    enabled:
      chart || (table && capability.kind === "event" && capability.history),
  });
  const stateHistory = useQuery({
    ...resource<CapabilityRecord[]>(historyPath + "&source=state"),
    enabled:
      chart && (capability.kind === "metric" || capability.kind === "state"),
  });
  const record = current.data?.find(
    (item) => item.capabilityId === capability.id && item.revision === revision,
  );
  const recent =
    record &&
    (!capability.actual || record.observedAt >= capability.actual.observedAt)
      ? record
      : capability.actual;
  const value = recent?.value;
  const stale =
    recent === capability.actual
      ? capability.stale
      : !!(
          recent &&
          capability.stale_after_seconds &&
          Date.now() - recent.observedAt >=
            capability.stale_after_seconds * 1000
        );
  const records = useMemo(
    () =>
      (history.data ?? emptyRecords).filter(
        (item) => item.revision === revision,
      ),
    [history.data, revision],
  );
  const chartRecords = useMemo(
    () => [
      ...records,
      ...(stateHistory.data ?? emptyRecords).filter(
        (item) => item.revision === revision,
      ),
    ],
    [records, stateHistory.data, revision],
  );
  const error = current.error ?? history.error ?? stateHistory.error;
  const suggestion = capability.alert_suggestion;
  const formatDecimal = (input: string) => {
    const [whole, fraction = ""] = input.split(".");
    const precision = capability.precision;
    if (precision === undefined) return input;
    // Keep the exact integer portion, even when it exceeds JS number precision.
    return (
      whole +
      (precision
        ? "." + fraction.slice(0, precision).padEnd(precision, "0")
        : "")
    );
  };
  return (
    <>
      {description && capability.description && (
        <p className="muted">{capability.description}</p>
      )}
      {error && <ErrorView error={error} />}
      {chart && (
        <CapabilityChart
          records={chartRecords}
          candle={capability.renderer === "candlestick"}
        />
      )}
      {table ? (
        <DataTable
          title=""
          maxColumns={40}
          rows={
            capability.kind === "event" && capability.history
              ? (records.length ? records : record ? [record] : []).map(
                  (item) => {
                    const { value, associations = {} } = item;
                    return {
                      observedAt: timestamp(item.observedAt),
                      ...asRow(value),
                      ...associations,
                    };
                  },
                )
              : (Array.isArray(value)
                  ? value
                  : value === undefined
                    ? []
                    : [value]
                ).map((item) => ({
                  ...asRow(item),
                  ...record?.associations,
                }))
          }
        />
      ) : (
        <div className="equity-widget">
          <strong>
            {typeof value === "string" &&
            (chart || capability.renderer === "number")
              ? formatDecimal(value)
              : shown(value)}{" "}
            {capability.unit}
          </strong>
          {detailed && recent && (
            <time className="muted">{timestamp(recent.observedAt)}</time>
          )}
        </div>
      )}
      {stale && <Badge tone="warning">{t("staleData")}</Badge>}
      {capability.actual?.reason && (
        <p className="warning">{capability.actual.reason}</p>
      )}
      {detailed && suggestion && (
        <small className="muted">
          {t(
            suggestion.type === "stale"
              ? "suggestStale"
              : suggestion.type === "above"
                ? "suggestAbove"
                : "suggestBelow",
          )}
          {suggestion.threshold &&
            " " +
              suggestion.threshold +
              (capability.unit ? " " + capability.unit : "")}{" "}
          · {t("alertInactive")}
        </small>
      )}
    </>
  );
}

function asRow(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function CapabilityChart({
  records,
  candle,
}: {
  records: CapabilityRecord[];
  candle: boolean;
}) {
  const { t } = useLanguage();
  const points = useMemo(() => chartPoints(records, candle), [records, candle]);
  return points.length ? (
    <Suspense fallback={<Loading />}>
      <Chart points={points} candle={candle} />
    </Suspense>
  ) : (
    <p className="empty-inline">{t("missing")}</p>
  );
}

function chartPoints(records: CapabilityRecord[], candle: boolean) {
  const times = new Map<number, Point>();
  // Prefer the newest real observation within the chart's time precision.
  for (const item of [...records].sort(
    (a, b) => b.observedAt - a.observedAt || b.receivedAt - a.receivedAt,
  )) {
    const stamp = candle
      ? Math.floor(item.observedAt / 1000) * 1000
      : item.observedAt;
    if (times.has(stamp)) continue;
    const at = item.observedAt;
    if (candle) {
      const { open, high, low, close, volume } = asRow(item.value);
      if (
        typeof open === "string" &&
        typeof high === "string" &&
        typeof low === "string" &&
        typeof close === "string" &&
        typeof volume === "string"
      )
        times.set(stamp, { at, open, high, low, close, volume, count: 1 });
    } else if (
      typeof item.value === "string" &&
      Number.isFinite(Number(item.value))
    ) {
      const value = item.value;
      times.set(stamp, {
        at,
        open: value,
        high: value,
        low: value,
        close: value,
        count: 1,
      });
    }
  }
  return [...times.values()].reverse();
}
