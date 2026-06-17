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

const LIGHT: TuiTheme = {
  name: "light",
  background: "#ffffff",
  panel: "#fafafa",
  panelAlt: "#eeeeee",
  panelActive: "#f5f5f5",
  dialogBg: "#fafafa",
  composeBg: "#f5f5f5",
  buttonFg: "#ffffff",
  buttonBg: "#111111",
  buttonActiveFg: "#ffffff",
  buttonActiveBg: "#2a2a2a",
  buttonSecondaryFg: "#ffffff",
  buttonSecondaryBg: "#1f1f1f",
  menuFg: "#161616",
  menuBg: "#f0f0f0",
  menuActiveFg: "#ffffff",
  menuActiveBg: "#22388f",
  headerBg: "#ffffff",
  sidebarBg: "#fafafa",
  sidebarFg: "#161616",
  sidebarMuted: "#808080",
  metricBg: "#eeeeee",
  border: "#e8e8e8",
  primary: "#161616",
  secondary: "#5c5c5c",
  muted: "#808080",
  accent: "#3b5cf6",
  accentStrong: "#034cff",
  ok: "#198b43",
  warning: "#cb9f34",
  error: "#d92e3c",
  activeFg: "#22388f",
  activeBg: "#ecf1fe",
  sourceFg: "#22388f",
  sourceBg: "#ecf1fe",
  selectedFg: "#22388f",
  selectedBg: "#ecf1fe",
  listReadFg: "#161616",
  listUnreadFg: "#161616",
  unreadBadgeFg: "#111111",
  unreadBadgeBg: "#ffd43b",
  unread: "#161616",
  star: "#e7af36",
  dimRead: "#808080",
  selectionFg: "#ffffff",
  selectionBg: "#3b5cf6",
  labelPalette: ["#3b7dd8", "#7b5bb6", "#d68c27", "#3d9a57", "#318795", "#d1383d", "#b0851f"],
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
  return "dark";
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
