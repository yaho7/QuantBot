import { useTranslation } from "react-i18next";
import { i18n, languages, t } from "../i18n";

const names = { en: "English", "zh-CN": "简体中文" };

export function LanguagePicker() {
  useTranslation();
  return <select className="language-picker" aria-label={t("app.language")} value={i18n.language}
    onChange={(event) => void i18n.changeLanguage(event.target.value)}>
    {languages.map((language) => <option key={language} value={language} lang={language}>{names[language]}</option>)}
  </select>;
}
