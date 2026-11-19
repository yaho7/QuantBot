import "./styles.css";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Banner } from "@astryxdesign/core/Banner";
import { Table } from "@astryxdesign/core/Table";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { quantbotAppTheme } from "../../../themes/quantbot-app/quantbot-app.js";
import { quantbotOceanTheme } from "../../../themes/quantbot-app/quantbot-ocean.js";
import { quantbotVioletTheme } from "../../../themes/quantbot-app/quantbot-violet.js";
import { quantbotAmberTheme } from "../../../themes/quantbot-app/quantbot-amber.js";
import { quantbotGraphiteTheme } from "../../../themes/quantbot-app/quantbot-graphite.js";
import EquityChart from "../../../src/components/equity-chart";
import type { ThemeStrategyData } from "../../../src/themes/bridge-data";
import type { Strategy } from "../../../src/shared/api";
import { connect, request, send, type Context } from "./bridge";

const palettes = { forest: quantbotAppTheme, ocean: quantbotOceanTheme, violet: quantbotVioletTheme, amber: quantbotAmberTheme, graphite: quantbotGraphiteTheme };
// Format the exact decimal text received from the bridge.
const formatDecimal = (value?: string) => {
  if (value === undefined) return "—";
  const [whole = "", fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : "." + fraction);
};

type Label = (zh: string, en: string) => string;

