import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Plus, Server } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, client, resource, type Strategy } from "../shared/api";
import { useLanguage, type Message } from "../shared/i18n";
import { Badge, ErrorView, Loading, Modal } from "../shared/ui";
import { Page } from "./App";
import {
  HostMetricsGrid, hostsQuery, ProcessMetricsGrid, ResourceChart, SampleStatus,
  useResourceFormat, type Host, type HostMetrics, type HostProcess, type Reading, type Resources,
} from "../components/host-performance";

type HostDetail = Host & { members: HostProcess[]; history: Reading<HostMetrics>[] };
type Binding = { id: string; bindingKey: string };

export function HostsPage() {
  const { t } = useLanguage();
  const query = useQuery(hostsQuery);
  const [adding, setAdding] = useState(false);
  const [binding, setBinding] = useState<Binding>();
  return <Page title={t("hosts")} actions={<button className="primary" onClick={() => setAdding(true)}><Plus size={16} />{t("addHost")}</button>}>
    {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} retry={() => void query.refetch()} /> :
      !query.data.length ? <div className="surface empty-state"><Server size={28} /><p>{t("noHosts")}</p></div> :
      <div className="hosts-grid">{query.data.map(host => <article key={host.id} className="surface padded performance-host">
        <header className="performance-process-heading">
          <Link className="performance-link" to={"/hosts/" + host.id}><h2>{host.name}</h2><ArrowUpRight size={15} /></Link>
          <Badge>{t(host.scope === "container" ? "hostContainer" : "hostMachine")}</Badge>
        </header>
        <HostMetricsGrid host={host} />
        <SampleStatus latest={host.latest} stale={host.stale} />
      </article>)}</div>}
    {adding && <CreateHost close={() => setAdding(false)} created={value => { setAdding(false); setBinding(value); }} />}
    {binding && <BindingDialog binding={binding} close={() => setBinding(undefined)} />}
  </Page>;
}

function CreateHost({ close, created }: { close: () => void; created: (value: Binding) => void }) {
  const { t } = useLanguage();
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const [strategyId, setStrategyId] = useState("");
  const [scope, setScope] = useState("machine");
  const mutation = useMutation({
    mutationFn: (body: object) => api<Binding>("/admin/hosts", "POST", body),
    onSuccess: value => { void client.invalidateQueries({ queryKey: hostsQuery.queryKey }); created(value); },
  });
  const selected = strategyId || strategies.data?.[0]?.id || "";
  return <Modal title={t("addHost")} open onOpenChange={value => { if (!value && !mutation.isPending) close(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      mutation.mutate({ name: data.get("name"), scope, reporterStrategyId: selected, reporterInstanceId: data.get("instance") });
    }}>
      <label>{t("hostName")}<input name="name" required maxLength={128} /></label>
      <label>{t("hostScope")}<select value={scope} onChange={e => setScope(e.target.value)}>
        <option value="machine">{t("hostMachine")}</option><option value="container">{t("hostContainer")}</option>
      </select></label>
      <label>{t("hostReporterStrategy")}<select value={selected} onChange={e => setStrategyId(e.target.value)} required>
        {strategies.data?.map(strategy => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
      </select></label>
      {strategies.error && <ErrorView error={strategies.error} />}
      <label>{t("hostReporterInstance")}<input name="instance" required maxLength={96} pattern="[A-Za-z0-9][A-Za-z0-9._:\\-]*" /></label>
      <p className="muted">{t("hostReporterHint")}</p>
      {mutation.error && <p className="error-text" role="alert">{mutation.error.message}</p>}
      <button className="primary" disabled={!selected || mutation.isPending}>{t("addHost")}</button>
    </form>
  </Modal>;
}

function BindingDialog({ binding, close }: { binding: Binding; close: () => void }) {
  const { t } = useLanguage();
  return <Modal title={t("hostBinding")} open onOpenChange={value => { if (!value) close(); }}>
    <p>{t("hostBindingHint")}</p>
    <label>host_id<input readOnly value={binding.id} onFocus={e => e.target.select()} /></label>
    <label>{t("hostBindingKey")}<input readOnly value={binding.bindingKey} onFocus={e => e.target.select()} /></label>
  </Modal>;
}

const hostCPU = (m: HostMetrics) => m.cpu_usage_percent;
const hostMemory = (m: HostMetrics) => m.memory_available_bytes == null ? undefined : m.memory_available_bytes / 1024 ** 3;
const gib = 1024 ** 3;

export function HostDetailPage() {
  const { id = "" } = useParams();
  const { t } = useLanguage();
  const query = useQuery({ ...resource<HostDetail>("/hosts/" + id), refetchInterval: 15_000 });
  const [binding, setBinding] = useState<Binding>();
  const rotate = useMutation({
    mutationFn: () => api<Binding>("/admin/hosts/" + id + "/key", "PUT"),
    onSuccess: setBinding,
  });
  return <Page title={query.data?.name ?? t("hosts")} actions={
    <Link className="button" to="/hosts"><ArrowLeft size={16} />{t("hosts")}</Link>
  }>
    {query.isPending ? <Loading /> : query.error ? <ErrorView error={query.error} retry={() => void query.refetch()} /> :
      <>
        <section className="surface padded performance-host">
          <header className="performance-process-heading">
            <Badge>{t(query.data.scope === "container" ? "hostContainer" : "hostMachine")}</Badge>
            <SampleStatus latest={query.data.latest} stale={query.data.stale} />
          </header>
          <HostMetricsGrid host={query.data} />
        </section>
        <CapacityPlanner key={id} host={query.data} />
        <section className="section">
          <div className="section-heading"><h2>{t("hostTrends")}</h2></div>
          <div className="performance-trends">
            <ResourceChart readings={query.data.history} select={hostCPU} label={t("hostCPU") + " · %"} />
            <ResourceChart readings={query.data.history} select={hostMemory} label={t("availableMemory") + " · GiB"} />
          </div>
        </section>
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
        <section className="section surface padded host-binding-panel">
          <h2>{t("hostBinding")}</h2>
          <dl className="compact-dl"><dt>host_id</dt><dd>{query.data.id}</dd>
            <dt>{t("hostReporterInstance")}</dt><dd>{query.data.reporterInstanceId}</dd></dl>
          <button disabled={rotate.isPending} onClick={() => { if (window.confirm(t("rotateHostKeyHint"))) rotate.mutate(); }}>{t("rotateHostKey")}</button>
          {rotate.error && <p className="error-text" role="alert">{rotate.error.message}</p>}
        </section>
      </>}
    {binding && <BindingDialog binding={binding} close={() => setBinding(undefined)} />}
  </Page>;
}

type Estimate = { additional: number | null; reason?: string; bottleneck?: string; budget?: Resources; source?: string; sampleMinutes?: number };
const reasons: Record<string, Message> = {
  host_stale: "estimateHostStale", host_metrics_missing: "estimateMissing",
  swap_pressure: "estimateSwap", process_stale: "estimateProcessStale", insufficient_history: "estimateHistory",
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
    <h2>{t("capacityPlanner")}</h2>
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
    if (host.capacity.memory_bytes > 0 && data.memory_available_bytes != null && data.memory_available_bytes / host.capacity.memory_bytes < .15) suggestions.push("suggestHostMemory");
    if (data.disk_available_bytes != null && data.disk_available_bytes < 5 * gib) suggestions.push("suggestHostDisk");
  }
  if (!suggestions.length) return null;
  return <aside className="section surface padded">
    <h2>{t("hostSuggestions")}</h2>
    <ul>{suggestions.map(key => <li key={key}>{t(key)}</li>)}</ul>
  </aside>;
}
