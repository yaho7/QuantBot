import { Card } from "@/components/ui/card";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RiArrowLeftLine as ArrowLeft, RiArrowRightUpLine as ArrowUpRight, RiServerLine as Server } from "@remixicon/react";
import { useParams } from "react-router-dom";
import { Link } from "../shared/page-links";
import { resource } from "../shared/api";
import { useLanguage, type Message } from "../shared/i18n";
import { ErrorView, Loading } from "../shared/ui";
import { Page } from "./App";
import {
  HostMetricsGrid, hostsQuery, ProcessMetricsGrid, ResourceChart, SampleStatus,
  hostTrendAvailable, useResourceFormat, type Host, type HostMetrics, type HostProcess, type Reading, type Resources,
} from "../components/host-performance";

type HostDetail = Host & { members: HostProcess[]; history: Reading<HostMetrics>[] };

export function HostsPage() {
  const { t } = useLanguage();
  const query = useQuery(hostsQuery);
  return <Page title={t("hosts")}>
    {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} retry={() => void query.refetch()} /> :
      !query.data.length ? (
        <section className="empty-state">
          <Server size={24} strokeWidth={1.5} aria-hidden="true" />
          <h2>{t("hosts")}</h2>
          <p>{t("noHosts")}</p>
        </section>
      ) : (
        <div className="host-cards grid gap-4">
          {query.data.map(host => (
            <Card className="monitor-panel min-w-0 p-4" key={host.id}>
              <article className="performance-host grid gap-3">
                <header className="performance-process-heading">
                  <Link className="performance-link" to={"/hosts/" + host.id}>
                    <h2 className="text-lg font-medium">{host.name}</h2>
                    <ArrowUpRight size={16} strokeWidth={1.5} aria-hidden="true" />
                  </Link>
                </header>
                <HostMetricsGrid host={host} compact />
                <SampleStatus latest={host.latest} stale={host.stale} />
              </article>
            </Card>
          ))}
        </div>
      )}
  </Page>;
}

const hostCPU = (m: HostMetrics) => m.cpu_usage_percent;
const hostMemory = (m: HostMetrics) => m.memory_available_bytes == null ? undefined : m.memory_available_bytes / 1024 ** 3;
const gib = 1024 ** 3;

export function HostDetailPage() {
  const { id = "" } = useParams();
  const { t } = useLanguage();
  const query = useQuery({ ...resource<HostDetail>("/hosts/" + id), refetchInterval: 15_000 });
  return <Page title={query.data?.name ?? t("hosts")} actions={
    <Link className="button" to="/hosts"><ArrowLeft size={16} />{t("hosts")}</Link>
  }>
    {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} retry={() => void query.refetch()} /> :
      <>
        <Card className="monitor-panel p-4"><section className="performance-host grid gap-3">
          <header className="performance-process-heading">
            <SampleStatus latest={query.data.latest} stale={query.data.stale} />
          </header>
          <HostMetricsGrid host={query.data} />
        </section></Card>
        <CapacityPlanner key={id} host={query.data} />
        <HostTrends history={query.data.history} />
        <section className="section">
          <div className="section-heading"><h2>{t("hostProcesses")}</h2></div>
          {!query.data.members.length ? <p className="surface empty-inline">{t("noHostBinding")}</p> :
            <div className="hosts-grid">{query.data.members.map(process =>
              <article className="surface padded performance-process" key={processKey(process)}>
                <div className="performance-process-heading">
                  <Link className="performance-link" to={"/strategies/" + process.strategyId}>{process.strategyName}</Link>
                  <small className="muted">{process.instanceId}</small>
                </div>
                <ProcessMetricsGrid process={process} />
                <SampleStatus latest={process.latest} stale={process.stale} />
              </article>
            )}</div>}
        </section>
        <HostSuggestions host={query.data} />
      </>}
  </Page>;
}

