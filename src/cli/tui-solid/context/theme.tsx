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

// Catppuccin Latte accents on a clean WHITE background (mirrors open-aicopilot's light
// theme structure — white base, neutral light surfaces — rather than Latte's blue-gray
// #eff1f5 base, which read as a "weird gray" background).
const LIGHT: TuiColorTheme = {
  mode: "light",
  primary: "#1e66f5",        // Latte blue
  secondary: "#209fb5",      // Latte sapphire
  accent: "#8839ef",         // Latte mauve
  error: "#d20f39",          // Latte red
  warning: "#df8e1d",        // Latte yellow
  success: "#40a02b",        // Latte green
  info: "#04a5e5",           // Latte sky
  text: "#4c4f69",           // Latte text
  textMuted: "#6c6f85",      // Latte subtext0
  textFaint: "#9ca0b0",      // Latte overlay0
  selectedListItemText: "#ffffff",
  background: "#ffffff",      // clean white — no gray
  backgroundPanel: "#fafbfc",
  backgroundElement: "#f4f5f7",
  backgroundMenu: "#f4f5f7",
  backgroundActive: "#e8eefc",   // soft Latte-blue tint for the active/selected row
  backgroundHover: "#eef0f4",
  backgroundPressed: "#dfe3ea",
  border: "#dce0e8",
  borderActive: "#bcc0cc",
  borderSubtle: "#eceef1",
  markdownText: "#4c4f69",
  markdownHeading: "#8839ef",   // mauve
  markdownLink: "#1e66f5",      // blue
  markdownLinkText: "#209fb5",  // sapphire
  markdownCode: "#40a02b",      // green
  markdownBlockQuote: "#df8e1d",// yellow
  markdownEmph: "#df8e1d",
  markdownStrong: "#fe640b",    // peach
  markdownHorizontalRule: "#9ca0b0",
  markdownListItem: "#1e66f5",
  markdownListEnumeration: "#209fb5",
  markdownImage: "#1e66f5",
  markdownImageText: "#209fb5",
  markdownCodeBlock: "#4c4f69",
  labelPalette: ["#1e66f5", "#8839ef", "#fe640b", "#40a02b", "#179299", "#d20f39", "#df8e1d"],
};

export function resolveSolidTheme(mode: TuiThemeMode = "auto", env: Record<string, string | undefined> = process.env): TuiColorTheme {
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
  const theme = createMemo(() => resolveSolidTheme(props.mode ?? "auto"));
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
