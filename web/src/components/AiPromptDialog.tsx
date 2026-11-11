import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import * as React from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Input, Skeleton, Textarea } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { copyText } from "@/lib/utils";

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The "copy for AI" message: project links and the exact way to connect, no token. */
export function AiPromptDialog({ open, onOpenChange, strategy }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  strategy?: { id: string; name: string };
}) {
  const toast = useToast();
  const area = React.useRef<HTMLTextAreaElement>(null);
  const [id, setId] = React.useState(strategy?.id ?? "");
  const [name, setName] = React.useState(strategy?.name ?? "");
  const query = useDebounced({ id: id.trim(), name: name.trim() });
  const valid = ID.test(query.id);
  const prompt = useQuery({
    queryKey: ["prompt", query.id, query.name],
    queryFn: () => api.prompt(query.id, query.name),
    enabled: open && valid,
    staleTime: Infinity,
  });
  const text = valid ? prompt.data?.text : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={strategy ? `复制给 AI：${strategy.name}` : "让 AI 帮你接入策略"} className="max-w-2xl"
        description="把这段话和你的策略代码一起交给 AI。里面有 QuantBot 的项目地址和具体接法，不含 token。">
        {!strategy && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="策略 id" htmlFor="ai-id" hint="小写字母、数字、- 和 _，例如 momentum">
              <Input id="ai-id" value={id} placeholder="momentum" autoFocus
                aria-invalid={id.length > 0 && !ID.test(id.trim())} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label="显示名" htmlFor="ai-name" hint="网页和 Telegram 上显示的名字">
              <Input id="ai-name" value={name} placeholder="动量策略" onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
        )}
        {!valid ? (
          <Alert tone="info">先填策略 id。</Alert>
        ) : prompt.error ? (
          <Alert tone="loss">{prompt.error.message}</Alert>
        ) : text === undefined ? (
          <Skeleton className="h-72" />
        ) : (
          <Textarea ref={area} readOnly value={text} rows={14}
            className="font-mono text-xs leading-relaxed" onFocus={(e) => e.currentTarget.select()} />
        )}
        <DialogFooter>
          <Button disabled={!text} onClick={async () => {
            if (!text) return;
            if (await copyText(text, area.current)) toast.success("已复制。贴给 AI，再附上你的策略代码。");
            else toast.error("浏览器不让自动复制，请在框里全选后手动复制。");
          }}>
            <Copy /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
