import { label, t, type Message } from "../i18n";
import type { ReactNode } from "react";
import type { Account, Fill, Order, Position } from "./api";
import { Empty, Table, money, when } from "./ui";

const performanceNames: Record<string, Message> = {
  cumulative_return: "telemetryViews.cumulativeReturn", daily_return: "telemetryViews.dailyReturn", max_drawdown: "telemetryViews.maximumDrawdown",
  sharpe_ratio: "telemetryViews.sharpeRatio", sortino_ratio: "telemetryViews.sortinoRatio", win_rate: "telemetryViews.winRate",
  profit_loss_ratio: "telemetryViews.profitLossRatio", profit_factor: "telemetryViews.profitFactor",
};

export function Accounts({ rows }: { rows: Account[] }) {
  return <Table columns={[t("telemetryViews.account"), t("telemetryViews.currency"), t("telemetryViews.balance"), t("telemetryViews.availableCash"), t("telemetryViews.equity"), t("telemetryViews.buyingPower"), t("telemetryViews.realized"), t("telemetryViews.unrealized"), t("overview.dailyPL")]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.currency}`}><td>{row.account_id}</td><td>{row.currency}</td>
      {[row.balance, row.cash, row.equity, row.buying_power, row.realized_pnl, row.unrealized_pnl, row.daily_pnl]
        .map((value, i) => <td className="mono" key={i}>{money(value)}</td>)}</tr>)}
  </Table>;
}
export function Performance({ values }: { values?: Record<string, string | null> }) {
  const metrics = Object.entries(values ?? {}).filter((entry) => entry[1] != null);
  return metrics.length ? <div className="value-grid">{metrics.map(([name, value]) => <div key={name}><span>{label(performanceNames[name], name)}</span>
    <strong>{money(value, ["daily_return", "cumulative_return", "max_drawdown", "win_rate"].includes(name) ? "%" : undefined)}</strong></div>)}</div> : <Empty />;
}
export function Positions({ rows }: { rows: Position[] }) {
  return <Table columns={[t("telemetryViews.symbol"), t("telemetryViews.account"), t("telemetryViews.quantity"), t("telemetryViews.cost"), t("telemetryViews.marketPrice"), t("telemetryViews.unrealizedPL")]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.position_id}`}><td><strong>{row.symbol}</strong></td><td>{row.account_id}</td>
      <td className="mono">{money(row.quantity)}</td><td className="mono">{money(row.cost, row.currency)}</td>
      <td className="mono">{money(row.market_price, row.currency)}</td><td className="mono">{money(row.unrealized_pnl, row.currency)}</td></tr>)}
  </Table>;
}
export function Orders({ rows, action }: { rows: Order[]; action?: (row: Order) => ReactNode }) {
  return <Table columns={[t("telemetryViews.orderId"), t("telemetryViews.symbol"), t("marketChart.side"), t("telemetryViews.orderedFilled"), t("marketChart.price"), t("telemetryViews.fee"), t("onboarding.status"), ...(action ? [t("onboarding.actions")] : [])]} empty={!rows.length}>
    {rows.map((row, index) => <tr key={`${row.account_id}/${row.order_id}/${index}`}><td className="mono">{row.order_id}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? t("overview.buy") : t("overview.sell")}</td><td className="mono">{row.quantity} / {row.filled_quantity ?? "—"}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.fee_currency ?? row.currency)}</td><td>{row.status}</td>{action && <td>{action(row)}</td>}</tr>)}
  </Table>;
}
export function Fills({ rows }: { rows: Fill[] }) {
  return <Table columns={[t("telemetryViews.fillTime"), t("telemetryViews.symbol"), t("marketChart.side"), t("telemetryViews.quantity"), t("marketChart.price"), t("telemetryViews.fee")]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.fill_id}`}><td>{when(row.occurred_at)}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? t("overview.buy") : t("overview.sell")}</td><td className="mono">{row.quantity}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.fee_currency ?? row.currency)}</td></tr>)}
  </Table>;
}
