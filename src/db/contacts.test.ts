// The contacts family — suppression ledger and counters — over the store seam,
// against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/contacts.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any filtered list or write — and reach SQLite
// through the real `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`:
// a `/v1` service that stores nothing and translates every request onto the same store
// seam, backed by the same in-memory database the SQLite variant reads. Both variants
// answer from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back.
//
// THE CASES SEEDED PAST 500 ROWS ARE THE POINT OF THE COLLAPSE. Both stores clamp a
// list page to 500 rows, and the deleted second arm answered every lookup out of ONE
// such page: a contact past the clamp was unfindable by email — `isContactSuppressed`
// answered false for a suppressed address — and suppress-then-find missed the existing
// row and CREATED A DUPLICATE. Each has a case below, with a raw one-page CONTROL
// proving the clamp is real so the whole-set discipline cannot pass vacuously.
//
// THE PINNED CONTRACT (deliberate, not legacy drift — src/db/contacts.ts divergence 6):
// suppressing OR unsuppressing an address with no contact row CREATES the row in the
// named state. A suppression ledger that can only suppress addresses it has already
// mailed cannot hold an unsubscribe from an import or an operator's pre-emptive block;
// create-on-unsuppress rides with it because both deleted arms shared it for the whole
// 1.x line and the row it leaves is what `upsertContact` would have left.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  getContact,
  getSuppressedEmailSet,
  incrementBounceCount,
  incrementBounceCounts,
  incrementComplaintCount,
  incrementComplaintCounts,
  incrementSendCount,
  incrementSendCounts,
  isContactSuppressed,
  listContacts,
  suppressContact,
  suppressedRecipientsAmong,
  unsuppressContact,
  upsertContact,
  type ContactStore,
} from "./contacts.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
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
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Leave exactly ONE store configured, named through the resolution's OWN exported
 * constants: a stray inherited API setting beside the database path is a hard boot error
 * with deliberately no precedence rule, and it would turn every default-store case into
 * that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi | null = null;

function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "contact row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (contacts test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

// ─── Seeding straight into the shared table ─────────────────────────────────
//
// A case that needs chosen ids, chosen timestamps, or more rows than one page holds
// writes the table directly. Both variants read this same data.

