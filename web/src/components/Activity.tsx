import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Field, Select, Table, Td, Th } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { actionLabel, dateTime, NA } from "@/lib/format";
import { tr } from "@/lib/i18n";

const KIND_TONE = { info: "neutral", trade: "info", alert: "warning", error: "loss" } as const;
const KIND_LABEL = { info: tr("消息"), trade: tr("成交"), alert: tr("提醒"), error: tr("报错") };

const pageSize = 50;

export function Feed() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState(() => {
    const params = new URLSearchParams(location.search);
    return { strategy: "", kind: params.get("kind") === "critical" ? "critical" : "", days: "30", unread: params.get("unread") === "1", offset: 0 };
  });
  const notices = useQuery({ queryKey: ["notices", filters], queryFn: () => api.notices(filters), refetchInterval: 5_000, retry: false });
  const mark = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => api.markNotice(id, read),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notices"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  function filter(update: Partial<typeof filters>) { setFilters({ ...filters, ...update, offset: 0 }); }
  return (
    <div>
      <div className="grid gap-3 border-b p-4 sm:grid-cols-4">
        <Field label={tr("策略")} htmlFor="notice-strategy">
          <Select id="notice-strategy" value={filters.strategy} onChange={(event) => filter({ strategy: event.target.value })}>
            <option value="">{tr("所有策略")}</option>
            {notices.data?.strategies.map((name) => <option value={name} key={name}>{name}</option>)}
          </Select>
        </Field>
        <Field label={tr("推送类型")} htmlFor="notice-kind">
          <Select id="notice-kind" value={filters.kind} onChange={(event) => filter({ kind: event.target.value })}>
            <option value="">{tr("所有类型")}</option>
            <option value="critical">{tr("提醒与报错")}</option>
            {Object.entries(KIND_LABEL).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
          </Select>
        </Field>
        <Field label={tr("时间")} htmlFor="notice-days">
          <Select id="notice-days" value={filters.days} onChange={(event) => filter({ days: event.target.value })}>
            {[1, 7, 30].map((days) => <option value={days} key={days}>{tr("最近 {0} 天", days)}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 self-end py-2 text-sm">
          <input type="checkbox" checked={filters.unread} onChange={(event) => filter({ unread: event.target.checked })} />
          {tr("只看未读")}
        </label>
      </div>
      {mark.error && <Alert tone="loss" className="m-4">{mark.error.message}</Alert>}
      <QueryBoundary query={notices}>
        {({ items, has_more }) => <>
          {!items.length ? (
            <EmptyState title={tr("没有符合条件的推送")} description={tr("推送保留最近 30 天。可以调整筛选条件。")} />
          ) : (
            <ul className="divide-y">
              {items.map((n) => (
                <li key={n.id} className="flex flex-wrap gap-3 px-5 py-3 sm:flex-nowrap">
                  <span className="num w-28 shrink-0 text-xs text-muted-foreground">{dateTime(n.time)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{n.strategy}</span>
                      <Badge tone={KIND_TONE[n.kind] ?? "neutral"}>{KIND_LABEL[n.kind] ?? n.kind}</Badge>
                      {!n.read && <Badge tone="info">{tr("未读")}</Badge>}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">{n.text}</p>
                  </div>
                  <Button variant="ghost" size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ id: n.id, read: !n.read })}>
                    {n.read ? tr("标为未读") : tr("标为已读")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {(filters.offset > 0 || has_more) && <div className="flex justify-between gap-2 border-t p-3">
            <Button size="sm" variant="outline" disabled={filters.offset === 0}
              onClick={() => setFilters({ ...filters, offset: filters.offset - pageSize })}>{tr("上一页")}</Button>
            <Button size="sm" variant="outline" disabled={!has_more}
              onClick={() => setFilters({ ...filters, offset: filters.offset + pageSize })}>{tr("下一页")}</Button>
          </div>}
        </>}
      </QueryBoundary>
    </div>
  );
}

export function AuditLog() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit, refetchInterval: 15_000 });
  return (
    <QueryBoundary query={audit}>
      {({ records }) =>
        records.length === 0 ? (
          <EmptyState title={tr("还没有操作记录")} description={tr("在网页或 Telegram 里点过的按钮会记在这里。")} />
        ) : (
          <Table>
            <thead>
              <tr><Th>{tr("时间")}</Th><Th>{tr("操作")}</Th><Th>{tr("策略")}</Th><Th>{tr("从哪")}</Th><Th>{tr("结果")}</Th></tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.time}-${i}`}>
                  <Td className="num text-xs text-muted-foreground">{dateTime(r.time)}</Td>
                  <Td>{actionLabel(r.action)}</Td>
                  <Td className="font-mono text-xs">{r.strategy ?? r.strategies?.join(", ") ?? NA}</Td>
                  <Td className="text-xs">{r.user === "web" ? tr("网页") : r.user === "cli" ? tr("终端") : r.user ? "Telegram" : NA}</Td>
                  <Td className="max-w-md whitespace-normal text-xs">
                    {r.ok === false && <Badge tone="loss" className="mr-2">{tr("失败")}</Badge>}
                    {r.result ?? NA}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      }
    </QueryBoundary>
  );
}
