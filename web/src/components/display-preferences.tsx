import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { Choices } from "../shared/ui";
import { Languages, Palette } from "lucide-react";
import { setLanguage, useLanguage } from "../shared/i18n";
import { palettes, setPalette, usePalette } from "../shared/preferences";
import "./display-preferences.css";

export function DisplayPreferences() {
  const { lang, t } = useLanguage();
  const palette = usePalette();
  return <Card padding={4}><VStack as="section" className="display-preferences" gap={4}>
    <Heading level={2}>{t("appearance")} · Classical</Heading>
    <fieldset>
      <legend><Languages size={16} />{t("language")}</legend>
      <Choices label={t("language")} value={lang} select={setLanguage}
        options={[{ value: "zh", label: "简体中文" }, { value: "en", label: "English" }]} />
    </fieldset>
    <fieldset>
      <legend><Palette size={18} />{t("palette")}</legend>
      <div className="palette-options">
        {palettes.map(name => <button key={name} type="button"
          className={"palette-option palette-" + name} aria-pressed={palette === name}
          onClick={() => setPalette(name)}>
          <span className="palette-swatch" aria-hidden="true" />{t(name)}
        </button>)}
      </div>
    </fieldset>
  </VStack></Card>;
}
