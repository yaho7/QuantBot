import { useQuery } from "@tanstack/react-query";
import { EmptyState, QueryBoundary } from "@/components/common";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import { api, type Notice } from "@/lib/api";
import { actionLabel, dateTime, NA } from "@/lib/format";
import { tr } from "@/lib/i18n";

const KIND_TONE = { info: "neutral", trade: "info", alert: "warning", error: "loss" } as const;
const KIND_LABEL = { info: tr("消息"), trade: tr("成交"), alert: tr("提醒"), error: tr("报错") };

export function Feed({ items }: { items: Notice[] }) {
  if (!items.length) return <EmptyState title={tr("还没有推送")} description={tr("QuantBot 这次启动后发出的消息会显示在这里。")} />;
  return (
    <ul className="divide-y">
      {items.map((n, i) => (
        <li key={`${n.time}-${i}`} className="flex gap-3 px-5 py-3">
          <span className="num w-28 shrink-0 text-xs text-muted-foreground">{dateTime(n.time)}</span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{n.strategy}</span>
              <Badge tone={KIND_TONE[n.kind] ?? "neutral"}>{KIND_LABEL[n.kind] ?? n.kind}</Badge>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{n.text}</p>
          </div>
        </li>
      ))}
    </ul>
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
