import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  resource,
  type Command,
  type Datum,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge } from "../shared/ui";

export const alertsQuery = resource<Datum[]>("/alerts");
const recentWindow = 15 * 60_000;

export function useAttention() {
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const alerts = useQuery(alertsQuery);
  const waiting = useQuery(
    resource<Command[]>("/commands?status=confirmation_required"),
  );
  const unknown = useQuery(resource<Command[]>("/commands?status=unknown"));
  const rows = strategies.data ?? [];
  const online = rows.filter((strategy) => strategy.online);
  const telemetry = useQueries({
    queries: online.map((strategy) =>
      resource<Datum[]>("/strategies/" + strategy.id + "/telemetry"),
    ),
  });
  const abnormal = new Set(
    online
      .filter((_, index) =>
        telemetry[index]?.data?.some(
          (record) => record.kind === "status" && record.data.state === "error",
        ),
      )
      .map((strategy) => strategy.id),
  );
  const issues = rows.filter(
    (strategy) => !strategy.online || abnormal.has(strategy.id),
  );
  const [now, setNow] = useState(Date.now);
  // The alert log is historical. Decay the marker when recent warnings age out.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const latest = Math.max(now, alerts.dataUpdatedAt);
  const recent = (alerts.data ?? []).filter(
    (record) =>
      record.observedAt > latest - recentWindow &&
      ["warning", "error", "critical"].includes(String(record.data.severity)),
  );
  const waitingCount = waiting.data?.length ?? 0;
  const unknownCount = unknown.data?.length ?? 0;
  return {
    issues,
    waitingCount,
    unknownCount,
    recentCount: recent.length,
    count: issues.length + waitingCount + unknownCount + recent.length,
  };
}
export type Attention = ReturnType<typeof useAttention>;

export function AttentionSummary({ attention }: { attention: Attention }) {
  const { t } = useLanguage();
  const { issues, waitingCount, unknownCount } = attention;
  if (!issues.length && !waitingCount && !unknownCount) return null;
  return (
    <VStack
      as="section"
      gap={3}
      className="attention-section"
      aria-label={t("needsAttention")}
    >
      <Heading level={2}>{t("needsAttention")}</Heading>
      <List hasDividers edge="flush">
        {unknownCount > 0 && (
          <ListItem
            href="/activity?status=unknown"
            label={t("unknown")}
            endContent={<Badge tone="danger">{unknownCount}</Badge>}
          />
        )}
        {waitingCount > 0 && (
          <ListItem
            href="/activity?status=confirmation_required"
            label={t("confirmation")}
            endContent={<Badge tone="warning">{waitingCount}</Badge>}
          />
        )}
        {issues.map((strategy) => (
          <ListItem
            key={strategy.id}
            href={"/strategies/" + strategy.id}
            label={strategy.name}
            endContent={
              <Badge tone={strategy.online ? "danger" : "warning"}>
                {t(strategy.online ? "abnormal" : "offline")}
              </Badge>
            }
          />
        ))}
      </List>
    </VStack>
  );
}
