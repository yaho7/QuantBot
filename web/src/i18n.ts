import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh-CN.json";

export const languages = ["en", "zh-CN"] as const;
export type Language = typeof languages[number];
export type Message = keyof typeof en;

const storageKey = "quantbot.language";
function readPreference() {
  try { return localStorage.getItem(storageKey); }
  catch { return null; }
}
const saved = readPreference();
const preferred = navigator.languages.find((language) => /^(zh|en)(-|$)/i.test(language));
const initial = saved === "en" || saved === "zh-CN" ? saved : preferred?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: initial,
  supportedLngs: [...languages],
  fallbackLng: "en",
  resources: { en: { translation: en }, "zh-CN": { translation: zh } },
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});

document.documentElement.lang = initial;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
  try { localStorage.setItem(storageKey, language); } catch { /* Storage may be disabled. */ }
});

export function t(key: Message, values?: Record<string, unknown>): string {
  return i18n.t(key, values ?? {});
}

export function label(key: Message | undefined, fallback = ""): string {
  return key ? t(key) : fallback;
}

const controlReasons: Message[] = [
  "controls.executorMissingScope", "operations.executorOffline", "controls.registryOwnerRequired",
  "controls.incompatibleCapability", "operations.highRiskLiveTradingIsDisabled", "controls.disabledByStrategy",
];

export function controlReason(message: string): string {
  const key = controlReasons.find((key) => zh[key] === message);
  return key ? t(key) : message;
}
