import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, Save, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { ProgramConnection } from "@/components/ProgramConnection";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/WorkspaceContext";
import { api as controlApi } from "@/lib/api";
import { tr } from "@/lib/i18n";

export function WorkspaceProgram() {
  const qc = useQueryClient();
  const { active, api, key: workspaceKey } = useWorkspace();
  const key = workspaceKey("program");
  const status = useQuery({ queryKey: key, queryFn: api.workspaceProgram, enabled: active, refetchInterval: 2_000, refetchIntervalInBackground: true, retry: false });
  const strategies = useQuery({ queryKey: ["overview"], queryFn: controlApi.overview, enabled: active });
  const [draft, setDraft] = useState<string>();
  const [strategyId, setStrategyId] = useState<string>();
  const [confirmStop, setConfirmStop] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const followLog = useRef(true);
  const logs = status.data?.logs;
  useEffect(() => {
    if (log.current && followLog.current) log.current.scrollTop = log.current.scrollHeight;
  }, [logs]);
  const change = useMutation({
    mutationFn: ({ action, command }: { action: "configure" | "start" | "stop"; command?: string }) =>
      api.changeWorkspaceProgram(action, command),
    onSuccess: (data, { action }) => {
      qc.setQueryData(key, data);
      if (action === "configure") setDraft(undefined);
      if (action === "stop") setConfirmStop(false);
    },
  });
  const bind = useMutation({
    mutationFn: (action: "bind" | "rotate" | "unbind") => api.bindWorkspaceStrategy(action, strategyId),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setStrategyId(undefined);
    },
  });
  return (
    <Card className="min-w-0">
      <CardHeader><CardTitle>{tr("后台程序")}</CardTitle></CardHeader>
      <CardContent>
        <QueryBoundary query={status.data ? { ...status, error: null } : status}>
          {(data) => {
            const command = draft ?? data.command;
            const changed = command.trim() !== data.command;
            return (
              <div className="grid gap-4">
                <form className="grid gap-3" onSubmit={(event) => {
                  event.preventDefault();
                  if (changed && command.trim()) change.mutate({ action: "configure", command });
                }}>
                  <Field label={tr("启动命令")} htmlFor="workspace-command"
                    hint={tr("在工作区目录运行。关闭浏览器后，后台程序会继续运行。")}>
                    <div className="flex flex-wrap gap-2">
                      <Input className="min-w-0 flex-1 font-mono" id="workspace-command" value={command}
                        placeholder="uv run python main.py" maxLength={4096}
                        disabled={data.running || change.isPending} onChange={(event) => setDraft(event.target.value)} />
                      <Button type="submit" variant="outline" disabled={data.running || !changed || !command.trim()}
                        loading={change.isPending && change.variables.action === "configure"}>
                        <Save /> {tr("保存命令")}
                      </Button>
                    </div>
                  </Field>
                </form>
                <Field label={tr("连接 QuantBot 策略")} htmlFor="workspace-strategy"
                  hint={tr("工作区程序启动时会收到独立的连接令牌。轮换后需重新启动程序。")}>
                  <div className="flex flex-wrap gap-2">
                    <Select id="workspace-strategy" className="min-w-36 flex-1" value={strategyId ?? data.strategy_id}
                      disabled={data.running || bind.isPending} onChange={(event) => setStrategyId(event.target.value)}>
                      <option value="">{tr("请选择")}</option>
                      {data.strategy_id && !strategies.data?.strategies.some(({ id }) => id === data.strategy_id)
                        && <option value={data.strategy_id}>{data.strategy_id}</option>}
                      {strategies.data?.strategies.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                    </Select>
                    <Button size="sm" variant="outline" disabled={data.running || !strategyId || strategyId === data.strategy_id}
                      loading={bind.isPending && bind.variables === "bind"} onClick={() => bind.mutate("bind")}>
                      {tr("绑定策略")}
                    </Button>
                    {data.strategy_id && <>
                      <Button size="sm" variant="outline" disabled={bind.isPending || data.running}
                        onClick={() => bind.mutate("rotate")}>{tr("换发令牌")}</Button>
                      <Button size="sm" variant="ghost" disabled={bind.isPending}
                        onClick={() => bind.mutate("unbind")}>{tr("撤销绑定")}</Button>
                    </>}
                  </div>
                </Field>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={data.running ? "gain" : "neutral"}>{data.running ? tr("运行中") : tr("已停止")}</Badge>
                  </div>
                  {data.running ? (
                    <Button variant="outline" size="sm" disabled={change.isPending} onClick={() => { change.reset(); setConfirmStop(true); }}>
                      <Square /> {tr("停止程序")}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={!data.command || changed} loading={change.isPending}
                      onClick={() => change.mutate({ action: "start" })}><Play /> {tr("启动程序")}</Button>
                  )}
                </div>
                <ProgramConnection data={data} />
                {!confirmStop && change.error && <Alert tone="loss">{change.error.message}</Alert>}
                {bind.error && <Alert tone="loss">{bind.error.message}</Alert>}
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{tr("程序日志")}</h3>
                    <Button size="icon" variant="ghost" className="size-7" aria-label={tr("刷新程序日志")} title={tr("刷新程序日志")}
                      disabled={status.isFetching} onClick={() => void status.refetch()}><RefreshCw /></Button>
                  </div>
                  {(status.error || data.log_error) && <Alert tone="warning">{status.error?.message || data.log_error}</Alert>}
                  <pre ref={log} onScroll={(event) => {
                    const el = event.currentTarget;
                    followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                  }} className="max-h-60 min-h-16 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                    {data.logs || (!(status.error || data.log_error) && tr(data.running ? "等待程序输出…" : "暂无输出。"))}
                  </pre>
                </div>
                <ConfirmDialog open={confirmStop && data.running} onOpenChange={(open) => { if (!change.isPending) setConfirmStop(open); }}
                  title={tr("停止工作区程序？")} confirmLabel={tr("停止程序")} destructive loading={change.isPending}
                  description={data.strategy_id
                    ? tr("停止后，策略 {0} 将离线并暂停管理持仓。券商侧的持仓和订单仍需处理。点击「启动程序」可重新运行。", data.strategy_id)
                    : tr("工作区后台进程将终止。点击「启动程序」可重新运行。")}
                  onConfirm={() => change.mutate({ action: "stop" })}>
                  {change.error && <Alert tone="loss">{change.error.message}</Alert>}
                </ConfirmDialog>
              </div>
            );
          }}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
