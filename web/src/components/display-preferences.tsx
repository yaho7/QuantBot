import { Languages, Palette } from "lucide-react";
import { setLanguage, useLanguage } from "../shared/i18n";
import { palettes, setPalette, usePalette } from "../shared/preferences";
import "./display-preferences.css";

export function DisplayPreferences() {
  const { lang, t } = useLanguage();
  const palette = usePalette();
  return <section className="surface padded display-preferences">
    <h2>{t("appearance")} · Classical</h2>
    <label className="preference-language">
      <span><Languages size={18} />{t("language")}</span>
      <select value={lang} onChange={event => setLanguage(event.target.value)}>
        <option value="zh">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
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
  </section>;
}
