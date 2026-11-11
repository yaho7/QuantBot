import { tr } from "@/lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Link } from "lucide-react";
import { useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { copyText } from "@/lib/utils";

export function AccountDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(username || "admin");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const linkField = useRef<HTMLInputElement>(null);
  const change = useMutation({
    mutationFn: api.changePassword,
    onSuccess: (answer) => {
      if (!answer.ok) return setError(answer.message);
      setCurrent("");
      setPassword("");
      setConfirm("");
      setLink("");
      toast.success(answer.message);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err.message),
  });
  const generate = useMutation({
    mutationFn: api.webLink,
    onSuccess: (answer) => {
      if (!answer.ok) return setError(answer.message);
      setLink(new URL(answer.data.url, location.origin).href);
    },
    onError: (err) => setError(err.message),
  });

  return (
    <Dialog open onOpenChange={() => { if (!change.isPending) onClose(); }}>
      <DialogContent title={tr("网页管理员")} className="max-w-lg">
        <form className="grid gap-3" onSubmit={(event) => {
          event.preventDefault();
          setError("");
          if (password !== confirm) return setError(tr("两次输入的新密码不同。"));
          change.mutate({ username: name.trim(), current, password, confirm });
        }}>
          <Field label={tr("用户名")} htmlFor="admin-name">
            <Input id="admin-name" autoComplete="username" value={name} required maxLength={32}
              onChange={(e) => setName(e.target.value)} />
          </Field>
          {username && (
            <Field label={tr("当前密码")} htmlFor="admin-current">
              <Input id="admin-current" type="password" autoComplete="current-password" value={current} required
                onChange={(e) => setCurrent(e.target.value)} />
            </Field>
          )}
          <Field label={tr("新密码")} htmlFor="admin-password" hint={tr("至少 8 位。保存后，其他会话需要重新登录。")}>
            <Input id="admin-password" type="password" autoComplete="new-password" value={password} required minLength={8}
              onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={tr("确认新密码")} htmlFor="admin-confirm">
            <Input id="admin-confirm" type="password" autoComplete="new-password" value={confirm} required
              onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <DialogFooter><Button type="submit" loading={change.isPending}>{tr("保存管理员账号")}</Button></DialogFooter>
        </form>
        <section className="grid gap-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{tr("一次性登录链接")}</h3>
            <Button variant="outline" size="sm" loading={generate.isPending} disabled={change.isPending}
              onClick={() => { setError(""); generate.mutate(); }}>
              <Link /> {tr("生成链接")}</Button>
          </div>
          {link && (
            <>
              <div className="flex gap-2">
                <Input ref={linkField} aria-label={tr("一次性登录链接")} className="font-mono text-xs" readOnly value={link}
                  onFocus={(event) => event.currentTarget.select()} />
                <Button variant="outline" size="icon" aria-label={tr("复制链接")} onClick={async () => {
                  if (await copyText(link, linkField.current)) toast.success(tr("已复制登录链接。"));
                  else toast.error(tr("请选中链接后手动复制。"));
                }}><Copy /></Button>
              </div>
              <p className="text-xs text-muted-foreground">{tr("5 分钟内有效，可以登录一次。")}</p>
            </>
          )}
        </section>
        {error && <Alert tone="loss">{error}</Alert>}
      </DialogContent>
    </Dialog>
  );
}
