// The address-lifecycle family has ONE implementation, and every fact it reports comes
// through the store seam.
//
// WHY THIS SUITE IS PARAMETERISED OVER BOTH STORES. The family used to be a facade over
// two modules that disagreed about MEANING, not just about mechanism: one enforced a daily
// quota against a real send ledger, the other hard-coded the usage figure to 0 and so could
// never enforce a quota at all. A collapsed implementation that is only ever exercised
// against one store cannot show that the disagreement is gone — it can only show that one
// side of it still works. So every behavioural case below runs TWICE — once against a real
// SQLite store and once against a real HTTP store in front of the same seam — and the
// assertions are identical.
//
// WHAT IS TESTED HARDEST, in order:
//
//  1. THE QUOTA IS REAL ON BOTH STORES. This is the behaviour the deleted API arm did not
//     have. The case seeds sends, sets a quota, and requires the send to be blocked.
//  2. A COUNT IS NEVER FABRICATED. A store that cannot be enumerated to the end reports
//     `null`, and a sendability answer that could not be determined RAISES. `0` and
//     `sendable: true` are the two values those answers must never be spelled as.
//  3. THE SENDER MATCH IS EXACT. `ListMessagesOptions.from` is a SUBSTRING match on both
//     stores, so a positive control proves the filter really is a superset and a paired
//     case proves the client-side equality rejects the extra rows. Without it,
//     `ceo@acme.com`'s quota is consumed by sends from `xceo@acme.com`.
//  4. THE DAY IS BOUNDED ON BOTH SIDES. `since` is a lower bound only, where the deleted
//     arm's `LIKE '<day>%'` bounded the day above as well.
//  5. TIE-BREAKING IS DETERMINISTIC. Two rows for one email used to resolve differently
//     per arm; a suspended row must win on both stores.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { AddressRecord, ListMessagesOptions, MessageListRecord, Page } from "../store/records.js";
import {
  activateAddress,
  countSendsToday,
  countSendsTodayByAddress,
  getAddressSendability,
  setAddressQuota,
  suspendAddress,
} from "./address-lifecycle.js";

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

