export type TuiThemeMode = "auto" | "light" | "dark";
export type ResolvedTuiThemeName = "light" | "dark";

export interface TuiTheme {
  name: ResolvedTuiThemeName;
  background: string;
  panel: string;
  panelAlt: string;
  headerBg: string;
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
  unread: string;
  star: string;
  dimRead: string;
}

const LIGHT: TuiTheme = {
  name: "light",
  background: "#f7f4ef",
  panel: "#fffdf8",
  panelAlt: "#ede7db",
  headerBg: "#213547",
  border: "#6b7d8f",
  primary: "#17212b",
  secondary: "#4d5d6c",
  muted: "#7a8793",
  accent: "#0b6f8a",
  accentStrong: "#005f73",
  ok: "#207a3c",
  warning: "#9b5d00",
  error: "#b42318",
  activeFg: "#fffdf8",
  activeBg: "#0b6f8a",
  sourceFg: "#fffdf8",
  sourceBg: "#7c3aed",
  selectedFg: "#fffdf8",
  selectedBg: "#213547",
  unread: "#0b6f8a",
  star: "#b7791f",
  dimRead: "#87919b",
};

const DARK: TuiTheme = {
  name: "dark",
  background: "#101418",
  panel: "#171c22",
  panelAlt: "#202832",
  headerBg: "#0c1117",
  border: "#3d5969",
  primary: "#edf2f7",
  secondary: "#b8c4cc",
  muted: "#7f8d98",
  accent: "#64d2ff",
  accentStrong: "#8bd5ca",
  ok: "#7ee787",
  warning: "#f2cc60",
  error: "#ff7b72",
  activeFg: "#071018",
  activeBg: "#64d2ff",
  sourceFg: "#071018",
  sourceBg: "#d2a8ff",
  selectedFg: "#ffffff",
  selectedBg: "#2d4f67",
  unread: "#64d2ff",
  star: "#f2cc60",
  dimRead: "#6f7b85",
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
  const forced = normalizeThemeMode(env["EMAILS_TUI_THEME"] ?? env["TUI_THEME"] ?? env["TERMINAL_THEME"]);
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
  if (mode === "auto") return "light";
  if (mode === "light") return "dark";
  return "auto";
}
