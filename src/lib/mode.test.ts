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

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

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

  it("normalizes the two canonical mode names", () => {
    expect(normalizeMaileryMode("local")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeMaileryMode("self_hosted")).toEqual({ mode: "self_hosted", deprecatedAlias: null });
    expect(normalizeMaileryMode("self-hosted")).toEqual({ mode: "self_hosted", deprecatedAlias: null });
  });

  it("rejects removed cloud, remote, and hybrid product modes", () => {
    for (const value of ["cloud", "mailery_cloud", "remote", "hybrid"]) {
      expect(() => normalizeMaileryMode(value)).toThrow("Use local or self_hosted");
    }
  });

  it("rejects removed deployment env modes without mutating config", () => {
    setEnv("MAILERY_MODE", "remote");

    expect(() => resolveMaileryMode({ migrateConfig: true })).toThrow("Cloud, remote, and hybrid product modes were removed");
    expect(loadConfig()).toEqual({});
  });

  it("does not treat storage sync env as the Emails deployment mode", () => {
    setEnv("HASNA_EMAILS_STORAGE_MODE", "remote");

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("local");
    expect(resolved.warning).toBeNull();
    expect(loadConfig()).toEqual({});
  });

  it("observes self_hosted config mode values without migrating on read", () => {
    saveConfig({ storage_mode: "self_hosted", other: "kept" });

    const resolved = resolveMaileryMode();

    expect(resolved).toMatchObject({
      mode: "self_hosted",
      migratedConfig: false,
      warning: null,
    });
    expect(loadConfig()).toEqual({ storage_mode: "self_hosted", other: "kept" });
  });

  it("migrates legacy config keys to mailery_mode=self_hosted", () => {
    saveConfig({ storage_mode: "self_hosted", other: "kept" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "self_hosted",
      migratedConfig: true,
    });
    expect(resolved.warning).toBe("Migrated legacy Emails mode config key 'storage_mode' to 'mailery_mode=self_hosted'.");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "self_hosted", other: "kept" });
  });

  it("rejects removed config modes instead of migrating them to a third mode", () => {
    saveConfig({ mode: "cloud" });

    expect(() => resolveMaileryMode({ migrateConfig: true })).toThrow("Use local or self_hosted");
    expect(loadConfig()).toEqual({ mode: "cloud" });
  });

  it("rejects unknown mode values with canonical guidance", () => {
    saveConfig({ mailery_mode: "remoteish" });

    expect(() => resolveMaileryMode()).toThrow("Use local or self_hosted");
  });
});