function seedContact(row: {
  id: string;
  email: string;
  suppressed?: boolean;
  send_count?: number;
  bounce_count?: number;
  created_at?: string;
  updated_at?: string;
}): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 0, NULL, ?, ?, ?)`,
    [row.id, row.email, row.send_count ?? 0, row.bounce_count ?? 0, row.suppressed ? 1 : 0, at, row.updated_at ?? at],
  );
}

/** Raw rows for one address, straight from the table — the duplicate detector. */
function rowsFor(email: string): Array<{ id: string; suppressed: number }> {
  return db
    .query("SELECT id, suppressed FROM contacts WHERE lower(email) = lower(?)")
    .all(email) as Array<{ id: string; suppressed: number }>;
}

const pad = (value: number): string => String(value).padStart(3, "0");

describe.each(STORE_VARIANTS)("contact CRUD (%s)", (_label, variant) => {
  it("creates a new contact with zeroed counters", async () => {
    const c = await upsertContact("alice@example.com", variant());
    expect(c.id).toHaveLength(36);
    expect(c.email).toBe("alice@example.com");
    expect(c.send_count).toBe(0);
    expect(c.bounce_count).toBe(0);
    expect(c.complaint_count).toBe(0);
    expect(c.suppressed).toBe(false);
    expect(c.name).toBeNull();
    expect(c.last_sent_at).toBeNull();
    expect(c.created_at).toBeTruthy();
    expect(c.updated_at).toBeTruthy();
  });

  it("returns the existing contact on duplicate upsert, counters intact", async () => {
    const store = variant();
    seedContact({ id: "c-bob", email: "bob@example.com", send_count: 7 });
    const again = await upsertContact("bob@example.com", store);
    expect(again.id).toBe("c-bob");
    expect(again.send_count).toBe(7);
    expect(rowsFor("bob@example.com")).toHaveLength(1);
  });

  it("answers the existing contact for a re-spelled address instead of minting a sibling row", async () => {
    // `Bob@Example.com` and `bob@example.com` are one recipient. Two rows for one
    // address split the counters and let one spelling stay unsuppressed — the exact
    // hole canonical matching exists to close.
    const store = variant();
    const first = await upsertContact("bob@example.com", store);
    const respelled = await upsertContact("Bob@Example.com", store);
    expect(respelled.id).toBe(first.id);
    expect(rowsFor("bob@example.com")).toHaveLength(1);
  });

  it("retrieves a contact by email and answers null for an unknown one", async () => {
    const store = variant();
    await upsertContact("test@example.com", store);
    expect((await getContact("test@example.com", store))?.email).toBe("test@example.com");
    expect(await getContact("unknown@example.com", store)).toBeNull();
  });

  it("finds a contact stored under another spelling of the same address", async () => {
    // Stored mixed-case, queried lowercase: neither store's generic path folds case,
    // so this is answerable only by the whole-table canonical scan. A null here is
    // what let a suppression check pass a send it should have refused.
    seedContact({ id: "c-mixed", email: "Blocked@Ext.com", suppressed: true });
    const store = variant();
    const found = await getContact("blocked@ext.com", store);
    expect(found?.id).toBe("c-mixed");
    expect(found?.suppressed).toBe(true);
    expect(await isContactSuppressed("blocked@ext.com", store)).toBe(true);
  });
});

describe.each(STORE_VARIANTS)("contact listing (%s)", (_label, variant) => {
  it("returns an empty array when there are no contacts", async () => {
    expect(await listContacts(undefined, variant())).toEqual([]);
  });

  it("lists every contact, filters by suppression, and windows AFTER filtering", async () => {
    const store = variant();
    for (let i = 0; i < 5; i++) {
      await suppressContact(`suppressed-${i}@example.com`, store);
    }
    await upsertContact("active@example.com", store);

    expect(await listContacts(undefined, store)).toHaveLength(6);
    const active = await listContacts({ suppressed: false }, store);
    expect(active.map((c) => c.email)).toEqual(["active@example.com"]);

    const page = await listContacts({ suppressed: true, limit: 2, offset: 1 }, store);
    expect(page).toHaveLength(2);
    expect(page.every((c) => c.suppressed)).toBe(true);
    expect(page.map((c) => c.email)).not.toContain("active@example.com");
  });

  it("orders contacts sharing an updated_at instant identically on both stores", async () => {
    // No tiebreaker was the old arms' shape; rows written in one batch share the
    // instant, and the id tiebreaker is what makes the window reproducible.
    seedContact({ id: "c-b", email: "tie-b@example.com", updated_at: "2026-01-01T00:00:00.000Z" });
    seedContact({ id: "c-a", email: "tie-a@example.com", updated_at: "2026-01-01T00:00:00.000Z" });
    seedContact({ id: "c-c", email: "tie-c@example.com", updated_at: "2026-01-01T00:00:00.000Z" });
    const rows = await listContacts(undefined, variant());
    expect(rows.map((c) => c.id)).toEqual(["c-c", "c-b", "c-a"]);
  });

  it("faults on a row whose required timestamp is missing instead of dating it now", async () => {
    seedContact({ id: "c-blank", email: "blank@example.com", updated_at: "2026-01-01T00:00:00.000Z" });
    db.run("UPDATE contacts SET updated_at = '' WHERE id = 'c-blank'");
    await expect(listContacts(undefined, variant())).rejects.toThrow(/c-blank.*updated_at/);
  });
});

describe.each(STORE_VARIANTS)("suppression state (%s)", (_label, variant) => {
  it("suppresses and unsuppresses an existing contact", async () => {
    const store = variant();
    await upsertContact("test@example.com", store);
    expect(await isContactSuppressed("test@example.com", store)).toBe(false);
    await suppressContact("test@example.com", store);
    expect(await isContactSuppressed("test@example.com", store)).toBe(true);
    await unsuppressContact("test@example.com", store);
    expect(await isContactSuppressed("test@example.com", store)).toBe(false);
    expect(rowsFor("test@example.com")).toHaveLength(1);
  });

  it("PINNED: suppress of an unknown address creates the row suppressed", async () => {
    const store = variant();
    await suppressContact("imported-unsubscribe@example.com", store);
    const created = await getContact("imported-unsubscribe@example.com", store);
    expect(created).not.toBeNull();
    expect(created?.suppressed).toBe(true);
    expect(created?.send_count).toBe(0);
  });

  it("PINNED: unsuppress of an unknown address creates the row active", async () => {
    const store = variant();
    await unsuppressContact("never-seen@example.com", store);
    const created = await getContact("never-seen@example.com", store);
    expect(created).not.toBeNull();
    expect(created?.suppressed).toBe(false);
  });

  it("suppress of a re-spelled address flips the existing row rather than creating a sibling", async () => {
    seedContact({ id: "c-original", email: "Person@Example.com" });
    const store = variant();
    await suppressContact("person@example.com", store);
    const rows = rowsFor("person@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: "c-original", suppressed: 1 });
  });

  it("answers false for an unknown address", async () => {
    expect(await isContactSuppressed("unknown@example.com", variant())).toBe(false);
  });
});

describe.each(STORE_VARIANTS)("counters (%s)", (_label, variant) => {
  it("counts sends per address, stamps last_sent_at, and creates missing rows", async () => {
    const store = variant();
    seedContact({ id: "c-known", email: "known@example.com", send_count: 2 });
    await incrementSendCounts(["known@example.com", "new@example.com", "new@example.com"], store);
    const known = await getContact("known@example.com", store);
    expect(known?.send_count).toBe(3);
    expect(known?.last_sent_at).toBeTruthy();
    const fresh = await getContact("new@example.com", store);
    expect(fresh?.send_count).toBe(2);
    expect(fresh?.last_sent_at).toBeTruthy();
    expect(fresh?.suppressed).toBe(false);
  });

  it("auto-suppresses at three bounces, whether in one batch or across calls", async () => {
    const store = variant();
    await incrementBounceCounts(["burst@example.com", "burst@example.com", "burst@example.com"], store);
    const burst = await getContact("burst@example.com", store);
    expect(burst?.bounce_count).toBe(3);
    expect(burst?.suppressed).toBe(true);

    await incrementBounceCounts(["slow@example.com", "slow@example.com"], store);
    expect(await isContactSuppressed("slow@example.com", store)).toBe(false);
    await incrementBounceCount("slow@example.com", store);
    const slow = await getContact("slow@example.com", store);
    expect(slow?.bounce_count).toBe(3);
    expect(slow?.suppressed).toBe(true);
  });

  it("counts complaints without suppressing, and singular wrappers count one", async () => {
    const store = variant();
    await incrementComplaintCounts(["c@example.com"], store);
    await incrementComplaintCount("c@example.com", store);
    const c = await getContact("c@example.com", store);
    expect(c?.complaint_count).toBe(2);
    expect(c?.suppressed).toBe(false);
    await incrementSendCount("c@example.com", store);
    expect((await getContact("c@example.com", store))?.send_count).toBe(1);
  });

  it("counts against the EXISTING row for a re-spelled address", async () => {
    seedContact({ id: "c-spell", email: "Spelled@Example.com", bounce_count: 2 });
    const store = variant();
    await incrementBounceCount("spelled@example.com", store);
    const rows = rowsFor("spelled@example.com");
    expect(rows).toHaveLength(1);
    const updated = await getContact("Spelled@Example.com", store);
    expect(updated?.bounce_count).toBe(3);
    expect(updated?.suppressed).toBe(true);
  });

  it("does nothing for an empty batch", async () => {
    const store = variant();
    await incrementSendCounts([], store);
    await incrementBounceCounts([], store);
    await incrementComplaintCounts([], store);
    expect(await listContacts(undefined, store)).toEqual([]);
  });
});

describe.each(STORE_VARIANTS)("the suppressed set (%s)", (_label, variant) => {
  it("returns only the suppressed addresses among the input", async () => {
    const store = variant();
    await upsertContact("active@example.com", store);
    await suppressContact("blocked@example.com", store);
    await suppressContact("also-blocked@example.com", store);

    const suppressed = await getSuppressedEmailSet(
      [
        "active@example.com",
        "blocked@example.com",
        "blocked@example.com",
        "also-blocked@example.com",
        "unknown@example.com",
      ],
      store,
    );
    expect(suppressed).toEqual(new Set(["blocked@example.com", "also-blocked@example.com"]));
  });

  it("matches canonically in BOTH directions and keeps both spellings in the set", async () => {
    seedContact({ id: "c-stored-mixed", email: "Blocked@Ext.com", suppressed: true });
    seedContact({ id: "c-stored-lower", email: "quiet@ext.com", suppressed: true });
    const store = variant();

    const suppressed = await getSuppressedEmailSet(
      ["blocked@ext.com", "Loud Person <QUIET@ext.com>", "fine@ext.com"],
      store,
    );
    expect(suppressed.has("Blocked@Ext.com")).toBe(true);
    expect(suppressed.has("blocked@ext.com")).toBe(true);
    expect(suppressed.has("quiet@ext.com")).toBe(true);
    expect([...suppressed].some((value) => value.includes("fine@"))).toBe(false);

    // The recipient helper answers in the CALLER's spelling.
    const named = await suppressedRecipientsAmong(
      ["Loud Person <QUIET@ext.com>", "fine@ext.com", "blocked@ext.com"],
      store,
    );
    expect(named).toEqual(["Loud Person <QUIET@ext.com>", "blocked@ext.com"]);
  });

  it("answers the empty set for an empty or blank input without reading anything", async () => {
    expect(await getSuppressedEmailSet([], variant())).toEqual(new Set());
    expect(await getSuppressedEmailSet(["   ", ""], variant())).toEqual(new Set());
  });
});

describe("contact lookups past one clamped page", () => {
  it("finds, suppresses ONCE, and lists whole — and the clamp is real", async () => {
    // 520 contacts; the target sorts BELOW the first 500 of the store's newest-first
    // order because its updated_at is the oldest.
    for (let i = 0; i < 520; i++) {
      seedContact({ id: `c-${pad(i)}`, email: `bulk-${pad(i)}@example.com`, updated_at: `2026-02-01T00:00:${pad(i)}Z` });
    }
    seedContact({ id: "c-target", email: "needle@example.com", updated_at: "2026-01-01T00:00:00.000Z" });

    const store = httpStore();
    // CONTROL: one page really cannot see the whole table — without this the whole-set
    // claims below could pass over a fixture that never clamped anything.
    const onePage = await store.contacts.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // The deleted arm's one-page find answered null here.
    expect((await getContact("needle@example.com", store))?.id).toBe("c-target");

    // …and its suppress-then-find therefore created a DUPLICATE row. One row, flipped.
    await suppressContact("needle@example.com", store);
    expect(rowsFor("needle@example.com")).toEqual([{ id: "c-target", suppressed: 1 }]);
    expect(await isContactSuppressed("needle@example.com", store)).toBe(true);

    // The suppressed set sees past the clamp too.
    const suppressed = await getSuppressedEmailSet(["needle@example.com", "bulk-000@example.com"], store);
    expect(suppressed.has("needle@example.com")).toBe(true);
    expect(suppressed.has("bulk-000@example.com")).toBe(false);

    // A listing is the whole table, never 500 of 521.
    expect(await listContacts(undefined, store)).toHaveLength(521);
  });
});

describe("the store argument", () => {
  it("refuses a value that is neither an EmailStore nor a Database, naming both", async () => {
    await expect(
      listContacts(undefined, { not: "a store" } as unknown as ContactStore),
    ).rejects.toThrow(/EmailStore or a bun:sqlite Database/);
  });
});
