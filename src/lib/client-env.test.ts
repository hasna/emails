import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMAILS_CLIENT_ENV_SECRET_ENV, loadEmailsClientEnvSecret } from "./client-env.js";

const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_HOME = process.env["HOME"];
const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  EMAILS_CLIENT_ENV_SECRET_ENV,
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
