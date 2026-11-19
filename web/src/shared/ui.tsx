import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge as Chip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RiErrorWarningLine as CircleAlert, RiLoader4Line as LoaderCircle, RiCloseLine as X } from "@remixicon/react";
import type { ReactNode } from "react";
import { useLanguage } from "./i18n";

export function Modal({
  title,
  children,
  open,
  onOpenChange,
  className,
  purpose = "info",
}: {
  title: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  purpose?: "info" | "form" | "required";
}) {
  const { t } = useLanguage();
  return (
    <Dialog open={open} disablePointerDismissal={purpose !== "info"} onOpenChange={(next, details) => {
      if (!next && purpose === "required" && details.reason === "escape-key") {
        details.cancel();
        return;
      }
      onOpenChange(next);
    }}>
      <DialogContent showCloseButton={false} className="quantbot-dialog max-h-[90dvh] min-w-0 overflow-y-auto p-5">
        <DialogHeader className="flex-row items-center justify-between gap-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label={t("close")} />}>
            <X aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className={className}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}
export function Loading() {
  const { t } = useLanguage();
  return (
    <div className="loading" role="status">
      <LoaderCircle className="size-5 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />
      <span>{t("loading")}</span>
    </div>
  );
}
export function ErrorView({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Alert className="min-w-0" variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("error")}</AlertTitle>
      <AlertDescription className="break-all">{error.message}</AlertDescription>
      {retry && <Button className="col-start-2 justify-self-start" variant="outline" size="sm" onClick={retry}>{t("retry")}</Button>}
    </Alert>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  const color = tone === "success" ? "bg-(--success-bg) text-(--success)"
    : tone === "warning" ? "bg-(--warning-bg) text-(--warning)" : "";
  return <Chip className={color} variant={tone === "danger" ? "destructive" : "secondary"}>{children}</Chip>;
}

export function Choices<T extends string>({ label, value, options, select, disabled, fill = false, size = "md" }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  select: (value: T) => void;
  disabled?: boolean;
  fill?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <RadioGroup aria-label={label} value={value} disabled={disabled}
      className={`qb-choices inline-flex max-w-full flex-wrap items-center gap-1 border bg-muted p-1 ${fill ? "w-full" : "w-fit"}`}
      data-size={size} onValueChange={next => {
        const option = options.find(option => option.value === next);
        if (option) select(option.value);
      }}>
      {options.map(option => (
        <span key={option.value} className={`relative inline-flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground has-data-checked:bg-background has-data-checked:text-foreground has-data-checked:shadow-xs has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-data-disabled:opacity-50 ${size === "sm" ? "min-h-7" : size === "lg" ? "min-h-10" : "min-h-8"} ${fill ? "flex-1" : ""}`}>
          <RadioGroupItem aria-label={option.label} value={option.value}
            className="absolute inset-0 size-full cursor-pointer opacity-0 after:inset-0" />
          {option.icon}
          <span aria-hidden="true">{option.label}</span>
        </span>
      ))}
    </RadioGroup>
  );
}
export function decimalText(value: unknown) {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) return "—";
  const [integer = "", fraction] = value.split(".");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "")
  );
}
export function shown(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function timestamp(value: number, seconds = false) {
  return value
    ? new Date(seconds ? value * 1000 : value).toLocaleString()
    : "—";
}
