// Self-hosted-ONLY: the provider repo routes every read/write to `/v1/providers`
// (non-secret metadata only — credentials are never distributed to the client),
// so these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createProvider } from "../../db/providers.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerProviderCommands } from "./provider.js";

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

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
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
    // non-secret metadata to /v1, so a supplied api_key must not surface in the
    // listing.
    createProvider({
      name: "secret-provider",
      type: "resend",
      api_key: "provider-list-secret",
    });

    const result = await runProviderCommand(["provider", "list", "--limit", "1"]);
    const rows = result.data as Array<Record<string, unknown>>;

    expect(rows[0]?.name).toBe("secret-provider");
    expect(rows[0]).not.toHaveProperty("api_key");
    expect(rows[0]).not.toHaveProperty("secret_key");
    expect(rows[0]).not.toHaveProperty("oauth_refresh_token");
    expect(JSON.stringify(rows)).not.toContain("provider-list-secret");
  });
});
