import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { RiArrowRightUpLine as ArrowUpRight } from "@remixicon/react";
import { Badge as ShadcnBadge } from "@/components/ui/badge";
import { resource, type Command, type Datum, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge } from "../shared/ui";
import "./attention.css";

export const alertsQuery = resource<Datum[]>("/alerts");
const recentWindow = 15 * 60_000;

export function useRecentAlertCount(enabled: boolean) {
  const alerts = useQuery({ ...alertsQuery, enabled });
  const [now, setNow] = useState(Date.now);
  // The alert log is historical. Decay the marker when recent warnings age out.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const latest = Math.max(now, alerts.dataUpdatedAt);
  return alerts.data?.filter(record => record.observedAt > latest - recentWindow &&
    ["warning", "error", "critical"].includes(String(record.data.severity))).length;
}

export function RecentAlertBadge({ count, descriptionId }: { count: number; descriptionId: string }) {
  const { t } = useLanguage();
  if (!count) return null;
  return <>
    <ShadcnBadge className="admin-alert-badge" aria-hidden="true">{count > 99 ? "99+" : count}</ShadcnBadge>
    <span id={descriptionId} hidden>{t("recentWarnings")}: {count}</span>
  </>;
}

export function useAttention() {
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const waiting = useQuery(resource<Command[]>("/commands?status=confirmation_required"));
  const unknown = useQuery(resource<Command[]>("/commands?status=unknown"));
  const rows = strategies.data ?? [];
  const online = rows.filter(strategy => strategy.online);
  const telemetry = useQueries({
    queries: online.map(strategy => resource<Datum[]>("/strategies/" + strategy.id + "/telemetry")),
  });
  const abnormal = new Set(online.filter((_, index) =>
    telemetry[index]?.data?.some(record => record.kind === "status" && record.data.state === "error")
  ).map(strategy => strategy.id));
  const issues = rows.filter(strategy => !strategy.online || abnormal.has(strategy.id));
  return { issues, waitingCount: waiting.data?.length, unknownCount: unknown.data?.length };
}
export type Attention = ReturnType<typeof useAttention>;

export function AttentionSummary({ attention }: { attention: Attention }) {
  const { t } = useLanguage();
  const { issues, waitingCount, unknownCount } = attention;
  if (!issues.length && !waitingCount && !unknownCount) return null;
  return <section className="section attention-section" aria-label={t("needsAttention")}>
    <div className="section-heading"><h2>{t("needsAttention")}</h2></div>
    <ul className="surface attention-list">
      {!!unknownCount && <li><Link className="attention-row" to="/admin/activity?status=unknown">
        <strong>{t("unknown")}</strong><Badge tone="danger">{unknownCount}</Badge><ArrowUpRight size={16} />
      </Link></li>}
      {!!waitingCount && <li><Link className="attention-row" to="/admin/activity?status=confirmation_required">
        <strong>{t("confirmation")}</strong><Badge tone="warning">{waitingCount}</Badge><ArrowUpRight size={16} />
      </Link></li>}
      {issues.map(strategy => <li key={strategy.id}><Link className="attention-row" to={"/strategies/" + strategy.id}>
        <strong>{strategy.name}</strong><Badge tone={strategy.online ? "danger" : "warning"}>{t(strategy.online ? "abnormal" : "offline")}</Badge>
        <ArrowUpRight size={16} />
      </Link></li>)}
    </ul>
  </section>;
}
