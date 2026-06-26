import { describe, expect, it } from "bun:test";
import { detectSystemTheme, nextThemeMode, normalizeThemeMode, resolveTheme, resolveThemeName } from "./theme.js";
import { resolveSolidTheme, selectedForeground } from "../tui-solid/context/theme.js";

describe("tui theme", () => {
  it("defaults to light (Catppuccin Latte) when no system signal is available", () => {
    expect(detectSystemTheme({})).toBe("light");
    expect(resolveThemeName("auto", {})).toBe("light");
    expect(resolveTheme("auto", {}).name).toBe("light");
  });

  it("uses the Catppuccin Latte palette for the light theme", () => {
    const light = resolveTheme("light", {}, "light");
    expect(light.name).toBe("light");
    expect(light.background).toBe("#eff1f5"); // Latte base
    expect(light.accent).toBe("#1e66f5"); // Latte blue
    expect(light.selectionBg).toBe("#1e66f5");
    expect(light.error).toBe("#d20f39"); // Latte red
    expect(light.ok).toBe("#40a02b"); // Latte green
    expect(light.unreadBadgeBg).toBe("#1e66f5");

    const solidLight = resolveSolidTheme("light", {});
    expect(solidLight.background).toBe("#eff1f5");
    expect(solidLight.primary).toBe("#1e66f5");
    expect(solidLight.text).toBe("#4c4f69"); // Latte text
    expect(solidLight.markdownHeading).toBe("#8839ef"); // Latte mauve
  });

  it("detects dark and light terminal backgrounds from COLORFGBG", () => {
    expect(detectSystemTheme({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectSystemTheme({ COLORFGBG: "0;15" })).toBe("light");
  });

  it("allows explicit environment theme overrides", () => {
    expect(resolveThemeName("auto", { EMAILS_TUI_THEME: "dark" })).toBe("dark");
    expect(resolveThemeName("auto", { TUI_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
  });

  it("normalizes and cycles persisted theme modes", () => {
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("weird")).toBe("auto");
    expect(nextThemeMode("auto")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("light");
    expect(nextThemeMode("light")).toBe("auto");
  });

  it("keeps dark action and unread colors readable", () => {
    const dark = resolveTheme("dark", {}, "dark");
    expect(dark.listUnreadFg).toBe("#ffffff");
    expect(dark.unread).toBe("#ffffff");
    expect(dark.unreadBadgeFg).toBe("#0a0a0a");
    expect(dark.unreadBadgeBg).toBe("#fcd53a");
    expect(dark.buttonFg).toBe("#ededed");
    expect(dark.buttonBg).toBe("#050505");
  });

  it("maps the Solid TUI theme to open-aicopilot default dark roles", () => {
    const dark = resolveSolidTheme("dark", {});
    expect(dark.background).toBe("#0a0a0a");
    expect(dark.backgroundPanel).toBe("#141414");
    expect(dark.backgroundElement).toBe("#1e1e1e");
    expect(dark.backgroundMenu).toBe("#1e1e1e");
    expect(dark.primary).toBe("#fab283");
    expect(dark.secondary).toBe("#5c9cf5");
    expect(dark.accent).toBe("#9d7cd8");
    expect(dark.text).toBe("#eeeeee");
    expect(dark.textMuted).toBe("#808080");
    expect(dark.selectedListItemText).toBe("#0a0a0a");
    expect(dark.markdownHeading).toBe("#9d7cd8");
    expect(dark.markdownLink).toBe("#fab283");
    expect(dark.markdownLinkText).toBe("#56b6c2");
    expect(dark.markdownCode).toBe("#7fd88f");
    expect(dark.markdownBlockQuote).toBe("#e5c07b");
    expect(dark.markdownStrong).toBe("#f5a742");
    expect(selectedForeground(dark, dark.primary)).toBe("#0a0a0a");
  });
});
