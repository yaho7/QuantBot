import * as React from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "quantbot-theme";

function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = React.useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? "system",
  );
  React.useEffect(() => {
    apply(theme);
    localStorage.setItem(KEY, theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  return [theme, setTheme];
}
