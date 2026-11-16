import { themes, defaultThemeSlug } from "../astryx-themes";
import { quantbotAppTheme } from "../../themes/quantbot-app/quantbot-app.js";
import { quantbotOceanTheme } from "../../themes/quantbot-app/quantbot-ocean.js";
import { quantbotVioletTheme } from "../../themes/quantbot-app/quantbot-violet.js";
import { quantbotAmberTheme } from "../../themes/quantbot-app/quantbot-amber.js";
import { quantbotGraphiteTheme } from "../../themes/quantbot-app/quantbot-graphite.js";

// Fixed palettes ship as compiled Astryx themes: no runtime styling layer.
export const quantbotThemes = {
  forest: quantbotAppTheme,
  ocean: quantbotOceanTheme,
  violet: quantbotVioletTheme,
  amber: quantbotAmberTheme,
  graphite: quantbotGraphiteTheme,
};

export function appTheme(palette: string) {
  return quantbotThemes[palette as keyof typeof quantbotThemes] ?? themes[defaultThemeSlug];
}