/** A stamp inside `day`, far enough from both edges that no clock skew straddles them. */
function at(day: string, hour = 12): string {
  return `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

interface SeedSend {
  from: string;
  /** When the send happened. Defaults to midday today. */
  at?: string;
}

/**
 * One store, plus the only two fixtures these cases need.
 *
 * BOTH HARNESSES SEED THROUGH THEIR OWN STORE'S WRITES, so a case cannot be set up by a
 * path the family would never take — the HTTP side's fixture rows go over the wire through
 * `createAddress` and `createMessage` exactly as production writes would.
 */
interface Harness {
  readonly name: string;
  store(): EmailStore;
  seedAddress(input: { email: string; status?: string; daily_quota?: number | null; created_at?: string }): Promise<string>;
  seedSends(sends: SeedSend[]): Promise<void>;
}

// ---- SQLite harness ---------------------------------------------------------

let db: Database;
let INHERITED_ENV: NodeJS.ProcessEnv;

/**
 * The SQLite `addresses` table has a NOT NULL provider foreign key that the seam's
 * `AddressInput` does not carry, so a registry row cannot exist there without a provider.
 * Neither the seam nor the `/v1` address model has a provider dimension — which is exactly
 * why `AddressRecord` has no `provider_id` — so this is a fixture step for whichever
 * database is underneath, never something a caller of this family supplies.
 */
async function ensureSqliteProvider(store: EmailStore): Promise<void> {
  const listed = await store.providers.list({ limit: 1 });
  if (!listed.ok) throw new Error(`could not read providers: ${listed.message}`);
  if (listed.value.length > 0) return;
  const created = await store.providers.create({ name: "sandbox", type: "sandbox", active: 1 });
  if (!created.ok) throw new Error(`could not seed a provider: ${created.message}`);
}

const sqliteHarness: Harness = {
  name: "a local SQLite store",
  store: () => createSqliteEmailStore({ database: db, detail: "SQLite in-memory (address-lifecycle test)" }),
  async seedAddress(input) {
    const store = sqliteHarness.store();
    await ensureSqliteProvider(store);
    const created = await store.addresses.createAddress({
      email: input.email,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.daily_quota === undefined ? {} : { daily_quota: input.daily_quota }),
    });
    if (!created.ok) throw new Error(`could not seed the address: ${created.message}`);
    if (input.created_at !== undefined) {
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [input.created_at, created.value.id]);
    }
    return created.value.id;
  },
  async seedSends(sends) {
    const store = sqliteHarness.store();
    for (const send of sends) {
      const created = await store.messages.createMessage({
        direction: "outbound",
        from_addr: send.from,
        to_addrs: ["recipient@example.test"],
        subject: "seed",
        received_at: send.at ?? at(TODAY),
      });
      if (!created.ok) throw new Error(`could not seed the send: ${created.message}`);
    }
  },
};

// ---- HTTP harness (a real HTTP client in front of a real store) -------------
//
// `src/test-support/v1-store-api.ts`, NOT `v1-stub.ts`, and the choice is the point of this
// half of the suite. The stub keeps its own in-memory dictionary, so a client that mis-maps
// a field is handed its own mistake back; this fixture STORES NOTHING — it translates the
// service's real routes onto an `EmailStore` and serves every row out of it, with the route
// contract pinned to the server's own OpenAPI document. It also serves the message-record
// route, so the writes below go through the client rather than around it.
//
// The backing store is the same in-memory database the SQLite harness uses. That is safe
// because each case below runs against ONE harness and `beforeEach` resets the database, and
// it is what makes the comparison meaningful: identical rows, two client stacks, and the
// family may not be able to tell.

let api: V1StoreApi;

const httpHarness: Harness = {
  // NO environment is configured for this store: it is constructed with the fixture's own
  // origin and key. A test that resolved the store from configuration would be testing the
  // resolver, and this suite is testing the family.
  name: "a real HTTP store in front of the seam",
  store: () => createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey }),
  async seedAddress(input) {
    // The provider row is a property of the BACKING store, not of the client: the SQLite
    // `addresses` table has a NOT NULL provider foreign key and the seam's `AddressInput`
    // carries no provider, so the fixture's own database needs one before any address write.
    await ensureSqliteProvider(createSqliteEmailStore({ database: db, detail: "http fixture backing" }));
    const store = httpHarness.store();
    const created = await store.addresses.createAddress({
      email: input.email,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.daily_quota === undefined ? {} : { daily_quota: input.daily_quota }),
    });
    if (!created.ok) throw new Error(`could not seed the address: ${created.message}`);
    if (input.created_at !== undefined) {
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [input.created_at, created.value.id]);
    }
    return created.value.id;
  },
  async seedSends(sends) {
    const store = httpHarness.store();
    for (const send of sends) {
      const created = await store.messages.createMessage({
        direction: "outbound",
        from_addr: send.from,
        to_addrs: ["recipient@example.test"],
        subject: "seed",
        received_at: send.at ?? at(TODAY),
      });
      if (!created.ok) throw new Error(`could not seed the send: ${created.message}`);
    }
  },
};

beforeEach(() => {
  INHERITED_ENV = { ...process.env };
  // EXACTLY ONE store is configured for this file, and the key list is read from
  // `src/store-resolution.ts` rather than re-spelled, so a new setting cannot be missed
  // here. Anything else is a BOOT ERROR from `planEmailStore` — correctly: an installation
  // with both a database path and an API configured has two places to keep its mail and no
  // way to tell which was meant. The config-driven cases below resolve a real store, so an
  // inherited API setting from the developer's shell would fail them for the wrong reason.
  for (const key of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS, ...DATABASE_PATH_SETTINGS]) {
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "v1 fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_ENV);
});

const HARNESSES: readonly Harness[] = [sqliteHarness, httpHarness];

for (const harness of HARNESSES) {
  describe(`address lifecycle over ${harness.name}`, () => {
    it("suspends, reactivates, and reports both transitions as idempotent", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });

      expect((await suspendAddress(id, store)).status).toBe("suspended");
      // IDEMPOTENCE, asserted rather than assumed: neither deleted arm made a repeated
      // transition an error and neither store does, so a future store that started
      // refusing the second write would be a divergence and not a hardening.
      expect((await suspendAddress(id, store)).status).toBe("suspended");
      expect((await activateAddress(id, store)).status).toBe("active");
      expect((await activateAddress(id, store)).status).toBe("active");
    });

    it("raises AddressNotFoundError for an unknown id rather than reporting a write", async () => {
      const store = harness.store();
      await expect(suspendAddress("11111111-9999-4000-8000-000000000000", store)).rejects.toThrow(/not found/i);
    });

    it("stores and clears a daily quota, and refuses a negative one", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });
      expect((await setAddressQuota(id, 50, store)).daily_quota).toBe(50);
      expect((await setAddressQuota(id, null, store)).daily_quota).toBeNull();
      await expect(setAddressQuota(id, -1, store)).rejects.toThrow(/quota/i);
      // The refusal must not have written anything on the way to being refused.
      expect((await setAddressQuota(id, 7, store)).daily_quota).toBe(7);
    });

    it("returns the seam's address record, which carries no provider id to fabricate", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });
      const record: AddressRecord = await suspendAddress(id, store);
      // The deleted API arm coerced a missing provider id to the empty string and shipped it
      // in every CLI and MCP payload. The seam's record has no such field, so the value is
      // ABSENT rather than wrong — asserted, because re-adding it would be a silent
      // regression to a fabricated id.
      expect(Object.prototype.hasOwnProperty.call(record, "provider_id")).toBe(false);
      expect(record.email).toBe("a@x.test");
    });

    it("reports an unregistered sender as unrestricted", async () => {
      const store = harness.store();
      const answer = await getAddressSendability("ghost@x.test", store);
      expect(answer.sendable).toBe(true);
      expect(answer.reason).toBeNull();
      expect(answer.daily_quota).toBeNull();
      // The narrowness of the answer is IN the answer, in every outcome including this one:
      // nothing but registration was checked, so `sendable: true` here says only "this
      // installation has no row for this address" and never "outbound policy passed".
      expect(answer.evaluated).toEqual(["registration"]);
    });

    it("blocks a suspended sender, case-insensitively", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "Ceo@x.test" });
      await suspendAddress(id, store);
      for (const spelling of ["ceo@x.test", "CEO@X.TEST", '"The CEO" <Ceo@x.test>']) {
        const answer = await getAddressSendability(spelling, store);
        expect(answer.sendable).toBe(false);
        expect(answer.reason).toMatch(/suspend/i);
        // Suspension short-circuits, so the quota was never asked about.
        expect(answer.evaluated).toEqual(["registration", "suspension"]);
      }
    });

    it("ENFORCES a daily quota against real sends counted through the seam", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });
      await setAddressQuota(id, 2, store);
      await harness.seedSends([{ from: "a@x.test" }, { from: "a@x.test" }]);

      const answer = await getAddressSendability("a@x.test", store);
      expect(answer.sendable).toBe(false);
      expect(answer.reason).toMatch(/quota/i);
      expect(answer.daily_quota).toBe(2);
      expect(answer.sent_today).toBe(2);
      expect(answer.evaluated).toEqual(["registration", "suspension", "quota"]);
    });

    it("leaves a sender under its quota sendable and reports the usage it measured", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });
      await setAddressQuota(id, 3, store);
      await harness.seedSends([{ from: "a@x.test" }]);

      const answer = await getAddressSendability("a@x.test", store);
      expect(answer.sendable).toBe(true);
      expect(answer.sent_today).toBe(1);
      expect(answer.sent_today_is_lower_bound).toBe(false);
      expect(answer.daily_quota).toBe(3);
      // A PASS names its checks too. #117's lesson: a loss reported only on failure is a
      // loss reported only where someone is already looking.
      expect(answer.evaluated).toEqual(["registration", "suspension", "quota"]);
    });

    it("blocks every send at a quota of zero", async () => {
      const store = harness.store();
      const id = await harness.seedAddress({ email: "a@x.test" });
      // 0 is a legal quota on both stores, so it is a usable "stop this address" setting
      // and `used >= quota` has to hold with nothing sent at all.
      await setAddressQuota(id, 0, store);
      const answer = await getAddressSendability("a@x.test", store);
      expect(answer.sendable).toBe(false);
      expect(answer.reason).toMatch(/quota/i);
    });

    it("counts today's sends, and counts a display-name row toward the address", async () => {
      const store = harness.store();
      await harness.seedSends([
        { from: "a@x.test" },
        { from: '"A Team" <a@x.test>' },
        { from: "b@x.test" },
      ]);
      expect(await countSendsToday("a@x.test", store)).toBe(2);
      expect(await countSendsToday('"A Team" <a@x.test>', store)).toBe(2);
      expect(await countSendsToday("b@x.test", store)).toBe(1);
      expect(await countSendsToday("nobody@x.test", store)).toBe(0);
    });

    it("bounds the day on BOTH sides, not just below", async () => {
      const store = harness.store();
      await harness.seedSends([
        { from: "a@x.test", at: at(YESTERDAY) },
        { from: "a@x.test", at: at(TODAY) },
        // `since` is a lower bound only. A row stamped tomorrow passes the store's filter
        // and must still not be counted against today, which is what the deleted arm's
        // `sent_at LIKE '<day>%'` bounded above.
        { from: "a@x.test", at: at(TOMORROW) },
      ]);
      expect(await countSendsToday("a@x.test", store)).toBe(1);
    });

    it("does not let a longer address consume a shorter one's quota (substring filter)", async () => {
      const store = harness.store();
      await harness.seedSends([{ from: "xceo@x.test" }, { from: "ceo@x.test.uk" }, { from: "ceo@x.test" }]);

      // POSITIVE CONTROL: the store's own `from` filter really is a substring match, so all
      // three rows ARE served to the read below. Without this the exactness assertion could
      // be passing because the filter already excluded the neighbours.
      const served = await store.messages.listMessages({ direction: "outbound", from: "ceo@x.test", limit: 100 });
      expect(served.ok).toBe(true);
      if (served.ok) {
        expect(served.value.items.map((row) => row.from_addr).sort()).toEqual([
          "ceo@x.test",
          "ceo@x.test.uk",
          "xceo@x.test",
        ]);
      }

      // EXACTLY ONE, and the count is asserted rather than only its non-inflation. An
      // assertion of `0` alone would hold for a family that counts nothing at all — which
      // is what the deleted API arm did — so it would pass with this collapse reverted.
      expect(await countSendsToday("ceo@x.test", store)).toBe(1);
      expect(await countSendsToday("xceo@x.test", store)).toBe(1);
      expect(await countSendsToday("ceo@x.test.uk", store)).toBe(1);
    });

    it("pages a count past the store's own 500-row clamp", async () => {
      const store = harness.store();
      // 501 SENDS, ONE MORE THAN A PAGE. Both stores clamp a list at 500 (`MAX_PAGE` in the
      // SQLite store; `clampLimit` in the service), so an
      // implementation that trusted a single page — or that stopped on the second, SHORT page
      // before it was empty — reports 500 for 501 sends and calls it exact. This is the case
      // that exercises the real clamp rather than a fake one, on both client stacks: a
      // fixture that was more permissive than the service on exactly this read is how a
      // silently truncated export once shipped with green tests.
      await harness.seedSends(Array.from({ length: 501 }, () => ({ from: "bulk@x.test" })));
      expect(await countSendsToday("bulk@x.test", store)).toBe(501);
    }, 30_000);

    it("counts many addresses, keyed the way it canonicalises them", async () => {
      const store = harness.store();
      await harness.seedSends([{ from: "a@x.test" }, { from: "a@x.test" }, { from: "c@x.test" }]);
      const counts = await countSendsTodayByAddress(['"A" <a@x.test>', "A@X.TEST", "c@x.test", "d@x.test"], store);
      expect([...counts.entries()].sort()).toEqual([
        ["a@x.test", 2],
        ["c@x.test", 1],
        ["d@x.test", 0],
      ]);
    });
  });
}

// ---- resolved from CONFIGURATION, with nothing injected ---------------------
//
// The cases above hand the family a store, which is the right way to pin behaviour and the
// wrong way to prove that a real configuration reaches it. These two inject NOTHING, so
// they go through `createConfiguredEmailStore()` — and they are the local-store half of the
// change-detector evidence, because the deleted local arm counted `SELECT COUNT(*) FROM
// emails`, the LEGACY ledger table only, while the seam's outbound stream unions that ledger
// with the outbound rows in the unified table. A send recorded only in the unified table was
// invisible to that arm's quota check.

describe("address lifecycle — resolved from configuration", () => {
  it("counts a send the deleted local arm's ledger-only query could not see", async () => {
    await sqliteHarness.seedSends([{ from: "cfg@x.test" }, { from: "cfg@x.test" }]);
    expect(await countSendsToday("cfg@x.test")).toBe(2);
  });

  it("enforces a quota against those rows, with no store injected", async () => {
    const id = await sqliteHarness.seedAddress({ email: "cfg@x.test" });
    expect((await setAddressQuota(id, 1)).daily_quota).toBe(1);
    await sqliteHarness.seedSends([{ from: "cfg@x.test" }]);

    const answer = await getAddressSendability("cfg@x.test");
    expect(answer.sendable).toBe(false);
    expect(answer.reason).toMatch(/quota/i);
    expect(answer.sent_today).toBe(1);
  });
});

// ---- refusal, truncation and fault boundaries -------------------------------
//
// These override ONE method of a real store rather than hand-rolling a partial object cast
// to `EmailStore`, so a signature drift on the seam is a `tsc` error here instead of a
// silently-unexercised branch.

function realStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (address-lifecycle test)" });
}

