// mode.ts is the self-hosted-ONLY client mode resolver. There is a single mode
// (`self_hosted`); the local/SQLite runtime and all config-file mode resolution
// were removed. resolveEmailsMode() now REQUIRES a complete self-hosted endpoint
// (EMAILS_SELF_HOSTED_URL + EMAILS_SELF_HOSTED_API_KEY, or an EMAILS_CLIENT_ENV_SECRET
// pointer) and fails loud otherwise. These tests cover the happy path, the mandatory
// config, rejection of removed modes/legacy env, and that no secret leaks or is
// loaded for a removed mode.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import {
  EMAILS_CLIENT_ENV_SECRET_ENV,
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  assertNoLegacyHostedEnvironment,
  getEmailsMode,
  labelForEmailsMode,
  normalizeEmailsMode,
  resolveEmailsMode,
} from "./mode.js";

const TMP_HOME = join("/tmp", `emails-mode-test-${process.pid}`);
const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_PATH = process.env["PATH"];

const ENV_KEYS = [
  EMAILS_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  EMAILS_CLIENT_ENV_SECRET_ENV,
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  // Legacy mode keys (must be rejected loudly).
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  // Legacy hosted credential keys (must be ignored, never select/redirect).
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

// A canonical, non-loopback self-hosted endpoint (HTTPS is mandatory off-loopback).
const SELF_HOSTED_URL = "https://emails.example.invalid";
const SELF_HOSTED_KEY = "not-a-real-key";

function setSelfHostedCredentials(): void {
  process.env["EMAILS_SELF_HOSTED_URL"] = SELF_HOSTED_URL;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = SELF_HOSTED_KEY;
}

// Install a `secrets` shim on PATH that returns a self_hosted client-env payload.
function installSelfHostedSecretsCommand(): void {
  const binDir = join(TMP_HOME, "bin");
  mkdirSync(binDir, { recursive: true });
  const secretsBin = join(binDir, "secrets");
  writeFileSync(
    secretsBin,
    `#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "hasna/xyz/opensource/emails/prod/client-env" ]; then
  printf '%s\\n' '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"${SELF_HOSTED_URL}","EMAILS_SELF_HOSTED_API_KEY":"${SELF_HOSTED_KEY}"}'
  exit 0
fi
exit 2
`,
  );
  chmodSync(secretsBin, 0o700);
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/xyz/opensource/emails/prod/client-env";
}

// Install a `secrets` shim that FAILS loudly if invoked — proves the loader is
// never reached (e.g. for a removed mode).
function installFailingSecretsCommand(): void {
  const binDir = join(TMP_HOME, "bin-fail");
  mkdirSync(binDir, { recursive: true });
  const secretsBin = join(binDir, "secrets");
  writeFileSync(
    secretsBin,
    `#!/bin/sh
echo "secrets command should not be called" >&2
exit 42
`,
  );
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
  resetSelfHostedConfigCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
  resetSelfHostedConfigCache();
});

describe("normalizeEmailsMode", () => {
  it("accepts only self_hosted (case-insensitive, trimmed)", () => {
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    expect(normalizeEmailsMode("  SELF_HOSTED  ")).toBe("self_hosted");
  });

  it("rejects every other value with a self-hosted-only message", () => {
    for (const value of ["local", "cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow("self-hosted-only");
    }
  });
});

describe("labelForEmailsMode / getEmailsMode", () => {
  it("labels the single mode as Self-hosted", () => {
    expect(labelForEmailsMode("self_hosted")).toBe("Self-hosted");
  });

  it("getEmailsMode returns self_hosted once configured", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(getEmailsMode()).toBe("self_hosted");
  });
});

describe("assertNoLegacyHostedEnvironment", () => {
  it("throws on legacy mode/storage-mode env vars", () => {
    for (const key of [
      "MAILERY_MODE",
      "HASNA_MAILERY_MODE",
      "MAILERY_STORAGE_MODE",
      "HASNA_MAILERY_STORAGE_MODE",
      "EMAILS_STORAGE_MODE",
      "HASNA_EMAILS_STORAGE_MODE",
    ]) {
      const env = { [key]: "cloud" } as NodeJS.ProcessEnv;
      expect(() => assertNoLegacyHostedEnvironment(env)).toThrow("removed hosted/legacy runtime");
    }
  });

  it("ignores legacy hosted API credentials (never throws on them)", () => {
    const env = {
      MAILERY_API_URL: "https://legacy.example",
      MAILERY_API_KEY: "legacy",
      HASNA_MAILERY_API_URL: "https://legacy.example",
      HASNA_MAILERY_API_KEY: "legacy",
    } as NodeJS.ProcessEnv;
    expect(() => assertNoLegacyHostedEnvironment(env)).not.toThrow();
  });
});

