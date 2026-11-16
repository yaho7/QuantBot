import { defineTheme } from "@astryxdesign/core/theme";
import { quantbotUI } from "./quantbot.theme";
export const amber = defineTheme({name: "quantbot-amber", extends: quantbotUI, tokens: {
"--color-accent": ["#835a0d","#e8c47b"], "--color-text-accent": ["#835a0d","#e8c47b"], "--color-icon-accent": ["#835a0d","#e8c47b"], "--color-accent-muted": ["#f9efd9","#443619"], "--color-on-accent": ["white","black"], "--focus-outline-color": ["#835a0d","#e8c47b"]
}});