/** A real store with a provider already registered, so an address row can be written. */
async function seededStore(): Promise<EmailStore> {
  const store = realStore();
  await ensureSqliteProvider(store);
  return store;
}

function storeListingAddressesWith(answer: Outcome<AddressRecord[]>): EmailStore {
  const base = realStore();
  return { ...base, addresses: { ...base.addresses, listAddresses: async () => answer } };
}

function storeListingMessagesWith(answer: Outcome<Page<MessageListRecord>>): EmailStore {
  const base = realStore();
  return { ...base, messages: { ...base.messages, listMessages: async () => answer } };
}

const REFUSAL = { ok: false, code: "capability_unavailable", message: "the test store does not provide this", status: 501 } as const;

describe("address lifecycle — what it does when the store cannot answer", () => {
  it("raises on a refused address read instead of reporting the sender unrestricted", async () => {
    // A REFUSAL IS NOT AN EMPTY REGISTRY. `sendable: true` is what "this sender is not
    // registered" looks like, so a store that refused the question must not be able to
    // produce it — that is a store nothing was learned from certifying a send.
    const refusing = storeListingAddressesWith(REFUSAL);
    await expect(getAddressSendability("a@x.test", refusing)).rejects.toThrow(/capability_unavailable/);
  });

  it("raises on a refused message read instead of counting zero sends", async () => {
    const store = await seededStore();
    const created = await store.addresses.createAddress({ email: "a@x.test", daily_quota: 1 });
    expect(created.ok).toBe(true);

    const base = realStore();
    const refusing: EmailStore = {
      ...base,
      messages: { ...base.messages, listMessages: async () => REFUSAL },
    };
    // 0 is the value the deleted API arm returned here, and 0 satisfies every quota.
    await expect(getAddressSendability("a@x.test", refusing)).rejects.toThrow(/capability_unavailable/);
    await expect(countSendsToday("a@x.test", refusing)).rejects.toThrow(/capability_unavailable/);
  });

  it("reports null, never zero, for a count that could not be finished", async () => {
    // A store that always has one more page. The scan hits its budget, so the count is a
    // floor — and a floor reported as a total is how a store's clamp gets published as
    // usage. `null` is the only honest answer.
    const endless = storeListingMessagesWith({
      ok: true,
      value: {
        items: [
          {
            id: "seed", direction: "outbound", from_addr: "a@x.test", to_addrs: [], cc_addrs: [],
            subject: null, status: "sent", provider_message_id: null, message_id: null, in_reply_to: null,
            received_at: at(TODAY), is_read: true, is_starred: false, labels: [], source_id: null,
            send_state: "none", send_started_at: null, created_at: at(TODAY), updated_at: at(TODAY),
            snippet: null, attachment_count: 0, policy_denial: null,
          },
        ],
        next_cursor: "always-more",
      },
    });
    expect(await countSendsToday("a@x.test", endless)).toBeNull();
  });

  it("raises rather than allowing a send whose quota could not be resolved", async () => {
    const store = await seededStore();
    const created = await store.addresses.createAddress({ email: "a@x.test", daily_quota: 5_000_000 });
    expect(created.ok).toBe(true);

    // A store with endless pages of rows that do NOT match the sender, so the floor never
    // reaches the quota and the scan never ends. Under-quota-and-unfinished is exactly the
    // case where reporting `sendable: true` is a guess, and the guess mails the message.
    const base = realStore();
    const endless: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        listMessages: async () => ({
          ok: true,
          value: {
            items: [
              {
                id: "other", direction: "outbound", from_addr: "someone-else@x.test", to_addrs: [], cc_addrs: [],
                subject: null, status: "sent", provider_message_id: null, message_id: null, in_reply_to: null,
                received_at: at(TODAY), is_read: true, is_starred: false, labels: [], source_id: null,
                send_state: "none", send_started_at: null, created_at: at(TODAY), updated_at: at(TODAY),
                snippet: null, attachment_count: 0, policy_denial: null,
              },
            ],
            next_cursor: "always-more",
          },
        }),
      },
    };
    await expect(getAddressSendability("a@x.test", endless)).rejects.toThrow(/could not be determined/);
  });

  it("stops the address scan only on an EMPTY page, advancing by rows RECEIVED", async () => {
    const store = await seededStore();
    const created = await store.addresses.createAddress({ email: "late@x.test", status: "suspended" });
    expect(created.ok).toBe(true);
    const row = created.ok ? created.value : null;
    if (!row) throw new Error("fixture failed");

    // A store that serves a SHORT page (one row, not the 500 requested) and only then the
    // row that matters. Treating the short page as end-of-table would report this sender
    // unrestricted; advancing the offset by 500 instead of by 1 would skip the row.
    const base = realStore();
    const offsets: number[] = [];
    const shortPaging: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async (opts) => {
          const offset = opts?.offset ?? 0;
          offsets.push(offset);
          if (offset === 0) return { ok: true, value: [{ ...row, id: "filler", email: "filler@x.test" }] };
          if (offset === 1) return { ok: true, value: [row] };
          return { ok: true, value: [] };
        },
      },
    };

    const answer = await getAddressSendability("late@x.test", shortPaging);
    expect(answer.sendable).toBe(false);
    expect(offsets).toEqual([0, 1, 2]);
  });

  it("raises rather than reporting a sender unregistered from a truncated scan", async () => {
    const store = await seededStore();
    const created = await store.addresses.createAddress({ email: "filler@x.test" });
    expect(created.ok).toBe(true);
    const row = created.ok ? created.value : null;
    if (!row) throw new Error("fixture failed");

    // A registry that never runs out. "I did not find the row" and "I did not finish
    // looking" have opposite consequences for a send, and only the first may reach the
    // unrestricted branch.
    const endless = storeListingAddressesWith({ ok: true, value: [row] });
    await expect(getAddressSendability("unseen@x.test", endless)).rejects.toThrow(/could not be determined/);
  });

  // TIE-BREAKING lives here rather than in the parameterised block because the two stores
  // cannot both hold the fixture: SQLite's `addresses` table is UNIQUE on (provider_id,
  // email), so a second row for one email needs a second provider — and the seam's
  // `AddressInput` carries no provider, so it cannot ask for one. The ordering is
  // client-side anyway, which is what has to be pinned: the deleted local arm ordered
  // deterministically (`suspended` first, then `created_at DESC`) and the deleted API arm
  // took whatever position the dataset returned first, so two installations holding the
  // same two rows disagreed about whether that email could send.
  it("prefers a suspended row over an active one for the same email, in any input order", async () => {
    const store = await seededStore();
    const created = await store.addresses.createAddress({ email: "dup@x.test" });
    if (!created.ok) throw new Error("fixture failed");
    const active: AddressRecord = { ...created.value, id: "active", status: "active", created_at: "2026-06-01T00:00:00.000Z" };
    const suspended: AddressRecord = { ...created.value, id: "suspended", status: "suspended", created_at: "2026-01-01T00:00:00.000Z" };

    // The ACTIVE row is newest, so recency alone picks the wrong one; both input orders are
    // exercised so the answer cannot depend on the store's own ordering.
    for (const rows of [[active, suspended], [suspended, active]]) {
      const listing = storeListingAddressesWith({ ok: true, value: rows });
      const answer = await getAddressSendability("dup@x.test", {
        ...listing,
        addresses: {
          ...listing.addresses,
          listAddresses: async (opts) => ((opts?.offset ?? 0) === 0 ? { ok: true, value: rows } : { ok: true, value: [] }),
        },
      });
      expect(answer.sendable).toBe(false);
      expect(answer.reason).toMatch(/suspend/i);
    }
  });

  // FOUND BY MUTATION TESTING, and it is the reason that pass exists. Reverting
  // `applyWrite`'s refusal throw left every test in this file green: nothing exercised a
  // REFUSED lifecycle write, so a store that declined to suspend an address would have been
  // reported to the CLI and to MCP as a completed suspension. Three writes, one check each.
  it("raises on a refused lifecycle write instead of reporting it as done", async () => {
    const base = await seededStore();
    const created = await base.addresses.createAddress({ email: "a@x.test" });
    if (!created.ok) throw new Error("fixture failed");
    const id = created.value.id;

    const refusing: EmailStore = {
      ...base,
      addressLifecycle: {
        ...base.addressLifecycle,
        suspendAddress: async () => REFUSAL,
        activateAddress: async () => REFUSAL,
        setAddressQuota: async () => REFUSAL,
      },
    };
    await expect(suspendAddress(id, refusing)).rejects.toThrow(/capability_unavailable/);
    await expect(activateAddress(id, refusing)).rejects.toThrow(/capability_unavailable/);
    await expect(setAddressQuota(id, 5, refusing)).rejects.toThrow(/capability_unavailable/);

    // POSITIVE CONTROL that the refusals were refusals and not silent writes: the row is
    // exactly as it was. Without this the assertions above would also hold for an
    // implementation that threw AFTER writing.
    const readBack = await base.addresses.getAddress(id);
    expect(readBack.ok).toBe(true);
    if (readBack.ok) {
      expect(readBack.value?.status).toBe("active");
      expect(readBack.value?.daily_quota).toBeNull();
    }
  });

  // ALSO FOUND BY MUTATION TESTING. Dropping the `from` push-down changed no answer — the
  // client-side equality is the contract and it holds either way — so nothing was red, and
  // the module's claim that the store narrows the scan was unasserted. It is a claim about
  // COST rather than about correctness, which is exactly the kind that rots unnoticed: an
  // unfiltered scan of a busy day would page until the budget ran out and then report a
  // floor for an address that has an exact answer.
  it("pushes the sender, direction and day filters to the store", async () => {
    const base = await seededStore();
    const seen: ListMessagesOptions[] = [];
    const observing: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        listMessages: async (opts) => {
          seen.push(opts ?? {});
          return base.messages.listMessages(opts);
        },
      },
    };

    expect(await countSendsToday("watch@x.test", observing)).toBe(0);
    // Not a vacuous check: a read that never happened would satisfy every assertion below.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.from).toBe("watch@x.test");
    expect(seen[0]?.direction).toBe("outbound");
    expect(seen[0]?.since).toBe(`${TODAY}T00:00:00.000Z`);
  });

  it("propagates a store fault as a fault, not as an empty answer", async () => {
    const base = realStore();
    const faulting: EmailStore = {
      ...base,
      addresses: {
        ...base.addresses,
        listAddresses: async () => {
          throw new Error("connection reset by peer");
        },
      },
    };
    await expect(getAddressSendability("a@x.test", faulting)).rejects.toThrow(/connection reset/);
  });
});
