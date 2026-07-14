// Self-hosted (self_hosted) routing for the address CLI. With the client pointed
// at the operator's `/v1` API, `emails addresses` must READ from that HTTP API
// (there is no local SQLite island anymore). This locks in the mission-alignment
// fix where `addresses` used to show empty LOCAL state in self-hosted mode.
//
// The self-hosted store performs its HTTP call with a SYNCHRONOUS `curl`
// (spawnSync), which blocks Bun's event loop — so the stand-in for the operator
// `/v1` API runs OUT OF PROCESS (an in-process server would deadlock). See
// src/test-support/v1-stub.ts. No module mocks are used, so the real transport
// path is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerAddressCommands } from "./address.js";

let stub: V1Stub;

async function runAddressCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAddressCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

// Server-only subcommands fail loud: handleError() logs to console.error then
// process.exit(1). Stub both so the exit is observable.
async function runAddressCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAddressCommand(args);
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
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("address CLI — self-hosted (/v1) routing", () => {
  it("`addresses` reads from the /v1 API", async () => {
    await stub.seed({
      addresses: [
        { id: crypto.randomUUID(), email: "cloud-a@example.com", status: "active", verified: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: crypto.randomUUID(), email: "cloud-b@example.com", status: "active", verified: false, created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const { data } = await runAddressCommand(["addresses"]);
    const addresses = data as Array<{ email: string }>;
    expect(addresses.map((a) => a.email).sort()).toEqual(["cloud-a@example.com", "cloud-b@example.com"]);
  });

  it("reports an empty configuration when the /v1 API has no addresses", async () => {
    const { data, out } = await runAddressCommand(["addresses"]);
    expect((data as Array<{ email: string }>) ?? []).toEqual([]);
    expect(out).toContain("No addresses configured.");
  });

  it("blocks server-only address lifecycle commands", async () => {
    for (const args of [
      ["address", "provision", "agent@example.com", "--provider", "prov-1"],
      ["address", "owner", "agent@example.com"],
    ]) {
      const result = await runAddressCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("is not available in the self-hosted client; it runs on the self-hosted server.");
    }
  });
});
