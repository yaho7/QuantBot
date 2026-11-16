import "./styles.css";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
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
import { BrandIcon } from "./brand-icon";
import { connect, request, send, type Context } from "./bridge";

const palettes = { forest: quantbotAppTheme, ocean: quantbotOceanTheme, violet: quantbotVioletTheme, amber: quantbotAmberTheme, graphite: quantbotGraphiteTheme };
const number = (value?: string) => {
  if (value === undefined) return "—";
  const [whole = "", fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : "." + fraction);
};

function Dashboard() {
  const [context, setContext] = useState<Context>();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState("");
  const [hours, setHours] = useState("24");
  const [view, setView] = useState("compact");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [detail, setDetail] = useState<ThemeStrategyData>();
  const [error, setError] = useState(false);
  const zh = context?.language !== "en";
  const label = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => connect(setContext), []);
  useEffect(() => {
    if (!context) return;
    const element = document.querySelector(".page-layout");
    if (!element) return;
    const observer = new ResizeObserver(() => send("quantbot:resize", { height: Math.max(320, Math.min(8000, Math.ceil(element.getBoundingClientRect().height))) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!context]);
  useEffect(() => {
    if (!context) return;
    document.documentElement.dataset.appearance = context.appearance;
    document.documentElement.dataset.palette = context.palette;
    document.documentElement.lang = context.language;
  }, [context]);
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void request<Strategy[]>("quantbot:strategies").then(rows => {
        if (cancelled) return;
        setStrategies(rows);
        setSelected(previous => rows.some(row => row.id === previous) ? previous : (rows.find(row => row.online) ?? rows[0])?.id ?? "");
      }).catch(() => { if (!cancelled) setError(true); });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [!!context]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetail(undefined);
    const refresh = () => {
      if (document.hidden) return;
      void request<ThemeStrategyData>("quantbot:strategy", { strategyId: selected, hours: Number(hours) }).then(value => {
        if (cancelled) return;
        setDetail(value);
        setError(false);
      }).catch(() => { if (!cancelled) setError(true); });
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selected, hours]);
  const rows = useMemo(() => strategies.filter(row => (!group || row.group === group) && row.name.toLowerCase().includes(search.toLowerCase())), [strategies, group, search]);
  const groups = [...new Set(strategies.map(row => row.group).filter(Boolean))];
  const current = detail?.strategyId === selected ? detail : undefined;
  const openStrategy = (id: string) => send("quantbot:open-strategy", { requestId: "open-strategy", strategyId: id });
  if (!context) return <VStack padding={8}><Spinner label={label("加载中", "Loading")} /></VStack>;
  return (
    <InternationalizationProvider locale={zh ? "zh-Hans" : "en"}>
      <Theme theme={palettes[context.palette as keyof typeof palettes] ?? palettes.forest} mode={context.appearance}>
        <VStack gap={6} width="100%" maxWidth={1560} className="page-layout min-w-0 mx-auto px-4 py-6 md:px-8 md:py-8 bg-body">
          <HStack hAlign="between" vAlign="center" gap={4} wrap="wrap">
            <HStack gap={3} vAlign="center"><BrandIcon /><Heading level={1}>{label("运行总览", "Overview")}</Heading></HStack>
            <HStack gap={2} vAlign="center">
              <Selector label={label("策略", "Strategy")} isLabelHidden width="calc(var(--spacing-10) * 4)" value={selected} onChange={setSelected} isDisabled={!strategies.length} options={strategies.map(row => ({ value: row.id, label: row.name }))} />
              <Button label={label("详情", "Details")} variant="ghost" isDisabled={!selected} onClick={() => openStrategy(selected)} />
            </HStack>
          </HStack>
          {error && <Banner status="warning" title={label("暂时无法获取数据，请稍后重试。", "Data is temporarily unavailable. Retrying shortly.")} />}
          <Grid columns={{ minWidth: 150, repeat: "fit" }} gap={4}>
            {[
              [label("策略总数", "Strategies"), strategies.length],
              [label("在线", "Online"), strategies.filter(row => row.online).length],
              [label("离线", "Offline"), strategies.filter(row => !row.online).length],
            ].map(([title, value]) => <Card key={title} padding={4}><VStack gap={2}><Text type="supporting">{title}</Text><Text type="large" weight="semibold" hasTabularNumbers className="text-2xl">{value}</Text></VStack></Card>)}
          </Grid>
          <Card padding={5}>
            <VStack gap={4}>
              <VStack gap={2}>
                <Text type="supporting">{label("账户权益", "Account equity")}</Text>
                <HStack gap={2} vAlign="end"><Text type="large" weight="semibold" hasTabularNumbers className="text-2xl">{number(current?.equity?.value)}</Text><Text type="supporting">{current?.equity?.currency ?? ""}</Text></HStack>
                {current?.dailyPnl !== undefined && <Text className={current.dailyPnl.startsWith("-") ? "text-error" : "text-success"}>{label("当日盈亏", "Daily P&L")} {number(current.dailyPnl)}</Text>}
              </VStack>
              {current?.points.length ? <EquityChart points={current.points} lang={context.language} valueLabel={label("数值", "Value")} /> : <VStack height="clamp(16rem, 28vw, 20rem)" vAlign="center" hAlign="center"><Text type="supporting">{!current && selected ? label("加载中", "Loading") : label("暂无净值数据", "No equity history")}</Text></VStack>}
              <SegmentedControl label={label("选择时间范围", "Choose period")} value={hours} onChange={setHours} size="sm">
                {[["1", label("1小时", "1h")], ["24", label("24小时", "24h")], ["168", label("7天", "7d")], ["720", label("30天", "30d")]].map(([value, text]) => <SegmentedControlItem key={value} value={value!} label={text!} />)}
              </SegmentedControl>
            </VStack>
          </Card>
          <VStack gap={4}>
            <HStack hAlign="between" wrap="wrap" vAlign="center" gap={3}>
              <Heading level={2}>{label("策略", "Strategies")}</Heading>
              <SegmentedControl label={label("显示方式", "View")} value={view} onChange={setView} size="sm">
                {[["large", label("大卡片", "Large")], ["compact", label("紧凑", "Compact")], ["mini", label("迷你", "Mini")], ["list", label("列表", "List")]].map(([value, text]) => <SegmentedControlItem key={value} value={value!} label={text!} />)}
              </SegmentedControl>
            </HStack>
            <HStack gap={3} wrap="wrap" vAlign="end">
              <TextInput label={label("搜索策略", "Search strategies")} value={search} onChange={setSearch} />
              <Selector label={label("分组", "Group")} value={group} onChange={setGroup} options={[{ value: "", label: label("全部", "All") }, ...groups.map(value => ({ value, label: value }))]} />
            </HStack>
            {view === "list" ? <Table data={rows} idKey="id" columns={[
              { key: "name", header: label("策略名称", "Strategy") },
              { key: "group", header: label("分组", "Group") },
              { key: "online", header: label("状态", "Status"), renderCell: row => <Text>{row.online ? label("在线", "Online") : label("离线", "Offline")}</Text> },
              { key: "id", header: label("操作", "Action"), renderCell: row => <Button label={label("详情", "Details")} size="sm" variant="ghost" onClick={() => openStrategy(row.id)} /> },
            ]} /> : <Grid columns={{ minWidth: view === "mini" ? 180 : view === "large" ? 360 : 280, repeat: "fill" }} gap={4}>
              {rows.map(row => <Card key={row.id} padding={view === "mini" ? 3 : 5}><VStack gap={3} height="100%">
                <HStack gap={3} hAlign="between" vAlign="start"><Heading level={3} maxLines={1}>{row.name}</Heading><StatusDot variant={row.online ? "success" : "neutral"} label={row.online ? label("在线", "Online") : label("离线", "Offline")} /></HStack>
                {view !== "mini" && <Text type="supporting">{row.group || label("未分组", "Ungrouped")} · {row.mode === "paper" ? label("模拟", "Paper") : label("实盘", "Live")}</Text>}
                <Button label={label("查看数据", "View data")} variant={row.id === selected ? "secondary" : "ghost"} onClick={() => setSelected(row.id)} />
              </VStack></Card>)}
            </Grid>}
            {!rows.length && <Text type="supporting">{label("暂无符合筛选条件的策略", "No matching strategies")}</Text>}
          </VStack>
          {!!current?.controls.length && <VStack gap={4}>
            <Heading level={2}>{label("控制中心", "Controls")}</Heading>
            <Grid columns={{ minWidth: 240, repeat: "fit" }} gap={4}>
              {current.controls.map(control => <Card key={control.id} padding={4}><VStack gap={3}>
                <Heading level={3}>{control.title}</Heading>
                {control.value !== undefined && control.value !== null && <Text type="supporting">{label("实际状态", "Actual state")} · {typeof control.value === "object" ? JSON.stringify(control.value) : String(control.value)}</Text>}
                <Button label={label("打开控制", "Open control")} onClick={() => { void request<void>("quantbot:control", { strategyId: selected, controlId: control.id }).catch(() => setError(true)); }} />
              </VStack></Card>)}
            </Grid>
          </VStack>}
          <Text type="supporting">QuantBot · Astryx</Text>
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
