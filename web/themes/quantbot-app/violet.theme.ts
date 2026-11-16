import { defineTheme } from "@astryxdesign/core/theme";
import { quantbotUI } from "./quantbot.theme";
export const violet = defineTheme({name: "quantbot-violet", extends: quantbotUI, tokens: {
"--color-accent": ["#6940a7","#cdb0f7"], "--color-text-accent": ["#6940a7","#cdb0f7"], "--color-icon-accent": ["#6940a7","#cdb0f7"], "--color-accent-muted": ["#f1eafb","#38264f"], "--color-on-accent": ["white","black"], "--focus-outline-color": ["#6940a7","#cdb0f7"]
}});
