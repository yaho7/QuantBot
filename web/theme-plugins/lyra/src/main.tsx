import "./styles.css";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import EquityChart, { formatDecimal } from "./equity-chart";
import type { ThemeStrategyData } from "../../../src/themes/bridge-data";
import type { Strategy } from "../../../src/shared/api";
import { connect, request, send, type Context } from "./bridge";

type Label = (zh: string, en: string) => string;

function ConnectionStatus({ online, label }: { online: boolean; label: Label }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className={online ? "size-2 rounded-full bg-foreground" : "size-2 rounded-full border border-muted-foreground"} />
      {online ? label("在线", "Online") : label("离线", "Offline")}
    </span>
  );
}

function SegmentedChoices({ label, options, value, onChange }: {
  label: string;
  options: readonly (readonly [string, string])[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
      {options.map(([id, text]) => (
        <Button
          key={id}
          size="sm"
          variant="ghost"
          aria-pressed={id === value}
          className="aria-pressed:bg-background aria-pressed:shadow-xs"
          onClick={() => onChange(id)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

function Dashboard() {
  const [context, setContext] = useState<Context>();
  const [strategies, setStrategies] = useState<Strategy[]>();
  const [selected, setSelected] = useState("");
  const [hours, setHours] = useState("24");
  const [view, setView] = useState("compact");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [detail, setDetail] = useState<{ hours: string; data: ThemeStrategyData }>();
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState<{ selected: string; hours: string }>();
  const [controlError, setControlError] = useState("");
  const [openingControl, setOpeningControl] = useState(false);
  const layout = useRef<HTMLElement>(null);
  const connected = context !== undefined;
  const zh = context?.language !== "en";
  const label: Label = (cn, en) => zh ? cn : en;

  useEffect(() => connect(setContext), []);
  useEffect(() => {
    const element = layout.current;
    if (!connected || !element) return;
    let lastHeight = 0;
    let timer: number;
    const publishHeight = () => {
      const height = Math.max(320, Math.min(8000, Math.ceil(element.getBoundingClientRect().height)));
      if (height === lastHeight) return;
      lastHeight = height;
      send("quantbot:resize", { height });
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(publishHeight, 100);
    });
    publishHeight();
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [connected]);
  useEffect(() => {
    if (!context) return;
    document.documentElement.classList.toggle("dark", context.appearance === "dark");
    document.documentElement.dataset.appearance = context.appearance;
    document.documentElement.lang = context.language;
  }, [context]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void request<Strategy[]>("quantbot:strategies").then(rows => {
        if (cancelled) return;
        setStrategies(rows);
        setListError(false);
        setSelected(previous => rows.some(row => row.id === previous) ? previous : (rows.find(row => row.online) ?? rows[0])?.id ?? "");
        setGroup(previous => rows.some(row => row.group === previous) ? previous : "");
      }).catch(() => { if (!cancelled) setListError(true); });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [connected]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void request<ThemeStrategyData>("quantbot:strategy", { strategyId: selected, hours: Number(hours) }).then(data => {
        if (cancelled) return;
        setDetail({ hours, data });
        setDetailError(undefined);
      }).catch(() => { if (!cancelled) setDetailError({ selected, hours }); });
    };
    // Coalesce fast strategy/range changes before spending a bridge read.
    const initial = window.setTimeout(refresh, 120);
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      clearInterval(timer);
    };
  }, [selected, hours]);

  const inventory = useMemo(() => ({
    online: strategies?.filter(row => row.online).length ?? 0,
    options: strategies?.map(row => ({ value: row.id, label: row.name })) ?? [],
    groups: [...new Set(strategies?.map(row => row.group).filter(Boolean))],
  }), [strategies]);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return strategies?.filter(row => (!group || row.group === group) && row.name.toLowerCase().includes(query)) ?? [];
  }, [strategies, group, search]);
  const active = strategies?.find(row => row.id === selected);
  const current = detail?.data.strategyId === selected ? detail.data : undefined;
  const points = detail?.hours === hours ? current?.points : undefined;
  const equityFailed = detailError?.selected === selected && detailError?.hours === hours;
  const error = listError || equityFailed;
  const openStrategy = (id: string) => send("quantbot:open-strategy", { requestId: "open-strategy", strategyId: id });
  const selectStrategy = (id: string) => {
    setControlError("");
    setDetailError(undefined);
    setSelected(id);
  };
  const selectHours = (value: string) => {
    setDetailError(undefined);
    setHours(value);
  };

  async function openControl(controlId: string) {
    setControlError("");
    setOpeningControl(true);
    try {
      await request<void>("quantbot:control", { strategyId: selected, controlId });
    } catch {
      setControlError(selected);
    } finally {
      setOpeningControl(false);
    }
  }

  if (!context) return <p className="p-6 text-sm text-muted-foreground" role="status">{label("加载中", "Loading")}</p>;
  const periodOptions = [
    ["1", label("1小时", "1h")],
    ["24", label("24小时", "24h")],
    ["168", label("7天", "7d")],
    ["720", label("30天", "30d")],
  ] as const;
  const viewOptions = [
    ["large", label("大卡片", "Large")],
    ["compact", label("紧凑", "Compact")],
    ["mini", label("迷你", "Mini")],
    ["list", label("列表", "List")],
  ] as const;
  const summary = [
    [label("策略总数", "Strategies"), strategies?.length],
    [label("在线", "Online"), strategies && inventory.online],
    [label("离线", "Offline"), strategies && strategies.length - inventory.online],
  ] as const;
  const mode = (strategy: Strategy) => strategy.mode === "paper" ? label("模拟", "Paper") : label("实盘", "Live");
  const lastSeen = new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });

  return (
    <main ref={layout} className="page-layout mx-auto grid w-full max-w-[97.5rem] min-w-0 gap-6 px-4 py-6 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{label("运行总览", "Strategy overview")}</h1>
      {error && (
        <Alert>
          <AlertDescription role="status">{label("暂时无法更新数据，正在重试", "Could not refresh data. Retrying shortly")}</AlertDescription>
        </Alert>
      )}
      <Card className="py-0">
        <dl className="grid grid-cols-3 divide-x divide-border">
          {summary.map(([title, value]) => (
            <div key={title} className="min-w-0 space-y-1 px-3 py-3 sm:px-5 sm:py-4">
              <dt className="text-xs text-muted-foreground sm:text-sm">{title}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card role="region" aria-labelledby="equity-heading" className="min-w-0">
        <CardHeader className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="equity-heading" className="text-sm font-medium text-muted-foreground">{label("账户权益", "Account equity")}</h2>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">{formatDecimal(current?.equity?.value)}</span>
              {current?.equity?.currency && <span className="text-sm text-muted-foreground">{current.equity.currency}</span>}
            </p>
            {current?.dailyPnl !== undefined && (
              <p className="text-sm text-muted-foreground">
                {label("当日盈亏", "Daily P&L")} <span className="font-medium text-foreground tabular-nums">{formatDecimal(current.dailyPnl)}</span>
              </p>
            )}
          </div>
          <div className="grid w-full gap-3 sm:w-auto sm:justify-items-end">
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Select
                value={selected || null}
                disabled={!inventory.options.length}
                onValueChange={value => { if (value) selectStrategy(value); }}
              >
                <SelectTrigger aria-label={label("策略", "Strategy")} className="min-w-0 flex-1 sm:min-w-40">
                  <SelectValue placeholder={label("选择策略", "Select strategy")}>{active?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {inventory.options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" disabled={!selected} onClick={() => openStrategy(selected)}>{label("详情", "Details")}</Button>
            </div>
            <SegmentedChoices label={label("选择时间范围", "Choose period")} options={periodOptions} value={hours} onChange={selectHours} />
          </div>
        </CardHeader>
        <CardContent className="min-w-0">
          {points?.length ? (
            <EquityChart key={selected + ":" + hours} points={points} lang={context.language}
              valueLabel={label("权益", "Equity")} periodLabel={label("选择时间范围", "Choose period")} />
          ) : (
            <div className="grid min-h-64 place-items-center rounded-lg bg-muted px-3 text-center text-sm text-muted-foreground">
              {equityFailed || (!strategies && listError) ? label("暂时无法读取净值", "Equity history unavailable")
                : !strategies || (selected && !points) ? label("正在加载净值", "Loading equity history")
                : !selected ? label("接入策略后显示净值", "Equity history appears when a strategy connects")
                : label("该时段暂无净值数据", "No equity history for this period")}
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid min-w-0 gap-4" aria-labelledby="strategies-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="strategies-heading" className="text-lg font-semibold">{label("策略", "Strategies")}</h2>
          <SegmentedChoices label={label("显示方式", "View")} options={viewOptions} value={view} onChange={setView} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            aria-label={label("搜索策略", "Search strategies")}
            placeholder={label("按名称搜索", "Search by name")}
            className="min-w-32 flex-1 sm:max-w-64"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <Select value={group ? "group:" + group : "all"}
            onValueChange={value => setGroup(value?.startsWith("group:") ? value.slice(6) : "")}>
            <SelectTrigger aria-label={label("分组", "Group")} className="min-w-28">
              <SelectValue>{group || label("全部", "All groups")}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="all">{label("全部", "All groups")}</SelectItem>
              {inventory.groups.map(value => <SelectItem key={value} value={"group:" + value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {!rows.length ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {!strategies ? (listError ? label("暂时无法读取策略", "Strategies unavailable") : label("正在加载策略", "Loading strategies"))
              : !strategies.length ? label("接入后，策略会显示在此处", "Connected strategies will appear here")
              : label("暂无符合筛选条件的策略", "No matching strategies")}
          </p>
        ) : view === "list" ? (
          <div className="min-w-0 rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead scope="col" className="pl-3">{label("策略名称", "Strategy")}</TableHead>
                <TableHead scope="col">{label("分组", "Group")}</TableHead>
                <TableHead scope="col">{label("状态", "Status")}</TableHead>
                <TableHead scope="col" className="pr-3 text-right">{label("操作", "Action")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.id}>
                    <TableCell className="pl-3 font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{row.group || "—"}</TableCell>
                    <TableCell><ConnectionStatus online={row.online} label={label} /></TableCell>
                    <TableCell className="pr-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openStrategy(row.id)}>{label("详情", "Details")}</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className={
            view === "mini" ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-3"
              : view === "large" ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3"
                : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3"
          }>
            {rows.map(row => (
              <Card key={row.id} size={view === "mini" ? "sm" : "default"}>
                <CardHeader className="flex items-center justify-between gap-2">
                  <h3 title={row.name} className="min-w-0 truncate text-sm font-semibold">{row.name}</h3>
                  <ConnectionStatus online={row.online} label={label} />
                </CardHeader>
                <CardContent className="grid gap-2">
                  {view !== "mini" && <p className="truncate text-xs text-muted-foreground">{row.group || label("未分组", "Ungrouped")} · {mode(row)}</p>}
                  {view === "large" && <p className="text-xs text-muted-foreground tabular-nums">
                    {label("最近在线", "Last seen")} · {row.lastSeen > 0 ? lastSeen.format(row.lastSeen * 1000) : "—"}
                  </p>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={row.id === selected ? "secondary" : "outline"} onClick={() => selectStrategy(row.id)}>
                      {row.id === selected ? label("当前净值", "Current equity") : label("切换净值图", "Select for chart")}
                    </Button>
                    {view === "large" && <Button size="sm" variant="ghost" onClick={() => openStrategy(row.id)}>{label("详情", "Details")}</Button>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {!!current?.controls.length && (
        <section className="grid gap-3" aria-labelledby="controls-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="controls-heading" className="text-lg font-semibold">{label("控制中心", "Controls")}</h2>
            {active && <p className="min-w-0 truncate text-sm text-muted-foreground">{active.name} · {mode(active)}</p>}
          </div>
          {controlError === selected && <Alert variant="destructive">
            <AlertDescription role="alert">{label("暂时无法打开控制窗口", "Could not open the control dialog")}</AlertDescription>
          </Alert>}
          <Card className="py-0">
            <ul className="divide-y divide-border">
              {current.controls.map(control => (
                <li key={control.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 space-y-1">
                    <h3 className="text-sm font-medium">{control.title}</h3>
                    <p className="line-clamp-2 text-sm text-muted-foreground wrap-anywhere">
                      {label("实际状态", "Actual state")} · {
                        control.value == null ? "—"
                          : typeof control.value === "boolean" ? (control.value ? label("是", "Yes") : label("否", "No"))
                          : typeof control.value === "object" ? JSON.stringify(control.value) : String(control.value)
                      }
                    </p>
                  </div>
                  <Button variant="outline" disabled={openingControl} onClick={() => void openControl(control.id)}>
                    {label("打开控制", "Open control")}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </main>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { send("quantbot:error"); }
  render() { return this.state.failed ? null : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<Boundary><Dashboard /></Boundary>);
