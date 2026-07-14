// Self-hosted-ONLY: the addresses repo routes every read/write to the /v1
// `addresses` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts for why the stub must
// run in a separate process).
//
// Migrated from the deleted local-SQLite pattern. Notes on behavior that changed
// with the self-hosted model:
//   - The /v1 address entity does NOT persist provider_id (the operator model
//     keys addresses by email, not by a local provider row). createAddress carries
//     the caller's provider through on the RETURNED entity, but stored rows have no
//     provider dimension. Every test that exercises provider filtering therefore
//     SEEDS rows with an explicit provider_id instead of relying on createAddress.
//   - Ordering-sensitive tests seed explicit created_at (create sets created_at≈now
//     so freshly-created rows tie).
//   - Readiness keys off verified + not-suspended (the rich local DKIM/SPF/domain
//     lifecycle join does not exist over /v1), so the readiness expectations reflect
//     that simplified model rather than the old SQL join.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  countAddressesForReadiness,
  createAddress,
  findAddressesByEmail,
  getAddress,
  getAddressByEmail,
  listAddressEmails,
  listActiveAddressCountsByDomain,
  listActiveAddressEmails,
  getPreferredActiveAddressEmail,
  listAddresses,
  listAddressesByProviderIds,
  listAddressesForReadiness,
  listUsableSendingAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./addresses.js";
import { AddressNotFoundError } from "../types/index.js";

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

const PROVIDER = "prov-1";

/** A snake_case /v1 address row with the fields apiToAddress reads. */
function addr(row: {
  id: string;
  email: string;
  provider_id?: string;
  verified?: boolean;
  status?: string;
  created_at?: string;
}): Record<string, unknown> {
  const ts = row.created_at ?? "2026-01-01T00:00:00.000Z";
  return {
    id: row.id,
    email: row.email,
    provider_id: row.provider_id ?? null,
    verified: row.verified ?? false,
    status: row.status ?? "active",
    owner_id: null,
    administrator_id: null,
    daily_quota: null,
    created_at: ts,
    updated_at: ts,
  };
}

describe("createAddress", () => {
  it("creates an address with verified=false", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    expect(a.id).toHaveLength(36);
    expect(a.email).toBe("test@example.com");
    // provider_id is carried through on the returned entity (not persisted over /v1).
    expect(a.provider_id).toBe(PROVIDER);
    expect(a.verified).toBe(false);
    expect(a.display_name).toBeNull();
  });

  it("stores display_name when provided", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "no-reply@example.com", display_name: "No Reply" });
    expect(a.display_name).toBe("No Reply");
  });
});

describe("getAddress", () => {
  it("retrieves address by id", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    const found = getAddress(a.id);
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown id", () => {
    expect(getAddress("nonexistent")).toBeNull();
  });
});

describe("getAddressByEmail", () => {
  it("finds address by email (provider is not part of the self-hosted identity)", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    const found = getAddressByEmail(PROVIDER, "test@example.com");
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown email", () => {
    expect(getAddressByEmail(PROVIDER, "unknown@example.com")).toBeNull();
  });
});

describe("findAddressesByEmail", () => {
  it("finds addresses case-insensitively", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "Ops@Example.com" }),
        addr({ id: "a2", email: "ops@example.com" }),
      ],
    });

    const matches = findAddressesByEmail("OPS@example.COM");
    expect(matches.map((address) => address.id).sort()).toEqual(["a1", "a2"]);
  });
});

