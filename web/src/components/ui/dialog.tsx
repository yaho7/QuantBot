import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  ...p
}: React.ComponentProps<typeof D.Content> & { title: string; description?: React.ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/50" />
      <D.Content
        className={cn(
          "dialog-panel fixed left-1/2 top-1/2 z-50 grid max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border bg-background p-6 shadow-lg",
          className,
        )}
        {...p}
      >
        <div className="grid gap-1 pr-6">
          <D.Title className="text-base font-semibold">{title}</D.Title>
          {description ? (
            <D.Description className="text-sm text-muted-foreground">{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{title}</D.Description>
          )}
        </div>
        {children}
        <D.Close
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
          aria-label="关闭"
        >
          <X className="size-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...p} />;
}
