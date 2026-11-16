import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { resource, type Point } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";

const Chart = lazy(() => import("./chart"));
export type Resources = { cpu_cores: number; memory_bytes: number };
export type Reading<T> = { observedAt: number; receivedAt: number; data: T };
export type HostMetrics = {
  cpu_usage_percent?: number;
  memory_available_bytes?: number;
  swap_used_bytes?: number;
  disk_available_bytes?: number;
  swap_pressure?: boolean;
};
export type ProcessMetrics = {
  cpu_cores_used?: number;
  rss_bytes?: number;
  thread_count?: number;
  uptime_seconds?: number;
};
export type Host = {
  id: string; name: string;
  capacity: Resources | null; stale: boolean; latest: Reading<HostMetrics> | null;
};
export type HostProcess = {
  strategyId: string; strategyName: string; instanceId: string;
  hostId: string; hostName: string; stale: boolean; latest: Reading<ProcessMetrics> | null;
};
export const hostsQuery = { ...resource<Host[]>("/hosts"), refetchInterval: 15_000 };

export function useResourceFormat() {
  const { lang, t } = useLanguage();
  const format = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  return {
    bytes: (bytes?: number) => {
      if (bytes == null) return "—";
      const exponent = bytes === 0 ? 0 : Math.min(5, Math.floor(Math.log(bytes) / Math.log(1024)));
      return format.format(bytes / 1024 ** exponent) + " " + ["B", "KiB", "MiB", "GiB", "TiB", "PiB"][exponent];
    },
    cores: (cores?: number) => cores == null ? "—" : format.format(cores) + " " + t("cpuCores"),
    percent: (percent?: number) => percent == null ? "—" : format.format(percent) + "%",
  };
}

export function SampleStatus({ latest, stale }: { latest?: Reading<unknown> | null; stale: boolean }) {
  const { t } = useLanguage();
  return <Text className="performance-sample-status">
    <Badge tone={latest && !stale ? "success" : latest ? "warning" : "neutral"}>
      {t(!latest ? "missing" : stale ? "performanceStale" : "performanceFresh")}
    </Badge>
    {latest && <time className="muted" dateTime={new Date(latest.observedAt).toISOString()}>{timestamp(latest.observedAt)}</time>}
  </Text>;
}

export function HostMetricsGrid({ host, compact = false }: { host: Host; compact?: boolean }) {
  const { t } = useLanguage();
  const { bytes, cores, percent } = useResourceFormat();
  const sample = host.latest?.data;
  return <dl className="performance-metrics">
    <VStack gap={3}><dt>{t("hostCPU")}</dt><dd>{percent(sample?.cpu_usage_percent)}</dd>
      {host.capacity && host.capacity.cpu_cores > 0 && <Text type="supporting" className="muted">{cores(host.capacity.cpu_cores)}</Text>}
    </VStack>
    <VStack gap={3}><dt>{t("availableMemory")}</dt><dd>{bytes(sample?.memory_available_bytes)}</dd>
      {host.capacity && host.capacity.memory_bytes > 0 && <Text type="supporting" className="muted">{t("resourceLimit")} {bytes(host.capacity.memory_bytes)}</Text>}
    </VStack>
    {!compact && sample?.disk_available_bytes != null && <VStack gap={3}><dt>{t("availableDisk")}</dt><dd>{bytes(sample.disk_available_bytes)}</dd></VStack>}
    {!compact && sample?.swap_used_bytes != null && <VStack gap={3}><dt>{t("swapUsed")}</dt><dd>{bytes(sample.swap_used_bytes)}</dd></VStack>}
  </dl>;
}

export function ProcessMetricsGrid({ process }: { process: HostProcess }) {
  const { t } = useLanguage();
  const { bytes, cores } = useResourceFormat();
  const data = process.latest?.data;
  return <dl className="performance-metrics process-metrics">
    <VStack gap={3}><dt>{t("processCPU")}</dt><dd>{cores(data?.cpu_cores_used)}</dd></VStack>
    <VStack gap={3}><dt>{t("processRSS")}</dt><dd>{bytes(data?.rss_bytes)}</dd></VStack>
    {data?.thread_count != null && <VStack gap={3}><dt>{t("threadCount")}</dt><dd>{data.thread_count}</dd></VStack>}
  </dl>;
}

