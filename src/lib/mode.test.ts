import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "./config.js";
import {
  EMAILS_CLIENT_ENV_SECRET_ENV,
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
  EMAILS_CLIENT_ENV_SECRET_ENV,
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
] as const;
const ORIGINAL_PATH = process.env["PATH"];
const LEGACY_CONFIG_MODE_KEYS = ["mailery_mode", "mode", "storage_mode"] as const;

function installFailingSecretsCommand(): void {
  const binDir = join(TMP_HOME, "bin-fail");
  mkdirSync(binDir, { recursive: true });
  const secretsBin = join(binDir, "secrets");
  writeFileSync(secretsBin, `#!/bin/sh
echo "secrets command should not be called" >&2
exit 42
`);
  chmodSync(secretsBin, 0o700);
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";
}

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
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

  it("ignores inherited hosted API credentials instead of redirecting or poisoning local mode", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "not-a-real-key";
    expect(resolveEmailsMode()).toEqual({
      mode: "local",
      label: "Local",
      source: { kind: "default", name: null, value: null },
      warning: null,
    });
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

  it("loads canonical self_hosted env from EMAILS_CLIENT_ENV_SECRET", () => {
    const binDir = join(TMP_HOME, "bin");
    mkdirSync(binDir, { recursive: true });
    const secretsBin = join(binDir, "secrets");
    writeFileSync(secretsBin, `#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "hasna/xyz/opensource/emails/prod/client-env" ]; then
  printf '%s\n' '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid","EMAILS_SELF_HOSTED_API_KEY":"not-a-real-key"}'
  exit 0
fi
exit 2
`);
    chmodSync(secretsBin, 0o700);
    process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_CLIENT_ENV_SECRET_ENV },
    });
    expect(process.env[EMAILS_MODE_ENV]).toBe("self_hosted");
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBe("https://emails.example.invalid");
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBe("not-a-real-key");
  });

  it("lets EMAILS_CLIENT_ENV_SECRET override unrelated Mailery hosted credentials", () => {
    const binDir = join(TMP_HOME, "bin");
    mkdirSync(binDir, { recursive: true });
    const secretsBin = join(binDir, "secrets");
    writeFileSync(secretsBin, `#!/bin/sh
printf '%s\n' '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid","EMAILS_SELF_HOSTED_API_KEY":"not-a-real-key"}'
`);
    chmodSync(secretsBin, 0o700);
    process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "old-mailery-key";

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_CLIENT_ENV_SECRET_ENV },
    });
  });

  it("does not load EMAILS_CLIENT_ENV_SECRET when EMAILS_MODE is explicitly local", () => {
    installFailingSecretsCommand();
    process.env[EMAILS_MODE_ENV] = "local";

    expect(resolveEmailsMode()).toEqual({
      mode: "local",
      label: "Local",
      source: { kind: "env", name: EMAILS_MODE_ENV, value: "local" },
      warning: null,
    });
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBeUndefined();
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();
  });

  it("does not load EMAILS_CLIENT_ENV_SECRET when HASNA_EMAILS_MODE is explicitly local", () => {
    installFailingSecretsCommand();
    process.env[HASNA_EMAILS_MODE_ENV] = "local";

    expect(resolveEmailsMode()).toEqual({
      mode: "local",
      label: "Local",
      source: { kind: "env", name: HASNA_EMAILS_MODE_ENV, value: "local" },
      warning: null,
    });
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBeUndefined();
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();
  });

  it("rejects self_hosted from local config mode keys with client-env guidance", () => {
    for (const key of [EMAILS_MODE_CONFIG_KEY, ...LEGACY_CONFIG_MODE_KEYS] as const) {
      saveConfig({ [key]: "self_hosted" });
      expect(() => resolveEmailsMode()).toThrow(`config key '${key}' value 'self_hosted'`);
      expect(() => resolveEmailsMode()).toThrow("cannot select self_hosted from local config");
      expect(() => resolveEmailsMode()).toThrow("EMAILS_CLIENT_ENV_SECRET");
    }
  });

  it("rejects legacy config mode aliases with migration guidance", () => {
    for (const key of LEGACY_CONFIG_MODE_KEYS) {
      saveConfig({ [key]: "remote" });
      expect(() => resolveEmailsMode()).toThrow(`config key '${key}' value 'remote'`);
      expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
    }
  });

  it("rejects removed mode values from the canonical config key with migration guidance", () => {
    saveConfig({ [EMAILS_MODE_CONFIG_KEY]: "remote" });
    expect(() => resolveEmailsMode()).toThrow(`config key '${EMAILS_MODE_CONFIG_KEY}' value 'remote'`);
    expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
  });

  it("lets explicit local env mode override self_hosted config values", () => {
    for (const envKey of [EMAILS_MODE_ENV, HASNA_EMAILS_MODE_ENV] as const) {
      for (const key of [EMAILS_MODE_CONFIG_KEY, ...LEGACY_CONFIG_MODE_KEYS] as const) {
        saveConfig({ [key]: "self_hosted" });
        process.env[envKey] = "local";

        expect(resolveEmailsMode()).toEqual({
          mode: "local",
          label: "Local",
          source: { kind: "env", name: envKey, value: "local" },
          warning: null,
        });

        delete process.env[envKey];
      }
    }
  });

  it("reads local from the canonical config key without rewriting it", () => {
    saveConfig({ [EMAILS_MODE_CONFIG_KEY]: "local" });
    expect(resolveEmailsMode()).toEqual({
      mode: "local",
      label: "Local",
      source: { kind: "config", name: EMAILS_MODE_CONFIG_KEY, value: "local" },
      warning: null,
    });
  });

  it("reads local from legacy local config aliases without selecting self_hosted", () => {
    for (const key of LEGACY_CONFIG_MODE_KEYS) {
      saveConfig({ [key]: "local" });
      expect(resolveEmailsMode()).toEqual({
        mode: "local",
        label: "Local",
        source: { kind: "config", name: key, value: "local" },
        warning: null,
      });
    }
  });
});
