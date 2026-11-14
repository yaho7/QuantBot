import type { Definition } from "./api";
import { useLanguage } from "./i18n";

type Labels = Record<string, readonly [string, string]>;

const kinds: Labels = {
  status: ["运行状态", "Status"], connection: ["连接", "Connection"],
  portfolio: ["账户组合", "Portfolio"], equity: ["权益", "Equity"],
  position: ["持仓", "Positions"], order: ["订单", "Orders"],
  fill: ["成交", "Fills"], performance: ["绩效", "Performance"],
  metric: ["指标", "Metrics"], ohlcv: ["K 线", "Candles"],
  signal: ["信号", "Signals"], risk: ["风控", "Risk"],
  alert: ["告警", "Alerts"], log: ["日志", "Logs"], command: ["指令", "Commands"],
};
const fields: Labels = {
  accountId: ["账户", "Account"], account_id: ["账户", "Account"],
  positionId: ["持仓编号", "Position ID"], orderId: ["订单编号", "Order ID"],
  order_id: ["订单编号", "Order ID"], fillId: ["成交编号", "Fill ID"],
  signal_id: ["信号编号", "Signal ID"], decision_id: ["决策编号", "Decision ID"],
  command_id: ["指令编号", "Command ID"], correlation_id: ["关联编号", "Correlation ID"],
  symbol: ["标的", "Symbol"], side: ["方向", "Side"], direction: ["方向", "Direction"],
  currency: ["币种", "Currency"], quantity: ["数量", "Quantity"],
  filledQuantity: ["已成交数量", "Filled quantity"], entryPrice: ["开仓价", "Entry price"],
  markPrice: ["标记价", "Mark price"], price: ["价格", "Price"],
  cash: ["现金", "Cash"], margin: ["保证金", "Margin"], available: ["可用", "Available"],
  dailyPnl: ["当日盈亏", "Daily P&L"], totalPnl: ["累计盈亏", "Total P&L"],
  realizedPnl: ["已实现盈亏", "Realized P&L"], unrealizedPnl: ["浮动盈亏", "Unrealized P&L"],
  equity: ["权益", "Equity"], drawdown: ["回撤", "Drawdown"], value: ["数值", "Value"],
  fee: ["费用", "Fee"], state: ["运行状态", "State"], status: ["状态", "Status"],
  severity: ["级别", "Severity"], source: ["来源", "Source"],
  message: ["说明", "Message"], code: ["代码", "Code"],
  open: ["开盘", "Open"], high: ["最高", "High"], low: ["最低", "Low"],
  close: ["收盘", "Close"], volume: ["成交量", "Volume"],
  "Observed at": ["观测时间", "Observed at"],
  "Related IDs": ["关联编号", "Related IDs"],
  "Resource ID": ["资源编号", "Resource ID"],
};
const severity: Labels = {
  debug: ["调试", "Debug"], info: ["信息", "Info"], warning: ["警告", "Warning"],
  error: ["错误", "Error"], critical: ["严重", "Critical"],
};
const risk: Labels = {
  low: ["低风险", "Low risk"], medium: ["中风险", "Medium risk"],
  high: ["高风险", "High risk"], critical: ["极高风险", "Critical risk"],
};
const side: Labels = {
  buy: ["买入", "Buy"], sell: ["卖出", "Sell"], long: ["多头", "Long"],
  short: ["空头", "Short"], flat: ["空仓", "Flat"], hold: ["持有", "Hold"],
};
const orderStatus: Labels = {
  new: ["新建", "New"], open: ["挂单中", "Open"], partially_filled: ["部分成交", "Partially filled"],
  filled: ["已成交", "Filled"], cancelled: ["已取消", "Cancelled"],
  rejected: ["已拒绝", "Rejected"], expired: ["已过期", "Expired"],
};
const runState: Labels = {
  starting: ["启动中", "Starting"], running: ["运行中", "Running"],
  paused: ["已暂停", "Paused"], stopped: ["已停止", "Stopped"], error: ["异常", "Error"],
};
const delivery: Labels = {
  queued: ["待发送", "Queued"], sending: ["发送中", "Sending"], sent: ["已发送", "Sent"],
  failed: ["发送失败", "Failed"], cancelled: ["已取消", "Cancelled"],
};
const scope: Labels = {
  heartbeat: ["心跳", "Heartbeat"], report: ["数据上报", "Reporting"],
  control: ["能力与状态", "Capabilities and state"], command: ["领取与回执", "Command execution"],
};
const reasons: Labels = {
  "confirmation required by policy": ["按策略要求确认", "Confirmation required by policy"],
  "authorized and queued": ["已授权并进入队列", "Authorized and queued"],
  "operator cancelled": ["操作人取消", "Operator cancelled"],
  "claim response requires reconciliation": ["领取结果需要核对", "Claim response requires reconciliation"],
  "executor accepted": ["执行器已领取", "Executor accepted"],
  "one-time execution permit issued": ["已发放一次性执行许可", "One-time execution permit issued"],
  "execution deadline elapsed before receipt": ["执行截止前未收到回执", "Execution deadline elapsed before receipt"],
  "execution receipt recorded": ["已保存执行回执", "Execution receipt recorded"],
  "restored from backup": ["从备份恢复", "Restored from backup"],
};

export function useDisplay() {
  const { t, lang } = useLanguage();
  const locale = lang === "zh" ? "zh-CN" : "en";
  const label = (dictionary: Labels, value: string) =>
    Object.hasOwn(dictionary, value) ? (dictionary[value]?.[lang === "zh" ? 0 : 1] ?? value) : value;
  function value(input: unknown, definition?: Definition): string {
    if (input == null) return "—";
    if (typeof input === "boolean") {
      return definition?.kind === "toggle"
        ? t(input ? "controlOn" : "controlOff")
        : t(input ? "yes" : "no");
    }
    if (typeof input === "string") {
      return definition?.options?.find((option) => option.value === input)?.label ?? input;
    }
    if (Array.isArray(input)) return input.map((item) => value(item, definition)).join(" · ") || "—";
    if (typeof input === "object") return JSON.stringify(input);
    return String(input);
  }
  function tableValue(key: string, input: unknown) {
    if (typeof input === "string") {
      if (key === "side" || key === "direction") return label(side, input);
      if (key === "status") return label(orderStatus, input);
      if (key === "state") return label(runState, input);
      if (key === "severity") return label(severity, input);
    }
    return value(input);
  }
  function series(kind: string, raw: string) {
    try {
      const parts: unknown = JSON.parse(raw);
      if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === "string")) {
        if (kind === "ohlcv" && /^\d+$/.test(parts[1])) {
          return [parts[0], unit(Number(parts[1]), "second")].filter(Boolean).join(" · ");
        }
        return parts.filter(Boolean).join(" · ");
      }
    } catch {
      // A single, Agent-supplied label is already displayable.
    }
    return raw;
  }
  function unit(input: number, unit: "minute" | "hour" | "day" | "second") {
    return new Intl.NumberFormat(locale, { style: "unit", unit }).format(input);
  }
  return {
    value, tableValue, series, unit,
    kind: (input: string) => label(kinds, input),
    field: (input: string) => label(fields, input),
    severity: (input: string) => label(severity, input),
    risk: (input: string) => label(risk, input),
    reason: (input: string) => label(reasons, input),
    delivery: (input: string) => label(delivery, input),
    scope: (input: string) => label(scope, input),
  };
}
