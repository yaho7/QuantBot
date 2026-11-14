import { createContext } from "react";
import { resource } from "../shared/api";

export type Palette = Partial<
  Record<
    | "background"
    | "surface"
    | "foreground"
    | "muted"
    | "border"
    | "accent"
    | "positive"
    | "negative"
    | "chart",
    string
  >
>;
export type Theme = {
  id: string;
  revision: string;
  previousRevision?: string;
  manifest: {
    name: string;
    author?: string;
    description?: string;
    version?: string;
    type: "declarative" | "frontend";
  };
  presentation: {
    light?: Palette;
    dark?: Palette;
    sections?: string[];
    cardView?: string;
    surface?: string;
    font?: string;
    background?: string;
    radius?: number;
    gap?: number;
  };
  settings: Record<string, string | number | boolean>;
  fields?: {
    key: string;
    label: string;
    type: string;
    default: string | number | boolean;
    options?: string[];
    min?: number;
    max?: number;
  }[];
  assets?: string[];
  entryUrl?: string;
  assetBase?: string;
  previewUrl?: string;
  builtin: boolean;
  available: boolean;
};

export const activeTheme = resource<Theme>("/theme");
export const ThemeContext = createContext<Theme["presentation"] & { portfolio?: boolean }>({});
