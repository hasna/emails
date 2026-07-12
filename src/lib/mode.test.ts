import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "./config.js";
import {
  EMAILS_MODE_CONFIG_KEY,
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  normalizeEmailsMode,
  resolveEmailsMode,
} from "./mode.js";

const TMP_HOME = join("/tmp", `emails-mode-test-${process.pid}`);
const ORIGINAL_HOME = process.env["HOME"];
const ENV_KEYS = [
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
] as const;

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("Emails mode resolution", () => {
  it("defaults to local", () => {
    expect(resolveEmailsMode()).toEqual({
      mode: "local",
      label: "Local",
      source: { kind: "default", name: null, value: null },
      warning: null,
    });
  });

  it("accepts exactly local and self_hosted", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow("No cloud, remote, or hybrid alias is supported");
    }
  });

  it("resolves self_hosted only from an explicit Emails mode setting", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV },
    });
  });

  it("rejects legacy Mailery and storage-mode environment variables", () => {
    process.env["HASNA_MAILERY_STORAGE_MODE"] = "cloud";
    expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
  });

  it("rejects inherited hosted API credentials instead of silently redirecting", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "not-a-real-key";
    expect(() => resolveEmailsMode()).toThrow("HASNA_MAILERY_API_URL");
  });

  it("lets explicit Emails self_hosted client env override unrelated Mailery hosted credentials", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.invalid";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "not-a-real-key";
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "old-mailery-key";

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV },
    });
  });

  it("lets explicit Hasna-prefixed self_hosted client env override unrelated Mailery hosted credentials", () => {
    process.env[HASNA_EMAILS_MODE_ENV] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.invalid";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "not-a-real-key";
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "old-mailery-key";

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: HASNA_EMAILS_MODE_ENV },
    });
  });

  it("rejects legacy config keys with migration guidance", () => {
    saveConfig({ storage_mode: "remote" });
    expect(() => resolveEmailsMode()).toThrow("config key 'storage_mode'");
  });

  it("reads the canonical config key without rewriting it", () => {
    saveConfig({ [EMAILS_MODE_CONFIG_KEY]: "self_hosted" });
    expect(resolveEmailsMode()).toMatchObject({ mode: "self_hosted", source: { kind: "config" } });
  });
});
