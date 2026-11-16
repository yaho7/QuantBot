import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resource, activeStates, type Command, type Control } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { CommandDialog } from "../app/control";

export function CommandProgress({ desired }: { desired: NonNullable<Control["desired"]> }) {
  const { t } = useLanguage();
  const [details, setDetails] = useState(false);
  const query = useQuery({
    ...resource<Command>("/commands/" + desired.commandId),
    refetchInterval: query => activeStates.includes(query.state.data?.status ?? desired.status) ? 2000 : false,
  });
  const status = query.data?.status ?? desired.status;
  const steps = ["pending", "accepted", "executing", "succeeded"];
  const index = steps.indexOf(status);
  const exceptional = ["unknown", "failed", "rejected", "expired", "cancelled"].includes(status);
  return <section className="command-progress" aria-label={t("executionProgress")}>
    {!exceptional && status !== "confirmation_required" && <ol className="command-steps">
      {steps.map((step, i) => <li key={step} data-complete={i <= index} aria-current={step === status ? "step" : undefined}>
        {t(step === "pending" ? "awaitingClaim" : step === "accepted" ? "claimedCommand" : step === "executing" ? "executing" : "receiptSuccess")}
      </li>)}
    </ol>}
    <Text as="p" className={exceptional ? "warning" : "muted"} role="status">
      {status === "unknown" ? t("unknownGuidance") : status === "failed" ? t("failedGuidance") :
        status === "succeeded" ? t("receiptGuidance") : t(status as "pending")}
    </Text>
    {query.error && <Text type="supporting" className="warning">{t("progressUnavailable")}</Text>}
    {query.data?.receipt?.message && <Text as="p">{query.data.receipt.message}</Text>}
    <Button label={t("inspectCommand")} className="text-button" onClick={() => setDetails(true)}>{t("inspectCommand")}</Button>
    {details && <CommandDialog commandId={desired.commandId} close={() => setDetails(false)} />}
  </section>;
}
