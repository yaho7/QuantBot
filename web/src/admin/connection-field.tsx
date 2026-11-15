import { Copy, Eye, EyeOff } from "lucide-react";
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
  return <div className="connection-field" data-field={field}>
    <div className="connection-field-value">
      <span>{label}</span>
      <code dir="ltr">{value ?? (onReveal ? "••••••••••••••••" : "—")}</code>
    </div>
    <div className="connection-field-actions">
      {onReveal && <button type="button" className="icon-button"
        aria-label={t(value ? "hideToken" : "viewToken")}
        title={t(value ? "hideToken" : "viewToken")} disabled={revealing} onClick={onReveal}>
        {value ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>}
      <button type="button" className="icon-button" aria-label={copyLabel} title={copyLabel}
        disabled={!value} onClick={() => { if (value) void copy(value); }}>
        <Copy size={15} />
      </button>
    </div>
  </div>;
}
