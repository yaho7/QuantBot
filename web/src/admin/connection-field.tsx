import { Button } from "@/components/ui/button";
import {
  RiFileCopyLine as Copy,
  RiLoader4Line as LoaderCircle,
  RiEyeLine as Eye,
  RiEyeOffLine as EyeOff,
} from "@remixicon/react";
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
  const copy = useCopyText();
  const visibilityLabel = t(value ? "hideToken" : "viewToken");
  return <div className="connection-field" data-field={field}>
    <div className="connection-field-value">
      <span>{label}</span>
      <code dir="ltr">{value ?? (onReveal ? "••••••••••••••••" : "—")}</code>
    </div>
    <div className="connection-field-actions">
      {onReveal && <Button size="icon" variant="ghost" aria-label={visibilityLabel}
        disabled={revealing} aria-busy={revealing} onClick={onReveal}>
        {revealing ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : value ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </Button>}
      <Button size="icon" variant="ghost" aria-label={copyLabel} disabled={!value}
        onClick={() => { if (value) void copy(value); }}>
        <Copy size={16} aria-hidden="true" />
      </Button>
    </div>
  </div>;
}
