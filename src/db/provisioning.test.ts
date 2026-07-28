// Domain and address provisioning has ONE implementation, and every operation reaches storage
// through the store seam.
//
// The family used to be a 44-line facade dispatching NINETEEN exports to a 509-line SQLite arm
// and a 401-line `curl`-bridge arm. Thirteen divergences between those two arms are recorded in
// the module header; this suite is built around the ones that could hand a caller a wrong
// answer:
//
//   * THIRTEEN READS ANSWERED OUT OF ONE CLAMPED PAGE. Every read in the deleted HTTP arm was a
//     single `list({ limit: 1000 })`, which both stores and the service clamp to 500. There are
//     520-row cases below for the reads where that matters — a due-work queue missing its tail,
//     a `ready` count that stops at the page boundary and becomes a readiness verdict, an
//     inventory whose absent id reads as "not provisioned" — and each carries the CONTROL that
//     one clamped page really does miss the row.
//   * THE `nameservers` WRITE WAS CORRUPTING THE COLUMN. The deleted arm sent
//     `JSON.stringify(list)`. A case round-trips a two-element list through both stores, and
//     the control drives the OLD shape straight at the seam and shows the list does not
//     survive it. (Against the real service the damage is a one-element array holding the raw
//     JSON text, via `asStringArray`; the control reaches an empty list instead, because the
//     fixture translates HTTP into the seam rather than running the service's coercions.)
//   * UNDECLARED WRITE COLUMNS. Both deleted arms sent `id` and `created_at` on every event
//     insert; `/v1/provisioning` declares five writable columns behind
//     `additionalProperties: false`, so the real HTTP store REFUSES that write. A recording
//     store pins exactly which columns this implementation sends, and a control proves the old
//     set is refused.
//   * THE STORE ORDERS THE EVENT LOG BACKWARDS from what both arms published — SQLite
//     `created_at DESC, id DESC` against an oldest-first contract (the service's spec says
//     `created_at ASC`, a third answer). A case asserts the store's own first row is the wrong
//     one and that this module answers oldest-first over both variants regardless.
//   * NEITHER ARM HAD A TOTAL ORDER and one of them sorted with `localeCompare`, which is
//     locale-dependent. The tiebreakers are asserted directly.
//   * ABSENT IS NOT `now()`. The deleted HTTP arm read an event's `created_at` through a
//     coercion that fabricates the current time for a MISSING value.
//
// EVERY BEHAVIOURAL CASE THAT CAN RUN AGAINST A STORE RUNS TWICE: once against a real SQLite
// store and once against an `HttpEmailStore` talking to a `/v1` service over real HTTP.
// `src/test-support/v1-stub.ts` is deliberately NOT used — its generic list handler ignores
// equality filters and it serves `/v1/openapi.json` only on request, and the HTTP store
// validates every write column against that document.
//
// THE AGGREGATES GET TWO DIFFERENT ANSWERS AND BOTH ARE PINNED. The count maps and the single
// count REFUSE on a truncated read, because a `Map<string, number>` has nowhere to record a
// bound and every consumer reads it as `?? 0` on the way to a readiness verdict.
// `getProvisioningWorkSummary` REPORTS the bound, because its shape carries a
// `StatusAvailability` and its one consumer renders `≥N`. There is a case for each, and the
// renderer itself is pinned in `src/cli/commands/daemon.local.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import { createProvider } from "./providers.js";
import { createDomain } from "./domains.js";
import { createAddress } from "./addresses.js";
import {
  TERMINAL_STATES,
  claimDueAddresses,
  claimDueDomains,
  countReadyAddressesForDomain,
  getAddressProvisioning,
  getDomainProvisioning,
  getProvisioningWorkSummary,
  listAddressProvisioningByDomain,
  listAddressProvisioningByDomains,
  listAddressProvisioningById,
  listAddressProvisioningByIds,
  listAddressProvisioningForDomain,
  listDomainProvisioningById,
  listDomainProvisioningByIds,
  listProvisioningEvents,
  listReadyAddressCountsByDomain,
  listReadyAddressCountsByDomains,
  recordProvisioningEvent,
  setAddressProvisioning,
  setDomainProvisioning,
} from "./provisioning.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { DomainRecord, ResourceInput, ResourceRow } from "../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { statusGapClass, statusReasonCode } from "../lib/status-availability.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

let db: Database;
let api: V1StoreApi;
let providerId: string;

/**
 * Leave exactly ONE store configured, so the cases that pass no store can resolve.
 *
 * Named through the resolution's OWN exported constants rather than copied as literals: "a
 * database path AND an API are both configured" is a HARD BOOT ERROR with no precedence rule,
 * so a stray inherited API setting turns every default-store case into that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  providerId = createProvider({ name: "SES production", type: "ses" }, db).id;
  // The `/v1` service the HTTP store talks to. Every row it serves comes out of this same
  // database through the seam, so both store variants below read one dataset.
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "provisioning fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (provisioning test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

const CAPABILITY_REFUSAL = {
  ok: false,
  code: "capability_unavailable",
  message: "the test store does not serve this family",
  status: 501,
} as const;

/**
 * The real store with ONE repository member replaced — the neutering pattern the store suites
 * use. A hand-rolled partial store cast to `EmailStore` would let a signature drift without
 * `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeWith(patch: {
  domains?: Partial<EmailStore["domains"]>;
  addresses?: Partial<EmailStore["addresses"]>;
  provisioning?: Partial<EmailStore["provisioning"]>;
}): EmailStore {
  const base = sqliteStore();
  return {
    ...base,
    domains: { ...base.domains, ...(patch.domains ?? {}) },
    addresses: { ...base.addresses, ...(patch.addresses ?? {}) },
    provisioning: { ...base.provisioning, ...(patch.provisioning ?? {}) },
  };
}

/**
 * A store that serves addresses in the SERVER's order rather than SQLite's.
 *
 * `src/server/self-hosted/store.ts` orders `listAddresses` `created_at DESC, id ASC`; the
 * SQLite store orders it `created_at DESC, id DESC`. The `/v1` fixture translates HTTP into
 * the SQLite seam, so neither store variant above reproduces the server's tie order — which is
 * exactly why the address `id` tiebreaker survived mutation and why claiming it redundant
 * "against both real stores" was wrong.
 *
 * The reordering is a CONSISTENT TOTAL ORDER applied to the whole table before windowing, so
 * it pages cleanly: the anchor row lands where the pager expects it, no duplicate, no shift.
 * That also disproves the other half of the claim — that no fixture could exist because
 * reordering necessarily trips the shift detector.
 */
