import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-transparent bg-card text-card-foreground", className)}
      {...p}
    />
  );
}

export function CardHeader({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between gap-3 p-5 pb-2", className)} {...p} />;
}

export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[15px] font-semibold tracking-tight", className)} {...p} />;
}

export function CardDescription({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...p} />;
}

export function CardContent({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-2", className)} {...p} />;
}

export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground disabled:opacity-50",
        className,
      )}
      {...p}
    />
  );
}

export function Textarea({ className, ...p }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:opacity-50",
        className,
      )}
      {...p}
    />
  );
}

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-50",
        className,
      )}
      {...p}
    />
  );
}

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-medium text-muted-foreground", className)} {...p} />;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...p} />;
}

const badgeTones = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/12 text-primary",
  gain: "bg-gain/12 text-gain",
  loss: "bg-loss/12 text-loss",
  warning: "bg-warning/15 text-warning",
} as const;

export function Badge({
  tone = "neutral",
  className,
  ...p
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium [&_svg]:size-3",
        badgeTones[tone],
        className,
      )}
      {...p}
    />
  );
}

export function Table({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...p} />
    </div>
  );
}

export function Th({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "h-9 whitespace-nowrap border-b px-3 text-left align-middle text-xs font-medium text-muted-foreground",
        className,
      )}
      {...p}
    />
  );
}

export function Td({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("whitespace-nowrap border-b px-3 py-2 align-middle", className)} {...p} />;
}

export function Alert({
  tone = "info",
  className,
  ...p
}: React.HTMLAttributes<HTMLDivElement> & { tone?: "info" | "warning" | "loss" }) {
  const tones = {
    info: "border-primary/30 bg-primary/5",
    warning: "border-warning/40 bg-warning/10",
    loss: "border-loss/40 bg-loss/10",
  };
  return (
    <div
      role={tone === "loss" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-lg border p-3 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0", tones[tone], className)}
      {...p}
    />
  );
}
