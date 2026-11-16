import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/VStack";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/HStack";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { alertsQuery, AttentionSummary, type Attention } from "../components/attention-summary";
import { resource, type Command } from "../shared/api";
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";
import { useLanguage } from "../shared/i18n";
import { useDisplay } from "../shared/display";
import { Page } from "./App";
import { CommandDialog } from "./control";

export function ActivityPage({ strategyId }: { strategyId?: string }) {
  const { t } = useLanguage();
  const [embeddedStatus, setEmbeddedStatus] = useState("");
  const [params, setParams] = useSearchParams();
  const status = strategyId ? embeddedStatus : params.get("status") ?? "";
  const setStatus = (value: string) => {
    if (strategyId) {
      setEmbeddedStatus(value);
    } else {
      const next = new URLSearchParams(params);
      if (value) next.set("status", value); else next.delete("status");
      setParams(next, { replace: true, preventScrollReset: true });
    }
  };
  const [selected, setSelected] = useState("");
  const query = useQuery(
    resource<Command[]>(
      "/commands?" +
        new URLSearchParams({ strategyId: strategyId ?? "", status }),
    ),
  );
  const body = (
    <>
      <HStack gap={3} wrap="wrap" vAlign="center" className="filter-bar">
        <Selector label={t("status")} isLabelHidden value={String(status)} onChange={(e) => setStatus(e)} options={[{ value: String(""), label: String(t("all")) },...[
            "confirmation_required",
            "pending",
            "executing",
            "unknown",
            "succeeded",
            "failed",
            "expired",
            "cancelled",
          ].map((s) => (
            { value: String(s), label: String(t(s as "pending")) }
          ))]}  />
      </HStack>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <VStack gap={3} className="surface">
          {query.data.map((cmd) => (
            <Button label={cmd.controlId + " · " + t(cmd.status as "pending")}
              className="activity-line"
              key={cmd.id}
              onClick={() => setSelected(cmd.id)}
            >
              <Text>
                {cmd.controlId}
                <Text type="supporting" className="muted">{cmd.strategyId}</Text>
              </Text>
              <Badge tone={cmd.status === "unknown" ? "danger" : ""}>
                {t(cmd.status as "pending")}
              </Badge>
              <time>{timestamp(cmd.updatedAt)}</time>
            </Button>
          ))}
          {!query.data.length && (
            <Text as="p" className="empty-inline">{t("noEvents")}</Text>
          )}
        </VStack>
      )}
      {selected && (
        <CommandDialog commandId={selected} close={() => setSelected("")} />
      )}
    </>
  );
  return strategyId ? body : <Page title={t("activity")}>{body}</Page>;
}
export function AlertsPage() {
  const { t } = useLanguage();
  const display = useDisplay();
  const query = useQuery(alertsQuery);
  const attention = useOutletContext<Attention>();
  return (
    <Page title={t("alerts")}>
      <AttentionSummary attention={attention} />
      <section className="section">
        <HStack gap={3} wrap="wrap" vAlign="center" hAlign="between" className="section-heading"><Heading level={2}>{t("alertHistory")}</Heading></HStack>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorView error={query.error} />
        ) : (
          <VStack gap={3} className="surface">
            {query.data.map((row) => (
              <Link
                className="activity-line"
                key={row.strategyId + row.id}
                to={"/strategies/" + row.strategyId}
              >
                <Text>
                  <strong>{String(row.data.code)}</strong>
                  <Text type="supporting">{String(row.data.message)}</Text>
                </Text>
                <Badge
                  tone={
                    row.data.severity === "error" ||
                    row.data.severity === "critical"
                      ? "danger"
                      : "warning"
                  }
                >
                  {display.severity(String(row.data.severity ?? ""))}
                </Badge>
                <time>{timestamp(row.observedAt)}</time>
              </Link>
            ))}
            {!query.data.length && (
              <Text as="p" className="empty-inline">{t("noEvents")}</Text>
            )}
          </VStack>
        )}
      </section>
    </Page>
  );
}
