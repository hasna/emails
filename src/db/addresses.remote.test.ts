// The address clamp defect, live in production TODAY. Every list-shaped read in
// src/db/addresses.remote.ts took ONE `/v1/addresses` page and treated it as the
// table: `listAddresses()` with no limit sent NO limit at all — the server then
// windows to its 100-row default (clampLimit in src/server/self-hosted/store.ts)
// — and every other read sent `limit: 1000`, which the same clamp caps at 500.
// Production holds 325 real addresses, so `listAddresses()` returned 100 of 325
// AS IF COMPLETE, `getAddressByEmail` deduped against the first 500 rows only
// (a false null there is what mints a duplicate address), and every count above
// 500 was silently wrong.
//
// The fix routes every read through the shared pager
// (src/db/self-hosted-page.ts enumerateSelfHostedRows): full enumeration for
// unbounded reads and counts, a bounded `need` for windowed reads, and an
// honest refusal when the pager can neither prove completeness nor fill the
// window it was asked for — the contract src/db/events.remote.ts established.
//
// STUB FIDELITY THESE TESTS DEPEND ON: the v1 stub used to return EVERY row
// when the request carried no `limit` param, which made the live 100-of-325
// defect invisible here; the stub now mirrors the production 100-row default.
// The stub keeps INSERTION order for addresses while the real service orders
// `created_at DESC, id ASC`, so every seed below is written newest-first — the
// stub then hands back the same windows production would.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  countAddressesForReadiness,
  findAddressesByEmail,
  getAddressByEmail,
  getPreferredActiveAddressEmail,
  listActiveAddressCountsByDomain,
  listActiveAddressCountsByDomains,
  listActiveAddressEmails,
  listAddressEmails,
  listAddresses,
  listAddressesByProviderIds,
  listAddressesForReadiness,
  listUsableSendingAddresses,
} from "./addresses.js";
import { SELF_HOSTED_ENUMERATION_PAGE_BUDGET, SELF_HOSTED_SERVER_PAGE_MAX } from "./self-hosted-page.js";

let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

const PROVIDER = "prov-1";

/** Base timestamp for newest-first seeds; row N is N seconds older than row 0. */
const NEWEST = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * `count` /v1 address rows, NEWEST FIRST (descending created_at in insertion
 * order — see the stub-fidelity note at the top of this file). `shape` lets a
 * test vary a row by index without re-writing the whole seed.
 */
function addressRows(
  count: number,
  shape: (index: number) => Partial<Record<string, unknown>> = () => ({}),
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const ts = new Date(NEWEST - index * 1000).toISOString();
    return {
      id: `addr-${String(index).padStart(6, "0")}`,
      email: `user${index}@example.com`,
      provider_id: PROVIDER,
      verified: true,
      status: "active",
      owner_id: null,
      administrator_id: null,
      daily_quota: null,
      created_at: ts,
      updated_at: ts,
      ...shape(index),
    };
  });
}

describe("listAddresses reads past one server page", () => {
  // THE live defect, at production's exact size: 325 rows, no limit asked for,
  // 100 returned as if that were the table.
  it("returns all 325 production-shaped rows, not the server's 100-row default window", async () => {
    await stub.seed({ addresses: addressRows(325) });

    expect(listAddresses()).toHaveLength(325);
  });

  it("returns every row past the 500-row page cap when asked for everything", async () => {
    await stub.seed({ addresses: addressRows(1200) });

    const rows = listAddresses();
    expect(rows).toHaveLength(1200);
    expect(new Set(rows.map((a) => a.id)).size).toBe(1200);
  });

  // The clamp trap: `limit: 600` used to be sent as one `max(1000, 600)` request,
  // the server capped it at 500, and the local slice returned 500 rows for a
  // 600-row window — a bounded read quietly shorter than what it was asked for.
  it("fills a bounded window past the page cap instead of slicing a clamped page", async () => {
    await stub.seed({ addresses: addressRows(700) });

    const rows = listAddresses(undefined, { limit: 600 });
    expect(rows).toHaveLength(600);
    // Newest-first, and genuinely the FIRST 600 of the table's declared order.
    expect(rows[0]!.id).toBe("addr-000000");
    expect(rows[599]!.id).toBe("addr-000599");
  });

  it("fills a window that starts past the page cap instead of returning nothing", async () => {
    await stub.seed({ addresses: addressRows(700) });

    const rows = listAddresses(undefined, { limit: 100, offset: 550 });
    expect(rows).toHaveLength(100);
    expect(rows[0]!.id).toBe("addr-000550");
    expect(rows[99]!.id).toBe("addr-000649");
  });

  // provider_id is a client-side filter (the /v1 address entity declares no
  // server-side filters), so the window must be counted in rows KEPT, not rows
  // read: only every other row matches here, and one 500-row page holds only
  // ~250 of the 550 asked for.
  it("fills a bounded window whose provider filter drops half of every page", async () => {
    await stub.seed({ addresses: addressRows(1200, (i) => ({ provider_id: i % 2 === 0 ? "prov-a" : "prov-b" })) });

    const rows = listAddresses("prov-a", { limit: 550 });
    expect(rows).toHaveLength(550);
    expect(rows.every((a) => a.provider_id === "prov-a")).toBe(true);
  });

  it("answers a bounded read the table is too small to fill", async () => {
    await stub.seed({ addresses: addressRows(60) });

    expect(listAddresses(undefined, { limit: 100 })).toHaveLength(60);
  });
});

