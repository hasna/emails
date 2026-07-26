// Self-hosted-ONLY: the provider repo routes every read/write to `/v1/providers`
// (non-secret metadata only — credentials are never distributed to the client),
// so these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createProvider } from "../../db/providers.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerProviderCommands } from "./provider.js";
import { setLogLevel } from "../../lib/logger.js";

let stub: V1Stub;

async function runProviderCommand(args: string[]) {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerProviderCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: [...logs, ...out].join("\n") };
  } finally {
    console.log = originalLog;
  }
}

// Commands that fail loud call handleError() -> console.error + process.exit(1).
// Stub both so the exit and the message are observable.
async function runProviderCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => { throw new Error(`process.exit:${code ?? 0}`); }) as typeof process.exit;
  try {
    await runProviderCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  // setLogLevel is process-global; a prior suite leaving it quiet would silence
  // the very lines these tests assert on.
  setLogLevel(false, false);
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("provider check command", () => {
  it("reports when no providers are configured", async () => {
    const result = await runProviderCommand(["provider", "check"]);

    expect(result.out).toContain("No providers configured.");
    expect(result.out).toContain("emails provider add --type ses");
  });
});

describe("provider list command", () => {
  it("paginates providers", async () => {
    const providers = [];
    for (let i = 1; i <= 4; i++) {
      const stamp = `2026-01-0${i}T00:00:00.000Z`;
      providers.push({
        id: crypto.randomUUID(),
        name: `provider-${i}`,
        type: "sandbox",
        region: null,
        active: true,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    await stub.seed({ providers });

    const result = await runProviderCommand(["provider", "list", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("provider-3");
    expect(result.out).toContain("provider-2");
    expect(result.out).not.toContain("provider-4");
    expect(result.data).toMatchObject([
      { name: "provider-3" },
      { name: "provider-2" },
    ]);
  });

  it("returns credential-free provider rows", async () => {
    // Credentials are never distributed to the client: the repo only ever sends
    // non-secret metadata to /v1, so no secret column may surface in a listing.
    createProvider({ name: "metadata-provider", type: "resend" });

    const result = await runProviderCommand(["provider", "list", "--limit", "1"]);
    const rows = result.data as Array<Record<string, unknown>>;

    expect(rows[0]?.name).toBe("metadata-provider");
    expect(rows[0]).not.toHaveProperty("api_key");
    expect(rows[0]).not.toHaveProperty("secret_key");
    expect(rows[0]).not.toHaveProperty("oauth_refresh_token");
  });
});

describe("provider add credential honesty (self_hosted)", () => {
  // 2026-07-25: `emails provider add --type ses --access-key … --secret-key …`
  // reported "Provider credentials are invalid" and sending kept using the ECS
  // task role. Both statements were false: the credentials were stripped by the
  // client before they ever reached the server, and the server has nowhere to
  // put them. The command must now say exactly that, and must NOT create a row.
  it("refuses SES credentials and names where they belong", async () => {
    const before = await runProviderCommand(["provider", "list"]);
    expect(before.out).toContain("No providers configured");

    const result = await runProviderCommandExpectingExit([
      "provider", "add", "--name", "transactional-ses", "--type", "ses",
      "--region", "us-east-1", "--access-key", "AKIAEXAMPLE", "--secret-key", "s3cr3t",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("does not store per-provider credentials");
    expect(result.stderr).toContain("EMAILS_SES_ACCESS_KEY_ID");
    expect(result.stderr).toContain("EMAILS_SES_SECRET_ACCESS_KEY");
    // The false accusation is gone.
    expect(result.stderr).not.toContain("credentials are invalid");
    // …and the supplied secret is never echoed back.
    expect(result.stderr).not.toContain("s3cr3t");
    expect(result.stderr).not.toContain("AKIAEXAMPLE");

    const after = await runProviderCommand(["provider", "list"]);
    expect(after.out).toContain("No providers configured");
  });

  it("refuses a Resend API key the same way", async () => {
    const result = await runProviderCommandExpectingExit([
      "provider", "add", "--name", "resend", "--type", "resend", "--api-key", "re_example",
    ]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("does not store per-provider credentials (api_key)");
    expect(result.stderr).toContain("RESEND_API_KEY");
    expect(result.stderr).not.toContain("re_example");
  });

  it("registers credential-free metadata and says the credentials were NOT validated", async () => {
    // No credentials to check and the server holds the real ones, so the command
    // must not imply it verified anything against the provider API.
    const result = await runProviderCommand([
      "provider", "add", "--name", "server-side-ses", "--type", "ses", "--region", "us-east-1",
    ]);

    expect(result.out).toContain("Provider created: server-side-ses");
    expect(result.out).toContain("credentials were not validated");
    expect(result.out).not.toContain("Credentials validated");
  });
});
