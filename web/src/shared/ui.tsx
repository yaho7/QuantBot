import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { Badge as CountBadge } from "@astryxdesign/core/Badge";
import { Token } from "@astryxdesign/core/Token";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { VStack } from "@astryxdesign/core/VStack";
import { X } from "lucide-react";
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
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      width={className === "connection-dialog" ? "32.5rem" : "31.25rem"}
      maxHeight="90dvh"
      padding={5}
      purpose={purpose}
    >
      <DialogHeader
        title={title}
        hasDivider={false}
        endContent={
          <IconButton
            label={t("close")}
            tooltip={t("close")}
            variant="ghost"
            size="sm"
            icon={<AstryxIcon icon={X} size="sm" />}
            onClick={() => onOpenChange(false)}
          />
        }
      />
      <VStack
        className={className}
        gap={4}
        paddingInline={5}
        paddingBlockEnd={5}
      >
        {children}
      </VStack>
    </Dialog>
  );
}
export function Loading() {
  const { t } = useLanguage();
  return (
    <VStack
      className="loading"
      minHeight="10rem"
      vAlign="center"
      hAlign="center"
    >
      <Spinner label={t("loading")} size="lg" shade="subtle" />
    </VStack>
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
    <VStack className="error-state" role="alert">
      <Banner
        status="error"
        title={t("error")}
        description={error.message}
        endContent={retry && <Button label={t("retry")} onClick={retry} />}
      />
    </VStack>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  const variant =
    tone === "success"
      ? "green"
      : tone === "warning"
        ? "yellow"
        : tone === "danger"
          ? "red"
          : "neutral";
  if (typeof children === "number")
    return <CountBadge label={children} variant={variant} />;
  return (
    <Token
      label={String(children ?? "")}
      color={variant === "neutral" ? "default" : variant}
      size="sm"
    />
  );
}

export function Choices<T extends string>({
  label,
  value,
  options,
  select,
  disabled,
  fill = false,
  size = "md",
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  select: (value: T) => void;
  disabled?: boolean;
  fill?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <SegmentedControl
      label={label}
      value={value}
      size={size}
      layout={fill ? "fill" : "hug"}
      isDisabled={disabled}
      onChange={(next) => {
        const option = options.find((option) => option.value === next);
        if (option) select(option.value);
      }}
    >
      {options.map((option) => (
        <SegmentedControlItem {...option} key={option.value} />
      ))}
    </SegmentedControl>
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
