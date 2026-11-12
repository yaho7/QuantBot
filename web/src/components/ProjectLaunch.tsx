import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QueryBoundary } from "@/components/common";
import { ProgramConnection } from "@/components/ProgramConnection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { api, workspaceApi } from "@/lib/api";
import { tr } from "@/lib/i18n";

export function ProjectLaunch({ project, onDone }: { project: string; onDone: () => void }) {
  const scoped = workspaceApi(project);
  const qc = useQueryClient();
  const key = ["workbench", project, "program"];
  const status = useQuery({ queryKey: key, queryFn: scoped.workspaceProgram, refetchInterval: 2_000, retry: false });
  const inspection = useQuery({ queryKey: ["workbench", project, "preflight"], queryFn: scoped.projectPreflight, retry: false });
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const [draft, setDraft] = useState<string>();
  const [binding, setBinding] = useState<string>();
  const [mode, setMode] = useState("auto");
  const template = useMutation({ mutationFn: scoped.projectTemplate, onSuccess: () => {
    void inspection.refetch();
    void qc.invalidateQueries({ queryKey: ["workbench", project, "tree"] });
  } });
  const setup = useMutation({
    mutationFn: ({ command, id, start }: { command: string; id: string; start: boolean }) => scoped.setupProjectProgram(command, id, start),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setBinding(undefined);
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: () => { void status.refetch(); },
  });
  const busy = setup.isPending || template.isPending;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent title={tr("配置项目")} className="max-w-xl">
        <QueryBoundary query={status.data ? { ...status, error: null } : status}>
          {(data) => {
            const id = binding ?? data.strategy_id;
            const detected = inspection.data;
            const suggested = detected?.recommendation ? detected.commands[detected.recommendation] : "";
            const command = draft ?? (data.command || suggested || "");
            const options = { python: "Python", uv: "uv", conda: "Conda" } as const;
            return <form className="grid gap-3" onSubmit={(event) => {
              event.preventDefault();
              if (!busy && !data.running && command.trim()) setup.mutate({ command, id, start: true });
            }}>
              {detected?.files.length ? <code className="text-xs text-muted-foreground">{detected.files.join(" · ")}</code> : null}
              {inspection.error && <Alert tone="warning">{inspection.error.message}</Alert>}
              {detected?.can_seed && <Button type="button" variant="outline" className="w-fit" disabled={data.running || busy}
                onClick={() => template.mutate()}>{tr("生成 Python 入口")}</Button>}
              <Field label={tr("Python 环境")} htmlFor="project-environment">
                <Select id="project-environment" value={mode} disabled={data.running || busy} onChange={(event) => {
                  const next = event.target.value;
                  setMode(next);
                  if (next === "auto") setDraft(suggested || "");
                  else if (next in options) setDraft(detected?.commands[next as keyof typeof options] ?? "");
                }}>
                  <option value="auto">{tr("自动识别")}</option>
                  {Object.entries(options).filter(([key]) => !!detected?.commands[key as keyof typeof options]).map(([key, label]) =>
                    <option key={key} value={key}>{label}</option>)}
                  <option value="custom">{tr("自定义启动命令")}</option>
                </Select>
              </Field>
              <Field label={tr("启动命令")} htmlFor="project-command"
                hint={tr("请检查命令和依赖。点击「保存并启动」后，程序将立即运行。")}>
                <Input id="project-command" value={command} className="font-mono" placeholder="uv run spcx.py" maxLength={4096}
                  disabled={data.running || busy} onChange={(event) => { setDraft(event.target.value); setMode("custom"); }} />
              </Field>
              <Field label={tr("连接 QuantBot 策略")} htmlFor="project-strategy">
                <Select id="project-strategy" value={id} disabled={data.running || busy} onChange={(event) => setBinding(event.target.value)}>
                  <option value="">{data.strategy_id ? tr("保留当前绑定") : tr("自动注册新策略")}</option>
                  {data.strategy_id && !overview.data?.strategies.some(({ id }) => id === data.strategy_id) &&
                    <option value={data.strategy_id}>{data.strategy_id}</option>}
                  {overview.data?.strategies.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                </Select>
              </Field>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer">{tr("在 Python 代码中接入 QuantBot")}</summary>
                <pre className="my-2 overflow-auto rounded-md bg-muted p-2 text-xs">{"from quantbot_client import QuantBot\nqb = QuantBot().start()\n# In the strategy loop:\nqb.process()"}</pre>
                <p>{tr("运行时会提供 SDK 和独立凭据。已有 QuantBot 接入的代码可直接使用。")}</p>
              </details>
              {(setup.isSuccess || data.running || data.exit_code !== null) && <ProgramConnection data={data} />}
              {setup.isSuccess && !setup.variables.start && <Alert tone="info">{tr("已保存启动命令和策略绑定。")}</Alert>}
              {(template.error || setup.error || status.error) && <Alert tone="loss">{(template.error || setup.error || status.error)?.message}</Alert>}
              <DialogFooter>
                <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>{tr("打开工作区")}</Button>
                {!data.running && <>
                  <Button type="button" variant="outline" disabled={!command.trim() || busy}
                    onClick={() => setup.mutate({ command, id, start: false })}>{tr("保存配置")}</Button>
                  <Button type="submit" disabled={!command.trim() || busy} loading={setup.isPending && setup.variables.start}>
                    {tr("保存并启动")}</Button>
                </>}
              </DialogFooter>
            </form>;
          }}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
