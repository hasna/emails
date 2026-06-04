export type TuiThemeMode = "auto" | "light" | "dark";
export type ResolvedTuiThemeName = "light" | "dark";

export interface TuiTheme {
  name: ResolvedTuiThemeName;
  background: string;
  panel: string;
  panelAlt: string;
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
  unread: string;
  star: string;
  dimRead: string;
}

const LIGHT: TuiTheme = {
  name: "light",
  background: "#eef3f8",
  panel: "#ffffff",
  panelAlt: "#e6edf5",
  headerBg: "#0c1722",
  sidebarBg: "#102235",
  sidebarFg: "#edf6ff",
  sidebarMuted: "#88a5bc",
  metricBg: "#dbe8f5",
  border: "#b5c6d6",
  primary: "#142231",
  secondary: "#405466",
  muted: "#697d8e",
  accent: "#137985",
  accentStrong: "#215bb7",
  ok: "#237a4b",
  warning: "#9a5a00",
  error: "#b42318",
  activeFg: "#ffffff",
  activeBg: "#137985",
  sourceFg: "#ffffff",
  sourceBg: "#5d4bb7",
  selectedFg: "#ffffff",
  selectedBg: "#183b56",
  unread: "#215bb7",
  star: "#c47a00",
  dimRead: "#8a9aa8",
};

const DARK: TuiTheme = {
  name: "dark",
  background: "#090d14",
  panel: "#111821",
  panelAlt: "#192333",
  headerBg: "#050911",
  sidebarBg: "#0d1522",
  sidebarFg: "#e8f0f8",
  sidebarMuted: "#6f879d",
  metricBg: "#172436",
  border: "#2d4053",
  primary: "#edf4fb",
  secondary: "#b7c6d4",
  muted: "#7890a3",
  accent: "#5ad1c8",
  accentStrong: "#7aa8ff",
  ok: "#7ee2a8",
  warning: "#f5c76b",
  error: "#ff7b72",
  activeFg: "#061017",
  activeBg: "#5ad1c8",
  sourceFg: "#071018",
  sourceBg: "#b6a7ff",
  selectedFg: "#ffffff",
  selectedBg: "#24466b",
  unread: "#7aa8ff",
  star: "#f5c76b",
  dimRead: "#647486",
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
