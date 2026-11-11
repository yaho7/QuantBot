import { useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, ScrollText } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";

export function ServiceDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [showLogs, setShowLogs] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const status = useQuery({
    queryKey: ["service", "status"], queryFn: () => api.service("status"), retry: false,
  });
  const logs = useQuery({
    queryKey: ["service", "logs"], queryFn: () => api.service("logs"),
    enabled: showLogs && !!status.data?.installed, refetchInterval: 5000, retry: false,
  });
  const restart = useMutation({
    mutationFn: api.restartService,
    onSuccess: (answer) => {
      if (!answer.ok) return setError(answer.message);
      toast.success(answer.message);
      onClose();
    },
    onError: (err) => setError(err.message),
    onSettled: () => setConfirm(false),
  });

  return (
    <>
      <Dialog open onOpenChange={() => { if (!restart.isPending) onClose(); }}>
        <DialogContent title="后台服务" className={showLogs ? "max-w-3xl" : "max-w-lg"}>
          <QueryBoundary query={status} rows={2}>
            {({ installed, text }) => installed ? (
              <>
                {text && <pre className="max-h-44 overflow-auto rounded-lg border bg-card p-3 font-mono text-xs">{text}</pre>}
                {showLogs && (
                  <QueryBoundary query={logs} rows={3}>
                    {({ text }) => (
                      <pre aria-label="最近日志" className="max-h-[42vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed">
                        {text || "暂无日志。"}
                      </pre>
                    )}
                  </QueryBoundary>
                )}
                <DialogFooter>
                  <Button variant="ghost" size="sm" loading={status.isFetching && !status.isLoading}
                    onClick={() => void status.refetch()}><RefreshCw /> 刷新状态</Button>
                  <Button variant="outline" size="sm" onClick={() => setShowLogs(!showLogs)}>
                    <ScrollText /> {showLogs ? "隐藏日志" : "最近日志"}
                  </Button>
                  <Button size="sm" onClick={() => { setError(""); setConfirm(true); }}>
                    <RotateCcw /> 重启
                  </Button>
                </DialogFooter>
              </>
            ) : <Alert tone="info">当前未安装后台服务。可以在服务器上运行 quantbot service install。</Alert>}
          </QueryBoundary>
          {error && <Alert tone="loss">{error}</Alert>}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={(open) => { if (!restart.isPending) setConfirm(open); }}
        title="重启后台服务" description="QuantBot 会短暂断开，网页会自动重连。"
        confirmLabel="确认重启" loading={restart.isPending} onConfirm={() => restart.mutate()} />
    </>
  );
}
