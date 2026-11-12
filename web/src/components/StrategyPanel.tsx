import { tr } from "@/lib/i18n";
/**
 * Everything you can do with one strategy: the same commands as the Telegram buttons.
 * Buttons only appear for commands the strategy said it supports. Anything that
 * moves money or stops the program asks for confirmation first.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  LineChart,
  Pause,
  Play,
  RefreshCw,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wallet,
  X,
} from "lucide-react";
import * as React from "react";
import { AiPromptDialog } from "@/components/AiPromptDialog";
import { StrategyOperations } from "@/components/StrategyOperations";
import { ConfirmDialog, EmptyState } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Alert, Badge, Field, Input, Select } from "@/components/ui/primitives";
import { api, type Command, type OrderItem, type StrategyView } from "@/lib/api";

type View =
  | { kind: "none" }
  | { kind: "text"; title: string; text: string }
  | { kind: "orders"; items: OrderItem[]; message: string }
  | { kind: "chart"; png: string; message: string }
  | { kind: "params"; values: Record<string, unknown> }
  | { kind: "order" };

type Confirmation = {
  title: string;
  description: string;
  label: string;
  name: Command;
  args?: Record<string, unknown>;
  after?: () => void;
};

/** Turn what the user typed into the type the parameter has now. */
function convert(old: unknown, typed: string): unknown {
  if (typeof old === "number") return Number(typed);
  if (typeof old === "boolean") return typed === "true";
  if (typeof old === "string") return typed;
  try {
    return JSON.parse(typed);
  } catch {
    return typed;
  }
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function useCommand(s: StrategyView) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ name, args, ticket }: { name: Command; args?: Record<string, unknown>; ticket?: string }) =>
      api.command(s.id, name, args, ticket),
    onSuccess: (answer, { name }) => {
      if (["pause", "resume", "cancel", "flatten", "set_param", "manual_order", "stop"].includes(name)) {
        if (answer.ok) toast.success(answer.message);
        else toast.error(answer.message);
        void qc.invalidateQueries({ queryKey: ["overview"] });
        void qc.invalidateQueries({ queryKey: ["audit"] });
        void qc.invalidateQueries({ queryKey: ["operations", s.id] });
      }
    },
    onError: toast.error,
  });
}

export function PauseButton({ s }: { s: StrategyView }) {
  const command = useCommand(s);
  const toast = useToast();
  const [ticket, setTicket] = React.useState<string>();
  const prepare = useMutation({
    mutationFn: () => api.prepareCommand(s.id, "resume"),
    onSuccess: (result) => setTicket(result.ticket),
    onError: toast.error,
  });
  const paused = s.paused === true;
  const name = paused ? "resume" : "pause";
  if (s.connected && !s.commands.includes(name)) return null;
  return (
    <>
      <Button size="sm" variant="outline" loading={command.isPending || prepare.isPending}
        disabled={paused && !s.online}
        onClick={() => { if (paused) prepare.mutate(); else command.mutate({ name }); }}>
        {paused ? <Play /> : <Pause />} {paused ? tr("恢复开仓") : tr("暂停开仓")}
      </Button>
      {ticket && <ConfirmDialog open onOpenChange={(open) => { if (!open) setTicket(undefined); }}
        title={tr("确定让 {0} 恢复开仓？", s.name)} description={tr("确认后，策略可恢复开仓。")}
        confirmLabel={tr("恢复开仓")}
        onConfirm={() => { command.mutate({ name: "resume", ticket }); setTicket(undefined); }} />}
    </>
  );
}