function HostTrends({ history }: { history: Reading<HostMetrics>[] }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const cpu = hostTrendAvailable(history, hostCPU);
  const memory = hostTrendAvailable(history, hostMemory);
  if (!cpu && !memory) return null;
  return <details className="section surface padded performance-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("hostTrends")}</summary>
    {open && <div className="performance-trends">
      {cpu && <ResourceChart readings={history} select={hostCPU} label={t("hostCPU") + " · %"} />}
      {memory && <ResourceChart readings={history} select={hostMemory} label={t("availableMemory") + " · GiB"} />}
    </div>}
  </details>;
}

type Estimate = { additional: number | null; reason?: string; bottleneck?: string; budget?: Resources; source?: string };
const reasons: Record<string, Message> = {
  host_stale: "estimateHostStale", host_metrics_missing: "estimateMissing",
  swap_pressure: "estimateSwap", process_stale: "estimateProcessStale", process_metrics_missing: "estimateProcessMissing",
};
function processKey(process: HostProcess) { return process.strategyId + "/" + process.instanceId; }

function CapacityPlanner({ host }: { host: HostDetail }) {
  const { t } = useLanguage();
  const formats = useResourceFormat();
  const [selected, setSelected] = useState("");
  const [reserve, setReserve] = useState(20);
  const instance = host.members.find(member => processKey(member) === selected) ?? host.members[0];
  const params = new URLSearchParams({
    strategyId: instance?.strategyId ?? "", instanceId: instance?.instanceId ?? "", reservePercent: String(reserve),
  });
  const query = useQuery({
    ...resource<Estimate>("/hosts/" + host.id + "/capacity?" + params),
    enabled: !!instance, refetchInterval: 15_000,
  });
  const result = query.data;
  return <section className="section surface padded capacity-panel">
    <h2 className="text-lg font-medium">{t("capacityPlanner")}</h2>
    <p className="muted">{t("capacityHint")}</p>
    {!instance ? <p>{t("noHostBinding")}</p> : <>
      <div className="capacity-fields">
        <label>{t("similarInstance")}<select value={processKey(instance)} onChange={e => setSelected(e.target.value)}>
          {host.members.map(member => <option key={processKey(member)} value={processKey(member)}>{member.strategyName} · {member.instanceId}</option>)}
        </select></label>
        <label>{t("resourceReserve")}<input type="number" min={0} max={90} value={reserve} onChange={e => setReserve(Math.min(90, Math.max(0, Math.trunc(Number(e.target.value)))))} /></label>
      </div>
      {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} /> : result?.additional == null ?
        <p className="muted" role="status">{t(reasons[result?.reason ?? ""] ?? "estimateMissing")}</p> :
        <div className="capacity-result" role="status">
          <div><strong>{result.additional.toLocaleString()}</strong> {t("additionalInstances")}</div>
          <small>{t("limitingResource")}: {t(result.bottleneck === "cpu" ? "hostCPU" : result.bottleneck === "memory" ? "availableMemory" : "cpuAndMemory")}</small>
          {result.budget && <small>{t(result.source === "declared" ? "declaredBudget" : "observedBudget")}: {formats.cores(result.budget.cpu_cores)} · {formats.bytes(result.budget.memory_bytes)}</small>}
        </div>}
    </>}
  </section>;
}

function HostSuggestions({ host }: { host: Host }) {
  const { t } = useLanguage();
  const data = host.latest?.data;
  const suggestions: Message[] = [];
  if (host.stale) suggestions.push("suggestHostStale");
  else if (data) {
    if ((data.cpu_usage_percent ?? -1) >= 85) suggestions.push("suggestHostCPU");
    if ((host.capacity?.memory_bytes ?? 0) > 0 && data.memory_available_bytes != null && data.memory_available_bytes / (host.capacity?.memory_bytes ?? 1) < .15) suggestions.push("suggestHostMemory");
    if (data.disk_available_bytes != null && data.disk_available_bytes < 5 * gib) suggestions.push("suggestHostDisk");
  }
  if (!suggestions.length) return null;
  return <aside className="section surface padded">
    <h2>{t("hostSuggestions")}</h2>
    <ul>{suggestions.map(key => <li key={key}>{t(key)}</li>)}</ul>
  </aside>;
}
