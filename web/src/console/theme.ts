import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
const storageKey = "quantbot-theme";
const darkPreference = window.matchMedia("(prefers-color-scheme: dark)");

export const DarkMode = createContext(false);

function subscribe(callback: () => void) {
  darkPreference.addEventListener("change", callback);
  return () => darkPreference.removeEventListener("change", callback);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  const systemDark = useSyncExternalStore(subscribe, () => darkPreference.matches);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem(storageKey, theme); } catch { /* Keep the selection for this session. */ }
  }, [dark, theme]);
  return { theme, setTheme, dark };
}

const chartColors = {
  dark: {
    ink: "#cecdc3", muted: "#9f9d96", surface: "#1c1b1a", border: "#343331",
    gain: "#879a39", loss: "#d14d41", warning: "#d0a215", signal: "#769ebb",
    series: ["#5ea49c", "#769ebb", "#c5a556", "#c87c51", "#899857"],
  },
  light: {
    ink: "#100f0f", muted: "#575653", surface: "#f7f3e8", border: "#e6e2d6",
    gain: "#53670d", loss: "#af3029", warning: "#854f0b", signal: "#205ea6",
    series: ["#659892", "#688daf", "#b99f64", "#bb7b5b", "#83925b"],
  },
};

export function useChartPalette() {
  return useContext(DarkMode) ? chartColors.dark : chartColors.light;
}
