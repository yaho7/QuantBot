import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
} from "@astryxdesign/core/Table";
import { useRef } from "react";
import { Link } from "../shared/page-links";
import type { Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, decimalText } from "../shared/ui";
import { useTelemetryValues } from "../app/strategy";
import { ScrollHints } from "./scroll-hints";

export function StrategyTable({ strategies }: { strategies: Strategy[] }) {
  const { t } = useLanguage();
  const target = useRef<HTMLElement>(null);
  return (
    <VStack gap={3} className="strategy-table-container relative">
      <VStack
        gap={3}
        className="table-scroll overflow-auto min-w-0 max-w-full"
        ref={target}
        tabIndex={0}
        role="region"
        aria-label={t("strategies")}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "name",
                "status",
                "group",
                "equity",
                "dailyPnl",
                "lastSeen",
                "controls",
              ].map((label) => (
                <TableHeaderCell key={label}>
                  {t(label as "name")}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {strategies.map((strategy) => (
              <StrategyRow key={strategy.id} strategy={strategy} />
            ))}
          </TableBody>
        </Table>
        {!strategies.length && (
          <Text as="p" className="empty-inline text-secondary text-center p-6">
            {t("empty")}
          </Text>
        )}
      </VStack>
      <ScrollHints target={target} />
    </VStack>
  );
}
function StrategyRow({ strategy }: { strategy: Strategy }) {
  const { t } = useLanguage();
  const { records, equity, performance, query } = useTelemetryValues(
    strategy.id,
  );
  const error = records.some(
    (record) => record.kind === "status" && record.data.state === "error",
  );
  return (
    <TableRow>
      <TableHeaderCell>
        <Link to={"/strategies/" + strategy.id}>{strategy.name}</Link>
      </TableHeaderCell>
      <TableCell>
        <Badge tone={error ? "danger" : strategy.online ? "success" : ""}>
          {t(error ? "abnormal" : strategy.online ? "online" : "offline")}
        </Badge>
      </TableCell>
      <TableCell>{strategy.group || "—"}</TableCell>
      <TableCell>
        {query.error ? t("unavailable") : decimalText(equity?.data.value)}{" "}
        <Text type="supporting">{String(equity?.data.currency ?? "")}</Text>
      </TableCell>
      <TableCell>
        {query.error
          ? t("unavailable")
          : decimalText(performance?.data.dailyPnl)}{" "}
        <Text type="supporting">
          {String(performance?.data.currency ?? "")}
        </Text>
      </TableCell>
      <TableCell>
        {strategy.lastSeen
          ? new Date(strategy.lastSeen * 1000).toLocaleTimeString()
          : t("notConnected")}
      </TableCell>
      <TableCell>
        <Link to={"/strategies/" + strategy.id + "#strategy-controls"}>
          {t("controls")}
        </Link>
      </TableCell>
    </TableRow>
  );
}
