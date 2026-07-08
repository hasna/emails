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
import { resetCloudConfigCache } from "../db/cloud-store.js";

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

describe("Mailery mode resolution", () => {
  it("uses local as the OSS default", () => {
    const resolved = resolveMaileryMode();
    expect(resolved).toMatchObject({
      mode: "local",
      label: "Local",
      source: { kind: "default" },
      warning: null,
    });
  });

  it("resolves the credential-only fleet flip (API URL + key, no *_MODE) as cloud", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.hasna.xyz";
    process.env["HASNA_MAILERY_API_KEY"] = "test_key";
    resetCloudConfigCache();
    try {
      const resolved = resolveMaileryMode();
      expect(resolved.mode).toBe("cloud");
      expect(resolved.label).toBe("Mailery Cloud");
    } finally {
      delete process.env["HASNA_MAILERY_API_URL"];
      delete process.env["HASNA_MAILERY_API_KEY"];
      resetCloudConfigCache();
    }
  });

  it("normalizes canonical and deprecated mode names", () => {
    expect(normalizeMaileryMode("local")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeMaileryMode("cloud")).toEqual({ mode: "cloud", deprecatedAlias: null });
    expect(normalizeMaileryMode("self-hosted")).toEqual({ mode: "cloud", deprecatedAlias: "self_hosted" });
    expect(normalizeMaileryMode("remote")).toEqual({ mode: "cloud", deprecatedAlias: "remote" });
    expect(normalizeMaileryMode("hybrid")).toEqual({ mode: "cloud", deprecatedAlias: "hybrid" });
  });

  it("normalizes deprecated deployment env aliases without mutating config", () => {
    process.env["MAILERY_MODE"] = "remote";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("cloud");
    expect(resolved.warning).toContain("Deprecated Mailery mode 'remote'");
    expect(resolved.warning).toContain("MAILERY_MODE=cloud");
    expect(loadConfig()).toEqual({});
  });

  it("does not treat storage sync env as the Mailery deployment mode", () => {
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("local");
    expect(resolved.warning).toBeNull();
    expect(loadConfig()).toEqual({});
  });

  it("observes legacy config mode values without migrating on read", () => {
    saveConfig({ storage_mode: "remote", other: "kept" });

    const resolved = resolveMaileryMode();

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: false,
    });
    expect(resolved.warning).toContain("Deprecated Mailery mode 'remote'");
    expect(loadConfig()).toEqual({ storage_mode: "remote", other: "kept" });
  });

  it("migrates legacy config mode values to mailery_mode=cloud", () => {
    saveConfig({ storage_mode: "remote", other: "kept" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: true,
    });
    expect(resolved.warning).toContain("Migrated deprecated Mailery mode 'remote'");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "cloud", other: "kept" });
  });

  it("migrates legacy config keys without treating canonical values as deprecated aliases", () => {
    saveConfig({ mode: "cloud" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: true,
    });
    expect(resolved.warning).toBe("Migrated deprecated Mailery mode config key 'mode' to 'mailery_mode=cloud'.");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "cloud" });
  });

  it("rejects unknown mode values with canonical guidance", () => {
    saveConfig({ mailery_mode: "remoteish" });

    expect(() => resolveMaileryMode()).toThrow("Use local or cloud");
  });
});