function serverOrderedAddresses(): EmailStore {
  const base = sqliteStore();
  return storeWith({
    addresses: {
      listAddresses: async (opts) => {
        const whole = await base.addresses.listAddresses({ limit: 500, offset: 0 });
        if (!whole.ok) return whole;
        const ordered = [...whole.value].sort((a, b) =>
          (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 100;
        return { ok: true, value: ordered.slice(offset, offset + limit) };
      },
    },
  });
}

function seedDomain(name: string): string {
  return createDomain(providerId, name, db).id;
}

function seedAddress(email: string, domainId?: string): string {
  const id = createAddress({ provider_id: providerId, email }, db).id;
  if (domainId) db.run("UPDATE addresses SET domain_id = ? WHERE id = ?", [domainId, id]);
  return id;
}

/**
 * Seed `count` domains straight into SQLite with deliberately distinct timestamps.
 *
 * THE STAMPS ARE NOT DECORATION. Rows written in a tight loop share `created_at` to the
 * millisecond, and both stores order these rows `created_at DESC` with an id tiebreaker — so a
 * control assertion about "the row the first page misses" would hold only most of the time
 * while stealing an unrelated case's evidence. `src/db/forwarding.test.ts` records that exact
 * flake being found by mutation testing.
 */
function seedDomains(count: number, prefix: string, provisioning?: { status: string; next: string }): void {
  const insert = db.query(
    "INSERT INTO domains (id, provider_id, domain, ownership_status, provisioning_status, next_check_at, created_at, updated_at)"
      + " VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
  );
  for (let index = 0; index < count; index += 1) {
    const key = String(index).padStart(6, "0");
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    insert.run(
      `${prefix}-${key}`,
      providerId,
      `${prefix}-${key}.example`,
      provisioning?.status ?? "none",
      provisioning?.next ?? null,
      stamp,
      stamp,
    );
  }
}

function seedAddresses(count: number, prefix: string, domainId: string, status: string): void {
  const insert = db.query(
    "INSERT INTO addresses (id, provider_id, email, status, verified, domain_id, provisioning_status, created_at, updated_at)"
      + " VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?)",
  );
  for (let index = 0; index < count; index += 1) {
    const key = String(index).padStart(6, "0");
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    insert.run(`${prefix}-${key}`, providerId, `${prefix}-${key}@bulk.example`, domainId, status, stamp, stamp);
  }
}

/** What one clamped page of a store list really holds — the control the 520-row cases need. */
async function onePage<T>(read: Promise<Outcome<T[]>>): Promise<T[]> {
  const outcome = await read;
  if (!outcome.ok) throw new Error(`fixture: the store refused a page: ${outcome.message}`);
  return outcome.value;
}

/**
 * The message a call threw, or a description of the value it answered instead.
 *
 * Explicit rather than `expect().rejects`, which reports "this was not a promise" for a
 * synchronous implementation — a fact about a signature rather than about behaviour.
 */
async function thrownBy(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return `NO THROW — answered ${JSON.stringify(value)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ── exported data ───────────────────────────────────────────────────────────────

describe("TERMINAL_STATES", () => {
  it("holds the three states both deleted arms declared, and nothing else", () => {
    // Exported DATA, not a function: a divergence here would be a silent behaviour split
    // across every consumer. Both arms declared exactly this list, and the SQLite arm ALSO
    // hard-coded it a second time as a SQL literal beside it.
    expect([...TERMINAL_STATES]).toEqual(["ready", "failed", "none"]);
  });
});

// ── mapping ─────────────────────────────────────────────────────────────────────

describe.each(STORE_VARIANTS)("provisioning defaults through the %s", (_label, makeStore) => {
  it("reads a fresh domain's provisioning columns at their schema defaults", async () => {
    const id = seedDomain("example.com");
    const provisioning = await getDomainProvisioning(id, makeStore());
    expect(provisioning).not.toBeNull();
    expect(provisioning!.provisioning_status).toBe("none");
    // `NOT NULL DEFAULT 'cloudflare'` on the column. The deleted HTTP arm answered `""` here
    // whenever the entity did not carry the key.
    expect(provisioning!.dns_provider).toBe("cloudflare");
    expect(provisioning!.nameservers).toEqual([]);
    expect(provisioning!.cf_zone_id).toBeNull();
    expect(provisioning!.next_check_at).toBeNull();
    expect(provisioning!.last_error).toBeNull();
  });

  it("reads a fresh address's provisioning columns at their schema defaults", async () => {
    const id = seedAddress("ops@example.com");
    const provisioning = await getAddressProvisioning(id, makeStore());
    expect(provisioning).not.toBeNull();
    expect(provisioning!.provisioning_status).toBe("none");
    expect(provisioning!.receive_strategy).toBeNull();
    expect(provisioning!.forward_to).toBeNull();
    expect(provisioning!.last_validated_at).toBeNull();
  });

  it("answers null for an id no row carries, rather than faulting", async () => {
    const store = makeStore();
    expect(await getDomainProvisioning("no-such-domain", store)).toBeNull();
    expect(await getAddressProvisioning("no-such-address", store)).toBeNull();
  });
});

// ── writes ──────────────────────────────────────────────────────────────────────

describe.each(STORE_VARIANTS)("writing provisioning state through the %s", (_label, makeStore) => {
  it("round-trips every domain column it accepts", async () => {
    const id = seedDomain("example.com");
    const written = await setDomainProvisioning(id, {
      provisioning_status: "verifying",
      purchase_provider: "namecheap",
      dns_provider: "route53",
      send_provider: "ses",
      cf_zone_id: "zone-1",
      registrar: "namecheap",
      mail_from_domain: "mail.example.com",
      last_error: "transient",
      next_check_at: "2026-02-01T00:00:00.000Z",
    }, makeStore());
    expect(written).toEqual({
      provisioning_status: "verifying",
      purchase_provider: "namecheap",
      dns_provider: "route53",
      send_provider: "ses",
      cf_zone_id: "zone-1",
      registrar: "namecheap",
      nameservers: [],
      mail_from_domain: "mail.example.com",
      last_error: "transient",
      next_check_at: "2026-02-01T00:00:00.000Z",
    });
    // Read back through a SEPARATE call, so an implementation that echoed its own patch
    // instead of the stored row would not pass.
    expect(await getDomainProvisioning(id, makeStore())).toEqual(written!);
  });

  it("round-trips every address column it accepts", async () => {
    const domainId = seedDomain("example.com");
    const id = seedAddress("ops@example.com");
    const written = await setAddressProvisioning(id, {
      domain_id: domainId,
      receive_strategy: "ses-s3",
      forward_to: "ops@elsewhere.example",
      routing_rule_id: "rule-1",
      provisioning_status: "ready",
      last_validated_at: "2026-02-01T00:00:00.000Z",
      last_error: null,
      next_check_at: null,
    }, makeStore());
    expect(written).toEqual({
      domain_id: domainId,
      receive_strategy: "ses-s3",
      forward_to: "ops@elsewhere.example",
      routing_rule_id: "rule-1",
      provisioning_status: "ready",
      last_validated_at: "2026-02-01T00:00:00.000Z",
      last_error: null,
      next_check_at: null,
    });
    expect(await getAddressProvisioning(id, makeStore())).toEqual(written!);
  });

  it("clears a column with an explicit null and leaves an absent one alone", async () => {
    const id = seedDomain("example.com");
    await setDomainProvisioning(id, { provisioning_status: "verifying", last_error: "boom" }, makeStore());
    const cleared = await setDomainProvisioning(id, { last_error: null }, makeStore());
    expect(cleared!.last_error).toBeNull();
    // The status was NOT named on the second patch and must survive it.
    expect(cleared!.provisioning_status).toBe("verifying");
  });

  it("refuses to record an event with a blank entity_id or to_state, BEFORE writing", async () => {
    // Accept-on-write / refuse-on-read: `TEXT NOT NULL` admits `''`, so a blank used to be
    // committed and then rejected by this module's own reader, poisoning that entity's history
    // permanently. The store must never see it.
    const store = makeStore();
    expect(await thrownBy(() => recordProvisioningEvent("domain", "  ", null, "verifying", {}, store)))
      .toContain("needs the id of the domain or address");
    expect(await thrownBy(() => recordProvisioningEvent("domain", "d1", null, "  ", {}, store)))
      .toContain("refusing to record a transition to nothing");
    // AND WROTE NOTHING, which is the half that matters.
    expect(db.query("SELECT COUNT(*) AS n FROM provisioning_events").get() as { n: number }).toEqual({ n: 0 });
  });

  it("answers null for a write against a row that does not exist", async () => {
    // DIVERGENCE 9: the SQLite arm ran an UPDATE affecting zero rows and answered null; the
    // HTTP arm's bridge threw on the 404. The signature has always published `| null`.
    const store = makeStore();
    expect(await setDomainProvisioning("no-such-domain", { last_error: "x" }, store)).toBeNull();
    expect(await setAddressProvisioning("no-such-address", { last_error: "x" }, store)).toBeNull();
  });

  it("sends nameservers as an ARRAY, so a two-element list round-trips as two elements", async () => {
    // DIVERGENCE 2, and it is the sharpest one in the family. The deleted HTTP arm sent
    // `nameservers_json: JSON.stringify(list)`. The service's `extractDomainProvisioning` runs
    // that through `asStringArray`, which wraps a non-array STRING in a one-element array — so
    // a two-nameserver domain was stored as a single element holding the raw JSON text.
    const id = seedDomain("example.com");
    const written = await setDomainProvisioning(id, {
      nameservers: ["ns1.example.net", "ns2.example.net"],
    }, makeStore());
    expect(written!.nameservers).toEqual(["ns1.example.net", "ns2.example.net"]);
    expect(await getDomainProvisioning(id, makeStore())).toEqual(written!);
  });
});

describe("an EMPTY patch", () => {
  const stampOf = (table: "domains" | "addresses", id: string): string =>
    (db.query(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string }).updated_at;

  it("is a STORE-specific behaviour, and both shapes are pinned", async () => {
    // Documented but never pinned, and the note about it was wrong: the asymmetry belongs to
    // the SQLITE store, not to the seam. `applyAddressProvisioning` returns the row without
    // writing when the patch names no column, while `applyDomainProvisioning` still stamps —
    // over HTTP NEITHER stamps, because the service returns the row unchanged for an empty
    // body. Both deleted arms stamped unconditionally, on both paths. No caller passes an
    // empty patch; this exists so none of the three behaviours can drift unnoticed.
    const domainId = seedDomain("example.com");
    const addressId = seedAddress("ops@example.com");
    const OLD = "2020-01-01T00:00:00.000Z";

    db.run("UPDATE addresses SET updated_at = ? WHERE id = ?", [OLD, addressId]);
    db.run("UPDATE domains SET updated_at = ? WHERE id = ?", [OLD, domainId]);
    expect(await setAddressProvisioning(addressId, {}, sqliteStore())).not.toBeNull();
    expect(await setDomainProvisioning(domainId, {}, sqliteStore())).not.toBeNull();
    expect(stampOf("addresses", addressId), "SQLite: the address path does not write").toBe(OLD);
    expect(stampOf("domains", domainId), "SQLite: the domain path stamps").not.toBe(OLD);

    db.run("UPDATE addresses SET updated_at = ? WHERE id = ?", [OLD, addressId]);
    db.run("UPDATE domains SET updated_at = ? WHERE id = ?", [OLD, domainId]);
    expect(await setAddressProvisioning(addressId, {}, httpStore())).not.toBeNull();
    expect(await setDomainProvisioning(domainId, {}, httpStore())).not.toBeNull();
    expect(stampOf("addresses", addressId), "HTTP: neither path writes").toBe(OLD);
    expect(stampOf("domains", domainId), "HTTP: neither path writes").toBe(OLD);
  });
});

describe("the deleted arm's nameservers write, reproduced", () => {
  it("CONTROL: the JSON-string shape loses the whole list", async () => {
    // The positive control for the case above, driven straight at the seam so it cannot pass or
    // fail because of anything this module does.
    //
    // WHAT THIS PROVES AND WHAT IT DOES NOT. On this path the stringified value is stringified
    // AGAIN by the store and read back as a string rather than an array, so a two-nameserver
    // domain reports ZERO nameservers. The consequence against the REAL service is different
    // and worse — `extractDomainProvisioning` runs the value through `asStringArray`, which
    // wraps a non-array string in a ONE-element array holding the raw JSON text — and that
    // consequence is read from the server source rather than executed here, because
    // `src/test-support/v1-store-api.ts` translates HTTP into the seam rather than running the
    // service's own coercions. Either way the list does not survive; only the shape of the
    // damage differs.
    const id = seedDomain("example.com");
    const applied = await httpStore().provisioning.applyDomainProvisioning(id, {
      // The deleted arm's payload shape. Cast because the seam's patch type — correctly — does
      // not admit it, which is itself part of the finding.
      nameservers_json: JSON.stringify(["ns1.example.net", "ns2.example.net"]) as unknown as string[],
    });
    expect(applied.ok).toBe(true);
    expect((await getDomainProvisioning(id, sqliteStore()))!.nameservers).toEqual([]);
  });
});

// ── inventories ─────────────────────────────────────────────────────────────────

describe.each(STORE_VARIANTS)("inventories through the %s", (_label, makeStore) => {
  it("keys every domain's provisioning state by id", async () => {
    const first = seedDomain("first.example");
    const second = seedDomain("second.example");
    await setDomainProvisioning(first, { provisioning_status: "ready", send_provider: "ses" }, makeStore());
    await setDomainProvisioning(second, { provisioning_status: "failed", last_error: "boom" }, makeStore());
    const byId = await listDomainProvisioningById(makeStore());
    expect(byId.size).toBe(2);
    expect(byId.get(first)!.send_provider).toBe("ses");
    expect(byId.get(second)!.last_error).toBe("boom");
  });

  it("keys every address's provisioning state by id", async () => {
    const first = seedAddress("first@example.com");
    seedAddress("second@example.com");
    await setAddressProvisioning(first, { provisioning_status: "ready" }, makeStore());
    const byId = await listAddressProvisioningById(makeStore());
    expect(byId.size).toBe(2);
    expect(byId.get(first)!.provisioning_status).toBe("ready");
  });

  it("de-duplicates, trims and drops blank ids", async () => {
    const id = seedDomain("first.example");
    const byId = await listDomainProvisioningByIds([id, ` ${id} `, id, "", "   "], makeStore());
    expect([...byId.keys()]).toEqual([id]);
  });

  it("resolves an id that arrived PADDED, with no unpadded copy beside it", async () => {
    // The case above cannot kill a deleted `trim()`: it passes the bare id too, so the map is
    // the same either way. Only a padded id ON ITS OWN makes the trim decide.
    const id = seedDomain("first.example");
    expect([...(await listDomainProvisioningByIds([`  ${id}\t`], makeStore())).keys()]).toEqual([id]);
  });

  it("treats an id set of nothing but blanks as empty, WITHOUT reading the store", async () => {
    // Neither can the case above kill a deleted `filter(Boolean)`: a blank id simply matches no
    // row, so the map is empty either way. What changes is whether the whole table is read to
    // discover that — so the store here faults if it is touched at all.
    const store = storeWith({
      domains: { listDomains: () => Promise.reject(new Error("the store must not be read")) },
    });
    expect((await listDomainProvisioningByIds(["", "   ", "\t"], store)).size).toBe(0);
    // CONTROL: one real id in the same call DOES read the store, and faults.
    expect(await thrownBy(() => listDomainProvisioningByIds(["", "real"], store)))
      .toContain("the store must not be read");
  });

  it("leaves an id it could not resolve ABSENT from the map", async () => {
    // DIVERGENCE 10, preserved because BOTH arms did it, and pinned so it cannot change
    // silently. It is only safe because the enumeration behind it either saw the whole table
    // or threw: absence now means "read everything and it is not there", which is exactly what
    // the six `?? 0` consumers assume.
    const id = seedDomain("first.example");
    const byId = await listDomainProvisioningByIds([id, "no-such-domain"], makeStore());
    expect([...byId.keys()]).toEqual([id]);
  });

  it("keys the NAMED addresses' provisioning state by id, and only those", async () => {
    // This export was reached by exactly one assertion — with an EMPTY argument. It is live in
    // `src/mcp/resources.local.ts`, and its domain twin has four cases.
    const first = seedAddress("first@example.com");
    const second = seedAddress("second@example.com");
    seedAddress("third@example.com");
    await setAddressProvisioning(first, { provisioning_status: "ready", forward_to: "x@y.test" }, makeStore());
    await setAddressProvisioning(second, { provisioning_status: "failed", last_error: "boom" }, makeStore());

    const byId = await listAddressProvisioningByIds([first, ` ${second} `, first, "no-such-address"], makeStore());
    expect([...byId.keys()].sort()).toEqual([first, second].sort());
    expect(byId.get(first)!.forward_to).toBe("x@y.test");
    expect(byId.get(second)!.last_error).toBe("boom");
  });

  it("applies the id tiebreaker against the order the SERVER actually serves", async () => {
    // See `serverOrderedAddresses`. Neither store variant reproduces `created_at DESC, id ASC`,
    // so this is the only fixture in the suite where the tiebreaker decides anything.
    const domainId = seedDomain("first.example");
    const a = seedAddress("a@first.example", domainId);
    const b = seedAddress("b@first.example", domainId);
    db.run("UPDATE addresses SET created_at = '2026-01-01T00:00:00.000Z'");
    const store = serverOrderedAddresses();
    const expected = [a, b].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
    expect((await listAddressProvisioningForDomain(domainId, store)).map((row) => row.id))
      .toEqual(expected);
    // CONTROL: the fixture really does serve the opposite tie order, and it pages cleanly —
    // an enumeration that had shifted would have refused instead of answering.
    const served = await onePage(store.addresses.listAddresses({ limit: 500 }));
    expect(served.map((row) => row.id)).toEqual([...expected].reverse());
  });

  it("groups addresses under their domain, newest first, and skips the unowned ones", async () => {
    const domainId = seedDomain("first.example");
    const older = seedAddress("older@first.example", domainId);
    const newer = seedAddress("newer@first.example", domainId);
    seedAddress("orphan@nowhere.example");
    db.run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", older]);
    db.run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", newer]);

    const byDomain = await listAddressProvisioningByDomain(makeStore());
    expect([...byDomain.keys()]).toEqual([domainId]);
    expect(byDomain.get(domainId)!.map((row) => row.id)).toEqual([newer, older]);
    expect(byDomain.get(domainId)![0]!.email).toBe("newer@first.example");

    expect((await listAddressProvisioningByDomains([domainId], makeStore())).get(domainId)!.map((row) => row.id))
      .toEqual([newer, older]);
    expect((await listAddressProvisioningForDomain(domainId, makeStore())).map((row) => row.id))
      .toEqual([newer, older]);
  });

  it("orders addresses that share a created_at by id, descending", async () => {
    // DIVERGENCE 5: neither arm had a tiebreaker, so a batch written in one pass ordered
    // arbitrarily. Rows seeded in a loop really do share the millisecond, which is the whole
    // reason this case exists.
    const domainId = seedDomain("first.example");
    const a = seedAddress("a@first.example", domainId);
    const b = seedAddress("b@first.example", domainId);
    db.run("UPDATE addresses SET created_at = '2026-01-01T00:00:00.000Z'");
    const rows = await listAddressProvisioningForDomain(domainId, makeStore());
    const expected = [a, b].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
    expect(rows.map((row) => row.id)).toEqual(expected);
    //
    // THIS CASE CANNOT KILL A DELETED `id` TIEBREAKER, and saying so is the point. `sort` is
    // stable and both stores already order these rows `created_at DESC, id DESC`, so the term
    // is redundant for any order they produce. Nor can a fixture manufacture a disagreement:
    // a store that reorders a page moves the pager's anchor row, which `enumerateStoreRows`
    // correctly reports as a SHIFTED WINDOW and this module correctly refuses. The term stays
    // because `ListOptions` publishes no ordering at all and a page boundary over a non-total
    // order can repeat or drop a row; it is named as a mutation survivor in the module header
    // rather than covered by a test that only appears to cover it.
  });

});

describe("an empty id set is answered without reading anything", () => {
  it("does not touch a store whose every list would fault", async () => {
    // A store that FAULTS, so the early return is what is proven rather than an accidentally
    // empty table.
    const store = storeWith({
      domains: { listDomains: () => Promise.reject(new Error("the store must not be read")) },
      addresses: { listAddresses: () => Promise.reject(new Error("the store must not be read")) },
    });
    expect((await listDomainProvisioningByIds([], store)).size).toBe(0);
    expect((await listAddressProvisioningByIds([], store)).size).toBe(0);
    expect((await listAddressProvisioningByDomains([], store)).size).toBe(0);
    expect((await listReadyAddressCountsByDomains([], store)).size).toBe(0);
    // CONTROL: the same store really does fault when it IS read, so the four assertions above
    // pass because nothing was read rather than because this store is harmless.
    expect(await thrownBy(() => listDomainProvisioningByIds(["x"], store)))
      .toContain("the store must not be read");
  });
});

// ── counts ──────────────────────────────────────────────────────────────────────

describe.each(STORE_VARIANTS)("ready-address counts through the %s", (_label, makeStore) => {
  it("treats an EMPTY domain_id as no domain at all, in every read", async () => {
    // DIVERGENCE 14, and the mutation record's "equivalent mutant" claim was wrong about it:
    // `nullableText` yields `""`, which is falsy but not null, so without the guard a ready
    // address with an empty owner is tallied under an empty key. `""` is writable through this
    // module and no store refuses it, and the deleted SQL (`domain_id IS NOT NULL`) COUNTED
    // such a row. A bucket keyed `""` is a domain this module invented.
    const store = makeStore();
    const real = seedDomain("real.example");
    const owned = seedAddress("owned@real.example", real);
    const orphan = seedAddress("orphan@real.example");
    await setAddressProvisioning(owned, { provisioning_status: "ready" }, store);
    await setAddressProvisioning(orphan, { provisioning_status: "ready", domain_id: "" }, store);

    // CONTROL: the empty value really was written and really does read back, so the assertions
    // below are about how it is INTERPRETED rather than about a write that did not land.
    expect((await getAddressProvisioning(orphan, makeStore()))!.domain_id).toBe("");

    const counts = await listReadyAddressCountsByDomain(makeStore());
    expect([...counts.keys()]).toEqual([real]);
    expect(counts.has("")).toBe(false);
    expect(await countReadyAddressesForDomain("", makeStore())).toBe(0);
    const grouped = await listAddressProvisioningByDomain(makeStore());
    expect([...grouped.keys()]).toEqual([real]);
    expect(await listAddressProvisioningForDomain("", makeStore())).toEqual([]);
  });

  it("counts only addresses that are ready AND owned by a domain", async () => {
    const first = seedDomain("first.example");
    const second = seedDomain("second.example");
    const readyOne = seedAddress("one@first.example", first);
    const readyTwo = seedAddress("two@first.example", first);
    const pending = seedAddress("three@first.example", first);
    const other = seedAddress("four@second.example", second);
    const unowned = seedAddress("loose@nowhere.example");
    for (const id of [readyOne, readyTwo, other, unowned]) {
      await setAddressProvisioning(id, { provisioning_status: "ready" }, makeStore());
    }
    await setAddressProvisioning(pending, { provisioning_status: "verifying" }, makeStore());

    const all = await listReadyAddressCountsByDomain(makeStore());
    expect(all.get(first)).toBe(2);
    expect(all.get(second)).toBe(1);
    // The unowned ready address belongs to no domain and must not appear anywhere.
    expect(all.size).toBe(2);

    const named = await listReadyAddressCountsByDomains([first], makeStore());
    expect([...named.keys()]).toEqual([first]);
    expect(named.get(first)).toBe(2);

    expect(await countReadyAddressesForDomain(first, makeStore())).toBe(2);
    expect(await countReadyAddressesForDomain(second, makeStore())).toBe(1);
    // A domain with no ready addresses is a real zero, read off a complete enumeration.
    expect(await countReadyAddressesForDomain(seedDomain("third.example"), makeStore())).toBe(0);
  });
});

// ── the clamped page ────────────────────────────────────────────────────────────

describe("a clamped page is not the table", () => {
  it("CONTROL: one store page really does stop at 500 rows", async () => {
    seedDomains(520, "bulk");
    // Both stores clamp; the deleted HTTP arm asked for 1000 and believed what came back.
    expect(await onePage(sqliteStore().domains.listDomains({ limit: 1000 }))).toHaveLength(500);
    expect(await onePage(httpStore().domains.listDomains({ limit: 1000 }))).toHaveLength(500);
  });

  it.each(STORE_VARIANTS)("%s: the domain inventory reaches all 520 rows", async (_label, makeStore) => {
    seedDomains(520, "bulk");
    expect((await listDomainProvisioningById(makeStore())).size).toBe(520);
  });

  it.each(STORE_VARIANTS)("%s: the due-work queue reaches a row past the first page", async (_label, makeStore) => {
    // The row the deleted arm could not see is the OLDEST one, because both stores order
    // `created_at DESC` and this fixture stamps ascending.
    seedDomains(520, "due", { status: "verifying", next: "2026-01-01T00:00:00.000Z" });
    const due = await claimDueDomains("2026-06-01T00:00:00.000Z", makeStore());
    expect(due).toHaveLength(520);
    expect(due.some((row) => row.id === "due-000000")).toBe(true);
    const firstPage = await onePage(makeStore().domains.listDomains({ limit: 1000 }));
    expect(firstPage.some((row) => row.id === "due-000000")).toBe(false);
  });

  it.each(STORE_VARIANTS)("%s: the ready count reaches all 520 addresses", async (_label, makeStore) => {
    const domainId = seedDomain("bulk.example");
    seedAddresses(520, "ready", domainId, "ready");
    expect(await countReadyAddressesForDomain(domainId, makeStore())).toBe(520);
    expect((await listReadyAddressCountsByDomain(makeStore())).get(domainId)).toBe(520);
    expect((await listReadyAddressCountsByDomains([domainId], makeStore())).get(domainId)).toBe(520);
  });
});

// ── refusing rather than answering from part of the table ───────────────────────

describe("a read that could not finish is never an answer", () => {
  it("refuses when the page budget runs out", async () => {
    seedDomains(600, "bulk");
    const base = sqliteStore();
    // THREE rows a page, not one. Every page after the first re-requests the row it ended on,
    // so a one-row page yields ZERO fresh rows and the pager reads that — correctly — as the
    // end of the table. A pager cannot make progress against a store that serves fewer rows
    // than its own anchor costs, which is a property of `enumerateStoreRows` worth knowing
    // rather than a defect this fixture should hide.
    const store = storeWith({
      domains: { listDomains: (opts) => base.domains.listDomains({ ...opts, limit: 3 }) },
    });
    const message = await thrownBy(() => listDomainProvisioningById(store));
    expect(message).toContain("could not be read to the end");
    expect(message).toContain("refusing to answer from part of the table");
  });

  it("refuses when the window shifted under paging", async () => {
    // A store that loses a row above the cursor between pages slides every unread row down one
    // offset and produces NO duplicate at all — the case the anchor row exists for.
    seedDomains(600, "bulk");
    const base = sqliteStore();
    let pages = 0;
    const store = storeWith({
      domains: {
        listDomains: async (opts) => {
          pages += 1;
          if (pages === 2) db.run("DELETE FROM domains WHERE id = 'bulk-000599'");
          return base.domains.listDomains(opts);
        },
      },
    });
    const message = await thrownBy(() => listDomainProvisioningById(store));
    expect(message).toContain("could not be read to the end");
  });

  it("refuses a COUNT rather than reporting a short one", async () => {
    // The aggregates that cannot carry a bound. `Map<string, number>` and a bare `number` have
    // nowhere to say "this is a lower bound", and every consumer reads the map as `?? 0` on the
    // way to a readiness verdict — so a truncated read must not answer.
    const domainId = seedDomain("bulk.example");
    seedAddresses(600, "ready", domainId, "ready");
    // THE WINDOW MOVES between pages, which is the harder half of the completeness rule: a row
    // that disappears above the cursor slides every unread row down one offset and produces no
    // duplicate at all. Modelled by dropping the first row of every page after the first, so
    // the anchor never comes back — and built FRESH per case, because a fixture with shared
    // state only shifts for whichever call happens to run first.
    const shiftingAddresses = (): EmailStore => {
      const base = sqliteStore();
      let pages = 0;
      return storeWith({
        addresses: {
          listAddresses: async (opts) => {
            pages += 1;
            const page = await base.addresses.listAddresses(opts);
            if (!page.ok || pages === 1) return page;
            return { ok: true, value: page.value.slice(1) };
          },
        },
      });
    };
    const cases: ReadonlyArray<readonly [string, (store: EmailStore) => Promise<unknown>]> = [
      ["countReadyAddressesForDomain", (store) => countReadyAddressesForDomain(domainId, store)],
      ["listReadyAddressCountsByDomain", (store) => listReadyAddressCountsByDomain(store)],
      ["listReadyAddressCountsByDomains", (store) => listReadyAddressCountsByDomains([domainId], store)],
      ["listAddressProvisioningById", (store) => listAddressProvisioningById(store)],
      ["listAddressProvisioningForDomain", (store) => listAddressProvisioningForDomain(domainId, store)],
      ["claimDueAddresses", (store) => claimDueAddresses(undefined, store)],
    ];
    for (const [name, run] of cases) {
      expect(await thrownBy(() => run(shiftingAddresses())), name)
        .toContain("refusing to answer from part of the table");
    }
    // CONTROL: the same six answer normally against an unimpaired store, so they fail above
    // because the window moved rather than because the fixture is unusable.
    for (const [name, run] of cases) {
      expect(await thrownBy(() => run(sqliteStore())), name).toContain("NO THROW");
    }
  });

  it("refuses a truncated event log and names the missing filter", async () => {
    const base = sqliteStore();
    for (let index = 0; index < 3; index += 1) {
      await recordProvisioningEvent("domain", "d1", null, `state-${index}`, {}, base);
    }
    // A log that never ends: every page holds three rows this pager has not seen, so it can
    // neither reach an empty page nor notice a duplicate, and the budget is what stops it.
    let minted = 0;
    const store = storeWith({
      provisioning: {
        listProvisioningEvents: () => {
          const page = [0, 1, 2].map((offset) => ({
            id: `endless-${minted + offset}`,
            entity_type: "domain",
            entity_id: "d1",
            from_state: null,
            to_state: "verifying",
            detail_json: "{}",
            created_at: "2026-01-01T00:00:00.000Z",
          })) as ResourceRow[];
          minted += 3;
          return Promise.resolve({ ok: true, value: page });
        },
      },
    });
    const message = await thrownBy(() => listProvisioningEvents("domain", "d1", store));
    expect(message).toContain("could not be read to the end");
    expect(message).toContain("admits no entity filter");
  });

  it("turns a store refusal into a throw naming the operation and the code", async () => {
    const store = storeWith({ domains: { listDomains: async () => CAPABILITY_REFUSAL } });
    const message = await thrownBy(() => listDomainProvisioningById(store));
    expect(message).toContain("This installation's store cannot list every domain's provisioning state");
    expect(message).toContain("capability_unavailable");
    expect(message).toContain("501");
  });

  it("turns a point-read refusal into a throw too", async () => {
    const store = storeWith({ domains: { getDomain: async () => CAPABILITY_REFUSAL } });
    expect(await thrownBy(() => getDomainProvisioning("anything", store)))
      .toContain("cannot read a domain's provisioning state");
    const writeStore = storeWith({
      provisioning: { applyDomainProvisioning: async () => CAPABILITY_REFUSAL },
    });
    expect(await thrownBy(() => setDomainProvisioning("anything", { last_error: null }, writeStore)))
      .toContain("cannot write a domain's provisioning state");
  });

  it("turns a store fault into a throw rather than an empty inventory", async () => {
    const store = storeWith({
      addresses: { listAddresses: () => Promise.reject(new Error("connection reset")) },
    });
    const message = await thrownBy(() => listAddressProvisioningById(store));
    expect(message).toContain("faulted while it");
    expect(message).toContain("connection reset");
  });

  it("CONTROL: an unimpaired store answers rather than throwing", async () => {
    // The positive control for every case above: they must fail because the store could not
    // finish, not because these fixtures never work.
    seedDomains(3, "small");
    expect((await listDomainProvisioningById(sqliteStore())).size).toBe(3);
  });
});

// ── malformed stored rows ───────────────────────────────────────────────────────

describe("a row this module cannot read is a fault, not a default", () => {
  function domainRowWith(overrides: Record<string, unknown>): EmailStore {
    const base = sqliteStore();
    return storeWith({
      domains: {
        listDomains: async (opts) => {
          const page = await base.domains.listDomains(opts);
          if (!page.ok) return page;
          return { ok: true, value: page.value.map((row) => ({ ...row, ...overrides })) };
        },
        getDomain: async (id) => {
          const row = await base.domains.getDomain(id);
          if (!row.ok || row.value === null) return row;
          return { ok: true, value: { ...row.value, ...overrides } };
        },
      },
    });
  }

  /** The same row with the provisioning group marker REMOVED, the way an unprojected read is. */
  function domainRowWithoutStatus(): EmailStore {
    const base = sqliteStore();
    const strip = (row: DomainRecord): DomainRecord => {
      const { provisioning_status: _dropped, ...rest } = row;
      return rest as DomainRecord;
    };
    return storeWith({
      domains: {
        getDomain: async (id) => {
          const row = await base.domains.getDomain(id);
          if (!row.ok || row.value === null) return row;
          return { ok: true, value: strip(row.value) };
        },
      },
    });
  }

  it("refuses a domain whose provisioning columns were not projected at all", async () => {
    const id = seedDomain("example.com");
    expect(await thrownBy(() => getDomainProvisioning(id, domainRowWithoutStatus())))
      .toContain("no provisioning_status column at all");
    // CONTROL: the same wrapper WITH the marker reads fine, so the case above fails on the
    // missing column rather than on the wrapper.
    expect((await getDomainProvisioning(id, domainRowWith({})))!.provisioning_status).toBe("none");
  });

  it("maps an EMPTY provisioning_status to none, which is the column default", async () => {
    // DIVERGENCE 11: the HTTP arm did this and the SQLite arm passed the empty string through.
    // `""` is not a state.
    const id = seedDomain("example.com");
    expect((await getDomainProvisioning(id, domainRowWith({ provisioning_status: "" })))!.provisioning_status)
      .toBe("none");
  });

  it("refuses a domain whose nameservers column cannot be read", async () => {
    // DIVERGENCE 7: the deleted SQLite arm's `parseJsonArray` answered `[]` for all three of
    // these, which reports a domain whose nameserver list is unreadable as a domain with no
    // nameservers — and `domain adopt` prints that list to an operator.
    //
    // THE GUARD IS REACHABLE THROUGH THE HTTP STORE ONLY, and the case below says so by
    // injecting the shapes rather than writing them to SQLite: `src/store-sqlite/registry.ts`
    // maps this column with the same `parseJsonArray`, so on that store the defect now lives
    // BELOW this module and is swallowed before it can be seen. That is a store-layer defect,
    // described in the module header and deliberately not fixed here. The HTTP store copies
    // the column through unvalidated, which is the path this guard protects.
    const id = seedDomain("example.com");
    expect(await thrownBy(() => getDomainProvisioning(id, domainRowWith({ nameservers_json: "{not json" }))))
      .toContain("not JSON");
    expect(await thrownBy(() => getDomainProvisioning(id, domainRowWith({ nameservers_json: ["ok", 7] }))))
      .toContain("not a string");
    expect(await thrownBy(() => getDomainProvisioning(id, domainRowWith({ nameservers_json: { a: 1 } }))))
      .toContain("not an array");
  });

  it("accepts the JSON-text shape of nameservers, because that is the column's storage shape", async () => {
    const id = seedDomain("example.com");
    expect((await getDomainProvisioning(id, domainRowWith({ nameservers_json: '["ns1.example.net"]' })))!.nameservers)
      .toEqual(["ns1.example.net"]);
  });

  it("reads an ABSENT nameservers_json as an empty list, not as a fault", async () => {
    // `DomainRecord.nameservers_json` is OPTIONAL on the seam and the HTTP mapper copies it
    // only when the service sent it, so absence is reachable — and the column's
    // `NOT NULL DEFAULT '[]'` makes `[]` the truthful answer. Both deleted arms agreed.
    // Distinct from the null case below it and from every malformed case above: the group
    // marker has already established that the provisioning columns WERE projected.
    const id = seedDomain("example.com");
    const base = sqliteStore();
    const dropKey = (row: DomainRecord): DomainRecord => {
      const { nameservers_json: _dropped, ...rest } = row;
      return rest as DomainRecord;
    };
    const store = storeWith({
      domains: {
        getDomain: async (getId) => {
          const row = await base.domains.getDomain(getId);
          if (!row.ok || row.value === null) return row;
          return { ok: true, value: dropKey(row.value) };
        },
      },
    });
    expect((await getDomainProvisioning(id, store))!.nameservers).toEqual([]);
    // And an explicit null reads the same way.
    expect((await getDomainProvisioning(id, domainRowWith({ nameservers_json: null })))!.nameservers)
      .toEqual([]);
  });

  it("reads an EMPTY nameservers_json string as an empty list, not as bad JSON", async () => {
    // Distinct from absent and from null. Without the short-circuit `JSON.parse("")` throws and
    // the domain faults with "not JSON" — a fault for a column that simply holds nothing.
    const id = seedDomain("example.com");
    expect((await getDomainProvisioning(id, domainRowWith({ nameservers_json: "" })))!.nameservers)
      .toEqual([]);
    expect((await getDomainProvisioning(id, domainRowWith({ nameservers_json: "   " })))!.nameservers)
      .toEqual([]);
  });

  it("refuses a domain with a null dns_provider, which neither schema admits", async () => {
    const id = seedDomain("example.com");
    expect(await thrownBy(() => getDomainProvisioning(id, domainRowWith({ dns_provider: null }))))
      .toContain("null dns_provider");
  });

  it("accepts an EMPTY dns_provider, because this module can write one", async () => {
    // A value accepted on write and refused on read bricks the row.
    const id = seedDomain("example.com");
    const written = await setDomainProvisioning(id, { dns_provider: "" }, sqliteStore());
    expect(written!.dns_provider).toBe("");
    expect((await getDomainProvisioning(id, sqliteStore()))!.dns_provider).toBe("");
  });

  it("refuses an address row with no readable id", async () => {
    const domainId = seedDomain("example.com");
    seedAddress("ops@example.com", domainId);
    const base = sqliteStore();
    const store = storeWith({
      addresses: {
        listAddresses: async (opts) => {
          const page = await base.addresses.listAddresses(opts);
          if (!page.ok) return page;
          return { ok: true, value: page.value.map((row) => ({ ...row, id: "" })) };
        },
      },
    });
    expect(await thrownBy(() => listAddressProvisioningForDomain(domainId, store)))
      .toContain("no readable id");
  });

  it("refuses an address row with no readable email", async () => {
    const domainId = seedDomain("example.com");
    seedAddress("ops@example.com", domainId);
    const base = sqliteStore();
    const store = storeWith({
      addresses: {
        listAddresses: async (opts) => {
          const page = await base.addresses.listAddresses(opts);
          if (!page.ok) return page;
          return { ok: true, value: page.value.map((row) => ({ ...row, email: "" })) };
        },
      },
    });
    expect(await thrownBy(() => listAddressProvisioningForDomain(domainId, store)))
      .toContain("no readable email");
  });
});

// ── the audit trail ─────────────────────────────────────────────────────────────

describe.each(STORE_VARIANTS)("the provisioning event log through the %s", (_label, makeStore) => {
  it("records a transition and answers the row that was stored", async () => {
    const event = await recordProvisioningEvent("domain", "d1", "none", "verifying", { attempt: 1 }, makeStore());
    expect(event.entity_type).toBe("domain");
    expect(event.entity_id).toBe("d1");
    expect(event.from_state).toBe("none");
    expect(event.to_state).toBe("verifying");
    expect(event.detail).toEqual({ attempt: 1 });
    // The id and the timestamp come from the STORE, because only the store can mint them.
    expect(event.id).not.toBe("");
    expect(event.created_at).not.toBe("");
    expect(Number.isNaN(Date.parse(event.created_at))).toBe(false);
  });

  it("defaults the detail to an empty map and keeps a null from_state null", async () => {
    const event = await recordProvisioningEvent("address", "a1", null, "verifying", undefined, makeStore());
    expect(event.from_state).toBeNull();
    expect(event.detail).toEqual({});
  });

  it("reads one entity's transitions oldest first and no one else's", async () => {
    const store = makeStore();
    await recordProvisioningEvent("domain", "d1", null, "first", {}, store);
    await recordProvisioningEvent("domain", "d1", "first", "second", {}, store);
    await recordProvisioningEvent("domain", "other", null, "elsewhere", {}, store);
    await recordProvisioningEvent("address", "d1", null, "same id other type", {}, store);
    db.run("UPDATE provisioning_events SET created_at = '2026-01-01T00:00:00.000Z' WHERE to_state = 'first'");
    db.run("UPDATE provisioning_events SET created_at = '2026-01-02T00:00:00.000Z' WHERE to_state = 'second'");

    expect((await listProvisioningEvents("domain", "d1", makeStore())).map((event) => event.to_state))
      .toEqual(["first", "second"]);
  });

  it("answers no events for an entity that has none", async () => {
    expect(await listProvisioningEvents("domain", "never-touched", makeStore())).toEqual([]);
  });

  it("is not broken by an unreadable event belonging to a DIFFERENT entity", async () => {
    // REGRESSION, and it was mine: an earlier version of this module mapped every row in the
    // log before filtering by entity, so ONE malformed transition anywhere in an append-only
    // table made EVERY entity's history unreadable. The two columns the filter needs are read
    // off the raw row, so a row that is not part of the answer is never validated.
    const store = makeStore();
    await recordProvisioningEvent("domain", "mine", null, "verifying", {}, store);
    await recordProvisioningEvent("domain", "someone-else", null, "verifying", {}, store);
    db.run("UPDATE provisioning_events SET to_state = '' WHERE entity_id = 'someone-else'");

    const mine = await listProvisioningEvents("domain", "mine", makeStore());
    expect(mine.map((event) => event.to_state)).toEqual(["verifying"]);
    // CONTROL: the poisoned row really is unreadable, so the assertion above passes because it
    // was skipped rather than because the fixture failed to corrupt anything.
    expect(await thrownBy(() => listProvisioningEvents("domain", "someone-else", makeStore())))
      .toContain("no readable to_state");
  });

  it("falls through to detail_json when the row carries a NULL detail", async () => {
    // REGRESSION, also mine: an earlier version tested `Object.hasOwn(row, "detail")`, which
    // takes a present-but-NULL `detail` and answers `{}` — dropping a detail map that is right
    // there in the row's `detail_json`. The deleted HTTP arm used `??` and fell through.
    const base = sqliteStore();
    const patched = storeWith({
      provisioning: {
        listProvisioningEvents: async (opts) => {
          const page = await base.provisioning.listProvisioningEvents(opts);
          if (!page.ok) return page;
          return { ok: true, value: page.value.map((row) => ({ ...row, detail: null })) };
        },
      },
    });
    await recordProvisioningEvent("domain", "d1", null, "verifying", { attempt: 7 }, base);
    const events = await listProvisioningEvents("domain", "d1", patched);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ attempt: 7 });
  });
});

describe("the event log's order is this module's, not the store's", () => {
  it("CONTROL: the store's own order is the OPPOSITE of the published one", async () => {
    // DIVERGENCE 6. SQLite's generic resource path orders `provisioning_events`
    // `created_at DESC, id DESC` — the table has no `updated_at` — while both deleted arms
    // published oldest-first. So the store's own order is not merely unspecified here, it is
    // backwards, and a client that trusted it would print an entity's history in reverse.
    //
    // ONLY THE SQLITE SIDE IS ASSERTED. The service's spec orders the same resource
    // `created_at ASC` (`src/server/self-hosted/resources.ts`), but
    // `src/test-support/v1-store-api.ts` translates HTTP into the SEAM rather than running the
    // service's own ordering, so over the HTTP fixture both sides come back in SQLite's order.
    // That is why this module sorts rather than trusting either.
    const store = sqliteStore();
    await recordProvisioningEvent("domain", "d1", null, "first", {}, store);
    await recordProvisioningEvent("domain", "d1", "first", "second", {}, store);
    db.run("UPDATE provisioning_events SET created_at = '2026-01-01T00:00:00.000Z' WHERE to_state = 'first'");
    db.run("UPDATE provisioning_events SET created_at = '2026-01-02T00:00:00.000Z' WHERE to_state = 'second'");

    const storeOrder = await onePage(sqliteStore().provisioning.listProvisioningEvents({ limit: 500 }));
    expect(storeOrder[0]!["to_state"]).toBe("second");
    // And this module answers oldest-first over both store variants regardless.
    expect((await listProvisioningEvents("domain", "d1", sqliteStore())).map((event) => event.to_state))
      .toEqual(["first", "second"]);
    expect((await listProvisioningEvents("domain", "d1", httpStore())).map((event) => event.to_state))
      .toEqual(["first", "second"]);
  });

  it("breaks a tie on created_at by id, ascending", async () => {
    // DIVERGENCE 5: the SQLite arm tiebroke on `rowid`, which no store projects; the HTTP arm
    // had no tiebreaker at all. Events written in one pass share the millisecond.
    const store = sqliteStore();
    const a = await recordProvisioningEvent("domain", "d1", null, "a", {}, store);
    const b = await recordProvisioningEvent("domain", "d1", null, "b", {}, store);
    db.run("UPDATE provisioning_events SET created_at = '2026-01-01T00:00:00.000Z'");
    expect((await listProvisioningEvents("domain", "d1", sqliteStore())).map((event) => event.id))
      .toEqual([a.id, b.id].sort());
  });
});

describe("the event write names only the columns the resource has", () => {
  it("sends exactly the five declared columns", async () => {
    // DIVERGENCE 3. Both deleted arms sent `id` and `created_at` as well.
    let sent: ResourceInput | null = null;
    const base = sqliteStore();
    const store = storeWith({
      provisioning: {
        recordProvisioningEvent: (event) => {
          sent = event;
          return base.provisioning.recordProvisioningEvent(event);
        },
      },
    });
    await recordProvisioningEvent("domain", "d1", "none", "verifying", { attempt: 1 }, store);
    const columns = Object.keys(sent as unknown as Record<string, unknown>).sort();
    expect(columns).toEqual(["detail_json", "entity_id", "entity_type", "from_state", "to_state"]);
    // `detail_json` goes down as the OBJECT: SQLite stringifies it and the service casts it to
    // jsonb, and a pre-stringified value would double-encode on the second of those.
    expect((sent as unknown as Record<string, unknown>)["detail_json"]).toEqual({ attempt: 1 });
  });

  it("CONTROL: the deleted arm's column set is REFUSED by the real HTTP store", async () => {
    const refused = await httpStore().provisioning.recordProvisioningEvent({
      id: "caller-supplied",
      entity_type: "domain",
      entity_id: "d1",
      from_state: null,
      to_state: "verifying",
      detail_json: {},
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("invalid_input");
      expect(refused.message).toContain("has no column");
    }
  });

  it.each([
    ["entity_type", { entity_type: "address" }],
    ["entity_id", { entity_id: "somebody-else" }],
    ["from_state", { from_state: "not-what-was-asked" }],
    ["to_state", { to_state: "something else" }],
  ] as const)("refuses to report a transition whose %s the store changed", async (_field, patch) => {
    // ONE FIELD AT A TIME. A single fixture that changed only `to_state` killed the whole
    // condition while leaving the other three conjuncts individually deletable — so a store
    // that recorded a `domain` transition as an `address` one, or against the wrong entity,
    // was caught by code with no coverage at all. Adversarial review measured that.
    const base = sqliteStore();
    const store = storeWith({
      provisioning: {
        recordProvisioningEvent: (event) => base.provisioning.recordProvisioningEvent({ ...event, ...patch }),
      },
    });
    expect(await thrownBy(() => recordProvisioningEvent("domain", "d1", "none", "verifying", {}, store)))
      .toContain("recorded a different provisioning event");
  });

  it("refuses an event row with no created_at rather than stamping now()", async () => {
    // DIVERGENCE 8: the deleted HTTP arm read this through a coercion that returns
    // `new Date().toISOString()` for a MISSING value, so an unreadable timestamp was reported
    // as "this happened just now".
    const base = sqliteStore();
    const store = storeWith({
      provisioning: {
        recordProvisioningEvent: async (event) => {
          const created = await base.provisioning.recordProvisioningEvent(event);
          if (!created.ok) return created;
          const { created_at: _dropped, ...rest } = created.value;
          return { ok: true, value: rest as ResourceRow };
        },
      },
    });
    expect(await thrownBy(() => recordProvisioningEvent("domain", "d1", null, "verifying", {}, store)))
      .toContain("no readable created_at");
  });

  it("refuses an event row whose entity_type is neither a domain nor an address", async () => {
    const base = sqliteStore();
    const store = storeWith({
      provisioning: {
        recordProvisioningEvent: async (event) => {
          const created = await base.provisioning.recordProvisioningEvent(event);
          if (!created.ok) return created;
          return { ok: true, value: { ...created.value, entity_type: "mailbox" } };
        },
      },
    });
    expect(await thrownBy(() => recordProvisioningEvent("domain", "d1", null, "verifying", {}, store)))
      .toContain("neither a domain nor an address");
  });
});

// ── the daemon queue ────────────────────────────────────────────────────────────

const PAST = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const NOW = "2026-06-01T00:00:00.000Z";

describe.each(STORE_VARIANTS)("the daemon queue through the %s", (_label, makeStore) => {
  async function seedQueue(): Promise<{ due: string; later: string }> {
    const store = makeStore();
    const due = seedDomain("due.example");
    const later = seedDomain("later.example");
    const notYet = seedDomain("not-yet.example");
    const terminal = seedDomain("terminal.example");
    seedDomain("never-scheduled.example");
    await setDomainProvisioning(due, { provisioning_status: "verifying", next_check_at: PAST }, store);
    await setDomainProvisioning(later, { provisioning_status: "verifying", next_check_at: LATER }, store);
    await setDomainProvisioning(notYet, { provisioning_status: "verifying", next_check_at: FUTURE }, store);
    await setDomainProvisioning(terminal, { provisioning_status: "failed", next_check_at: PAST }, store);
    return { due, later };
  }

  it("lists the domains whose check has arrived, soonest first", async () => {
    const { due, later } = await seedQueue();
    expect((await claimDueDomains(NOW, makeStore())).map((row) => row.id)).toEqual([due, later]);
  });

  it("excludes every terminal state, derived from TERMINAL_STATES", async () => {
    const store = makeStore();
    const scheduled: string[] = [];
    for (const state of TERMINAL_STATES) {
      const id = seedDomain(`${state}.example`);
      await setDomainProvisioning(id, { provisioning_status: state, next_check_at: PAST }, store);
      scheduled.push(id);
    }
    const active = seedDomain("active.example");
    await setDomainProvisioning(active, { provisioning_status: "verifying", next_check_at: PAST }, store);
    const due = await claimDueDomains(NOW, makeStore());
    expect(due.map((row) => row.id)).toEqual([active]);
    for (const id of scheduled) expect(due.some((row) => row.id === id)).toBe(false);
  });

  it("includes a row whose check falls EXACTLY on the asOf instant", async () => {
    // The `<=` boundary, and it was undiscriminated: every other case uses a check time strictly
    // before or strictly after `asOf`, so `<=` weakened to `<` survived. A reconciler that
    // schedules `next_check_at = now()` and then asks for due work at that same instant is the
    // realistic shape, and under `<` its own row is invisible for a tick.
    const store = makeStore();
    const onTheDot = seedDomain("exact.example");
    await setDomainProvisioning(onTheDot, { provisioning_status: "verifying", next_check_at: NOW }, store);
    expect((await claimDueDomains(NOW, makeStore())).map((row) => row.id)).toEqual([onTheDot]);
    // CONTROL: one millisecond later it is not yet due, so the assertion above is about the
    // boundary rather than about the comparison being absent.
    const justAfter = new Date(Date.parse(NOW) + 1).toISOString();
    const later = seedDomain("just-after.example");
    await setDomainProvisioning(later, { provisioning_status: "verifying", next_check_at: justAfter }, store);
    expect((await claimDueDomains(NOW, makeStore())).map((row) => row.id)).toEqual([onTheDot]);
  });

  it("excludes a row with no next_check_at even when it is not terminal", async () => {
    const id = seedDomain("unscheduled.example");
    await setDomainProvisioning(id, { provisioning_status: "verifying" }, makeStore());
    expect(await claimDueDomains(NOW, makeStore())).toEqual([]);
  });

  it("does the same for addresses", async () => {
    const store = makeStore();
    const due = seedAddress("due@example.com");
    const notYet = seedAddress("later@example.com");
    await setAddressProvisioning(due, { provisioning_status: "verifying", next_check_at: PAST }, store);
    await setAddressProvisioning(notYet, { provisioning_status: "verifying", next_check_at: FUTURE }, store);
    expect((await claimDueAddresses(NOW, makeStore())).map((row) => row.id)).toEqual([due]);
  });

  it("breaks a tie on next_check_at by id, ascending", async () => {
    const store = makeStore();
    const first = seedDomain("aaa.example");
    const second = seedDomain("bbb.example");
    for (const id of [first, second]) {
      await setDomainProvisioning(id, { provisioning_status: "verifying", next_check_at: PAST }, store);
    }
    expect((await claimDueDomains(NOW, makeStore())).map((row) => row.id)).toEqual([first, second].sort());
  });

  it("summarises due and failed work on both sides, with an availability record", async () => {
    const store = makeStore();
    await seedQueue();
    const address = seedAddress("due@example.com");
    await setAddressProvisioning(address, { provisioning_status: "verifying", next_check_at: PAST }, store);
    const failedAddress = seedAddress("failed@example.com");
    await setAddressProvisioning(failedAddress, { provisioning_status: "failed" }, store);

    const summary = await getProvisioningWorkSummary(NOW, makeStore());
    expect(summary.due_domains).toBe(2);
    expect(summary.failed_domains).toBe(1);
    expect(summary.due_addresses).toBe(1);
    expect(summary.failed_addresses).toBe(1);
    expect(summary.availability.available).toBe(true);
    expect(summary.availability.complete).toBe(true);
    expect(summary.availability.basis).toBe("client_enumeration");
  });
});

describe("the work summary reports a bound instead of refusing", () => {
  it("marks the counts as lower bounds when the enumeration could not finish", async () => {
    // The ONE aggregate whose shape can carry a bound. Its counts stay real numbers and
    // `availability.complete === false` is what makes `renderStatusCount` print `≥N`.
    seedDomains(600, "due", { status: "verifying", next: PAST });
    const base = sqliteStore();
    // Three rows a page: see the page-budget case for why one is not enough.
    const store = storeWith({
      domains: { listDomains: (opts) => base.domains.listDomains({ ...opts, limit: 3 }) },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.availability.available).toBe(true);
    expect(summary.availability.complete).toBe(false);
    expect(summary.availability.reason).toContain("lower bounds, not totals");
    // A BOUND, not a zero and not a null: rows really were read.
    expect(summary.due_domains).toBeGreaterThan(0);
    expect(summary.due_domains).toBeLessThan(600);
  });

  it("marks the counts as bounds when the ADDRESSES side is the truncated one", async () => {
    // The domains twin of this case existed and this one did not, so deleting the addresses
    // arm of `combineQueueAvailability` survived mutation — and with it deleted, a truncated
    // address enumeration reports `complete: true` and the renderer prints BARE INTEGERS.
    // That is divergence 1 reintroduced on the local side, which is the whole point of the
    // change. Adversarial review found it.
    const domainId = seedDomain("bulk.example");
    seedAddresses(600, "due", domainId, "verifying");
    db.run("UPDATE addresses SET next_check_at = ? WHERE id LIKE 'due-%'", [PAST]);
    const base = sqliteStore();
    const store = storeWith({
      addresses: { listAddresses: (opts) => base.addresses.listAddresses({ ...opts, limit: 3 }) },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.availability.complete).toBe(false);
    expect(summary.availability.reason).toContain("lower bounds, not totals");
    // The DOMAINS side read cleanly, and its numbers are still nulled — one record covers all
    // four, so a renderer cannot show two of them without the `≥` the others have not earned.
    expect(summary.due_addresses).toBeGreaterThan(0);
    expect(summary.due_addresses).toBeLessThan(600);
  });

  it("names the enumeration_cap_exceeded CODE, not just the shared prose", async () => {
    // Both arms of the reason end in "counts are lower bounds, not totals", so asserting only
    // that tail let the `enumeration.stable` test be inverted with nothing noticing — a page
    // budget running out would then be reported as `enumeration_unstable`, a fabricated
    // accusation that the store's list order is not total, printed verbatim to the operator.
    // `statusReasonCode` reads the prefix, so the machine-readable classification is wrong too.
    seedDomains(600, "due", { status: "verifying", next: PAST });
    const base = sqliteStore();
    const store = storeWith({
      domains: { listDomains: (opts) => base.domains.listDomains({ ...opts, limit: 3 }) },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.availability.reason).toContain("enumeration_cap_exceeded:");
    expect(summary.availability.reason).not.toContain("enumeration_unstable");
    expect(statusReasonCode(summary.availability.reason)).toBe("enumeration_cap_exceeded");
  });

  it("names the enumeration_unstable CODE when the window moved instead", async () => {
    seedDomains(600, "bulk");
    const base = sqliteStore();
    let pages = 0;
    const store = storeWith({
      domains: {
        listDomains: async (opts) => {
          pages += 1;
          const page = await base.domains.listDomains(opts);
          if (!page.ok || pages === 1) return page;
          return { ok: true, value: page.value.slice(1) };
        },
      },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(statusReasonCode(summary.availability.reason)).toBe("enumeration_unstable");
  });

  it("classifies a NON-capability refusal as a live failure, not a structural one", async () => {
    // Only `capability_unavailable` reached this ternary. The else-branch decides whether
    // `statusGapClass` calls the installation `degraded`, so misclassifying a live store
    // failure as structural is the "flag nobody reads" failure this vocabulary exists to stop.
    const store = storeWith({
      domains: {
        listDomains: async () => ({ ok: false, code: "not_found", message: "no such scope", status: 404 }),
      },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(statusReasonCode(summary.availability.reason)).toBe("source_unreachable");
    expect(statusGapClass(summary.availability.reason)).toBe("failure");
    // CONTROL: the capability refusal really is classified the other way.
    const structural = await getProvisioningWorkSummary(NOW, storeWith({
      domains: { listDomains: async () => CAPABILITY_REFUSAL },
    }));
    expect(statusGapClass(structural.availability.reason)).toBe("structural");
  });

  it("reports BOTH sides when both fail, rather than only the first", async () => {
    // A structural refusal on one side and a live transport fault on the other: returning the
    // first record would hide the outage an operator can actually fix, and `statusGapClass`
    // would call the whole thing structural.
    const store = storeWith({
      domains: { listDomains: async () => CAPABILITY_REFUSAL },
      addresses: { listAddresses: () => Promise.reject(new Error("connection reset")) },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.availability.available).toBe(false);
    expect(summary.availability.reason).toContain("capability_unavailable");
    expect(summary.availability.reason).toContain("connection reset");
    expect(statusGapClass(summary.availability.reason)).toBe("failure");
  });

  it("nulls every count and records the reason when the store refuses", async () => {
    const store = storeWith({ domains: { listDomains: async () => CAPABILITY_REFUSAL } });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.due_domains).toBeNull();
    expect(summary.failed_domains).toBeNull();
    // BOTH sides are nulled, because one availability record covers all four numbers and a
    // renderer cannot show two of them without a `≥` the other two have not earned.
    expect(summary.due_addresses).toBeNull();
    expect(summary.failed_addresses).toBeNull();
    expect(summary.availability.available).toBe(false);
    expect(summary.availability.reason).toContain("store_refusal:capability_unavailable");
    // A declared-false capability is STRUCTURAL, not a live failure.
    expect(summary.availability.reason).toContain("not_modelled_on_store");
  });

  it("nulls every count and records the reason when the store faults", async () => {
    const store = storeWith({
      addresses: { listAddresses: () => Promise.reject(new Error("connection reset")) },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.due_addresses).toBeNull();
    expect(summary.due_domains).toBeNull();
    expect(summary.availability.available).toBe(false);
    expect(summary.availability.reason).toContain("source_unreachable");
    expect(summary.availability.reason).toContain("connection reset");
  });

  it("nulls the counts rather than throwing when a row cannot be mapped", async () => {
    // A status command must still render. The distinction survives in the reason string; what
    // does not survive is any number.
    seedDomain("example.com");
    const base = sqliteStore();
    const store = storeWith({
      domains: {
        listDomains: async (opts) => {
          const page = await base.domains.listDomains(opts);
          if (!page.ok) return page;
          return {
            ok: true,
            value: page.value.map((row) => {
              const { provisioning_status: _dropped, ...rest } = row;
              return rest as DomainRecord;
            }),
          };
        },
      },
    });
    const summary = await getProvisioningWorkSummary(NOW, store);
    expect(summary.due_domains).toBeNull();
    expect(summary.availability.available).toBe(false);
    expect(summary.availability.reason).toContain("no provisioning_status column at all");
  });

  it("keeps a malformed nameserver list from stopping the queue", async () => {
    // The queue asks about two columns and must not be blocked by a third it never reads. A
    // domain whose nameservers cannot be parsed is still a domain whose check is due.
    const id = seedDomain("example.com");
    await setDomainProvisioning(id, { provisioning_status: "verifying", next_check_at: PAST }, sqliteStore());
    const base = sqliteStore();
    const corrupt = (rows: DomainRecord[]): DomainRecord[] =>
      rows.map((row) => ({ ...row, nameservers_json: "{not json" as unknown as string[] }));
    const store = storeWith({
      domains: {
        listDomains: async (opts) => {
          const page = await base.domains.listDomains(opts);
          return page.ok ? { ok: true, value: corrupt(page.value) } : page;
        },
        getDomain: async (getId) => {
          const row = await base.domains.getDomain(getId);
          if (!row.ok || row.value === null) return row;
          return { ok: true, value: corrupt([row.value])[0] as DomainRecord };
        },
      },
    });
    expect((await claimDueDomains(NOW, store)).map((row) => row.id)).toEqual([id]);
    expect((await getProvisioningWorkSummary(NOW, store)).due_domains).toBe(1);
    // CONTROL: a read that DOES look at the column refuses the very same row, so the two
    // assertions above pass because the queue avoids the column rather than because this
    // fixture failed to corrupt it.
    expect(await thrownBy(() => getDomainProvisioning(id, store))).toContain("not JSON");
  });
});

// ── the default store ───────────────────────────────────────────────────────────

describe("the configured store", () => {
  it("is used when no store is passed", async () => {
    // No store argument: `configureExactlyOneStore` leaves the SQLite path as the only one, so
    // this exercises the resolution rather than an injected handle.
    const id = seedDomain("example.com");
    await setDomainProvisioning(id, { provisioning_status: "verifying" });
    expect((await getDomainProvisioning(id))!.provisioning_status).toBe("verifying");
    expect((await listDomainProvisioningById()).size).toBe(1);
    expect(await countReadyAddressesForDomain(id)).toBe(0);
    expect(await claimDueDomains()).toEqual([]);
    expect((await getProvisioningWorkSummary()).availability.available).toBe(true);
  });
});

// ── the deleted arms ────────────────────────────────────────────────────────────

describe("the two arms are gone", () => {
  const here = new URL(".", import.meta.url).pathname;

  it("has one implementation and no siblings", () => {
    // THE POSITIVE CONTROLS COME FIRST, so a broken path fails this test instead of satisfying
    // it: the directory resolves, the facade exists, and it is a real implementation rather
    // than a stub.
    expect(existsSync(here)).toBe(true);
    expect(existsSync(join(here, "provisioning.ts"))).toBe(true);
    const source = readFileSync(join(here, "provisioning.ts"), "utf8");
    expect(source.length).toBeGreaterThan(4000);
    expect(source).toContain("store-resolution.js");

    expect(existsSync(join(here, "provisioning.local.ts"))).toBe(false);
    expect(existsSync(join(here, "provisioning.remote.ts"))).toBe(false);
  });
});
