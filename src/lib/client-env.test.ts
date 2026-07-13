import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMAILS_CLIENT_ENV_SECRET_ENV,
  EMAILS_SESSION_TOKEN_ENV,
  clearClientEnvSessionToken,
  loadEmailsClientEnvSecret,
  persistClientEnvSessionToken,
} from "./client-env.js";

const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_HOME = process.env["HOME"];
const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  EMAILS_CLIENT_ENV_SECRET_ENV,
  EMAILS_SESSION_TOKEN_ENV,
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "DATABASE_URL",
  "EMAILS_DATABASE_URL",
  "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_API_SIGNING_KEY",
  "HASNA_MAILERY_API_SIGNING_KEY",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "MAILERY_API_KEY",
  "HASNA_MAILERY_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "CLOUDFLARE_API_KEY",
  "HASNA_SECRETS_STORAGE_MODE",
  "HASNA_SECRETS_API_URL",
  "HASNA_SECRETS_API_KEY",
  "SECRETS_BACKEND",
] as const;

let tempDirs: string[] = [];

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
}

function installCapturingSecretsCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "emails-client-env-scrub-test-"));
  tempDirs.push(dir);
  const envPath = join(dir, "secrets-env.txt");
  const bin = join(dir, "secrets");
  writeFileSync(bin, `#!/bin/sh
ENV_PATH=${JSON.stringify(envPath)}
env | sort > "$ENV_PATH"
if [ "$1" = "get" ] && [ "$2" = "hasna/test/opensource/emails/prod/client-env" ]; then
  printf '%s\\n' '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid","EMAILS_SELF_HOSTED_API_KEY":"loaded-client-key"}'
  exit 0
fi
exit 2
`);
  chmodSync(bin, 0o700);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
  return envPath;
}

// A fake `secrets` that returns a fixed JSON blob for any `get`, else exits 2.
function installStaticSecretsCommand(getJson: string): void {
  const dir = mkdtempSync(join(tmpdir(), "emails-client-env-static-"));
  tempDirs.push(dir);
  const bin = join(dir, "secrets");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "get" ]; then
  printf '%s\\n' ${JSON.stringify(getJson)}
  exit 0
fi
exit 2
`);
  chmodSync(bin, 0o700);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
}

// A fake `secrets` backed by a JSON file so get/set round-trips (persist tests).
function installVaultBackedSecretsCommand(initialJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "emails-client-env-vault-"));
  tempDirs.push(dir);
  const storePath = join(dir, "store.json");
  writeFileSync(storePath, initialJson);
  const bin = join(dir, "secrets");
  writeFileSync(bin, `#!/bin/sh
STORE=${JSON.stringify(storePath)}
if [ "$1" = "get" ]; then
  if [ -f "$STORE" ]; then cat "$STORE"; exit 0; else exit 2; fi
fi
if [ "$1" = "set" ]; then
  printf '%s' "$3" > "$STORE"
  exit 0
