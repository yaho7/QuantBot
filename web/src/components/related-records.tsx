import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resource, type CapabilityRecord } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { useDisplay } from "../shared/display";
import { ErrorView, Loading, Modal, timestamp } from "../shared/ui";

export function RelatedRecords({
  strategyId,
  associations,
}: {
  strategyId: string;
  associations?: Record<string, string>;
}) {
  const display = useDisplay();
  const [selected, setSelected] = useState<[string, string]>();
  return (
    <>
      {Object.entries(associations ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([field, value]) => (
          <Button
            label={display.field(field) + " " + value}
            type="button"
            className="text-button"
            key={field}
            onClick={() => setSelected([field, value])}
          >
            {display.field(field)} {value}
          </Button>
        ))}
      {selected && (
        <RelatedDialog
          strategyId={strategyId}
          selected={selected}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}

function RelatedDialog({
  strategyId,
  selected,
  close,
}: {
  strategyId: string;
  selected: [string, string];
  close: () => void;
}) {
  const { t } = useLanguage();
  const display = useDisplay();
  const [field, value] = selected;
  const query = useQuery(
    resource<
      (Omit<CapabilityRecord, "capabilityId" | "revision"> & {
        kind?: string;
        capabilityId?: string;
        revision?: number;
      })[]
    >(
      "/strategies/" +
        strategyId +
        "/related?" +
        new URLSearchParams({ field, value }),
    ),
  );
  return (
    <Modal
      title={t("relatedRecords")}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Text as="p">
        <code>
          <Text type="code">
            {display.field(field)} {value}
          </Text>
        </code>
      </Text>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <VStack
          gap={3}
          className="surface bg-surface border border-border rounded-lg"
        >
          {query.data.map((row) => (
            <HStack
              gap={3}
              wrap="wrap"
              vAlign="center"
              className="event-line"
              key={[row.capabilityId ?? row.kind, row.id, row.revision].join(
                ":",
              )}
            >
              <time>
                <Text type="supporting">{timestamp(row.observedAt)}</Text>
              </time>
              <Text>
                <Text weight="semibold">
                  {row.capabilityId ?? display.kind(row.kind ?? "")}
                </Text>{" "}
                · {display.value(row.value)}
              </Text>
            </HStack>
          ))}
          {!query.data.length && (
            <Text
              as="p"
              className="empty-inline text-secondary text-center p-6"
            >
              {t("missing")}
            </Text>
          )}
        </VStack>
      )}
    </Modal>
  );
}
