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
          <button
            type="button"
            className="text-button"
            key={field}
            onClick={() => setSelected([field, value])}
          >
            {display.field(field)} {value}
          </button>
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
      <p>
        <code>
          {display.field(field)} {value}
        </code>
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="surface">
          {query.data.map((row) => (
            <div
              className="event-line"
              key={[row.capabilityId ?? row.kind, row.id, row.revision].join(
                ":",
              )}
            >
              <time>{timestamp(row.observedAt)}</time>
              <span>
                <strong>{row.capabilityId ?? display.kind(row.kind ?? "")}</strong> ·{" "}
                {display.value(row.value)}
              </span>
            </div>
          ))}
          {!query.data.length && <p className="empty-inline">{t("missing")}</p>}
        </div>
      )}
    </Modal>
  );
}
