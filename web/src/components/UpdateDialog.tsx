import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";

export function UpdateDialog({ onClose, onInstalled }: { onClose: () => void; onInstalled: (version: string) => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["update"], queryFn: api.updateStatus });
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["update"] });
  const check = useMutation({
    mutationFn: api.checkUpdate,
    onSuccess: (answer) => {
      setError(answer.ok ? "" : answer.message);
      refresh();
    },
    onError: (err) => setError(err.message),
  });
  const install = useMutation({
    mutationFn: api.installUpdate,
    onSuccess: (answer) => {
      setConfirm(false);
      if (answer.ok) {
        setMessage(answer.message);
        if (status.data) onInstalled(status.data.version);
      } else {
        setError(answer.message);
      }
      refresh();
    },
    onError: (err) => {
      setConfirm(false);
      setError(err.message);
    },
  });
  const busy = check.isPending || install.isPending;
  return (
    <>
      <Dialog open onOpenChange={() => { if (!busy) onClose(); }}>
        <DialogContent title="版本更新" className="max-w-lg">
          <QueryBoundary query={status}>
            {({ version, result, uv, updated }) => (
              <div className="grid gap-4">
                <dl className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <dt className="text-muted-foreground">当前版本</dt>
                  <dd className="font-mono">{version}</dd>
                </dl>
                {message || updated ? (
                  <Alert tone="info">{message || "已安装更新，等待 QuantBot 重启。"}</Alert>
                ) : (
                  <>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {result?.available
                            ? result.behind ? `${result.behind} 个新提交` : "有新版本"
                            : result && !result.error ? "已经是最新版本" : "检查更新"}
                        </span>
                        {result?.checked_at && <span className="text-xs text-muted-foreground">{dateTime(result.checked_at)}</span>}
                      </div>
                      {!!result?.commits.length && (
                        <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                          {result.commits.map((commit) => (
                            <li key={commit.sha || commit.message} className="flex gap-3 px-3 py-2 text-sm">
                              {commit.sha && <code className="shrink-0 text-xs text-muted-foreground">{commit.sha}</code>}
                              <span className="min-w-0 break-words">{commit.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {!uv && <Alert tone="warning">服务器找不到 uv。可以在服务器上重新运行安装命令来更新。</Alert>}
                    {!error && result?.error && <Alert tone="warning">{result.error}</Alert>}
                  </>
                )}
                {error && <Alert tone="loss">{error}</Alert>}
                <DialogFooter>
                  <Button variant="outline" disabled={busy || updated} loading={check.isPending}
                    onClick={() => { setError(""); check.mutate(); }}>
                    <RefreshCw /> 检查更新
                  </Button>
                  <Button disabled={busy || updated || !!message || !uv || !result?.available || !!result.error}
                    onClick={() => setConfirm(true)}>
                    <Download /> 一键更新
                  </Button>
                </DialogFooter>
              </div>
            )}
          </QueryBoundary>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={(open) => { if (!install.isPending) setConfirm(open); }}
        title="安装更新"
        description={status.data?.service
          ? "安装完成后，QuantBot 后台服务会重启，网页会自动重连。"
          : "安装完成后，请在服务器上停止 QuantBot，再运行 quantbot run。"}
        confirmLabel="确认更新" loading={install.isPending}
        onConfirm={() => { setError(""); install.mutate(); }} />
    </>
  );
}
