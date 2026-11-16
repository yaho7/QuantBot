import { useRef } from "react";
import { Link } from "../shared/page-links";
import type { Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, decimalText } from "../shared/ui";
import { useTelemetryValues } from "../app/strategy";
import { ScrollHints } from "./scroll-hints";

export function StrategyTable({ strategies }: { strategies: Strategy[] }) {
  const { t } = useLanguage();
  const target = useRef<HTMLDivElement>(null);
  return <div className="strategy-table-container">
    <div className="table-scroll" ref={target} tabIndex={0} role="region" aria-label={t("strategies")}>
      <table>
        <thead><tr>{["name", "status", "group", "equity", "dailyPnl", "lastSeen", "controls"].map(label =>
          <th key={label} scope="col">{t(label as "name")}</th>)}</tr></thead>
        <tbody>{strategies.map(strategy => <StrategyRow key={strategy.id} strategy={strategy} />)}</tbody>
      </table>
      {!strategies.length && <p className="empty-inline">{t("empty")}</p>}
    </div>
    <ScrollHints target={target} />
  </div>;
}
function StrategyRow({ strategy }: { strategy: Strategy }) {
  const { t } = useLanguage();
  const { records, equity, performance, query } = useTelemetryValues(strategy.id);
  const error = records.some(record => record.kind === "status" && record.data.state === "error");
  return <tr>
    <th scope="row"><Link to={"/strategies/" + strategy.id}>{strategy.name}</Link></th>
    <td><Badge tone={error ? "danger" : strategy.online ? "success" : ""}>{t(error ? "abnormal" : strategy.online ? "online" : "offline")}</Badge></td>
    <td>{strategy.group || "—"}</td>
    <td>{query.error ? t("unavailable") : decimalText(equity?.data.value)} <small>{String(equity?.data.currency ?? "")}</small></td>
    <td>{query.error ? t("unavailable") : decimalText(performance?.data.dailyPnl)} <small>{String(performance?.data.currency ?? "")}</small></td>
    <td>{strategy.lastSeen ? new Date(strategy.lastSeen * 1000).toLocaleTimeString() : t("notConnected")}</td>
    <td><Link to={"/strategies/" + strategy.id + "#strategy-controls"}>{t("controls")}</Link></td>
  </tr>;
}
