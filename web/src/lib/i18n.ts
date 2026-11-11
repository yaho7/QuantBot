import english from "@/locales/en.json";

export type Language = "zh" | "en";
export const language: Language = document.documentElement.lang === "en" ? "en" : "zh";
export const locale = language === "en" ? "en" : "zh-CN";

const messages: Record<string, string> = english;

export function tr(source: string, ...values: unknown[]): string {
  const template = language === "en" ? messages[source] ?? source : source;
  return values.length
    ? template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ""))
    : template;
}
