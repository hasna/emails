import { createContext, createMemo, useContext, type ParentProps } from "solid-js";
import type { ColorInput } from "@opentui/core";
import { detectSystemTheme, normalizeThemeMode, type ResolvedTuiThemeName, type TuiThemeMode } from "../../tui/theme.js";

export interface TuiColorTheme {
  mode: ResolvedTuiThemeName;
  primary: ColorInput;
  secondary: ColorInput;
  accent: ColorInput;
  error: ColorInput;
  warning: ColorInput;
  success: ColorInput;
  info: ColorInput;
  text: ColorInput;
  textMuted: ColorInput;
  textFaint: ColorInput;
  selectedListItemText: ColorInput;
  background: ColorInput;
  backgroundPanel: ColorInput;
  backgroundElement: ColorInput;
  backgroundMenu: ColorInput;
  backgroundActive: ColorInput;
  backgroundHover: ColorInput;
  backgroundPressed: ColorInput;
  border: ColorInput;
  borderActive: ColorInput;
  borderSubtle: ColorInput;
  markdownText: ColorInput;
  markdownHeading: ColorInput;
  markdownLink: ColorInput;
  markdownLinkText: ColorInput;
  markdownCode: ColorInput;
  markdownBlockQuote: ColorInput;
  markdownEmph: ColorInput;
  markdownStrong: ColorInput;
  markdownHorizontalRule: ColorInput;
  markdownListItem: ColorInput;
  markdownListEnumeration: ColorInput;
  markdownImage: ColorInput;
  markdownImageText: ColorInput;
  markdownCodeBlock: ColorInput;
  labelPalette: string[];
}

// Mirrors open-aicopilot's default TUI theme (`aicopilot.json`) plus its
// optional runtime roles (`backgroundMenu`, `selectedListItemText`).
const DARK: TuiColorTheme = {
  mode: "dark",
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  info: "#56b6c2",
  text: "#eeeeee",
  textMuted: "#808080",
  textFaint: "#606060",
  selectedListItemText: "#0a0a0a",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  backgroundMenu: "#1e1e1e",
  backgroundActive: "#282828",
  backgroundHover: "#323232",
  backgroundPressed: "#3c3c3c",
  border: "#484848",
  borderActive: "#606060",
  borderSubtle: "#3c3c3c",
  markdownText: "#eeeeee",
  markdownHeading: "#9d7cd8",
  markdownLink: "#fab283",
  markdownLinkText: "#56b6c2",
  markdownCode: "#7fd88f",
  markdownBlockQuote: "#e5c07b",
  markdownEmph: "#e5c07b",
  markdownStrong: "#f5a742",
  markdownHorizontalRule: "#808080",
  markdownListItem: "#fab283",
  markdownListEnumeration: "#56b6c2",
  markdownImage: "#fab283",
  markdownImageText: "#56b6c2",
  markdownCodeBlock: "#eeeeee",
  labelPalette: ["#fab283", "#5c9cf5", "#9d7cd8", "#7fd88f", "#56b6c2", "#e06c75", "#e5c07b"],
};

const LIGHT: TuiColorTheme = {
  mode: "light",
  primary: "#3b7dd8",
  secondary: "#7b5bb6",
  accent: "#d68c27",
  error: "#d1383d",
  warning: "#d68c27",
  success: "#3d9a57",
  info: "#318795",
  text: "#1a1a1a",
  textMuted: "#8a8a8a",
  textFaint: "#a0a0a0",
  selectedListItemText: "#ffffff",
  background: "#ffffff",
  backgroundPanel: "#fafafa",
  backgroundElement: "#f5f5f5",
  backgroundMenu: "#f5f5f5",
  backgroundActive: "#ebebeb",
  backgroundHover: "#e1e1e1",
  backgroundPressed: "#d4d4d4",
  border: "#b8b8b8",
  borderActive: "#a0a0a0",
  borderSubtle: "#d4d4d4",
  markdownText: "#1a1a1a",
  markdownHeading: "#d68c27",
  markdownLink: "#3b7dd8",
  markdownLinkText: "#318795",
  markdownCode: "#3d9a57",
  markdownBlockQuote: "#b0851f",
  markdownEmph: "#b0851f",
  markdownStrong: "#d68c27",
  markdownHorizontalRule: "#8a8a8a",
  markdownListItem: "#3b7dd8",
  markdownListEnumeration: "#318795",
  markdownImage: "#3b7dd8",
  markdownImageText: "#318795",
  markdownCodeBlock: "#1a1a1a",
  labelPalette: ["#3b7dd8", "#7b5bb6", "#d68c27", "#3d9a57", "#318795", "#d1383d", "#b0851f"],
};

export function resolveSolidTheme(mode: TuiThemeMode = "dark", env: Record<string, string | undefined> = process.env): TuiColorTheme {
  const normalized = normalizeThemeMode(mode);
  const resolved = normalized === "auto" ? detectSystemTheme(env) : normalized;
  return resolved === "light" ? LIGHT : DARK;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.replace("#", "").slice(0, 6);
  if (raw.length !== 6) return null;
  const value = Number.parseInt(raw, 16);
  if (!Number.isFinite(value)) return null;
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function selectedForeground(theme: TuiColorTheme, bg?: ColorInput): ColorInput {
  if (theme.selectedListItemText) return theme.selectedListItemText;
  if (typeof bg === "string") {
    const rgb = hexToRgb(bg);
    if (rgb) {
      const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
      return luminance > 150 ? "#0a0a0a" : "#ffffff";
    }
  } else if (bg) {
    const luminance = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
    return luminance > 150 ? "#0a0a0a" : "#ffffff";
  }
  return theme.mode === "dark" ? theme.background : theme.text;
}

const ThemeContext = createContext<TuiColorTheme>();

export function ThemeProvider(props: ParentProps<{ mode?: TuiThemeMode }>) {
  const theme = createMemo(() => resolveSolidTheme(props.mode ?? "dark"));
  const value = new Proxy({} as TuiColorTheme, {
    get: (_, key: string | symbol) => typeof key === "string" ? theme()[key as keyof TuiColorTheme] : undefined,
  });
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): TuiColorTheme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used within ThemeProvider");
  return theme;
}

export function labelColor(theme: TuiColorTheme, label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return theme.labelPalette[Math.abs(hash) % theme.labelPalette.length] ?? (typeof theme.primary === "string" ? theme.primary : "#fab283");
}

export function friendlyLabel(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}
