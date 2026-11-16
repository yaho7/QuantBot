import { defineTheme } from "@astryxdesign/core/theme";
import { quantbotUI } from "./quantbot.theme";
export const ocean = defineTheme({name: "quantbot-ocean", extends: quantbotUI, tokens: {
"--color-accent": ["#2458b3","#a3c1ff"], "--color-text-accent": ["#2458b3","#a3c1ff"], "--color-icon-accent": ["#2458b3","#a3c1ff"], "--color-accent-muted": ["#e9f0fd","#203559"], "--color-on-accent": ["white","black"], "--focus-outline-color": ["#2458b3","#a3c1ff"]
}});