describe("listAddresses", () => {
  it("lists all addresses", () => {
    createAddress({ provider_id: PROVIDER, email: "a@example.com" });
    createAddress({ provider_id: PROVIDER, email: "b@example.com" });
    expect(listAddresses().length).toBe(2);
  });

  it("filters by provider_id", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "a@example.com", provider_id: "p1" }),
        addr({ id: "a2", email: "b@example.com", provider_id: "p2" }),
      ],
    });
    expect(listAddresses("p1").length).toBe(1);
    expect(listAddresses("p2").length).toBe(1);
  });

  it("paginates addresses", async () => {
    await stub.seed({
      addresses: Array.from({ length: 5 }, (_v, i) =>
        addr({ id: `a${i}`, email: `page-${i}@example.com`, provider_id: "p1", created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    });

    expect(listAddresses("p1", { limit: 2 })).toHaveLength(2);
    expect(listAddresses("p1", { limit: 2, offset: 2 })).toHaveLength(2);
  });

  it("lists addresses for multiple providers in one query", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "first@example.com", provider_id: "p1" }),
        addr({ id: "a2", email: "second@example.com", provider_id: "p2" }),
        addr({ id: "a3", email: "unrelated@example.com", provider_id: "p3" }),
      ],
    });

    const addresses = listAddressesByProviderIds(["p1", "p2", "p1"]);

    expect(addresses.map((address) => address.id).sort()).toEqual(["a1", "a2"]);
    expect(listAddressesByProviderIds([])).toEqual([]);
  });
});

describe("listAddressEmails", () => {
  it("lists email strings and supports provider filtering", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "first@example.com", provider_id: "p1" }),
        addr({ id: "a2", email: "second@example.com", provider_id: "p2" }),
      ],
    });

    expect(listAddressEmails(undefined).sort()).toEqual(["first@example.com", "second@example.com"]);
    expect(listAddressEmails("p2")).toEqual(["second@example.com"]);
  });
});

describe("listActiveAddressEmails", () => {
  it("lists active email strings and supports provider filtering", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "first@example.com", provider_id: "p1", status: "active" }),
        addr({ id: "a2", email: "suspended@example.com", provider_id: "p1", status: "suspended" }),
        addr({ id: "a3", email: "second@example.com", provider_id: "p2", status: "active" }),
      ],
    });

    expect(listActiveAddressEmails(undefined).sort()).toEqual(["first@example.com", "second@example.com"]);
    expect(listActiveAddressEmails("p1")).toEqual(["first@example.com"]);
  });
});

describe("listActiveAddressCountsByDomain", () => {
  it("groups active address counts by normalized domain", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a1", email: "first@example.com", status: "active" }),
        addr({ id: "a2", email: "second@Example.com", status: "active" }),
        addr({ id: "a3", email: "suspended@example.com", status: "suspended" }),
        addr({ id: "a4", email: "ops@other.com", status: "active" }),
      ],
    });

    const counts = listActiveAddressCountsByDomain();

    expect(counts.get("example.com")).toBe(2);
    expect(counts.get("other.com")).toBe(1);
  });
});

describe("listAddressesForReadiness / countAddressesForReadiness", () => {
  it("filters, counts, and paginates by verified + not-suspended over /v1", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "a", email: "verified-a@x.com", provider_id: "p1", verified: true, status: "active", created_at: "2026-01-04T00:00:00.000Z" }),
        addr({ id: "b", email: "verified-b@x.com", provider_id: "p1", verified: true, status: "active", created_at: "2026-01-03T00:00:00.000Z" }),
        addr({ id: "c", email: "unverified-c@x.com", provider_id: "p1", verified: false, status: "active", created_at: "2026-01-02T00:00:00.000Z" }),
        addr({ id: "d", email: "suspended-d@x.com", provider_id: "p1", verified: true, status: "suspended", created_at: "2026-01-01T00:00:00.000Z" }),
        addr({ id: "e", email: "other-e@x.com", provider_id: "p2", verified: true, status: "active", created_at: "2026-01-05T00:00:00.000Z" }),
      ],
    });

    // Default (no include_unverified): only send-ready (verified & not-suspended).
    expect(countAddressesForReadiness({ provider_id: "p1" })).toBe(2);
    expect(countAddressesForReadiness({ provider_id: "p1", send: true })).toBe(2);
    // receive-ready implied by send-ready under the default filter.
    expect(countAddressesForReadiness({ provider_id: "p1", receive: true })).toBe(2);
    // include_unverified opens the gate: receive-ready = not-suspended (a, b, c).
    expect(countAddressesForReadiness({ provider_id: "p1", receive: true, include_unverified: true })).toBe(3);
    expect(countAddressesForReadiness({ provider_id: "p1", include_unverified: true })).toBe(4);

    expect(listAddressesForReadiness({ provider_id: "p1", limit: 1, offset: 1 }).map((a) => a.email))
      .toEqual(["verified-b@x.com"]);
    expect(listAddressesForReadiness({ provider_id: "p1", receive: true, include_unverified: true }).map((a) => a.email))
      .toEqual(["verified-a@x.com", "verified-b@x.com", "unverified-c@x.com"]);
  });
});