describe("resolveEmailsMode — self-hosted-only", () => {
  it("resolves self_hosted from explicit mode + mandatory URL and key", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(resolveEmailsMode()).toEqual({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV, value: "self_hosted" },
      warning: null,
    });
  });

  it("resolves self_hosted from credentials alone (mode is implicit)", () => {
    setSelfHostedCredentials();
    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV, value: "self_hosted" },
    });
  });

  it("accepts the Hasna-prefixed mode alias", () => {
    process.env[HASNA_EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    expect(resolveEmailsMode()).toMatchObject({ mode: "self_hosted", label: "Self-hosted" });
  });

  it("fails loud when no endpoint is configured", () => {
    expect(() => resolveEmailsMode()).toThrow("not configured");
    expect(() => resolveEmailsMode()).toThrow("EMAILS_SELF_HOSTED_URL");
  });

  it("fails loud when the mode is set but URL/key are missing", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    expect(() => resolveEmailsMode()).toThrow("not configured");
  });

  it("rejects the removed 'local' mode", () => {
    process.env[EMAILS_MODE_ENV] = "local";
    setSelfHostedCredentials();
    expect(() => resolveEmailsMode()).toThrow("self-hosted-only");
  });

  it("rejects removed cloud/remote/hybrid aliases", () => {
    for (const value of ["cloud", "remote", "hybrid"]) {
      process.env[EMAILS_MODE_ENV] = value;
      setSelfHostedCredentials();
      resetSelfHostedConfigCache();
      expect(() => resolveEmailsMode()).toThrow("self-hosted-only");
    }
  });

  it("rejects legacy Mailery/storage mode environment variables", () => {
    process.env["HASNA_MAILERY_STORAGE_MODE"] = "cloud";
    setSelfHostedCredentials();
    expect(() => resolveEmailsMode()).toThrow("removed hosted/legacy runtime");
  });

  it("ignores inherited hosted API credentials (they never configure the client)", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "not-a-real-key";
    // With no EMAILS_SELF_HOSTED_* the client stays unconfigured — legacy creds are inert.
    expect(() => resolveEmailsMode()).toThrow("not configured");
  });

  it("lets an explicit self_hosted endpoint override unrelated Mailery hosted credentials", () => {
    process.env[EMAILS_MODE_ENV] = "self_hosted";
    setSelfHostedCredentials();
    process.env["HASNA_MAILERY_API_URL"] = "https://mailery.example.invalid";
    process.env["HASNA_MAILERY_API_KEY"] = "old-mailery-key";
    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      source: { kind: "env", name: EMAILS_MODE_ENV },
    });
  });
});

describe("resolveEmailsMode — EMAILS_CLIENT_ENV_SECRET", () => {
  it("loads canonical self_hosted env from the client-env secret pointer", () => {
    installSelfHostedSecretsCommand();

    expect(resolveEmailsMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
      source: { kind: "env", name: EMAILS_CLIENT_ENV_SECRET_ENV },
    });
    // The pointer is expanded into the canonical env names.
    expect(process.env[EMAILS_MODE_ENV]).toBe("self_hosted");
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBe(SELF_HOSTED_URL);
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBe(SELF_HOSTED_KEY);
  });

  it("does not report the secret value on the error path or the resolution", () => {
    installSelfHostedSecretsCommand();
    const resolution = resolveEmailsMode();
    // The source carries the (non-secret) vault POINTER, never the key value.
    expect(JSON.stringify(resolution)).not.toContain(SELF_HOSTED_KEY);
    expect(resolution.source.value).toBe("hasna/xyz/opensource/emails/prod/client-env");
  });

  it("never invokes the secrets loader for the removed 'local' mode", () => {
    installFailingSecretsCommand();
    process.env[EMAILS_MODE_ENV] = "local";

    // Must throw the self-hosted-only rejection, NOT the secrets shim's exit 42.
    expect(() => resolveEmailsMode()).toThrow("self-hosted-only");
    // And the loader left the canonical credentials untouched.
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBeUndefined();
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();
  });
});
