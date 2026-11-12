import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Save, Square } from "lucide-react";
import { useState } from "react";
import { QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/WorkspaceContext";
import { api as controlApi } from "@/lib/api";
import { tr } from "@/lib/i18n";

export function WorkspaceProgram() {
  const qc = useQueryClient();
  const { active, api, key: workspaceKey } = useWorkspace();
  const key = workspaceKey("program");
  const status = useQuery({ queryKey: key, queryFn: api.workspaceProgram, enabled: active, refetchInterval: active ? 2_000 : false });
  const strategies = useQuery({ queryKey: ["overview"], queryFn: controlApi.overview, enabled: active });
  const [draft, setDraft] = useState<string>();
  const [strategyId, setStrategyId] = useState<string>();
  const change = useMutation({
    mutationFn: ({ action, command }: { action: "configure" | "start" | "stop"; command?: string }) =>
      api.changeWorkspaceProgram(action, command),
    onSuccess: (data, { action }) => {
      qc.setQueryData(key, data);
      if (action === "configure") setDraft(undefined);
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
        <QueryBoundary query={status}>
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
                    {!data.running && data.exit_code !== null && <code className="text-xs text-muted-foreground">{tr("退出码 {0}", data.exit_code)}</code>}
                  </div>
                  {data.running ? (
                    <Button variant="outline" size="sm" loading={change.isPending} onClick={() => change.mutate({ action: "stop" })}>
                      <Square /> {tr("停止程序")}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={!data.command || changed} loading={change.isPending}
                      onClick={() => change.mutate({ action: "start" })}><Play /> {tr("启动程序")}</Button>
                  )}
                </div>
                {change.error && <Alert tone="loss">{change.error.message}</Alert>}
                {bind.error && <Alert tone="loss">{bind.error.message}</Alert>}
                <div className="grid gap-2">
                  <h3 className="text-sm font-medium">{tr("程序日志")}</h3>
                  <pre className="max-h-60 min-h-16 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                    {data.logs || tr("暂无输出。")}
                  </pre>
                </div>
              </div>
            );
          }}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
