import { useSyncExternalStore } from "react";

export const appearanceOptions = ["system", "light", "dark"] as const;
export type Appearance = typeof appearanceOptions[number];

const storageKey = "qb.appearance";
const listeners = new Set<() => void>();

function readAppearance(): Appearance {
  const value = localStorage.getItem(storageKey);
  return value === "light" || value === "dark" ? value : "system";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const sync = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener();
  };
  window.addEventListener("storage", sync);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", sync);
  };
}

export function setAppearance(value: Appearance) {
  localStorage.setItem(storageKey, value);
  for (const listener of listeners) listener();
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, readAppearance);
}
