import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import {
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  MAILERY_MODE_CONFIG_KEY,
  MAILERY_MODE_ENV,
  normalizeMaileryMode,
  resolveMaileryMode,
} from "./mode.js";

const TMP_HOME = join("/tmp", `mailery-mode-test-${process.pid}`);
const ORIGINAL_HOME = process.env["HOME"];
const MODE_ENV = [
  MAILERY_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_DATABASE_URL",
] as const;

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  for (const key of MODE_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of MODE_ENV) delete process.env[key];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("Emails mode resolution", () => {
  it("uses local as the OSS default", () => {
    const resolved = resolveMaileryMode();
    expect(resolved).toMatchObject({
      mode: "local",
      label: "Local",
      source: { kind: "default" },
      warning: null,
    });
  });

  it("normalizes canonical and deprecated mode names", () => {
    expect(normalizeMaileryMode("local")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeMaileryMode("self-hosted")).toEqual({ mode: "cloud", deprecatedAlias: null });
    expect(normalizeMaileryMode("cloud")).toEqual({ mode: "cloud", deprecatedAlias: "cloud" });
    expect(() => normalizeMaileryMode("remote")).toThrow("Use local or self_hosted");
    expect(() => normalizeMaileryMode("hybrid")).toThrow("Use local or self_hosted");
  });

  it("normalizes deprecated cloud deployment env aliases without mutating config", () => {
    process.env["HASNA_EMAILS_MODE"] = "cloud";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("cloud");
    expect(resolved.warning).toContain("Deprecated Emails mode 'cloud'");
    expect(resolved.warning).toContain("HASNA_EMAILS_MODE=self_hosted");
    expect(loadConfig()).toEqual({});
  });

  it("does not treat storage sync env as the Emails deployment mode", () => {
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("local");
    expect(resolved.warning).toBeNull();
    expect(loadConfig()).toEqual({});
  });

  it("observes legacy config mode values without migrating on read", () => {
    saveConfig({ storage_mode: "cloud", other: "kept" });

    const resolved = resolveMaileryMode();

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: false,
    });
    expect(resolved.warning).toContain("Deprecated Emails mode 'cloud'");
    expect(loadConfig()).toEqual({ storage_mode: "cloud", other: "kept" });
  });

  it("migrates legacy config mode values to emails_mode=self_hosted", () => {
    saveConfig({ storage_mode: "cloud", other: "kept" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: true,
    });
    expect(resolved.warning).toContain("Migrated deprecated Emails mode 'cloud'");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "self_hosted", other: "kept" });
  });

  it("migrates legacy config keys to the supported self_hosted spelling", () => {
    saveConfig({ mode: "self_hosted" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: true,
    });
    expect(resolved.warning).toBe("Migrated deprecated Emails mode config key 'mode' to 'emails_mode=self_hosted'.");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "self_hosted" });
  });

  it("rejects unknown mode values with canonical guidance", () => {
    saveConfig({ emails_mode: "remoteish" });

    expect(() => resolveMaileryMode()).toThrow("Use local or self_hosted");
  });
});
