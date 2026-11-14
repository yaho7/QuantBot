import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { resource, type Command, type Datum } from "../shared/api";
import { Badge, ErrorView, Loading, timestamp } from "../shared/ui";
import { useLanguage } from "../shared/i18n";
import { Page } from "./App";
import { CommandDialog } from "./control";

export function ActivityPage({ strategyId }: { strategyId?: string }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState("");
  const query = useQuery(
    resource<Command[]>(
      "/commands?" +
        new URLSearchParams({ strategyId: strategyId ?? "", status }),
    ),
  );
  const body = (
    <>
      <div className="filter-bar">
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("all")}</option>
          {[
            "confirmation_required",
            "pending",
            "executing",
            "unknown",
            "succeeded",
            "failed",
            "expired",
            "cancelled",
          ].map((s) => (
            <option key={s} value={s}>
              {t(s as "pending")}
            </option>
          ))}
        </select>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="surface">
          {query.data.map((cmd) => (
            <button
              className="activity-line"
              key={cmd.id}
              onClick={() => setSelected(cmd.id)}
            >
              <span>
                {cmd.controlId}
                <small className="muted">{cmd.strategyId}</small>
              </span>
              <Badge tone={cmd.status === "unknown" ? "danger" : ""}>
                {t(cmd.status as "pending")}
              </Badge>
              <time>{timestamp(cmd.updatedAt)}</time>
            </button>
          ))}
          {!query.data.length && (
            <p className="empty-inline">{t("noEvents")}</p>
          )}
        </div>
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
  const query = useQuery(resource<Datum[]>("/alerts"));
  return (
    <Page title={t("alerts")}>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} />
      ) : (
        <div className="surface">
          {query.data.map((row) => (
            <Link
              className="activity-line"
              key={row.strategyId + row.id}
              to={"/strategies/" + row.strategyId}
            >
              <span>
                <strong>{String(row.data.code)}</strong>
                <small>{String(row.data.message)}</small>
              </span>
              <Badge
                tone={
                  row.data.severity === "error" ||
                  row.data.severity === "critical"
                    ? "danger"
                    : "warning"
                }
              >
                {String(row.data.severity)}
              </Badge>
              <time>{timestamp(row.observedAt)}</time>
            </Link>
          ))}
          {!query.data.length && (
            <p className="empty-inline">{t("noEvents")}</p>
          )}
        </div>
      )}
    </Page>
  );
}