export function hostTrendAvailable<T>(history: Reading<T>[], value: (data: T) => number | undefined) {
  const first = history.find(sample => value(sample.data) != null);
  return first !== undefined && history.some(sample => sample.observedAt !== first.observedAt && value(sample.data) != null);
}

export function ResourceChart<T>({ readings, select, label }: {
  readings: Reading<T>[]; select: (data: T) => number | undefined; label: string;
}) {
  const { t } = useLanguage();
  const points: Point[] = useMemo(() => {
    const samples = new Map<number, Point>();
    for (const reading of readings) {
      const value = select(reading.data);
      if (value == null) continue;
      const text = String(value);
      samples.set(reading.observedAt, { at: reading.observedAt, count: 1, open: text, high: text, low: text, close: text });
    }
    return [...samples.values()];
  }, [readings, select]);
  return <VStack gap={3} className="surface padded resource-trend">
    <Heading level={3}>{label}</Heading>
    {points.length > 1 ? <Suspense fallback={<Loading />}><Chart points={points} /></Suspense> :
      <Text as="p" className="empty-inline">{t("performanceTrendEmpty")}</Text>}
  </VStack>;
}

const processCPU = (d: ProcessMetrics) => d.cpu_cores_used;
const processMemory = (d: ProcessMetrics) => d.rss_bytes == null ? undefined : d.rss_bytes / 1024 ** 2;

function ProcessTrend({ process }: { process: HostProcess }) {
  const { t } = useLanguage();
  const history = useQuery({
    ...resource<Reading<ProcessMetrics>[]>("/strategies/" + process.strategyId + "/performance/" + encodeURIComponent(process.instanceId) + "/history"),
    refetchInterval: 15_000,
  });
  return history.isPending ? <Loading /> : history.error ? <ErrorView error={history.error} /> :
    <VStack gap={3} className="performance-trends">
      <ResourceChart readings={history.data} select={processCPU} label={t("processCPU") + " · " + t("cpuCores")} />
      <ResourceChart readings={history.data} select={processMemory} label={t("processRSS") + " · MiB"} />
    </VStack>;
}

export function StrategyPerformance({ strategyId, compact = false, widget = false }: {
  strategyId: string; compact?: boolean; widget?: boolean;
}) {
  const { t } = useLanguage();
  const query = useQuery({ ...resource<HostProcess[]>("/strategies/" + strategyId + "/performance"), refetchInterval: 15_000 });
  const hosts = useQuery({ ...hostsQuery, enabled: widget && !compact && !!query.data?.length });
  const linkedHosts = new Set(query.data?.map(process => process.hostId));

  const content = query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} /> :
    !query.data.length ? <Text as="p" className="empty-inline">{t("noHostBinding")}</Text> :
    <VStack gap={3} className="performance-process-list">
      {widget && !compact && hosts.data?.filter(host => linkedHosts.has(host.id)).map(host =>
        <VStack gap={3} className="performance-widget-host" key={host.id}>
          <Link className="performance-link" to={"/hosts/" + host.id}>{host.name}</Link>
          <HostMetricsGrid host={host} compact />
          <SampleStatus latest={host.latest} stale={host.stale} />
        </VStack>
      )}
      {query.data.map(process => (
        <VStack gap={3} key={process.instanceId} className={widget ? "performance-process" : "surface padded performance-process"}>
          <HStack gap={3} wrap="wrap" vAlign="center" className="performance-process-heading">
            <strong>{process.instanceId}</strong>
            <Link className="performance-link" to={"/hosts/" + process.hostId}>{process.hostName}</Link>
          </HStack>
          <ProcessMetricsGrid process={process} />
          <SampleStatus latest={process.latest} stale={process.stale} />
          {!widget && <ProcessDetails process={process} />}
        </VStack>
      ))}
    </VStack>;

  return content;
}

function ProcessDetails({ process }: { process: HostProcess }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return <details className="performance-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("processTrend")}</summary>
    {open && <ProcessTrend process={process} />}
  </details>;
}
