export type TuiThemeMode = "auto" | "light" | "dark";
export type ResolvedTuiThemeName = "light" | "dark";

export interface TuiTheme {
  name: ResolvedTuiThemeName;
  background: string;
  panel: string;
  panelAlt: string;
  panelActive: string;
  dialogBg: string;
  composeBg: string;
  buttonFg: string;
  buttonBg: string;
  buttonActiveFg: string;
  buttonActiveBg: string;
  buttonSecondaryFg: string;
  buttonSecondaryBg: string;
  menuFg: string;
  menuBg: string;
  menuActiveFg: string;
  menuActiveBg: string;
  headerBg: string;
  sidebarBg: string;
  sidebarFg: string;
  sidebarMuted: string;
  metricBg: string;
  border: string;
  primary: string;
  secondary: string;
  muted: string;
  accent: string;
  accentStrong: string;
  ok: string;
  warning: string;
  error: string;
  activeFg: string;
  activeBg: string;
  sourceFg: string;
  sourceBg: string;
  selectedFg: string;
  selectedBg: string;
  listReadFg: string;
  listUnreadFg: string;
  unreadBadgeFg: string;
  unreadBadgeBg: string;
  unread: string;
  star: string;
  dimRead: string;
  selectionFg: string;
  selectionBg: string;
  labelPalette: string[];
}

// Catppuccin Latte (the light variant) — https://catppuccin.com/palette
// base #eff1f5 · mantle #e6e9ef · crust #dce0e8 · surface0 #ccd0da · surface1 #bcc0cc
// surface2 #acb0be · overlay0 #9ca0b0 · overlay1 #8c8fa1 · subtext0 #6c6f85
// subtext1 #5c5f77 · text #4c4f69 · blue #1e66f5 · mauve #8839ef · green #40a02b
// yellow #df8e1d · red #d20f39 · peach #fe640b · teal #179299 · lavender #7287fd
const LIGHT: TuiTheme = {
  name: "light",
  background: "#eff1f5",     // base
  panel: "#e6e9ef",          // mantle
  panelAlt: "#dce0e8",       // crust
  panelActive: "#ccd0da",    // surface0
  dialogBg: "#e6e9ef",       // mantle
  composeBg: "#dce0e8",      // crust
  buttonFg: "#eff1f5",       // base text on the accent button
  buttonBg: "#1e66f5",       // blue
  buttonActiveFg: "#eff1f5",
  buttonActiveBg: "#1552c9", // darker blue (derived) for the pressed/active button
  buttonSecondaryFg: "#eff1f5",
  buttonSecondaryBg: "#7287fd", // lavender
  menuFg: "#4c4f69",         // text
  menuBg: "#e6e9ef",         // mantle
  menuActiveFg: "#eff1f5",   // base
  menuActiveBg: "#1e66f5",   // blue
  headerBg: "#eff1f5",       // base
  sidebarBg: "#e6e9ef",      // mantle
  sidebarFg: "#4c4f69",      // text
  sidebarMuted: "#6c6f85",   // subtext0
  metricBg: "#ccd0da",       // surface0
  border: "#bcc0cc",         // surface1
  primary: "#4c4f69",        // text
  secondary: "#5c5f77",      // subtext1
  muted: "#8c8fa1",          // overlay1
  accent: "#1e66f5",         // blue
  accentStrong: "#8839ef",   // mauve
  ok: "#40a02b",             // green
  warning: "#df8e1d",        // yellow
  error: "#d20f39",          // red
  activeFg: "#1e66f5",       // blue
  activeBg: "#dce6fb",       // soft blue tint (derived) for active rows
  sourceFg: "#1e66f5",
  sourceBg: "#dce6fb",
  selectedFg: "#1e66f5",
  selectedBg: "#dce6fb",
  listReadFg: "#6c6f85",     // subtext0 — read items read as muted
  listUnreadFg: "#4c4f69",   // text — unread items at full strength
  unreadBadgeFg: "#eff1f5",  // base
  unreadBadgeBg: "#1e66f5",  // blue badge
  unread: "#4c4f69",         // text
  star: "#df8e1d",           // yellow
  dimRead: "#9ca0b0",        // overlay0
  selectionFg: "#eff1f5",    // base
  selectionBg: "#1e66f5",    // blue
  labelPalette: ["#1e66f5", "#8839ef", "#fe640b", "#40a02b", "#179299", "#d20f39", "#df8e1d"],
};

