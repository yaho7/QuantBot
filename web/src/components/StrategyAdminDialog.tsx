import { tr } from "@/lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input, Textarea } from "@/components/ui/primitives";
import { api, type StrategyConfigAction } from "@/lib/api";
import { copyText } from "@/lib/utils";

type Strategy = { id: string; name: string };
type ConfirmAction = "remove" | "rotate";

export function StrategyAdminDialog({ strategy, onClose }: { strategy?: Strategy; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [active, setActive] = useState(strategy);
  const [id, setId] = useState(strategy?.id ?? "");
  const [name, setName] = useState(strategy?.name ?? "");
  const [credentials, setCredentials] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmAction>();
  const field = useRef<HTMLTextAreaElement>(null);
  const config = useMutation({
    mutationFn: (action: StrategyConfigAction) =>
      api.strategyConfig(action, id.trim(), action === "rename" || action === "add" ? name.trim() : undefined),
    gcTime: 0,
    onSuccess: (answer, action) => {
      if (!answer.ok) return setError(answer.message);
      if (action !== "credentials") {
        toast.success(answer.message);
        void qc.invalidateQueries({ queryKey: ["overview"] });
      }
      if (action === "remove") {
        onClose();
        return;
      }
      const { id, name, url, token } = answer.data;
      setActive({ id, name });
      setId(id);
      setName(name);
      if (token) setCredentials(`QB_URL=${url || location.origin}\nQB_TOKEN=${token}`);
    },
    onError: (err) => setError(err.message),
    onSettled: () => setConfirm(undefined),
  });
  const run = (action: StrategyConfigAction) => {
    setError("");
    config.mutate(action);
  };
  const valid = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id.trim());
  return (
    <>
      <Dialog open onOpenChange={() => { if (!config.isPending) onClose(); }}>
        <DialogContent title={active ? tr("管理策略") : tr("添加策略")} className="max-w-lg">
          <form className="grid gap-3" onSubmit={(event) => {
            event.preventDefault();
            run(active ? "rename" : "add");
          }}>
            <Field label={tr("策略 ID")} htmlFor="strategy-id" hint={active ? undefined : tr("例如 momentum。使用小写字母、数字、- 或 _。")}>
              <Input id="strategy-id" className="font-mono" value={id} readOnly={!!active} required maxLength={32}
                onChange={(event) => setId(event.target.value)} />
            </Field>
            <Field label={tr("显示名称")} htmlFor="strategy-name">
              <Input id="strategy-name" value={name} placeholder={id || tr("动量策略")} maxLength={64} required={!!active}
                onChange={(event) => setName(event.target.value)} />
            </Field>
            <DialogFooter>
              <Button type="submit" loading={config.isPending && ["rename", "add"].includes(config.variables ?? "")}
                disabled={config.isPending || !valid || (!!active && (!name.trim() || name.trim() === active.name))}>
                {active ? tr("保存名称") : tr("添加策略")}
              </Button>
            </DialogFooter>
          </form>
          {active && (
            <section className="grid gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{tr("策略连接")}</h3>
                {!credentials && (
                  <Button variant="outline" size="sm" disabled={config.isPending}
                    onClick={() => run("credentials")}><KeyRound /> {tr("查看连接信息")}</Button>
                )}
              </div>
              {credentials && (
                <>
                  <Textarea ref={field} aria-label={tr("策略连接信息")} className="font-mono text-xs" value={credentials}
                    readOnly rows={3} onFocus={(event) => event.currentTarget.select()} />
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={async () => {
                      if (await copyText(credentials, field.current)) toast.success(tr("已复制策略连接信息。"));
                      else toast.error(tr("请选中连接信息后手动复制。"));
                    }}><Copy /> {tr("复制连接信息")}</Button>
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" disabled={config.isPending} onClick={() => setConfirm("rotate")}>
                  <KeyRound /> {tr("换发令牌")}</Button>
                <Button variant="ghost" size="sm" className="text-loss" disabled={config.isPending} onClick={() => setConfirm("remove")}>
                  <Trash2 /> {tr("移除策略")}</Button>
              </div>
            </section>
          )}
          {error && <Alert tone="loss">{error}</Alert>}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!confirm} onOpenChange={(open) => { if (!open && !config.isPending) setConfirm(undefined); }}
        title={confirm === "remove" ? tr("移除策略") : tr("换发令牌")}
        description={confirm === "remove"
          ? tr("将从 QuantBot 移除 {0}，并撤销连接令牌。策略程序需要在服务器上单独管理。", active?.name)
          : tr("旧令牌会立即失效。{0} 需要用新令牌重新连接。", active?.name)}
        confirmLabel={confirm === "remove" ? tr("确认移除") : tr("确认换发")} destructive loading={config.isPending}
        onConfirm={() => { if (confirm) run(confirm); }} />
    </>
  );
}
