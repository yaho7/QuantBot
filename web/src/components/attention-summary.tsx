import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { resource, type Command, type Datum, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import "./workbench-ux.css";

export function AttentionSummary({ strategies }: { strategies: Strategy[] }) {
  const { t } = useLanguage();
  const commands = useQuery(resource<Command[]>("/commands"));
  const telemetry = useQueries({ queries: strategies.map(s => resource<Datum[]>("/strategies/" + s.id + "/telemetry")) });
  const issues = strategies.flatMap((strategy, index) => {
    if (!strategy.online) return [{ id: strategy.id, label: strategy.name + " · " + t("offline"), to: "/strategies/" + strategy.id }];
    const abnormal = telemetry[index]?.data?.some(r => r.kind === "status" && r.data.state === "error");
    return abnormal ? [{ id: strategy.id, label: strategy.name + " · " + t("abnormal"), to: "/strategies/" + strategy.id }] : [];
  });
  const waiting = (commands.data ?? []).filter(c => c.status === "confirmation_required");
  const unknown = (commands.data ?? []).filter(c => c.status === "unknown");
  if (!issues.length && !waiting.length && !unknown.length) return null;
  return <aside className="attention-summary" aria-label={t("needsAttention")}>
    <strong><AlertTriangle size={16} />{t("needsAttention")}</strong>
    <div className="attention-items">
      {unknown.length > 0 && <Link to="/activity">{t("unknown")} · {unknown.length}</Link>}
      {waiting.length > 0 && <Link to="/activity">{t("confirmation")} · {waiting.length}</Link>}
      {issues.slice(0, 4).map(issue => <Link key={issue.id} to={issue.to}>{issue.label}</Link>)}
      {issues.length > 4 && <Link to="/strategies">+{issues.length - 4} {t("strategies")}</Link>}
    </div>
  </aside>;
}
