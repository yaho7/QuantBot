import { defineTheme } from "@astryxdesign/core/theme";
import { quantbotUI } from "./quantbot.theme";
export const graphite = defineTheme({name: "quantbot-graphite", extends: quantbotUI, tokens: {
"--color-accent": ["#3d4653","#c9d1dc"], "--color-text-accent": ["#3d4653","#c9d1dc"], "--color-icon-accent": ["#3d4653","#c9d1dc"], "--color-accent-muted": ["#e9edf2","#303944"], "--color-on-accent": ["white","black"], "--focus-outline-color": ["#3d4653","#c9d1dc"]
}});
