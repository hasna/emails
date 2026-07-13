import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SelfHostedTransportError, selfHostedStoreFor, isSelfHostedMode, resetSelfHostedConfigCache, resolveSelfHostedConfig } from "./self-hosted-store.js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_CLIENT_ENV_SECRET",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT",
  "EMAILS_SELF_HOSTED_HTTP_TIMEOUT",
  "DATABASE_URL",
  "EMAILS_DATABASE_URL",
  "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_API_SIGNING_KEY",
  "HASNA_MAILERY_API_SIGNING_KEY",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "MAILERY_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "CLOUDFLARE_API_KEY",
];
const ORIGINAL_PATH = process.env["PATH"];
let tempDirs: string[] = [];

function clearEnv(): void {
  for (const key of KEYS) delete process.env[key];
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  resetSelfHostedConfigCache();
}

function installFakeSecrets(payload: string): void {
  const dir = mkdtempSync(join(tmpdir(), "emails-client-env-test-"));
  tempDirs.push(dir);
  const bin = join(dir, "secrets");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "hasna/test/opensource/emails/prod/client-env" ]; then
  printf '%s\\n' '${payload}'
  exit 0
fi
exit 2
`);
  chmodSync(bin, 0o700);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
  process.env["EMAILS_CLIENT_ENV_SECRET"] = "hasna/test/opensource/emails/prod/client-env";
}

function installFakeCurl(): { argsPath: string; stdinPath: string; envPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "emails-curl-test-"));
  tempDirs.push(dir);
  const argsPath = join(dir, "curl-args.txt");
  const stdinPath = join(dir, "curl-stdin.txt");
  const envPath = join(dir, "curl-env.txt");
  const bin = join(dir, "curl");
  writeFileSync(bin, `#!/bin/sh
