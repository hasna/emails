// Self-hosted-ONLY: status/quota transitions PATCH /v1/addresses/<id> via the
// addresses repo, and sendability reads the /v1 address record. The per-address
// daily send ledger (`emails`) is NOT part of the /v1 address model, so send
// accounting is server-owned and the client reports 0. Exercised against the
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Notes on DELETED coverage:
//   - The former quota-enforcement tests ("over daily quota → not sendable",
//     "counts display-name sent rows toward daily quota", "counts today's sends
//     for many addresses with one grouped query", "countSendsToday ignores
//     yesterday's sends") all relied on the LOCAL `emails` send ledger and on
//     inspecting the emitted SQL ("GROUP BY", "sent_at LIKE"). That ledger and the
//     SQL are gone; send accounting is server-owned. The replacement asserts the
//     client-side zeroed accounting behavior directly.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createAddress, getAddress } from "./addresses.js";
import {
  suspendAddress, activateAddress, setAddressQuota,
  getAddressSendability, countSendsToday, countSendsTodayByAddress,
} from "./address-lifecycle.js";

const providerId = "prov-ses";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("address lifecycle — suspend / activate", () => {
  it("new addresses default to active", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(getAddress(a.id)!.status).toBe("active");
  });

  it("suspends and reactivates an address", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(suspendAddress(a.id).status).toBe("suspended");
    expect(getAddress(a.id)!.status).toBe("suspended");
    expect(activateAddress(a.id).status).toBe("active");
  });

  it("throws on unknown address", () => {
    expect(() => suspendAddress("nope")).toThrow();
  });
});

describe("address lifecycle — quota", () => {
  it("stores and clears a daily quota", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(setAddressQuota(a.id, 50).daily_quota).toBe(50);
    expect(setAddressQuota(a.id, null).daily_quota).toBeNull();
  });

  it("rejects a negative quota", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(() => setAddressQuota(a.id, -1)).toThrow();
  });
});

describe("address lifecycle — sendability", () => {
  it("active, no quota → sendable", () => {
    createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(getAddressSendability("a@x.com").sendable).toBe(true);
  });

  it("unknown address → sendable (no registered restriction)", () => {
    expect(getAddressSendability("ghost@x.com").sendable).toBe(true);
  });

  it("suspended → not sendable", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    suspendAddress(a.id);
    const s = getAddressSendability("a@x.com");
    expect(s.sendable).toBe(false);
    expect(s.reason).toMatch(/suspend/i);
  });

  it("send accounting is server-owned so the client counts zero", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    // A quota is stored, but the client has no local ledger to count against, so
    // usage resolves to 0 and the address stays sendable (the server enforces the
    // real quota during send).
    setAddressQuota(a.id, 2);
    expect(countSendsToday("a@x.com")).toBe(0);
    expect(countSendsToday('"A Team" <a@x.com>')).toBe(0);
    expect([...countSendsTodayByAddress(["a@x.com", "b@x.com"]).values()]).toEqual([0, 0]);
    expect(getAddressSendability("a@x.com").sendable).toBe(true);
  });
});

describe("address lifecycle — case-insensitive enforcement", () => {
  it("a suspended Mixed-Case address blocks a lowercase send", () => {
    const a = createAddress({ provider_id: providerId, email: "Ceo@x.com" });
    suspendAddress(a.id);
    expect(getAddressSendability("ceo@x.com").sendable).toBe(false);
    expect(getAddressSendability("CEO@X.COM").sendable).toBe(false);
  });
});