const DARK: TuiTheme = {
  name: "dark",
  background: "#0a0a0a",
  panel: "#141414",
  panelAlt: "#1e1e1e",
  panelActive: "#282828",
  dialogBg: "#141414",
  composeBg: "#1e1e1e",
  buttonFg: "#ededed",
  buttonBg: "#050505",
  buttonActiveFg: "#ffffff",
  buttonActiveBg: "#202020",
  buttonSecondaryFg: "#ededed",
  buttonSecondaryBg: "#111111",
  menuFg: "#ededed",
  menuBg: "#202020",
  menuActiveFg: "#0a0a0a",
  menuActiveBg: "#fab283",
  headerBg: "#0a0a0a",
  sidebarBg: "#141414",
  sidebarFg: "#ededed",
  sidebarMuted: "#707070",
  metricBg: "#232323",
  border: "#484848",
  primary: "#ededed",
  secondary: "#a0a0a0",
  muted: "#707070",
  accent: "#fab283",
  accentStrong: "#fab283",
  ok: "#12c905",
  warning: "#fcd53a",
  error: "#fc533a",
  activeFg: "#f1ece8",
  activeBg: "#282828",
  sourceFg: "#f1ece8",
  sourceBg: "#282828",
  selectedFg: "#f1ece8",
  selectedBg: "#343434",
  listReadFg: "#ededed",
  listUnreadFg: "#ffffff",
  unreadBadgeFg: "#0a0a0a",
  unreadBadgeBg: "#fcd53a",
  unread: "#ffffff",
  star: "#fcd53a",
  dimRead: "#707070",
  selectionFg: "#0a0a0a",
  selectionBg: "#fab283",
  labelPalette: ["#fab283", "#5c9cf5", "#9d7cd8", "#7fd88f", "#56b6c2", "#e06c75", "#e5c07b"],
};

export function normalizeThemeMode(value: unknown): TuiThemeMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  return "auto";
}

function themeFromColorFgBg(value: string | undefined): ResolvedTuiThemeName | null {
  if (!value) return null;
  const parts = value.split(";").map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
  const bg = parts.at(-1);
  if (bg === undefined) return null;
  if (bg === 7 || bg === 15) return "light";
  if ((bg >= 0 && bg <= 6) || bg === 8) return "dark";
  return null;
}

export function detectSystemTheme(env: Record<string, string | undefined> = process.env): ResolvedTuiThemeName {
  const forced = normalizeThemeMode(env["MAILERY_TUI_THEME"] ?? env["EMAILS_TUI_THEME"] ?? env["TUI_THEME"] ?? env["TERMINAL_THEME"]);
  if (forced === "light" || forced === "dark") return forced;

  const colorFgBg = themeFromColorFgBg(env["COLORFGBG"]);
  if (colorFgBg) return colorFgBg;

  const joined = [
    env["APPLE_INTERFACE_STYLE"],
    env["OS_APPEARANCE"],
    env["TERM_BACKGROUND"],
    env["GTK_THEME"],
    env["KDE_COLOR_SCHEME"],
    env["ITERM_PROFILE"],
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\b(dark|night|black)\b/.test(joined)) return "dark";
  if (/\b(light|day|white)\b/.test(joined)) return "light";
  // Default to the light (Catppuccin Latte) theme when no signal is available.
  return "light";
}

export function resolveThemeName(
  mode: TuiThemeMode = "auto",
  env: Record<string, string | undefined> = process.env,
  detected?: ResolvedTuiThemeName | null,
): ResolvedTuiThemeName {
  return mode === "auto" ? detected ?? detectSystemTheme(env) : mode;
}

export function resolveTheme(
  mode: TuiThemeMode = "auto",
  env: Record<string, string | undefined> = process.env,
  detected?: ResolvedTuiThemeName | null,
): TuiTheme {
  return resolveThemeName(mode, env, detected) === "dark" ? DARK : LIGHT;
}

export function nextThemeMode(mode: TuiThemeMode): TuiThemeMode {
  if (mode === "auto") return "dark";
  if (mode === "dark") return "light";
  return "auto";
}