describe("address lookups that must see the whole table", () => {
  // getAddressByEmail is what `address add` dedupes against. A row past the
  // first 500 used to come back null, and that null minted a DUPLICATE address.
  it("getAddressByEmail finds a row past the first server page", async () => {
    await stub.seed({ addresses: addressRows(520) });

    const found = getAddressByEmail(PROVIDER, "user519@example.com");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("addr-000519");
  });

  it("findAddressesByEmail returns matches on both sides of the page cap", async () => {
    await stub.seed({
      addresses: addressRows(520, (i) => (i === 10 || i === 519 ? { email: "dup@example.com" } : {})),
    });

    const rows = findAddressesByEmail("dup@example.com");
    expect(rows.map((a) => a.id).sort()).toEqual(["addr-000010", "addr-000519"]);
  });

  it("listAddressesByProviderIds sees a provider whose rows all sit past the page cap", async () => {
    await stub.seed({ addresses: addressRows(620, (i) => (i >= 600 ? { provider_id: "prov-z" } : {})) });

    const rows = listAddressesByProviderIds(["prov-z"]);
    expect(rows).toHaveLength(20);
    expect(rows.every((a) => a.provider_id === "prov-z")).toBe(true);
  });

  // getPreferredActiveAddressEmail ranks verified above unverified across the
  // WHOLE table; the only verified row here sits past the page cap, so a
  // one-page read never saw it and preferred an unverified address instead.
  it("getPreferredActiveAddressEmail prefers a verified row past the page cap", async () => {
    await stub.seed({ addresses: addressRows(520, (i) => ({ verified: i === 519 })) });

    expect(getPreferredActiveAddressEmail()).toBe("user519@example.com");
  });
});

describe("address counts and aggregates past one server page", () => {
  it("countAddressesForReadiness counts the whole table, not one page", async () => {
    await stub.seed({ addresses: addressRows(750) });

    expect(countAddressesForReadiness()).toBe(750);
  });

  it("listAddressesForReadiness fills a window past the page cap", async () => {
    await stub.seed({ addresses: addressRows(700) });

    expect(listAddressesForReadiness({ limit: 650 })).toHaveLength(650);
  });

  it("listAddressEmails and listActiveAddressEmails return every address", async () => {
    await stub.seed({ addresses: addressRows(600) });

    expect(listAddressEmails()).toHaveLength(600);
    expect(listActiveAddressEmails()).toHaveLength(600);
  });

  it("listUsableSendingAddresses counts usable rows past the page cap", async () => {
    await stub.seed({ addresses: addressRows(600) });

    expect(listUsableSendingAddresses()).toHaveLength(600);
    expect(listUsableSendingAddresses({ limit: 550 })).toHaveLength(550);
  });

  it("per-domain active counts cover rows past the page cap", async () => {
    await stub.seed({
      addresses: addressRows(600, (i) => ({
        email: i % 2 === 0 ? `user${i}@example.com` : `user${i}@example.org`,
      })),
    });

    const counts = listActiveAddressCountsByDomain();
    expect(counts.get("example.com")).toBe(300);
    expect(counts.get("example.org")).toBe(300);

    const scoped = listActiveAddressCountsByDomains(["example.org"]);
    expect(scoped.get("example.org")).toBe(300);
  });
});

describe("honest refusals instead of silent lower bounds", () => {
  // Past this many rows the pager cannot walk the table inside its budget, so an
  // unbounded read has no way to prove it saw all of it.
  const SCAN_CAP = SELF_HOSTED_ENUMERATION_PAGE_BUDGET * SELF_HOSTED_SERVER_PAGE_MAX;

  // When offset paging returns the same row twice the window MOVED, so the rows
  // read are a strict subset of the table: an unbounded read and a count must
  // refuse rather than publish the subset as the whole.
  it("refuses an unbounded read and a count when the paging window shifts", async () => {
    await stub.seed({ addresses: addressRows(1200) });
    await stub.setListOrderInstability(7, ["addresses"]);

    expect(() => listAddresses()).toThrow(/partial address list/);
    expect(() => listAddresses()).toThrow(/LOWER BOUND/);
    expect(() => countAddressesForReadiness()).toThrow(/partial address list/);
  });

  it("serves a bounded read on a table past the scan cap, and still refuses an unbounded one", async () => {
    await stub.seed({ addresses: addressRows(SCAN_CAP + 500) });

    // Asked for "the first 100": gets 100, and they are the 100 newest.
    const page = listAddresses(undefined, { limit: 100 });
    expect(page).toHaveLength(100);
    expect(page[0]!.id).toBe("addr-000000");
    expect(page[99]!.id).toBe("addr-000099");

    // Asked for "everything": refuses rather than returning a plausible subset.
    let refusal: unknown;
    try {
      listAddresses();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/partial address list/);
    expect(String(refusal)).toMatch(/LOWER BOUND/);

    // A count over the same table refuses for the same reason.
    expect(() => countAddressesForReadiness()).toThrow(/partial address list/);

    // The dedupe lookup refuses instead of returning a false null: on a table
    // it cannot finish, null would mean "not found", and `address add` would
    // mint a duplicate on the strength of it.
    expect(() => getAddressByEmail(PROVIDER, "nowhere@example.net")).toThrow(/partial address list/);
  }, 240_000);
});
