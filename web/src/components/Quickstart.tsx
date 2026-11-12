import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common";
import { WorkspaceSetup } from "@/components/WorkspaceSetup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Alert, Card } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { tr } from "@/lib/i18n";

export function Quickstart({ visible, requested, onStarted }: {
  visible: boolean;
  requested: boolean;
  onStarted: (project: string) => void;
}) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState(false);
  const prompted = useRef(false);
  const launch = useMutation({
    mutationFn: api.quickstart,
    onSuccess: async (result) => {
      if ("needs_setup" in result) {
        setSetup(true);
        return;
      }
      setSetup(false);
      onStarted(result.project);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
      ]);
    },
  });
  useEffect(() => {
    if (!requested || prompted.current) return;
    prompted.current = true;
    const url = new URL(location.href);
    url.searchParams.delete("quickstart");
    history.replaceState(null, "", url);
    launch.mutate(undefined);
  }, [requested, launch]);

  return (
    <>
      {visible && <Card>
        <EmptyState title={tr("还没有策略")} description={tr("启动模拟策略，试用网页和 Telegram 控制。")} />
        <div className="flex justify-center px-4 pb-5">
          <Button loading={launch.isPending} onClick={() => launch.mutate(undefined)}>
            <Play /> {tr("快速入手")}
          </Button>
        </div>
      </Card>}
      {launch.error && !setup && <Alert tone="loss" className="justify-between">
        {launch.error.message}
        <Button variant="outline" size="sm" onClick={() => setSetup(true)}>{tr("选择其他工作区")}</Button>
      </Alert>}
      <Dialog open={setup} onOpenChange={(open) => { if (!launch.isPending) setSetup(open); }}>
        <DialogContent title={tr("快速入手")} description={tr("选择工作区后，QuantBot 会写入模板并启动模拟策略。")}>
          <WorkspaceSetup onDone={(project) => { if (!launch.isPending) launch.mutate(project); }} />
          {launch.isPending && <p className="text-sm">{tr("正在启动模拟策略…")}</p>}
          {launch.error && <Alert tone="loss">{launch.error.message}</Alert>}
          <Button variant="outline" size="sm" asChild className="w-fit">
            <a href="/ui/api/quickstart/file" download><Download /> {tr("下载 Python 模板")}</a>
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
