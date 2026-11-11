import { tr } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";

export function updateLabel(latest?: string | null) {
  return latest && /^[a-f\d]{40,64}$/i.test(latest) ? latest.slice(0, 7) : latest;
}

export function UpdateDialog({ onClose, onInstalled, checkOnOpen = false }: {
  onClose: () => void; onInstalled: (version: string) => void; checkOnOpen?: boolean;
}) {
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
  const checked = useRef(false);
  useEffect(() => {
    if (checkOnOpen && !checked.current) {
      checked.current = true;
      check.mutate();
    }
  }, [checkOnOpen, check.mutate]);
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
        <DialogContent title={tr("版本更新")} className="max-w-lg">
          <QueryBoundary query={status}>
            {({ version, result, uv, updated }) => (
              <div className="grid gap-4">
                <dl className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <dt className="text-muted-foreground">{tr("当前版本")}</dt>
                  <dd className="font-mono">{version}</dd>
                  {result?.available && result.latest && (
                    <>
                      <dt className="basis-1/2 text-muted-foreground">{tr("新版本")}</dt>
                      <dd className="font-mono">{updateLabel(result.latest)}</dd>
                    </>
                  )}
                </dl>
                {message || updated ? (
                  <Alert tone="info">{message || tr("已安装更新，等待 QuantBot 重启。")}</Alert>
                ) : (
                  <>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {result?.available
                            ? result.behind ? tr("{0} 个新提交", result.behind) : tr("有新版本")
                            : result && !result.error ? tr("已经是最新版本") : tr("检查更新")}
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
                    {!uv && <Alert tone="warning">{tr("服务器找不到 uv。可以在服务器上重新运行安装命令来更新。")}</Alert>}
                    {!error && result?.error && <Alert tone="warning">{result.error}</Alert>}
                  </>
                )}
                {error && <Alert tone="loss">{error}</Alert>}
                <DialogFooter>
                  <Button variant="outline" disabled={busy || updated} loading={check.isPending}
                    onClick={() => { setError(""); check.mutate(); }}>
                    <RefreshCw /> {tr("检查更新")}</Button>
                  <Button disabled={busy || updated || !!message || !uv || !result?.available || !!result.error}
                    onClick={() => setConfirm(true)}>
                    <Download /> {tr("一键更新")}</Button>
                </DialogFooter>
              </div>
            )}
          </QueryBoundary>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={(open) => { if (!install.isPending) setConfirm(open); }}
        title={tr("安装更新")}
        description={status.data?.service
          ? tr("安装完成后，QuantBot 后台服务会重启，网页会自动重连。")
          : tr("安装完成后，请在服务器上停止 QuantBot，再运行 quantbot run。")}
        confirmLabel={tr("确认更新")} loading={install.isPending}
        onConfirm={() => { setError(""); install.mutate(); }} />
    </>
  );
}
