import { i18n, label, t, type Message } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowUpRight, Check, Copy, Inbox, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CommandState, type Mode, type Parameter, type Scalar, type Status } from "./api";

export const statusText: Record<Status, Message> = { online: "onboarding.online", offline: "onboarding.offline", abnormal: "ui.unhealthy" };
export const modeText: Record<Mode, Message> = { live: "onboarding.live", paper: "onboarding.paper", backtest: "onboarding.backtest" };
export const stateText: Record<CommandState, Message> = {
  confirmation_required: "ui.awaitingApproval", pending: "ui.awaitingStrategy", accepted: "ui.delivered",
  executing: "ui.executing", succeeded: "ui.confirmedByStrategy", failed: "ui.failed", unknown: "ui.unknownReconciliationRequired",
  expired: "onboarding.expired", superseded: "ui.superseded", cancelled: "ui.cancelled",
};
export const severityText = { debug: "ui.debug", info: "ui.info", warning: "ui.warning", error: "ui.error", critical: "ui.critical" } as const;
export const categoryText: Record<string, Message> = {
  online: "ui.cameOnline", offline: "onboarding.offline", risk: "marketChart.riskControls", alert: "ui.alert", warning: "ui.warning", error: "ui.error",
  trade: "marketChart.fills", open: "ui.openPosition", close: "ui.closePosition", custom: "ui.custom", log: "ui.log",
  authorization: "ui.authorization", command: "operations.command",
};

export function useData<T>(path: string, enabled = true, refresh = 12_000) {
  return useQuery({ queryKey: ["live", path], queryFn: () => api<T>(path), enabled, refetchInterval: refresh });
}

export function when(value?: string | null) {
  return value ? new Intl.DateTimeFormat(i18n.language, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value)) : "—";
}
export function observed(value?: string, offline = false) {
  if (!value) return undefined;
  const stale = offline || Date.now() - Date.parse(value) > 300_000;
  return t("ui.observedAt", { date: when(value), staleness: stale ? t("ui.stale") : "" });
}
export function relative(value?: string | null) {
  if (!value) return t("onboarding.neverConnected");
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return t("ui.justNow");
  if (seconds < 60) return t("ui.secAgo", { seconds: seconds });
  if (seconds < 3600) return t("ui.minAgo", { minutes: Math.floor(seconds / 60) });
  return when(value);
}
export function money(value?: string | null, unit?: string | null) {
  if (value == null) return "—";
  const [whole, fraction] = value.split(".");
  if (!whole || !/^-?\d+$/.test(whole)) return unit ? `${value} ${unit}` : value;
  const formatter = new Intl.NumberFormat(i18n.language);
  const integer = /^-0$/.test(whole) ? formatter.format(-0) : formatter.format(BigInt(whole));
  const decimal = fraction ? formatter.formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? "." : "";
  return integer + (fraction ? decimal + fraction : "") + (unit ? ` ${unit}` : "");
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
  return <span className={`badge ${status}`}><i />{label(statusText[status])}</span>;
}
export function CommandBadge({ state }: { state: CommandState }) {
  const color = state === "succeeded" ? "online" : ["failed", "unknown"].includes(state) ? "abnormal"
    : ["expired", "superseded", "cancelled"].includes(state) ? "offline" : "waiting";
  return <span className={`badge ${color}`}><i />{label(stateText[state])}</span>;
}
export function Empty({ title = t("ui.noData"), text, action }: { title?: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Inbox size={22} /></span><strong>{title}</strong>
    {text && <p>{text}</p>}{action}</div>;
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? <div role="alert" className="notice error"><AlertCircle size={17} />
    <span>{error instanceof Error ? error.message : String(error)}</span></div> : null;
}
export function Loading() {
  return <div className="loading"><LoaderCircle size={20} className="spin" /> {t("ui.loading")}</div>;
}
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-link" href={href}>{children}<ArrowUpRight size={14} /></a>;
}
export function CopyButton({ value, label = t("ui.copy") }: { value: string; label?: string }) {
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
    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t("ui.copied") : error ? t("ui.copyManually") : label}
  </button>;
}
export function Code({ children, label }: { children: string; label?: string }) {
  return <div className="code"><div className="code-header"><span>{label ?? t("ui.code")}</span>
    <CopyButton value={children} /></div><pre>{children}</pre></div>;
}
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>{title}</h2><button className="icon-button" aria-label={t("dynamicControls.close")} onClick={close}><X size={20} /></button></div>
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
    <option value="">{t("dashboardBuilder.selectAnOption")}</option><option value="true">{t("ui.yes")}</option><option value="false">{t("ui.no")}</option></select></Field>;
  if (type === "choice") return <Field label={label}><select required={required} value={value == null ? "" : String(value)}
    onChange={(e) => set(e.target.value || undefined)}>
    <option value="">{t("dashboardBuilder.selectAnOption")}</option>{choices.map((choice) => <option key={choice}>{choice}</option>)}</select></Field>;
  return <Field label={label} hint={[name, minimum != null ? t("ui.minimum", { minimum: minimum }) : "", maximum != null ? t("ui.maximum", { maximum: maximum }) : ""].filter(Boolean).join(" · ")}>
    <input type={type === "integer" ? "number" : "text"} inputMode={type === "decimal" ? "decimal" : undefined}
      required={required} min={type === "integer" ? minimum ?? undefined : undefined}
      max={type === "integer" ? maximum ?? undefined : undefined}
      pattern={type === "decimal" ? "-?(0|[1-9][0-9]*)([.][0-9]+)?" : undefined}
      value={value == null ? "" : String(value)} onChange={(e) =>
        set(e.target.value === "" ? undefined : type === "integer" ? Number(e.target.value) : e.target.value)} />
  </Field>;
}
