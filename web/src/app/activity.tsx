import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/HStack";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  alertsQuery,
  AttentionSummary,
  type Attention,
} from "../components/attention-summary";
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
  const status = strategyId ? embeddedStatus : (params.get("status") ?? "");
  const setStatus = (value: string) => {
    if (strategyId) {
      setEmbeddedStatus(value);
    } else {
      const next = new URLSearchParams(params);
      if (value) next.set("status", value);
      else next.delete("status");
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
        <Selector
          label={t("status")}
          isLabelHidden
          value={String(status)}
          onChange={(e) => setStatus(e)}
          options={[
            { value: String(""), label: String(t("all")) },
            ...[
              "confirmation_required",
              "pending",
              "executing",
              "unknown",
              "succeeded",
              "failed",
              "expired",
              "cancelled",
            ].map((s) => ({
              value: String(s),
              label: String(t(s as "pending")),
            })),
          ]}
        />
      </HStack>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <Section padding={0}>
          <List hasDividers>
            {query.data.map((cmd) => (
              <ListItem
                key={cmd.id}
                label={cmd.controlId}
                description={cmd.strategyId}
                onClick={() => setSelected(cmd.id)}
                endContent={
                  <HStack gap={3} vAlign="center" wrap="wrap">
                    <Badge tone={cmd.status === "unknown" ? "danger" : ""}>
                      {t(cmd.status as "pending")}
                    </Badge>
                    <Text type="supporting">{timestamp(cmd.updatedAt)}</Text>
                  </HStack>
                }
              />
            ))}
          </List>
          {!query.data.length && <EmptyState isCompact title={t("noEvents")} />}
        </Section>
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
      <VStack
        as="section"
        gap={4}
        className="section flex flex-col gap-4 min-w-0"
      >
        <HStack
          gap={3}
          wrap="wrap"
          vAlign="center"
          hAlign="between"
          className="section-heading"
        >
          <Heading level={2}>{t("alertHistory")}</Heading>
        </HStack>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorView error={query.error} />
        ) : (
          <Section padding={0}>
            <List hasDividers>
              {query.data.map((row) => (
                <ListItem
                  key={row.strategyId + row.id}
                  href={"/strategies/" + row.strategyId}
                  label={String(row.data.code)}
                  description={String(row.data.message)}
                  endContent={
                    <HStack gap={3} wrap="wrap" vAlign="center">
                      <Badge
                        tone={
                          ["error", "critical"].includes(
                            String(row.data.severity),
                          )
                            ? "danger"
                            : "warning"
                        }
                      >
                        {display.severity(String(row.data.severity ?? ""))}
                      </Badge>
                      <Text type="supporting">{timestamp(row.observedAt)}</Text>
                    </HStack>
                  }
                />
              ))}
            </List>
            {!query.data.length && (
              <EmptyState isCompact title={t("noEvents")} />
            )}
          </Section>
        )}
      </VStack>
    </Page>
  );
}
