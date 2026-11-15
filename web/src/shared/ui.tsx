import * as Dialog from "@radix-ui/react-dialog";
import { X, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useLanguage } from "./i18n";

export function Modal({
  title,
  children,
  open,
  onOpenChange,
  className,
}: {
  title: string;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const { t } = useLanguage();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={className ? "dialog-content " + className : "dialog-content"} aria-describedby={undefined}>
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("close")}>
              <X size={18} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Loading() {
  const { t } = useLanguage();
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={18} />
      {t("loading")}
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
    <div className="error-state" role="alert">
      <p>
        {t("error")} · {error.message}
      </p>
      {retry && <button onClick={retry}>{t("retry")}</button>}
    </div>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
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