function ConnectionStatus({ online, label }: { online: boolean; label: Label }) {
  const status = online ? label("在线", "Online") : label("离线", "Offline");
  return (
    <HStack gap={2} vAlign="center" className="shrink-0">
      <StackItem aria-hidden="true"><StatusDot variant={online ? "success" : "neutral"} label={status} /></StackItem>
      <Text type="supporting">{status}</Text>
    </HStack>
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
    document.documentElement.dataset.appearance = context.appearance;
    document.documentElement.dataset.palette = context.palette;
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

  if (!context) return <VStack padding={8}><Spinner label={label("加载中", "Loading")} /></VStack>;
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
    <InternationalizationProvider locale={zh ? "zh-Hans" : "en"}>
      <Theme theme={palettes[context.palette as keyof typeof palettes] ?? palettes.forest} mode={context.appearance}>
        <VStack ref={layout} gap={6} width="100%" maxWidth="97.5rem" className="page-layout min-w-0 mx-auto px-3 py-5 sm:px-6 md:p-8 bg-body">
          <Heading level={1}>{label("运行总览", "Strategy overview")}</Heading>
          {error && <Banner status="warning" title={label("暂时无法更新数据，正在重试", "Could not refresh data. Retrying shortly")} />}
          <Card padding={0}>
            <Grid columns={3} className="divide-x divide-border">
              {summary.map(([title, value]) => (
                <VStack key={title} gap={1} className="px-3 py-3 sm:px-5 sm:py-4">
                  <Text type="supporting">{title}</Text>
                  <Text type="large" size="2xl" weight="medium" hasTabularNumbers>{value ?? "—"}</Text>
                </VStack>
              ))}
            </Grid>
          </Card>

          <Card padding={4}>
            <VStack gap={4} as="section" aria-labelledby="equity-heading">
              <HStack gap={4} hAlign="between" vAlign="start" wrap="wrap">
                <VStack gap={1}>
                  <Heading id="equity-heading" level={2} weight="medium">{label("账户权益", "Account equity")}</Heading>
                  <HStack gap={2} className="items-baseline" wrap="wrap">
                    <Text type="display-2" weight="medium" hasTabularNumbers>{formatDecimal(current?.equity?.value)}</Text>
                    {current?.equity?.currency && <Text type="supporting">{current.equity.currency}</Text>}
                  </HStack>
                  {current?.dailyPnl !== undefined && <HStack gap={2} className="items-baseline" wrap="wrap">
                    <Text type="supporting">{label("当日盈亏", "Daily P&L")}</Text>
                    <Text type="supporting" hasTabularNumbers className={current.dailyPnl.startsWith("-") ? "text-red-vivid" : "text-green-vivid"}>{formatDecimal(current.dailyPnl)}</Text>
                  </HStack>}
                </VStack>
                <VStack gap={3} hAlign="start" className="w-full sm:w-auto sm:items-end">
                  <HStack gap={2} vAlign="center" className="w-full sm:w-auto">
                    <StackItem size="fill" className="sm:min-w-40">
                      <Selector
                        label={label("策略", "Strategy")}
                        isLabelHidden
                        width="100%"
                        placeholder={label("选择策略", "Select strategy")}
                        value={selected}
                        onChange={selectStrategy}
                        isDisabled={!strategies?.length}
                        options={inventory.options}
                      />
                    </StackItem>
                    <Button label={label("详情", "Details")} variant="ghost" isDisabled={!selected} onClick={() => openStrategy(selected)} />
                  </HStack>
                  <SegmentedControl label={label("选择时间范围", "Choose period")} value={hours} onChange={selectHours} size="md">
                    {periodOptions.map(([value, text]) => <SegmentedControlItem key={value} value={value} label={text} />)}
                  </SegmentedControl>
                </VStack>
              </HStack>
              {points?.length ? (
                <EquityChart key={selected + ":" + hours} points={points} lang={context.language} valueLabel={label("权益", "Equity")} />
              ) : (
                <VStack height="calc(clamp(16rem, 28vw, 20rem) + var(--spacing-8))" vAlign="center" hAlign="center" className="rounded-lg bg-muted">
                  <Text type="supporting">
                    {equityFailed || (!strategies && listError) ? label("暂时无法读取净值", "Equity history unavailable")
                      : !strategies || (selected && !points) ? label("正在加载净值", "Loading equity history")
                      : !selected ? label("接入策略后显示净值", "Equity history appears when a strategy connects")
                      : label("该时段暂无净值数据", "No equity history for this period")}
                  </Text>
                </VStack>
              )}
            </VStack>
          </Card>

          <VStack gap={4} as="section" aria-labelledby="strategies-heading">
            <HStack hAlign="between" wrap="wrap" vAlign="center" gap={3}>
              <Heading id="strategies-heading" level={2}>{label("策略", "Strategies")}</Heading>
              <SegmentedControl label={label("显示方式", "View")} value={view} onChange={setView} size="md">
                {viewOptions.map(([value, text]) => <SegmentedControlItem key={value} value={value} label={text} />)}
              </SegmentedControl>
            </HStack>
            <HStack gap={3} vAlign="end">
              <StackItem size="fill" className="sm:max-w-64">
                <TextInput label={label("搜索策略", "Search strategies")} placeholder={label("按名称搜索", "Search by name")} startIcon="search" value={search} onChange={setSearch} hasClear width="100%" />
              </StackItem>
              <StackItem className="w-28 sm:w-40">
                <Selector label={label("分组", "Group")} value={group} onChange={setGroup} width="100%" options={[{ value: "", label: label("全部", "All groups") }, ...inventory.groups.map(value => ({ value, label: value }))]} />
              </StackItem>
            </HStack>

            {!rows.length ? (
              <VStack padding={5} hAlign="center" className="rounded-lg border border-border">
                <Text type="supporting">
                  {!strategies ? (listError ? label("暂时无法读取策略", "Strategies unavailable") : label("正在加载策略", "Loading strategies"))
                    : !strategies.length ? label("接入后，策略会显示在此处", "Connected strategies will appear here")
                    : label("暂无符合筛选条件的策略", "No matching strategies")}
                </Text>
              </VStack>
            ) : view === "list" ? (
              <Table data={rows} idKey="id" columns={[
                { key: "name", header: label("策略名称", "Strategy") },
                { key: "group", header: label("分组", "Group"), renderCell: row => <Text type="supporting">{row.group || "—"}</Text> },
                { key: "online", header: label("状态", "Status"), renderCell: row => <ConnectionStatus online={row.online} label={label} /> },
                { key: "id", header: label("操作", "Action"), renderCell: row => <Button label={label("详情", "Details")} size="sm" variant="ghost" onClick={() => openStrategy(row.id)} /> },
              ]} />
            ) : (
              <Grid columns={{ minWidth: view === "mini" ? 176 : view === "large" ? 352 : 256, repeat: "fill" }} gap={3}>
                {rows.map(row => (
                  <Card key={row.id} padding={view === "mini" ? 3 : 4}>
                    <VStack gap={view === "mini" ? 2 : 3} height="100%" hAlign="start">
                      <HStack gap={2} hAlign="between" vAlign="center" width="100%">
                        <Heading level={3} weight="medium" maxLines={1} className="min-w-0">{row.name}</Heading>
                        <ConnectionStatus online={row.online} label={label} />
                      </HStack>
                      {view !== "mini" && <Text type="supporting" maxLines={1}>{row.group || label("未分组", "Ungrouped")} · {mode(row)}</Text>}
                      {view === "large" && <Text type="supporting" hasTabularNumbers>
                        {label("最近在线", "Last seen")} · {row.lastSeen > 0 ? lastSeen.format(row.lastSeen * 1000) : "—"}
                      </Text>}
                      <HStack gap={2} wrap="wrap">
                        <Button label={row.id === selected ? label("当前净值", "Current equity") : label("切换净值图", "Select for chart")} variant={row.id === selected ? "secondary" : "ghost"} onClick={() => selectStrategy(row.id)} />
                        {view === "large" && <Button label={label("详情", "Details")} variant="ghost" onClick={() => openStrategy(row.id)} />}
                      </HStack>
                    </VStack>
                  </Card>
                ))}
              </Grid>
            )}
          </VStack>

          {!!current?.controls.length && <VStack gap={3} as="section" aria-labelledby="controls-heading">
            <HStack gap={2} className="items-baseline" hAlign="between" wrap="wrap">
              <Heading id="controls-heading" level={2}>{label("控制中心", "Controls")}</Heading>
              {active && <Text type="supporting" maxLines={1}>{active.name} · {mode(active)}</Text>}
            </HStack>
            {controlError === selected && <Banner status="warning" title={label("暂时无法打开控制窗口", "Could not open the control dialog")} />}
            <Card padding={0}>
              <VStack className="divide-y divide-border">
                {current.controls.map(control => (
                  <HStack key={control.id} gap={3} vAlign="center" hAlign="between" wrap="wrap" className="px-4 py-3">
                    <VStack gap={1} className="min-w-0">
                      <Heading level={3} weight="medium">{control.title}</Heading>
                      <Text type="supporting" maxLines={2}>{label("实际状态", "Actual state")} · {
                        control.value == null ? "—"
                          : typeof control.value === "boolean" ? (control.value ? label("是", "Yes") : label("否", "No"))
                          : typeof control.value === "object" ? JSON.stringify(control.value) : String(control.value)
                      }</Text>
                    </VStack>
                    <Button label={label("打开控制", "Open control")} variant="secondary" size="lg" clickAction={async () => {
                      setControlError("");
                      try {
                        await request<void>("quantbot:control", { strategyId: selected, controlId: control.id });
                      } catch {
                        setControlError(selected);
                      }
                    }} />
                  </HStack>
                ))}
              </VStack>
            </Card>
          </VStack>}
        </VStack>
      </Theme>
    </InternationalizationProvider>
  );
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { send("quantbot:error"); }
  render() { return this.state.failed ? null : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<Boundary><Dashboard /></Boundary>);
