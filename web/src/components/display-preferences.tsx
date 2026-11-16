import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Choices } from "../shared/ui";
import { setLanguage, useLanguage } from "../shared/i18n";
import { palettes, setPalette, usePalette } from "../shared/preferences";

export function DisplayPreferences() {
  const { lang, t } = useLanguage();
  const palette = usePalette();
  return (
    <Section padding={5}>
      <VStack gap={5}>
        <Heading level={2}>{t("appearance")} · Classical</Heading>
        <VStack gap={2}>
          <Text type="label">{t("language")}</Text>
          <Choices
            label={t("language")}
            value={lang}
            select={setLanguage}
            options={[
              { value: "zh", label: "简体中文" },
              { value: "en", label: "English" },
            ]}
          />
        </VStack>
        <VStack gap={2}>
          <Text type="label">{t("palette")}</Text>
          <Choices
            label={t("palette")}
            value={palette}
            select={setPalette}
            options={palettes.map((value) => ({ value, label: t(value) }))}
          />
        </VStack>
      </VStack>
    </Section>
  );
}
