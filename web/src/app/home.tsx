import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Selector } from "@astryxdesign/core/Selector";
import { AttentionSummary, useAttention } from "../components/attention-summary";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { TextInput } from "@astryxdesign/core/TextInput";
import { StrategyTable } from "../components/strategy-table";
import { lazy, Suspense, memo, useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Link } from "../shared/page-links";
import {
  ArrowUpRight,
  ChevronDown,
  LayoutGrid,
  Grid2X2,
  Rows3,
  List,
  SlidersHorizontal,
} from "lucide-react";
import {
  resource,
  type Datum,
  type Strategy,
} from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, Choices, decimalText, ErrorView, Loading } from "../shared/ui";
import { Page } from "./App";
import { History, useTelemetryValues } from "./strategy";

const WidgetBoard = lazy(() => import("../components/widget-board"));
const views = [["large", LayoutGrid], ["compact", Grid2X2], ["mini", Rows3], ["list", List]] as const;
type View = typeof views[number][0];
const viewLabels = { large: ["大卡片", "Large"], compact: ["紧凑", "Compact"], mini: ["迷你", "Mini"], list: ["列表", "List"] } as const;
export function Home() {
  const { t, lang } = useLanguage();
  const attention = useAttention();
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const directory = useLocation().pathname === "/strategies";
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem("qb.strategyView");
    return views.some(([value]) => value === saved) ? saved as View : saved === "tableView" ? "list" : "compact";
  });
  const [filter, setFilter] = useState("all");
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [limit, setLimit] = useState(50);
  const rows = strategies.data ?? [];
  const [featuredId, setFeaturedId] = useState("");
  const equitySources = useQueries({
    queries: !directory ? rows.map((strategy) =>
      resource<Datum[]>("/strategies/" + strategy.id + "/telemetry"),
    ) : [],
  });
  const featured = rows.find((strategy) => strategy.id === featuredId) ??
    rows.find((_, index) => equitySources[index]?.data?.some((item) => item.kind === "equity")) ??
    rows.find((strategy) => strategy.online) ?? rows[0];
  const groups = useMemo(
    () => [...new Set(rows.map((s) => s.group).filter(Boolean))].sort(),
    [rows],
  );
  const selected = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            (!search ||
              row.name.toLowerCase().includes(search.toLowerCase())) &&
            (!group || row.group === group) &&
            (filter === "all" || (filter === "online") === row.online),
        )
        .sort((a, b) =>
          sort === "lastSeen"
            ? b.lastSeen - a.lastSeen
            : a.name.localeCompare(b.name),
        ),
    [rows, search, group, filter, sort],
  );
  if (strategies.error)
    return (
      <ErrorView
        error={strategies.error}
        retry={() => void strategies.refetch()}
      />
    );
  const collection = <VStack gap={4}>
    <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
      <HStack gap={2} vAlign="center"><Heading level={2}>{t("strategies")}</Heading><Text type="supporting">{rows.length}</Text></HStack>
      <Choices label={t("view")} value={view} options={views.map(([value, Icon]) => ({ value,
        label: viewLabels[value][lang === "zh" ? 0 : 1], icon: <Icon size={16} />,
      }))} select={name => { setView(name); localStorage.setItem("qb.strategyView", name); }} size="sm" />
    </HStack>
    <HStack gap={3} wrap="wrap" vAlign="center">
      <Choices label={t("status")} value={filter} options={(["all", "online", "offline"] as const).map(value => ({ value, label: t(value) }))} select={setFilter} />
      {!!groups.length && <Selector label={t("group")} isLabelHidden value={group} onChange={setGroup}
        options={[{ value: "", label: t("all") }, ...groups.map(value => ({ value, label: value }))]} />}
      <TextInput label={t("search")} placeholder={t("search")} isLabelHidden hasClear type="search" startIcon="search" value={search} onChange={setSearch} containerClassName="flex-1" />
      <Selector label={t("sort")} isLabelHidden value={sort} onChange={setSort}
        options={[{ value: "name", label: t("name") }, { value: "lastSeen", label: t("lastSeen") }]} />
    </HStack>
    {strategies.isPending ? <Loading /> : !rows.length ? <EmptyStrategies /> : !selected.length ?
      <EmptyState isCompact headingLevel={2} title={t("noMatchingStrategies")} description={t("noMatchingStrategiesHint")}
        actions={<Button label={t("clearFilters")} onClick={() => { setFilter("all"); setGroup(""); setSearch(""); }} />} /> :
      view === "list" ? <StrategyTable strategies={selected.slice(0, limit)} /> :
      <Grid columns={{ minWidth: view === "mini" ? 160 : view === "large" ? 360 : 280, repeat: "fit" }} gap={4}>
        {selected.slice(0, limit).map(strategy => <StrategyCard key={strategy.id} strategy={strategy} view={view} />)}
      </Grid>}
    {selected.length > limit && <Button label="+50" icon={<ChevronDown size={16} />} onClick={() => setLimit(limit + 50)} />}
  </VStack>;
  return <Page title={directory ? t("strategies") : t("overview")} actions={!directory && featured &&
    <PortfolioPicker strategies={rows} selected={featured} select={setFeaturedId} />}>
    {!directory && <>
      <Grid columns={{ minWidth: 150, repeat: "fit" }} gap={4}>
        {[[t("online"), rows.filter(row => row.online).length], [t("offline"), rows.filter(row => !row.online).length],
          [t("abnormal"), attention.issues.filter(row => row.online).length], [t("confirmation"), attention.waitingCount]].map(([label, value]) =>
          <Card key={label} padding={4}><VStack gap={2}><Text type="supporting">{label}</Text>
            <Text type="large" className="text-2xl leading-tight" weight="semibold" hasTabularNumbers>{strategies.isPending ? "—" : value}</Text></VStack></Card>)}
      </Grid>
      {featured && <Card padding={5}><PortfolioSnapshot key={featured.id} strategyId={featured.id} /></Card>}
      <AttentionSummary attention={attention} />
    </>}
    {collection}
    {!directory && !!featured && <Suspense fallback={<Loading />}><WidgetBoard /></Suspense>}
  </Page>;
}