fi
exit 2
`);
  chmodSync(bin, 0o700);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
  return storePath;
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("Emails client-env loader", () => {
  it("runs secrets get with a scrubbed environment", () => {
    const envPath = installCapturingSecretsCommand();
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "stale-self-hosted-key-must-not-pass";
    process.env["DATABASE_URL"] = "postgres://database-url-must-not-pass";
    process.env["EMAILS_DATABASE_URL"] = "postgres://emails-database-url-must-not-pass";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://hasna-emails-database-url-must-not-pass";
    process.env["EMAILS_API_SIGNING_KEY"] = "signing-key-must-not-pass";
    process.env["HASNA_MAILERY_API_SIGNING_KEY"] = "legacy-signing-key-must-not-pass";
    process.env["RESEND_API_KEY"] = "provider-key-must-not-pass";
    process.env["RESEND_WEBHOOK_SECRET"] = "provider-webhook-secret-must-not-pass";
    process.env["MAILERY_API_KEY"] = "legacy-provider-key-must-not-pass";
    process.env["HASNA_MAILERY_API_KEY"] = "legacy-hasna-provider-key-must-not-pass";
    process.env["AWS_ACCESS_KEY_ID"] = "aws-access-key-must-not-pass";
    process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret-key-must-not-pass";
    process.env["AWS_SESSION_TOKEN"] = "aws-session-token-must-not-pass";
    process.env["AWS_PROFILE"] = "aws-profile-must-not-pass";
    process.env["CLOUDFLARE_API_KEY"] = "dns-provider-key-must-not-pass";

    const loaded = loadEmailsClientEnvSecret();

    expect(loaded).toEqual({
      secretPath: "hasna/test/opensource/emails/prod/client-env",
      loaded: true,
      ready: true,
    });
    expect(process.env["EMAILS_MODE"]).toBe("self_hosted");
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBe("https://emails.example.invalid");
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBe("loaded-client-key");

    const childEnvKeys = new Set(
      readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split("=", 1)[0]),
    );
    for (const key of [
      "EMAILS_SELF_HOSTED_API_KEY",
      EMAILS_CLIENT_ENV_SECRET_ENV,
      "DATABASE_URL",
      "EMAILS_DATABASE_URL",
      "HASNA_EMAILS_DATABASE_URL",
      "EMAILS_API_SIGNING_KEY",
      "HASNA_MAILERY_API_SIGNING_KEY",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
      "MAILERY_API_KEY",
      "HASNA_MAILERY_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "CLOUDFLARE_API_KEY",
    ]) {
      expect(childEnvKeys.has(key)).toBe(false);
    }
  });

  it("loads an optional EMAILS_SESSION_TOKEN from the vault entry when present", () => {
    installStaticSecretsCommand(
      '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid",' +
        '"EMAILS_SELF_HOSTED_API_KEY":"loaded-client-key","EMAILS_SESSION_TOKEN":"emss_from_vault"}',
    );
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";

    const loaded = loadEmailsClientEnvSecret();

    expect(loaded.ready).toBe(true);
    expect(process.env[EMAILS_SESSION_TOKEN_ENV]).toBe("emss_from_vault");
  });

  it("accepts a session-token-only vault entry (no API key required)", () => {
    installStaticSecretsCommand(
      '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid",' +
        '"EMAILS_SESSION_TOKEN":"emss_only"}',
    );
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";

    const loaded = loadEmailsClientEnvSecret();

    expect(loaded.ready).toBe(true);
    expect(process.env[EMAILS_SESSION_TOKEN_ENV]).toBe("emss_only");
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();
  });

  it("fails loud when the vault entry has neither an API key nor a session token", () => {
    installStaticSecretsCommand(
      '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid"}',
    );
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";

    expect(() => loadEmailsClientEnvSecret()).toThrow("EMAILS_SELF_HOSTED_API_KEY or EMAILS_SESSION_TOKEN");
  });

  it("persists a session token into env and merges it into the vault entry", () => {
    const storePath = installVaultBackedSecretsCommand(
      '{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example.invalid","EMAILS_SELF_HOSTED_API_KEY":"op-key"}',
    );
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";

    const result = persistClientEnvSessionToken("emss_new_session");

    expect(result.scope).toBe("vault");
    expect(process.env[EMAILS_SESSION_TOKEN_ENV]).toBe("emss_new_session");
    const stored = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>;
    expect(stored[EMAILS_SESSION_TOKEN_ENV]).toBe("emss_new_session");
    // The pre-existing keys are preserved through the merge.
    expect(stored["EMAILS_SELF_HOSTED_API_KEY"]).toBe("op-key");
    expect(stored["EMAILS_SELF_HOSTED_URL"]).toBe("https://emails.example.invalid");

    // Clearing removes it from env and the vault entry.
    const cleared = clearClientEnvSessionToken();
    expect(cleared.scope).toBe("vault");
    expect(process.env[EMAILS_SESSION_TOKEN_ENV]).toBeUndefined();
    const after = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>;
    expect(after[EMAILS_SESSION_TOKEN_ENV]).toBeUndefined();
    expect(after["EMAILS_SELF_HOSTED_API_KEY"]).toBe("op-key");
  });

  it("persists to the process env only when no vault pointer is configured", () => {
    const result = persistClientEnvSessionToken("emss_process_only");
    expect(result.scope).toBe("process");
    expect(result.secretPath).toBeNull();
    expect(process.env[EMAILS_SESSION_TOKEN_ENV]).toBe("emss_process_only");
  });

  it("passes secrets-tooling backend config through so the vault is reachable", () => {
    // Regression: the loader previously scrubbed HASNA_SECRETS_*/SECRETS_* too,
    // so `secrets get` fell back to the empty local store in a cloud-vault setup
    // and the pointer failed to load ("Not found"). These backend-config vars
    // MUST reach the child so the configured vault is resolvable.
    const envPath = installCapturingSecretsCommand();
    process.env[EMAILS_CLIENT_ENV_SECRET_ENV] = "hasna/test/opensource/emails/prod/client-env";
    process.env["HASNA_SECRETS_STORAGE_MODE"] = "cloud";
    process.env["HASNA_SECRETS_API_URL"] = "https://secrets.example.invalid";
    process.env["HASNA_SECRETS_API_KEY"] = "vault-auth-key-must-pass";
    process.env["SECRETS_BACKEND"] = "cloud";

    const loaded = loadEmailsClientEnvSecret();

    expect(loaded.ready).toBe(true);
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBe("loaded-client-key");

    const childEnvKeys = new Set(
      readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split("=", 1)[0]),
    );
    for (const key of [
      "HASNA_SECRETS_STORAGE_MODE",
      "HASNA_SECRETS_API_URL",
      "HASNA_SECRETS_API_KEY",
      "SECRETS_BACKEND",
    ]) {
      expect(childEnvKeys.has(key)).toBe(true);
    }
  });
});