export function StrategyPanel({ s, open, onOpenChange }: {
  s: StrategyView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const command = useCommand(s);
  const toast = useToast();
  const [view, setView] = React.useState<View>({ kind: "none" });
  const [pending, setPending] = React.useState<(Confirmation & { ticket: string }) | null>(null);
  const [askAi, setAskAi] = React.useState(false);
  const prepare = useMutation({
    mutationFn: (confirmation: Confirmation) => api.prepareCommand(s.id, confirmation.name, confirmation.args),
    onSuccess: (result, confirmation) => setPending({ ...confirmation, ticket: result.ticket }),
    onError: toast.error,
  });
  const has = (name: Command) => s.commands.includes(name);

  async function read(name: Command, title: string) {
    const answer = await command.mutateAsync({ name }).catch(() => undefined);  // toast shows it
    if (!answer) return;
    if (!answer.ok) return setView({ kind: "text", title, text: answer.message });
    if (name === "orders") {
      const items = Array.isArray(answer.data) ? (answer.data as OrderItem[]) : [];
      return setView({ kind: "orders", items, message: answer.message });
    }
    if (name === "chart") {
      return typeof answer.data === "string" && answer.data
        ? setView({ kind: "chart", png: answer.data, message: answer.message })
        : setView({ kind: "text", title, text: tr("净值图是空的。") });
    }
    if (name === "params") {
      const values = answer.data && typeof answer.data === "object" ? (answer.data as Record<string, unknown>) : {};
      return setView({ kind: "params", values });
    }
    setView({ kind: "text", title, text: answer.message || tr("没有内容。") });
  }

  async function change({ name, args, ticket, after }: NonNullable<typeof pending>) {
    setPending(null);
    const answer = await command.mutateAsync({ name, args, ticket }).catch(() => undefined);
    if (answer?.ok) after?.();
  }

  const busy = command.isPending || prepare.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={s.name} className="max-w-2xl"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{s.id}</span>
            {s.online ? <Badge tone="gain">{tr("在线")}</Badge> : <Badge tone="loss">{tr("离线")}</Badge>}
            {s.paused && <Badge tone="warning">{tr("已暂停开仓")}</Badge>}
          </span>
        }>
        {!s.online && (
          <Alert tone="warning">{tr("策略离线。暂停请求会保存，其他命令需要策略在线。")}</Alert>
        )}
        {s.status && <p className="whitespace-pre-wrap rounded-lg bg-card p-3 text-sm">{s.status}</p>}

        <div className="flex flex-wrap gap-2">
          {has("status") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => command.mutate({ name: "status" })}>
              <RefreshCw /> {tr("刷新状态")}</Button>
          )}
          <PauseButton s={s} />
          {has("positions") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void read("positions", tr("持仓"))}>
              <Wallet /> {tr("持仓")}</Button>
          )}
          {has("orders") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void read("orders", tr("挂单"))}>
              <ClipboardList /> {tr("挂单")}</Button>
          )}
          {has("chart") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void read("chart", tr("净值图"))}>
              <LineChart /> {tr("净值图")}</Button>
          )}
          {has("set_param") && (
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => (has("params") ? void read("params", tr("参数")) : setView({ kind: "params", values: {} }))}>
              <SlidersHorizontal /> {tr("改参数")}</Button>
          )}
          {has("manual_order") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setView({ kind: "order" })}>
              <ShoppingCart /> {tr("手动下单")}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAskAi(true)}>
            <Sparkles /> {tr("复制给 AI")}</Button>
        </div>
        {askAi && <AiPromptDialog open onOpenChange={setAskAi} strategy={{ id: s.id, name: s.name }} />}

        <ViewArea view={view} busy={busy || !s.online} s={s}
          onCancel={(item) => prepare.mutate({
            title: tr("撤掉这个挂单？"), description: item.text, label: tr("撤单"),
            name: "cancel", args: { order_id: item.id }, after: () => void read("orders", tr("挂单")),
          })}
          onSet={(name, value, old) => prepare.mutate({
            title: tr("把 {0} 改成 {1}？", name, show(value)), description: tr("现在是 {0}。", show(old)), label: tr("改参数"),
            name: "set_param", args: { name, value },
            after: () => { if (has("params")) void read("params", tr("参数")); },
          })}
          onOrder={(side, symbol, qty) => prepare.mutate({
            title: `${side === "buy" ? tr("买入") : tr("卖出")} ${symbol} ${qty}？`,
            description: tr("这会让策略向券商下一个真实订单。"), label: side === "buy" ? tr("买入") : tr("卖出"),
            name: "manual_order", args: { side, symbol, qty },
          })}
        />

        {(has("flatten") || has("stop")) && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {has("flatten") && (
              <Button size="sm" variant="destructive" disabled={busy || !s.online}
                onClick={() => prepare.mutate({
                  title: tr("平掉 {0} 的仓位？", s.name),
                  description: tr("只会平它能确认归属的仓位。"), label: tr("平仓"),
                  name: "flatten",
                })}>
                <X /> {tr("平仓")}</Button>
            )}
            {has("stop") && (
              <Button size="sm" variant="outline" disabled={busy || !s.online}
                onClick={() => prepare.mutate({
                  title: tr("让 {0} 停止？", s.name),
                  description: tr("程序会退出，挂着的止损单会保留。要再跑起来，得在服务器上启动它。"), label: tr("停止"),
                  name: "stop",
                })}>
                <Square /> {tr("停止程序")}</Button>
            )}
          </div>
        )}

        {open && <StrategyOperations sid={s.id} />}
        {pending && (
          <ConfirmDialog open onOpenChange={(o) => { if (!o) setPending(null); }}
            title={pending.title} description={pending.description} confirmLabel={pending.label}
            destructive loading={busy} onConfirm={() => void change(pending)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewArea({ view, busy, s, onCancel, onSet, onOrder }: {
  view: View;
  busy: boolean;
  s: StrategyView;
  onCancel: (item: OrderItem) => void;
  onSet: (name: string, value: unknown, old: unknown) => void;
  onOrder: (side: "buy" | "sell", symbol: string, qty: number) => void;
}) {
  if (view.kind === "none") return null;
  if (view.kind === "text") {
    return (
      <section className="rounded-lg border p-3">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">{view.title}</h4>
        <p className="whitespace-pre-wrap text-sm">{view.text}</p>
      </section>
    );
  }
  if (view.kind === "orders") {
    if (!view.items.length) return <EmptyState title={view.message || tr("没有挂单")} />;
    return (
      <ul className="divide-y rounded-lg border">
        {view.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 break-words">{item.text}</span>
            {s.commands.includes("cancel") && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(item)}>{tr("撤单")}</Button>
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (view.kind === "chart") {
    return (
      <figure className="grid gap-2">
        <img src={`data:image/png;base64,${view.png}`} alt={tr("净值图")} className="w-full rounded-lg border" />
        {view.message && <figcaption className="text-xs text-muted-foreground">{view.message}</figcaption>}
      </figure>
    );
  }
  if (view.kind === "params") return <ParamsForm values={view.values} busy={busy} onSet={onSet} />;
  return <OrderForm busy={busy} onOrder={onOrder} />;
}

function ParamsForm({ values, busy, onSet }: {
  values: Record<string, unknown>;
  busy: boolean;
  onSet: (name: string, value: unknown, old: unknown) => void;
}) {
  const names = Object.keys(values);
  const [free, setFree] = React.useState({ name: "", value: "" });
  if (!names.length) {
    return (
      <form className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => { e.preventDefault(); if (free.name) onSet(free.name, convert(null, free.value), tr("（未知）")); }}>
        <Field label={tr("参数名")} htmlFor="pn"><Input id="pn" value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} /></Field>
        <Field label={tr("新的值")} htmlFor="pv"><Input id="pv" value={free.value} onChange={(e) => setFree({ ...free, value: e.target.value })} /></Field>
        <Button type="submit" size="sm" disabled={busy || !free.name}>{tr("改")}</Button>
      </form>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      {names.map((name) => <ParamRow key={name} name={name} old={values[name]} busy={busy} onSet={onSet} />)}
    </div>
  );
}

function ParamRow({ name, old, busy, onSet }: {
  name: string;
  old: unknown;
  busy: boolean;
  onSet: (name: string, value: unknown, old: unknown) => void;
}) {
  const [typed, setTyped] = React.useState(show(old));
  const id = `param-${name}`;
  const value = convert(old, typed);
  const invalid = typeof old === "number" && !Number.isFinite(value as number);
  return (
    <form className="grid items-end gap-2 sm:grid-cols-[10rem_1fr_auto]"
      onSubmit={(e) => { e.preventDefault(); if (!invalid) onSet(name, value, old); }}>
      <label htmlFor={id} className="truncate font-mono text-xs text-muted-foreground sm:pb-2.5">{name}</label>
      {typeof old === "boolean" ? (
        <Select id={id} value={typed} onChange={(e) => setTyped(e.target.value)}>
          <option value="true">{tr("开（true）")}</option>
          <option value="false">{tr("关（false）")}</option>
        </Select>
      ) : (
        <Input id={id} value={typed} inputMode={typeof old === "number" ? "decimal" : undefined}
          aria-invalid={invalid} onChange={(e) => setTyped(e.target.value)} />
      )}
      <Button type="submit" size="sm" variant="outline" disabled={busy || invalid || typed === show(old)}>{tr("改")}</Button>
    </form>
  );
}

function OrderForm({ busy, onOrder }: {
  busy: boolean;
  onOrder: (side: "buy" | "sell", symbol: string, qty: number) => void;
}) {
  const [side, setSide] = React.useState<"buy" | "sell">("buy");
  const [symbol, setSymbol] = React.useState("");
  const [qty, setQty] = React.useState("");
  const amount = Number(qty);
  const ok = /^[A-Za-z0-9.\-/]{1,15}$/.test(symbol) && amount > 0;
  return (
    <form className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[8rem_1fr_8rem_auto] sm:items-end"
      onSubmit={(e) => { e.preventDefault(); if (ok) onOrder(side, symbol.toUpperCase(), amount); }}>
      <Field label={tr("方向")} htmlFor="os">
        <Select id="os" value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")}>
          <option value="buy">{tr("买入")}</option>
          <option value="sell">{tr("卖出")}</option>
        </Select>
      </Field>
      <Field label={tr("代码")} htmlFor="oc"><Input id="oc" value={symbol} placeholder="QQQ" onChange={(e) => setSymbol(e.target.value)} /></Field>
      <Field label={tr("数量")} htmlFor="oq"><Input id="oq" value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} /></Field>
      <Button type="submit" size="sm" disabled={busy || !ok}>{tr("下单")}</Button>
    </form>
  );
}
