// Integration test: with the self-hosted-ONLY client, address id-resolution AND
// lifecycle writes (suspend/activate/quota) route to the /v1 HTTP API. The client
// makes blocking `curl` calls, so the /v1 stub runs OUT OF PROCESS (see
// src/test-support/v1-stub.ts) — no in-process Bun.serve (that would deadlock) and
// no external infra, so it runs in CI.
//
// Migrated from a bespoke inline stub onto the shared startV1Stub helper. Notes on
// DELETED coverage:
//   - Every `localAddressCount()` assertion checked that the deleted local SQLite
//     `addresses` island stayed empty. There is no local island anymore, so those
//     "no split-brain" checks are removed; the round-trips through /v1 remain.
//   - resolvePartialId / resolvePartialIdOrThrow (from the deleted database.ts) were
//     replaced by resolveResourceId / resolveResourceIdOrThrow (no db handle, resource
//     name as the first arg); the id-resolution test is migrated to those.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { resolveResourceId, resolveResourceIdOrThrow } from "./self-hosted-store.js";
import { getAddress, listAddresses } from "./addresses.js";
import { activateAddress, getAddressSendability, setAddressQuota, suspendAddress } from "./address-lifecycle.js";
import { registerAddressCommands } from "../cli/commands/address.js";

const ID = "11111111-2222-4333-8444-555555555555";
const EMAIL = "ceo@example.com";

/** One active, verified address — restored by stub.reset() before each test. */
function seededAddresses() {
  return [
    {
      id: ID,
      email: EMAIL,
      display_name: "CEO",
      status: "active",
      verified: true,
      daily_quota: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
}

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub({ seed: { addresses: seededAddresses() } });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("address self-hosted routing (self_hosted)", () => {
  test("listAddresses reads the /v1 dataset", () => {
    expect(listAddresses().map((a) => a.id)).toContain(ID);
  });

  test("resolveResourceId resolves a short id against the /v1 dataset", () => {
    expect(resolveResourceId("addresses", ID.slice(0, 8))).toBe(ID);
    expect(resolveResourceIdOrThrow("addresses", ID.slice(0, 8))).toBe(ID);
  });

  test("suspend writes to /v1 and getAddressSendability reflects it", () => {
    expect(suspendAddress(ID).status).toBe("suspended");
    expect(getAddress(ID)!.status).toBe("suspended");
    expect(getAddressSendability(EMAIL).sendable).toBe(false);
  });

  test("activate writes to /v1", () => {
    suspendAddress(ID);
    expect(activateAddress(ID).status).toBe("active");
    expect(getAddress(ID)!.status).toBe("active");
    expect(getAddressSendability(EMAIL).sendable).toBe(true);
  });

  test("setAddressQuota persists to /v1 and clears with null", () => {
    expect(setAddressQuota(ID, 5).daily_quota).toBe(5);
    expect(getAddress(ID)!.daily_quota).toBe(5);
    expect(setAddressQuota(ID, null).daily_quota).toBeNull();
    expect(getAddress(ID)!.daily_quota).toBeNull();
  });

  test("setAddressQuota rejects a negative quota", () => {
    expect(() => setAddressQuota(ID, -1)).toThrow(/quota/i);
  });

  // Regression: `address verify` must report the /v1 address record's `verified`
  // flag directly (no local provider lookup that would fail on a flipped machine).
  test("verify reports the /v1 address verified state (no local provider)", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const program = new Command();
      program.exitOverride();
      registerAddressCommands(program, () => {});
      await program.parseAsync(["node", "emails", "address", "verify", EMAIL]);
    } finally {
      console.log = original;
    }
    const out = logs.join("\n");
    expect(out).toContain(`${EMAIL} is verified`);
    expect(out).not.toContain("Provider not found");
  });
});
