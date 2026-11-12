import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Select } from "@/components/ui/primitives";
import { api, type Operation } from "@/lib/api";
import { tr } from "@/lib/i18n";

const states: Record<Operation["state"], string> = {
  CREATED: "已创建", ACCEPTED: "已投递", EXECUTING: "执行中",
  SUCCEEDED: "已完成", FAILED: "失败", UNKNOWN: "结果未知",
};

const names: Record<string, string> = {
  resume: "恢复开仓", cancel: "撤单", flatten: "平仓",
  manual_order: "手动下单", set_param: "改参数", stop: "停止程序",
};

function Reconcile({ sid, operation }: { sid: string; operation: Operation }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api.reconcile(sid, operation.id, outcome === "applied", note),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["operations", sid] }),
  });
  return (
    <form className="grid gap-2 border-t pt-2" onSubmit={(event) => {
      event.preventDefault();
      if (outcome && note.trim()) save.mutate();
    }}>
      <p className="text-muted-foreground">{tr("确认策略已结束此操作，并在券商端核对结果后再填写。")}</p>
      <Select aria-label={tr("核对结果")} value={outcome} required
        onChange={(event) => setOutcome(event.target.value)}>
        <option value="">{tr("选择核对结果")}</option>
        <option value="applied">{tr("已生效")}</option>
        <option value="rejected">{tr("未生效")}</option>
      </Select>
      <Input aria-label={tr("核对说明")} placeholder={tr("券商订单号或核对说明")} required
        maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      {save.error && <Alert tone="loss">{save.error.message}</Alert>}
      <Button size="sm" variant="outline" type="submit" loading={save.isPending}
        disabled={!outcome || !note.trim()}>{tr("保存核对结果")}</Button>
    </form>
  );
}

export function StrategyOperations({ sid }: { sid: string }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["operations", sid],
    queryFn: () => api.operations(sid),
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  return (
    <details className="rounded-lg border p-3 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">{tr("操作记录")}</summary>
      {history.isPending && <p className="mt-2 text-muted-foreground">{tr("加载中…")}</p>}
      {history.error && <Alert tone="loss">{history.error.message}</Alert>}
      {history.data?.operations.length === 0 && <p className="mt-2 text-muted-foreground">{tr("暂无操作记录")}</p>}
      <ol className="mt-2 max-h-96 divide-y overflow-auto">
        {history.data?.operations.map((operation) => (
          <li key={operation.id} className="grid gap-1 py-2">
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{tr(names[operation.name] ?? operation.name)} · {tr(states[operation.state])}</strong>
              <time className="text-muted-foreground">{new Date(operation.updated * 1000).toLocaleString()}</time>
            </div>
            <code className="break-all text-xs">{operation.id}</code>
            {Object.keys(operation.args).length > 0 && (
              <code className="break-all text-xs">{JSON.stringify(operation.args)}</code>
            )}
            {operation.result?.message && <p className="break-words">{operation.result.message}</p>}
            {operation.state === "UNKNOWN" && <Reconcile sid={sid} operation={operation} />}
          </li>
        ))}
      </ol>
    </details>
  );
}