ARGS_PATH=${JSON.stringify(argsPath)}
STDIN_PATH=${JSON.stringify(stdinPath)}
ENV_PATH=${JSON.stringify(envPath)}
printf '%s\\n' "$@" > "$ARGS_PATH"
env | sort > "$ENV_PATH"
cat > "$STDIN_PATH"
printf '%s\\n%s' '{"domain":{"id":"domain-1","domain":"example.com"}}' '201'
`);
  chmodSync(bin, 0o700);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
  return { argsPath, stdinPath, envPath };
}

describe("Emails self-hosted client resolver", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("unset env fails loud: the client is not configured", () => {
    // Self-hosted-ONLY: there is no local fallback. Missing config throws (never null).
    expect(() => resolveSelfHostedConfig()).toThrow("not configured");
    expect(() => resolveSelfHostedConfig()).toThrow("EMAILS_SELF_HOSTED_URL");
    // The client is always self-hosted; there is no other mode.
    expect(isSelfHostedMode()).toBe(true);
    // Building a store resolves the mandatory config first, so it fails loud too.
    expect(() => selfHostedStoreFor("domains")).toThrow("not configured");
  });

  test("requires explicit self_hosted mode, URL, and key", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    expect(() => resolveSelfHostedConfig()).toThrow("EMAILS_SELF_HOSTED_API_KEY");
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    resetSelfHostedConfigCache();
    expect(() => resolveSelfHostedConfig()).toThrow("EMAILS_SELF_HOSTED_URL");
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    resetSelfHostedConfigCache();
    expect(resolveSelfHostedConfig()?.baseUrl).toBe("https://emails.example/v1");
  });

  test("EMAILS_CLIENT_ENV_SECRET configures direct self-hosted resource resolution", () => {
    installFakeSecrets('{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example","EMAILS_SELF_HOSTED_API_KEY":"test-token"}');

    expect(resolveSelfHostedConfig()?.baseUrl).toBe("https://emails.example/v1");
    expect(isSelfHostedMode()).toBe(true);
    expect(selfHostedStoreFor("domains")).not.toBeNull();
  });

  test("rejects the removed 'local' mode without loading EMAILS_CLIENT_ENV_SECRET", () => {
    installFakeSecrets('{"EMAILS_MODE":"self_hosted","EMAILS_SELF_HOSTED_URL":"https://emails.example","EMAILS_SELF_HOSTED_API_KEY":"test-token"}');
    process.env["EMAILS_MODE"] = "local";

    // 'local' is a removed mode in the self-hosted-only client — fail loud.
    expect(() => resolveSelfHostedConfig()).toThrow("unsupported EMAILS_MODE 'local'");
    // The secret pointer is NOT resolved for an explicit local mode: env untouched.
    expect(process.env["EMAILS_SELF_HOSTED_URL"]).toBeUndefined();
    expect(process.env["EMAILS_SELF_HOSTED_API_KEY"]).toBeUndefined();
  });

  test("legacy Mailery client env is ignored (never configures the client)", () => {
    process.env["HASNA_MAILERY_API_URL"] = "https://legacy-mailery.example";
    process.env["HASNA_MAILERY_API_KEY"] = "legacy-token";

    // Legacy hosted vars never supply EMAILS_SELF_HOSTED_URL/KEY — still unconfigured.
    expect(() => resolveSelfHostedConfig()).toThrow("not configured");
    expect(() => selfHostedStoreFor("domains")).toThrow("not configured");
  });

  test("credentials alone configure the client (mode is optional / implicit)", () => {
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    // Self-hosted-ONLY: URL + key are sufficient; EMAILS_MODE defaults to self_hosted.
    expect(resolveSelfHostedConfig()?.baseUrl).toBe("https://emails.example/v1");
    expect(isSelfHostedMode()).toBe(true);
    expect(selfHostedStoreFor("domains")).not.toBeNull();
  });

  test("rejects the removed 'local' mode even when credentials are present", () => {
    process.env["EMAILS_MODE"] = "local";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://stale-emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "stale-key";
    expect(() => resolveSelfHostedConfig()).toThrow("unsupported EMAILS_MODE 'local'");

    clearEnv();
    process.env["HASNA_EMAILS_MODE"] = "local";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://stale-emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "stale-key";
    expect(() => resolveSelfHostedConfig()).toThrow("unsupported EMAILS_MODE 'local'");
  });

  test("rejects removed mode aliases and non-loopback plaintext HTTP", () => {
    process.env["EMAILS_MODE"] = "cloud";
    expect(() => resolveSelfHostedConfig()).toThrow("unsupported EMAILS_MODE 'cloud'");
    expect(() => resolveSelfHostedConfig()).toThrow("self-hosted-only");
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://192.0.2.1:8080";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    resetSelfHostedConfigCache();
    expect(() => resolveSelfHostedConfig()).toThrow("must use https");
  });

  test("transport fails fast and never includes the API key", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:9";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-secret-value";
    process.env["EMAILS_SELF_HOSTED_HTTP_CONNECT_TIMEOUT"] = "1";
    process.env["EMAILS_SELF_HOSTED_HTTP_TIMEOUT"] = "2";
    resetSelfHostedConfigCache();
    const store = selfHostedStoreFor("domains")!;
    let thrown: unknown;
    try {
      store.list({ limit: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SelfHostedTransportError);
    expect(String(thrown)).not.toContain("test-secret-value");
  });

  test("curl bridge passes API key and request body through stdin config instead of temp files or argv", () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-secret-value";
    process.env["EMAILS_CLIENT_ENV_SECRET"] = "hasna/test/opensource/emails/prod/client-env";
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
    resetSelfHostedConfigCache();
    const capture = installFakeCurl();

    const created = selfHostedStoreFor("domains")!.create({ domain: "example.com", note: "line\nbreak" });

    expect(created).toMatchObject({ id: "domain-1", domain: "example.com" });
    const args = readFileSync(capture.argsPath, "utf8");
    const stdin = readFileSync(capture.stdinPath, "utf8");
    const argv = args.split(/\r?\n/).filter(Boolean);
    expect(argv.slice(0, 3)).toEqual(["-q", "-K", "-"]);
    expect(args).not.toContain("test-secret-value");
    expect(args).not.toContain("emails-self-hosted");
    expect(stdin).toContain("Authorization: Bearer test-secret-value");
    expect(stdin).toContain("data-binary = ");
    expect(stdin).toContain("example.com");
    expect(stdin).not.toContain("body.json");
    expect(stdin).not.toContain("data-binary = \"@");

    const childEnvKeys = new Set(
      readFileSync(capture.envPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split("=", 1)[0]),
    );
    for (const key of [
      "EMAILS_SELF_HOSTED_API_KEY",
      "EMAILS_CLIENT_ENV_SECRET",
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
});