describe("getPreferredActiveAddressEmail", () => {
  it("prefers verified active senders and applies provider/domain filters", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "f", email: "fallback@example.com", provider_id: "p1", verified: false, status: "active", created_at: "2026-01-01T00:00:00.000Z" }),
        addr({ id: "v", email: "verified@example.com", provider_id: "p1", verified: true, status: "active", created_at: "2026-01-02T00:00:00.000Z" }),
        addr({ id: "s", email: "suspended@example.com", provider_id: "p1", verified: true, status: "suspended", created_at: "2026-01-03T00:00:00.000Z" }),
        addr({ id: "o", email: "other@example.net", provider_id: "p2", verified: false, status: "active", created_at: "2026-01-04T00:00:00.000Z" }),
      ],
    });

    expect(getPreferredActiveAddressEmail()).toBe("verified@example.com");
    expect(getPreferredActiveAddressEmail({ provider_id: "p2" })).toBe("other@example.net");
    expect(getPreferredActiveAddressEmail({ domain: "example.com" })).toBe("verified@example.com");
    expect(getPreferredActiveAddressEmail({ domain: "missing.com" })).toBeNull();
  });
});

describe("listUsableSendingAddresses", () => {
  it("returns verified non-suspended addresses only", async () => {
    await stub.seed({
      addresses: [
        addr({ id: "u", email: "usable@example.com", verified: true, status: "active" }),
        addr({ id: "s", email: "suspended@example.com", verified: true, status: "suspended" }),
        addr({ id: "p", email: "pending@example.com", verified: false, status: "active" }),
      ],
    });

    const addresses = listUsableSendingAddresses();
    expect(addresses.map((address) => address.email)).toEqual(["usable@example.com"]);
    expect(addresses.some((address) => address.id === "p")).toBe(false);
  });

  it("can limit usable sender rows", async () => {
    await stub.seed({
      addresses: Array.from({ length: 5 }, (_v, i) =>
        addr({ id: `u${i}`, email: `usable-${i}@example.com`, verified: true, status: "active", created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    });

    expect(listUsableSendingAddresses({ limit: 3 })).toHaveLength(3);
  });
});

describe("updateAddress", () => {
  it("updates display_name", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    const updated = updateAddress(a.id, { display_name: "Updated" });
    expect(updated.display_name).toBe("Updated");
  });

  it("updates verified status", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    const updated = updateAddress(a.id, { verified: true });
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => updateAddress("nonexistent", { verified: true })).toThrow(AddressNotFoundError);
  });
});

describe("deleteAddress", () => {
  it("deletes an address", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    expect(deleteAddress(a.id)).toBe(true);
    expect(getAddress(a.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteAddress("nonexistent")).toBe(false);
  });
});

describe("markVerified", () => {
  it("marks address as verified", () => {
    const a = createAddress({ provider_id: PROVIDER, email: "test@example.com" });
    expect(a.verified).toBe(false);
    const updated = markVerified(a.id);
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => markVerified("nonexistent")).toThrow(AddressNotFoundError);
  });
});
