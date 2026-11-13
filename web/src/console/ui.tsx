import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowUpRight, Check, Copy, Inbox, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CommandState, type Mode, type Parameter, type Scalar, type Status } from "./api";

export const statusText: Record<Status, string> = { online: "在线", offline: "离线", abnormal: "异常" };
export const modeText: Record<Mode, string> = { live: "实盘", paper: "模拟盘", backtest: "回测" };
export const stateText: Record<CommandState, string> = {
  confirmation_required: "等待确认", pending: "等待策略", accepted: "已投递",
  executing: "执行中", succeeded: "策略确认成功", failed: "执行失败", unknown: "结果未知",
  expired: "已过期", superseded: "已被替代", cancelled: "已取消",
};
export const severityText = { debug: "调试", info: "信息", warning: "警告", error: "错误", critical: "严重" };
export const categoryText: Record<string, string> = {
  online: "上线", offline: "离线", risk: "风控", alert: "告警", warning: "警告", error: "错误",
  trade: "成交", open: "开仓", close: "平仓", custom: "自定义", log: "日志",
  authorization: "授权", command: "指令",
};

export function useData<T>(path: string, enabled = true, refresh = 12_000) {
  return useQuery({ queryKey: ["live", path], queryFn: () => api<T>(path), enabled, refetchInterval: refresh });
}

const date = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function when(value?: string | null) {
  return value ? date.format(new Date(value)) : "—";
}
export function observed(value?: string, offline = false) {
  if (!value) return undefined;
  const stale = offline || Date.now() - Date.parse(value) > 300_000;
  return `观测于 ${when(value)}${stale ? " · 已过期" : ""}`;
}
export function relative(value?: string | null) {
  if (!value) return "尚未连接";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return when(value);
}
export function money(value?: string | null, unit?: string | null) {
  if (value == null) return "—";
  const [whole, fraction] = value.split(".");
  return (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    + (fraction ? `.${fraction}` : "") + (unit ? ` ${unit}` : "");
}

export function Brand() {
  return <span className="brand"><span className="brand-icon" aria-hidden="true" />
    <span className="brand-name">QuantBot</span></span>;
}
export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return <header className="page-title"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{action}</header>;
}
export function Panel({ title, hint, action, children, className = "" }: {
  title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel ${className}`}>{(title || action) && <header className="panel-heading">
    <div>{title && <h2>{title}</h2>}{hint && <p>{hint}</p>}</div>{action}
  </header>}{children}</section>;
}
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${status}`}><i />{statusText[status]}</span>;
}
export function CommandBadge({ state }: { state: CommandState }) {
  const color = state === "succeeded" ? "online" : ["failed", "unknown"].includes(state) ? "abnormal"
    : ["expired", "superseded", "cancelled"].includes(state) ? "offline" : "waiting";
  return <span className={`badge ${color}`}><i />{stateText[state]}</span>;
}
export function Empty({ title = "暂无数据", text, action }: { title?: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Inbox size={22} /></span><strong>{title}</strong>
    {text && <p>{text}</p>}{action}</div>;
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? <div role="alert" className="notice error"><AlertCircle size={17} />
    <span>{error instanceof Error ? error.message : String(error)}</span></div> : null;
}
export function Loading() {
  return <div className="loading"><LoaderCircle size={20} className="spin" /> 正在加载</div>;
}
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={14} /></a>;
}
export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true); setError(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setError(true); }
  }
  return <button className="button quiet" type="button" onClick={() => void copy()}>
    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "已复制" : error ? "请手动复制" : label}
  </button>;
}
export function Code({ children, label }: { children: string; label?: string }) {
  return <div className="code"><div className="code-header"><span>{label ?? "代码"}</span>
    <CopyButton value={children} /></div><pre>{children}</pre></div>;
}
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button></div>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Table({ columns, children, empty = false }: { columns: string[]; children: ReactNode; empty?: boolean }) {
  if (empty) return <Empty />;
  return <div className="table-wrap"><table><thead><tr>{columns.map((label, i) =>
    <th scope="col" key={`${label}-${i}`}>{label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

export function ParameterInput({ name, parameter, value, set }: {
  name: string; parameter: Parameter; value: Scalar | undefined;
  set: (value: Scalar | undefined) => void;
}) {
  const { type, required, label, choices, minimum, maximum } = parameter;
  if (type === "boolean") return <Field label={label}><select required={required} value={value == null ? "" : String(value)}
    onChange={(e) => set(e.target.value ? e.target.value === "true" : undefined)}>
    <option value="">请选择</option><option value="true">是</option><option value="false">否</option></select></Field>;
  if (type === "choice") return <Field label={label}><select required={required} value={value == null ? "" : String(value)}
    onChange={(e) => set(e.target.value || undefined)}>
    <option value="">请选择</option>{choices.map((choice) => <option key={choice}>{choice}</option>)}</select></Field>;
  return <Field label={label} hint={[name, minimum != null ? `最小 ${minimum}` : "", maximum != null ? `最大 ${maximum}` : ""].filter(Boolean).join(" · ")}>
    <input type={type === "integer" ? "number" : "text"} inputMode={type === "decimal" ? "decimal" : undefined}
      required={required} min={type === "integer" ? minimum ?? undefined : undefined}
      max={type === "integer" ? maximum ?? undefined : undefined}
      pattern={type === "decimal" ? "-?(0|[1-9][0-9]*)([.][0-9]+)?" : undefined}
      value={value == null ? "" : String(value)} onChange={(e) =>
        set(e.target.value === "" ? undefined : type === "integer" ? Number(e.target.value) : e.target.value)} />
  </Field>;
}
