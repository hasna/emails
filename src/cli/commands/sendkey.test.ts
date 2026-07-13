// Self-hosted-ONLY: the send-keys resource is summary-only (the secret key_hash
// never leaves the server). Listing/revoking/checking route to `/v1`, so these
// tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). Minting a key still fails loud because it runs on
// the authoritative self-hosted server. No local SQLite exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSendKeyCommands } from "./sendkey.js";

let stub: V1Stub;
const OWNER_ID = "owner-sendkey-agent";

async function runSendKeyCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSendKeyCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runSendKeyCommandExpectingError(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = ((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  registerSendKeyCommands(program, () => {});
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } catch {
    // handleError exits via the stubbed process.exit (or commander throws).
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
  return errors.join("\n");
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

describe("sendkey list command", () => {
  it("paginates send keys and displays owner names without leaking hashes", async () => {
    await stub.seed({
      owners: [{
        id: OWNER_ID,
        type: "agent",
        name: "sendkey-agent",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
      "send-keys": [0, 1, 2, 3, 4].map((i) => ({
        id: `sk-${i}`,
        owner_id: OWNER_ID,
        prefix: `pf${i}`,
        label: `key-${i}`,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        last_used_at: null,
        revoked_at: null,
      })),
    });

    const result = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<Record<string, unknown> & { label: string | null; owner_id: string }>;

    expect(data.map((key) => key.label)).toEqual(["key-3", "key-2"]);
    expect(data.every((key) => key.owner_id === OWNER_ID)).toBe(true);
    expect(data.every((key) => !("key_hash" in key))).toBe(true);
    expect(result.out).toContain("sendkey-agent");
    expect(result.out).not.toContain("key-4");
  });
});

describe("sendkey create command", () => {
  it("fails loud because minting a send key runs on the self-hosted server", async () => {
    await stub.seed({
      owners: [{
        id: "o-1",
        type: "agent",
        name: "sk-owner",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
    });

    const errors = await runSendKeyCommandExpectingError(["sendkey", "create", "sk-owner"]);

    expect(errors).toContain(
      "Creating a send key is not available in the self-hosted client; it runs on the self-hosted server.",
    );
  });
});