function EmptyStrategies() {
  const { t } = useLanguage();
  return <EmptyState headingLevel={2} title={t("empty")} description={t("emptyDescription")}
    icon={<LayoutGrid size={24} />} actions={<Link className="button primary" to="/admin/strategies">{t("create")}</Link>} />;
}

function PortfolioPicker({ strategies, selected, select }: {
  strategies: Strategy[];
  selected: Strategy;
  select: (strategyId: string) => void;
}) {
  const { t } = useLanguage();
  return <HStack gap={2} vAlign="center">
    <Selector label={t("strategy")} isLabelHidden value={selected.id} onChange={select}
      options={strategies.map(strategy => ({ value: strategy.id, label: strategy.name }))} />
    <Button href={"/strategies/" + selected.id} label={t("details")} variant="ghost" icon={<ArrowUpRight size={16} />} />
  </HStack>;
}

function PortfolioSnapshot({ strategyId }: { strategyId: string }) {
  const { t } = useLanguage();
  const { equity, performance } = useTelemetryValues(strategyId);
  const currency = typeof equity?.data.currency === "string" ? equity.data.currency : "";
  const pnl = performance?.data.dailyPnl;
  const sameAccount = !!equity && performance?.data.accountId === equity.data.accountId &&
    performance?.data.currency === equity.data.currency;
  return (
    <>
      <VStack gap={2}>
        <Text type="supporting">{t("equity")}</Text>
        <HStack gap={2} vAlign="center"><Text type="large" className="text-2xl leading-tight" weight="semibold" hasTabularNumbers>{decimalText(equity?.data.value)}</Text><Text type="supporting">{currency}</Text></HStack>
        {sameAccount && typeof pnl === "string" && (
          <Text className={pnl.startsWith("-") ? "danger" : "success"}>
            {t("dailyPnl")} {decimalText(pnl)}
          </Text>
        )}
      </VStack>
      {equity && (
        <History strategyId={strategyId} embedded featured seriesKind="equity"
          seriesKey={JSON.stringify([equity.data.accountId, currency])}
          instanceId={equity.instanceId} />
      )}
    </>
  );
}
const StrategyCard = memo(function StrategyCard({ strategy, view }: { strategy: Strategy; view: View }) {
  const { t } = useLanguage();
  const values = useTelemetryValues(strategy.id);
  const error = values.records.some(r => r.kind === "status" && r.data.state === "error");
  const state = error ? "abnormal" : strategy.online ? "online" : "offline";
  return <Card padding={view === "mini" ? 3 : 5}>
    <VStack gap={view === "mini" ? 3 : 4} height="100%">
      <HStack hAlign="between" vAlign="start" gap={2}>
        <VStack gap={2} className="min-w-0"><Link to={"/strategies/" + strategy.id}><Heading level={3} maxLines={1}>{strategy.name}</Heading></Link>
          {view !== "mini" && <HStack gap={2} wrap="wrap">{strategy.group && <Badge>{strategy.group}</Badge>}<Badge tone={strategy.mode === "live" ? "warning" : ""}>{t(strategy.mode)}</Badge></HStack>}
        </VStack>
        <StatusDot variant={error ? "error" : strategy.online ? "success" : "neutral"} label={t(state)} tooltip={t(state)} />
      </HStack>
      <Grid columns={view === "mini" ? 1 : 2} gap={3}>
        <VStack gap={1}><Text type="supporting">{t("equity")}</Text><Text type="large" className="text-2xl leading-tight" weight="semibold" hasTabularNumbers>{values.query.error ? t("unavailable") : decimalText(values.equity?.data.value)}</Text><Text type="supporting">{String(values.equity?.data.currency ?? "—")}</Text></VStack>
        {view !== "mini" && <VStack gap={1}><Text type="supporting">{t("dailyPnl")}</Text><Text type="large" className="text-2xl leading-tight" hasTabularNumbers>{decimalText(values.performance?.data.dailyPnl)}</Text><Text type="supporting">{String(values.performance?.data.currency ?? "—")}</Text></VStack>}
      </Grid>
      {view === "large" && <History strategyId={strategy.id} embedded seriesKind="equity" />}
      <HStack hAlign="between" vAlign="center" gap={2} className="mt-auto border-t border-default pt-3">
        <Text type="supporting">{t(state)}</Text>
        <Button href={"/strategies/" + strategy.id} label={view === "mini" ? t("details") : t("controls")} size="sm" variant="ghost" icon={<SlidersHorizontal size={16} />} />
      </HStack>
    </VStack>
  </Card>;
});
