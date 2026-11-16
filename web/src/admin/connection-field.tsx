import { IconButton } from "@astryxdesign/core/IconButton";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "../shared/i18n";

export function useCopyText() {
  const { t } = useLanguage();
  return async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };
}

export function ConnectionField({ label, value, field, onReveal, revealing = false, copyLabel }: {
  label: string; value?: string; field: string; onReveal?: () => void; revealing?: boolean; copyLabel: string;
}) {
  const { t } = useLanguage();
  const { copy, isCopied } = useClipboard({ announce: t("copied") });
  return <div className="connection-field" data-field={field}>
    <div className="connection-field-value">
      <span>{label}</span>
      <code dir="ltr">{value ?? (onReveal ? "••••••••••••••••" : "—")}</code>
    </div>
    <div className="connection-field-actions">
      {onReveal && <IconButton size="md" variant="ghost"
        label={t(value ? "hideToken" : "viewToken")} tooltip={t(value ? "hideToken" : "viewToken")}
        isLoading={revealing} onClick={onReveal}
        icon={value ? <EyeOff size={16} /> : <Eye size={16} />} />}
      <IconButton size="md" variant="ghost" label={copyLabel} tooltip={copyLabel} isDisabled={!value}
        icon={isCopied ? <Check size={16} /> : <Copy size={16} />} onClick={async () => {
          if (value && !(await copy(value))) toast.error(t("copyFailed"));
        }} />
    </div>
  </div>;
}
