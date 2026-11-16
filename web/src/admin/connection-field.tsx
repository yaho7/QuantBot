import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
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

export function ConnectionField({
  label,
  value,
  field,
  onReveal,
  revealing = false,
  copyLabel,
}: {
  label: string;
  value?: string;
  field: string;
  onReveal?: () => void;
  revealing?: boolean;
  copyLabel: string;
}) {
  const { t } = useLanguage();
  const { copy, isCopied } = useClipboard({ announce: t("copied") });
  return (
    <HStack
      gap={2}
      vAlign="center"
      hAlign="between"
      className="connection-field py-3 border-b border-border last:border-b-0"
      data-field={field}
    >
      <VStack
        gap={1}
        className="connection-field-value min-w-0   min-w-0   flex-1"
      >
        <Text>{label}</Text>
        <code>
          <Text type="code" dir="ltr">
            {value ?? (onReveal ? "••••••••••••••••" : "—")}
          </Text>
        </code>
      </VStack>
      <HStack
        gap={3}
        wrap="wrap"
        vAlign="center"
        className="connection-field-actions shrink-0"
      >
        {onReveal && (
          <IconButton
            size="md"
            variant="ghost"
            label={t(value ? "hideToken" : "viewToken")}
            tooltip={t(value ? "hideToken" : "viewToken")}
            isLoading={revealing}
            onClick={onReveal}
            icon={
              value ? (
                <AstryxIcon icon={EyeOff} size="sm" />
              ) : (
                <AstryxIcon icon={Eye} size="sm" />
              )
            }
          />
        )}
        <IconButton
          size="md"
          variant="ghost"
          label={copyLabel}
          tooltip={copyLabel}
          isDisabled={!value}
          icon={
            isCopied ? (
              <AstryxIcon icon={Check} size="sm" />
            ) : (
              <AstryxIcon icon={Copy} size="sm" />
            )
          }
          onClick={async () => {
            if (value && !(await copy(value))) toast.error(t("copyFailed"));
          }}
        />
      </HStack>
    </HStack>
  );
}
