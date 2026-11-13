import { readFileSync } from "node:fs";

const read = (language) => JSON.parse(readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8"));
const english = read("en");
const chinese = read("zh-CN");
const placeholders = (text) => [...new Set([...text.matchAll(/{{\s*([^},]+?)(?:,[^}]*)?\s*}}/g)]
  .map((match) => match[1]))].sort().join(",");

for (const key of new Set([...Object.keys(english), ...Object.keys(chinese)])) {
  if (!english[key]?.trim() || !chinese[key]?.trim()) throw new Error(`Missing translation for ${key}`);
  if (placeholders(english[key]) !== placeholders(chinese[key])) throw new Error(`Placeholder mismatch for ${key}`);
}
