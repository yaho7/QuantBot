import type { ReactNode } from "react";
import type { Account, Fill, Order, Position } from "./api";
import { Empty, Table, money, when } from "./ui";

const performanceNames: Record<string, string> = {
  cumulative_return: "累计收益率", daily_return: "当日收益率", max_drawdown: "最大回撤",
  sharpe_ratio: "Sharpe Ratio", sortino_ratio: "Sortino Ratio", win_rate: "胜率",
  profit_loss_ratio: "盈亏比", profit_factor: "Profit Factor",
};

export function Accounts({ rows }: { rows: Account[] }) {
  return <Table columns={["账户", "币种", "余额", "可用现金", "净值", "购买力", "已实现", "未实现", "当日盈亏"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.currency}`}><td>{row.account_id}</td><td>{row.currency}</td>
      {[row.balance, row.cash, row.equity, row.buying_power, row.realized_pnl, row.unrealized_pnl, row.daily_pnl]
        .map((value, i) => <td className="mono" key={i}>{money(value)}</td>)}</tr>)}
  </Table>;
}
export function Performance({ values }: { values?: Record<string, string | null> }) {
  const metrics = Object.entries(values ?? {}).filter((entry) => entry[1] != null);
  return metrics.length ? <div className="value-grid">{metrics.map(([name, value]) => <div key={name}><span>{performanceNames[name] ?? name}</span>
    <strong>{money(value, ["daily_return", "cumulative_return", "max_drawdown", "win_rate"].includes(name) ? "%" : undefined)}</strong></div>)}</div> : <Empty />;
}
export function Positions({ rows }: { rows: Position[] }) {
  return <Table columns={["标的", "账户", "数量", "成本", "市价", "未实现盈亏"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.position_id}`}><td><strong>{row.symbol}</strong></td><td>{row.account_id}</td>
      <td className="mono">{money(row.quantity)}</td><td className="mono">{money(row.cost, row.currency)}</td>
      <td className="mono">{money(row.market_price, row.currency)}</td><td className="mono">{money(row.unrealized_pnl, row.currency)}</td></tr>)}
  </Table>;
}
export function Orders({ rows, action }: { rows: Order[]; action?: (row: Order) => ReactNode }) {
  return <Table columns={["订单 ID", "标的", "方向", "委托 / 已成交", "价格", "手续费", "状态", ...(action ? ["操作"] : [])]} empty={!rows.length}>
    {rows.map((row, index) => <tr key={`${row.account_id}/${row.order_id}/${index}`}><td className="mono">{row.order_id}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? "买入" : "卖出"}</td><td className="mono">{row.quantity} / {row.filled_quantity ?? "—"}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.fee_currency ?? row.currency)}</td><td>{row.status}</td>{action && <td>{action(row)}</td>}</tr>)}
  </Table>;
}
export function Fills({ rows }: { rows: Fill[] }) {
  return <Table columns={["成交时间", "标的", "方向", "数量", "价格", "手续费"]} empty={!rows.length}>
    {rows.map((row) => <tr key={`${row.account_id}/${row.fill_id}`}><td>{when(row.occurred_at)}</td><td>{row.symbol}</td>
      <td>{row.side === "buy" ? "买入" : "卖出"}</td><td className="mono">{row.quantity}</td>
      <td className="mono">{money(row.price, row.currency)}</td><td className="mono">{money(row.fee, row.fee_currency ?? row.currency)}</td></tr>)}
  </Table>;
}
