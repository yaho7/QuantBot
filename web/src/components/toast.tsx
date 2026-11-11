import { CheckCircle2, X, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface Toast {
  id: number;
  tone: "success" | "error";
  message: string;
}

const ToastContext = React.createContext<{
  success: (m: string) => void;
  error: (m: unknown) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const push = React.useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);
  const value = React.useMemo(
    () => ({
      success: (m: string) => push("success", m),
      error: (m: unknown) => push("error", m instanceof Error ? m.message : String(m)),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-start gap-2 rounded-lg border bg-card p-3 text-sm shadow-lg",
              item.tone === "error" && "border-loss/40",
            )}
          >
            {item.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-gain" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-loss" />
            )}
            <span className="flex-1 break-words">{item.message}</span>
            <button
              aria-label="关闭"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== item.id))}
            >
              <X className="size-4 opacity-60" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
