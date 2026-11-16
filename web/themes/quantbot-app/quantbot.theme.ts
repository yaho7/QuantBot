import { defineTheme } from "@astryxdesign/core/theme";
import { quantbotTheme as base } from "../../src/themes/quantbot/quantbot.js";
const tokens = {
  "--canvas": "var(--color-background-body)",
  "--surface": "var(--color-background-surface)",
  "--raised": "var(--color-background-muted)",
  "--text": "var(--color-text-primary)",
  "--muted": "var(--color-text-secondary)",
  "--line": "var(--color-border)",
  "--accent": "var(--color-text-accent)",
  "--accent-soft": "var(--color-accent-muted)",
  "--accent-ink": "var(--color-on-accent)",
  "--success": "var(--color-text-green)",
  "--success-bg": "var(--color-background-green)",
  "--warning": "var(--color-text-yellow)",
  "--warning-bg": "var(--color-background-yellow)",
  "--danger": "var(--color-text-red)",
  "--danger-bg": "var(--color-background-red)",
  "--radius": "var(--radius-container)",
  "--gap": "var(--spacing-4)",
  "--qb-font-family": "var(--font-family-body)",
  "--size-element-md": "2.5rem",
  "--size-element-lg": "2.75rem",
};
export const quantbotUI = defineTheme({
  name: "quantbot-app",
  extends: base,
  tokens,
  components: { "side-nav": { base: { width: "15rem" } } },
});
