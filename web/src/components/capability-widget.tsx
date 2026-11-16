import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
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
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";
import { useDisplay } from "../shared/display";
import { DataTable } from "../app/strategy";
import { RelatedRecords } from "./related-records";

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
  compact = false,
}: {
  strategyId: string;
  revision: number;
  capability: Capability;
  description: boolean;
  detailed: boolean;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const base = "/strategies/" + strategyId;
  const chart =
    capability.renderer === "line" || capability.renderer === "candlestick";
  const table = capability.renderer === "table";
  const current = useQuery({
    ...resource<CapabilityRecord[]>(base + "/capability-data"),
    enabled: capability.kind === "metric" || capability.kind === "event",
  });
  const resources = useQuery({
    ...resource<{
      resourceRevision: number;
      observedAt: number;
      items: CapabilityRecord[];
    }>(base + "/resources/" + capability.id),
    enabled: capability.kind === "resource",
  });
  const historyPath =
    base + "/capabilities/" + capability.id + "/history?limit=200";
  const history = useQuery({
    ...resource<CapabilityRecord[]>(historyPath),
    enabled:
      capability.kind !== "resource" &&
      (chart || (table && capability.kind === "event" && capability.history)),
  });
  const stateHistory = useQuery({
    ...resource<CapabilityRecord[]>(historyPath + "&source=state"),
    enabled:
      chart && (capability.kind === "metric" || capability.kind === "state"),
  });
  const record = current.data?.find(
    (item) =>
      item.capabilityId === capability.id &&
      item.revision >= capability.sinceRevision &&
      item.revision <= revision,
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
        (item) =>
          item.revision >= capability.sinceRevision &&
          item.revision <= revision,
      ),
    [history.data, revision, capability.sinceRevision],
  );
  const chartRecords = useMemo(
    () => [
      ...records,
      ...(stateHistory.data ?? emptyRecords).filter(
        (item) =>
          item.revision >= capability.sinceRevision &&
          item.revision <= revision,
      ),
    ],
    [records, stateHistory.data, revision, capability.sinceRevision],
  );
  const error =
    current.error ?? history.error ?? stateHistory.error ?? resources.error;
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
        <Text as="p" className="muted">{capability.description}</Text>
      )}
      {error && <ErrorView error={error} />}
      {chart && !compact && (
        <CapabilityChart
          records={
            capability.kind === "resource"
              ? (resources.data?.items ?? emptyRecords)
              : chartRecords
          }
          candle={capability.renderer === "candlestick"}
        />
      )}
      {table && compact ? (
        <Text as="p" className="muted">{t("expandForDetails")}</Text>
      ) : table ? (
        <DataTable
          title=""
          maxColumns={40}
          fields="annotations"
          renderCell={(key, value) =>
            key === "Related IDs" && value && typeof value === "object" ? (
              <RelatedRecords
                strategyId={strategyId}
                associations={value as Record<string, string>}
              />
            ) : undefined
          }
          rows={
            capability.kind === "resource"
              ? (resources.data?.items ?? []).flatMap((item) =>
                  (Array.isArray(item.value) ? item.value : [item.value]).map(
                    (value) => ({
                      "Resource ID": item.id,
                      ...asRow(value),
                      "Related IDs": item.associations,
                    }),
                  ),
                )
              : capability.kind === "event" && capability.history
                ? (records.length ? records : record ? [record] : []).map(
                    (item) => {
                      return {
                        "Observed at": timestamp(item.observedAt),
                        ...asRow(item.value),
                        "Related IDs": item.associations,
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
                    "Related IDs": record?.associations,
                  }))
          }
        />
      ) : (
        <VStack gap={3} className="equity-widget">
          <strong>
            {typeof value === "string" &&
            (chart || capability.renderer === "number")
              ? formatDecimal(value)
              : capability.kind === "state" && capability.group === "health" && typeof value === "boolean"
                ? t(value ? "healthy" : "degraded")
                : display.value(value)}{" "}
            {capability.unit}
          </strong>
          {detailed && recent && (
            <time className="muted">{timestamp(recent.observedAt)}</time>
          )}
          <RelatedRecords
            strategyId={strategyId}
            associations={record?.associations}
          />
        </VStack>
      )}
      {(stale ||
        (resources.data?.observedAt &&
          capability.stale_after_seconds &&
          Date.now() - resources.data.observedAt >=
            capability.stale_after_seconds * 1000)) && (
        <Badge tone="warning">{t("staleData")}</Badge>
      )}
      {capability.actual?.reason && (
        <Text as="p" className="warning">{capability.actual.reason}</Text>
      )}
      {detailed && suggestion && (
        <Text type="supporting" className="muted">
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
        </Text>
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
    <Text as="p" className="empty-inline">{t("missing")}</Text>
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
