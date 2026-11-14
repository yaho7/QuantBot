import { Check, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n, languages, t } from "../i18n";
import { ActionPopover } from "./ui";

const names = { en: "English", "zh-CN": "简体中文" };

export function LanguagePicker() {
  useTranslation();
  return <ActionPopover label={t("app.language")} trigger={<Languages size={19} aria-hidden="true" />}>
    {(close) => languages.map((language) => <button type="button" key={language} lang={language}
      aria-pressed={i18n.language === language} onClick={() => { void i18n.changeLanguage(language); close(); }}>
      <span>{names[language]}</span>{i18n.language === language && <Check size={15} aria-hidden="true" />}
    </button>)}
  </ActionPopover>;
}
