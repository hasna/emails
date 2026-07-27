// Integration test: with an API-configured installation, address id-resolution AND the
// collapsed lifecycle writes (suspend/activate/quota) reach the /v1 HTTP API. The /v1 stub
// runs OUT OF PROCESS (see src/test-support/v1-stub.ts) — no in-process Bun.serve (that
// would deadlock the client's blocking `curl` calls) and no external infra, so it runs in
// CI.
//
// WHAT THIS FILE IS FOR NOW THAT THE FAMILY IS COLLAPSED, and it is not a duplicate of
// src/db/address-lifecycle.test.ts. That suite injects a store, which is the right way to
// pin behaviour but the wrong way to prove that CONFIGURATION reaches it: an injected store
// bypasses `createConfiguredEmailStore()` entirely. Every case here resolves its store from
// the environment the stub installs, so the assertions below are the ones that would still
// have failed if the collapse had been wired up correctly and then never reached.
//
// The two cases marked CHANGE DETECTOR are the ones that fail on a tree without this
// collapse, and they fail on BEHAVIOUR rather than on a missing module: the deleted API arm
// hard-coded today's send count to 0, so a per-address daily quota was unenforceable on
// exactly the configuration this file sets up.
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
import {
  activateAddress,
  countSendsToday,
  getAddressSendability,
  setAddressQuota,
  suspendAddress,
} from "./address-lifecycle.js";
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

/** One outbound row stamped inside the current UTC day. */
function sentToday(suffix: string, from: string) {
  const day = new Date().toISOString().slice(0, 10);
  const stamp = `${day}T12:00:00.000Z`;
  return {
    id: `22222222-3333-4444-8555-6666666${suffix}`,
    direction: "outbound",
    from_addr: from,
    to_addrs: ["recipient@example.com"],
    subject: "seed",
    status: "sent",
    received_at: stamp,
    created_at: stamp,
    updated_at: stamp,
  };
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

  test("suspend writes to /v1 and getAddressSendability reflects it", async () => {
    expect((await suspendAddress(ID)).status).toBe("suspended");
    expect(getAddress(ID)!.status).toBe("suspended");
    expect((await getAddressSendability(EMAIL)).sendable).toBe(false);
  });

  test("activate writes to /v1", async () => {
    await suspendAddress(ID);
    expect((await activateAddress(ID)).status).toBe("active");
    expect(getAddress(ID)!.status).toBe("active");
    expect((await getAddressSendability(EMAIL)).sendable).toBe(true);
  });

  test("setAddressQuota persists to /v1 and clears with null", async () => {
    expect((await setAddressQuota(ID, 5)).daily_quota).toBe(5);
    expect(getAddress(ID)!.daily_quota).toBe(5);
    expect((await setAddressQuota(ID, null)).daily_quota).toBeNull();
    expect(getAddress(ID)!.daily_quota).toBeNull();
  });

  test("setAddressQuota rejects a negative quota", async () => {
    await expect(setAddressQuota(ID, -1)).rejects.toThrow(/quota/i);
  });

  // CHANGE DETECTOR. `countSendsToday` used to be hard-coded to 0 on this configuration —
  // "the server owns send accounting, so the client reports 0" — which is a fabricated
  // number for a question about quota. It is now counted from the /v1 message stream.
  test("counts today's sends from /v1 instead of reporting a fabricated zero", async () => {
    await stub.seed({
      addresses: seededAddresses(),
      messages: [
        sentToday("m1", EMAIL),
        sentToday("m2", `"The CEO" <${EMAIL}>`),
        sentToday("m3", "someone-else@example.com"),
      ],
    });
    expect(await countSendsToday(EMAIL)).toBe(2);
    expect(await countSendsToday("someone-else@example.com")).toBe(1);
    expect(await countSendsToday("nobody@example.com")).toBe(0);
  });

  // CHANGE DETECTOR. With send accounting fabricated as 0, `used >= quota` was false for
  // every quota on this configuration, so a daily quota set through `emails address quota`
  // was silently unenforceable at the client gate. It is enforced now.
  test("enforces a daily quota on this configuration", async () => {
    await stub.seed({
      addresses: seededAddresses(),
      messages: [sentToday("m1", EMAIL), sentToday("m2", EMAIL)],
    });
    expect((await setAddressQuota(ID, 2)).daily_quota).toBe(2);

    const answer = await getAddressSendability(EMAIL);
    expect(answer.sendable).toBe(false);
    expect(answer.reason).toMatch(/quota/i);
    expect(answer.sent_today).toBe(2);
    expect(answer.daily_quota).toBe(2);
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
