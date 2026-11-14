import { useSyncExternalStore, useEffect } from "react";

export const palettes = ["forest", "ocean", "violet", "amber", "graphite"] as const;
export type PaletteName = typeof palettes[number];
const listeners = new Set<() => void>();
const read = (): PaletteName => {
  const value = localStorage.getItem("qb.palette");
  return palettes.includes(value as PaletteName) ? value as PaletteName : "forest";
};
export function setPalette(value: PaletteName) {
  localStorage.setItem("qb.palette", value);
  for (const listener of listeners) listener();
}
export function usePalette() {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener);
    window.addEventListener("storage", listener);
    return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
  }, read);
  useEffect(() => { document.documentElement.dataset.palette = value; }, [value]);
  return value;
}
