import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { resource, activeStates, type Command, type Control } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { CommandDialog } from "../app/control";
import "./workbench-ux.css";

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
    <p className={exceptional ? "warning" : "muted"} role="status">
      {status === "unknown" ? t("unknownGuidance") : status === "failed" ? t("failedGuidance") :
        status === "succeeded" ? t("receiptGuidance") : t(status as "pending")}
    </p>
    {query.error && <small className="warning">{t("progressUnavailable")}</small>}
    {query.data?.receipt?.message && <p>{query.data.receipt.message}</p>}
    <button className="text-button" onClick={() => setDetails(true)}>{t("inspectCommand")}</button>
    {details && <CommandDialog commandId={desired.commandId} close={() => setDetails(false)} />}
  </section>;
}
