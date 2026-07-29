// The delivery-event family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/events.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any filtered list or write — and reach SQLite
// through the real `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`:
// a `/v1` service that stores nothing and translates every request onto the same store
// seam, backed by the same in-memory database the SQLite variant reads. Both variants
// answer from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back. (The OLD stub accepted client-posted `id`s verbatim,
// which is exactly how the deleted arm's fabricated-id create stayed green — see
// divergence 3 in src/db/events.ts. This fixture routes creates through the real
// generic path, which mints its own.)
//
// THE DUPLICATE-DELIVERY CASES ARE THE POINT (#146). The deleted SQLite arm's
// `INSERT OR IGNORE` was a load-bearing dedup layer; the deleted second arm's stand-in
// was a find over ONE clamped page, so a duplicate whose original sat past the newest
// 500 events was re-created. Each variant below proves the upsert skips a duplicate it
// has to CROSS THE CLAMP to see, with a raw one-page control proving the clamp is real
// so the proof cannot pass vacuously.
//
// THE ORDERING CASES ARE THE OTHER HALF. The two stores' generic lists order this
// table differently (SQLite `created_at DESC` — its ingestion clock — and the service
// `occurred_at DESC`), so a backfilled event sits at the TOP of one raw order and deep
// inside the other. The collapse sorts the enumerated set itself; the cases that seed
// ingestion order against occurrence order are what keep that sort load-bearing, and
// they are the reason a bounded read cannot trust either store's raw window
// (divergence 6 in src/db/events.ts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  createEvent,
  getEvent,
  getEventsByEmail,
  listEvents,
  listEventSummaries,
  upsertEvent,
  upsertEventWithResult,
  type EventStore,
} from "./events.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import {
  STORE_ENUMERATION_PAGE_BUDGET,
  STORE_LIST_PAGE_MAX,
} from "../lib/status-facts-enumeration.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { ListOptions, ResourceInput, ResourceRow } from "../store/records.js";
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
 * constants: a stray inherited API setting beside the database path is a hard boot
 * error with deliberately no precedence rule, and it would turn every case into that
 * error the moment the environment carried one.
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "events row fixture" }) });
  seedProvider(PROVIDER_ID);
  seedProvider(OTHER_PROVIDER_ID);
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (events test)" });
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
// The local schema enforces its foreign keys (`PRAGMA foreign_keys = ON`), so every
// event row needs a real provider and a linked event needs a real message row. A case
// that needs chosen ids, chosen timestamps, malformed payloads, or more rows than one
// page holds writes the table directly; both variants read this same data.

const PROVIDER_ID = "prov-events-1";
const OTHER_PROVIDER_ID = "prov-events-2";

function seedProvider(id: string): void {
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'sandbox', 1)", [id, id]);
}

function seedEmail(id: string): void {
  db.run(
    "INSERT INTO emails (id, provider_id, from_address, subject, sent_at) VALUES (?, ?, 'a@x.test', 's', ?)",
    [id, PROVIDER_ID, "2026-01-01T00:00:00.000Z"],
  );
}

function seedEvent(row: {
  id: string;
  provider_id?: string;
  email_id?: string | null;
  provider_event_id?: string | null;
  type?: string;
  recipient?: string | null;
  metadata?: string;
  occurred_at?: string;
  created_at?: string;
}): void {
  db.run(
    `INSERT INTO events (id, email_id, provider_id, provider_event_id, type, recipient, metadata, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.email_id ?? null,
      row.provider_id ?? PROVIDER_ID,
      row.provider_event_id ?? null,
      row.type ?? "delivered",
      row.recipient ?? null,
      row.metadata ?? "{}",
      row.occurred_at ?? "2026-01-01T00:00:00.000Z",
      row.created_at ?? row.occurred_at ?? "2026-01-01T00:00:00.000Z",
    ],
  );
}

/** Bulk rows inside one transaction, so the >20k budget case seeds in tenths of a second. */
function seedEventRows(count: number, rowOf: (index: number) => Parameters<typeof seedEvent>[0]): void {
  db.run("BEGIN");
  try {
    for (let index = 0; index < count; index++) seedEvent(rowOf(index));
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

const pad = (value: number): string => String(value).padStart(6, "0");

/** An ISO instant `seconds` before a fixed epoch, so ordering is choosable per row. */
function isoAt(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 20) - seconds * 1000).toISOString();
}

describe.each(STORE_VARIANTS)("event writes (%s)", (_label, variant) => {
  it("creates an event and answers with the row the store holds", async () => {
    const store = variant();
    const created = await createEvent(
      {
        provider_id: PROVIDER_ID,
        provider_event_id: "evt-created-1",
        type: "delivered",
        recipient: "user@example.com",
        metadata: { note: "hello" },
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
      store,
    );
    expect(created.id).toBeTruthy();
    expect(created.provider_id).toBe(PROVIDER_ID);
    expect(created.provider_event_id).toBe("evt-created-1");
    expect(created.type).toBe("delivered");
    expect(created.recipient).toBe("user@example.com");
    expect(created.metadata).toEqual({ note: "hello" });
    expect(created.email_id).toBeNull();
    // The STORE's stamp, as an ISO instant — never the input echoed back.
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // THE ID NAMES A STORED ROW. The deleted second arm returned a locally minted id
    // the service had dropped, so this exact read answered null against production.
    const roundTripped = await getEvent(created.id, store);
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.provider_event_id).toBe("evt-created-1");
    expect(roundTripped!.metadata).toEqual({ note: "hello" });
  });

  it("stores the metadata OBJECT once, not a string of JSON", async () => {
    // Divergence 4: the deleted arm double-encoded metadata on the wire. Whichever
    // encoding the store performed, the RAW stored column must hold one level of
    // JSON — an object at the JSON layer, not a quoted string of JSON.
    const store = variant();
    const created = await createEvent(
      { provider_id: PROVIDER_ID, type: "clicked", metadata: { url: "https://example.com" }, occurred_at: isoAt(0) },
      store,
    );
    const raw = db.query("SELECT metadata FROM events WHERE id = ?").get(created.id) as { metadata: string };
    expect(JSON.parse(raw.metadata)).toEqual({ url: "https://example.com" });
  });

  it("skips a duplicate delivery it must cross the page clamp to see (#146)", async () => {
    // 520 events for this provider, the DUPLICATE'S ORIGINAL OLDEST-CREATED — on the
    // SQLite generic order (created_at DESC) it is the LAST row of the table, past
    // the 500-row clamp of any one page. The deleted second arm's one-page dedup
    // could not see it and re-created it.
    seedEvent({
      id: "evt-original",
      provider_event_id: "pe-dup",
      occurred_at: isoAt(10_000),
      created_at: isoAt(10_000),
    });
    seedEventRows(519, (index) => ({
      id: `evt-fill-${pad(index)}`,
      provider_event_id: `pe-fill-${index}`,
      occurred_at: isoAt(9_000 - index),
      created_at: isoAt(9_000 - index),
    }));
    const store = variant();

    // CONTROL: the clamp is real — one raw page cannot hold the whole table, and the
    // original is not on it. Without this, the whole-set discipline passes vacuously.
    const onePage = await store.events.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(STORE_LIST_PAGE_MAX);
    expect(onePage.value.some((row) => row["id"] === "evt-original")).toBe(false);

    const result = await upsertEventWithResult(
      { provider_id: PROVIDER_ID, provider_event_id: "pe-dup", type: "delivered", occurred_at: isoAt(0) },
      store,
    );
    expect(result.created).toBe(false);
    expect(result.event.id).toBe("evt-original");
    // Still exactly one row carries the provider event id.
    const count = db
      .query("SELECT COUNT(*) AS n FROM events WHERE provider_id = ? AND provider_event_id = ?")
      .get(PROVIDER_ID, "pe-dup") as { n: number };
    expect(count.n).toBe(1);
  });

  it("reports created for the first delivery and not for the second", async () => {
    const store = variant();
    const input = {
      provider_id: PROVIDER_ID,
      provider_event_id: "pe-once",
      type: "delivered" as const,
      occurred_at: isoAt(5),
    };
    const first = await upsertEventWithResult(input, store);
    const second = await upsertEventWithResult(input, store);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(await listEvents({ provider_id: PROVIDER_ID }, store)).toHaveLength(1);
  });

  it("dedups per provider, not globally: the same provider event id under another provider is a new event", async () => {
    const store = variant();
    const first = await upsertEvent(
      { provider_id: PROVIDER_ID, provider_event_id: "pe-shared", type: "delivered", occurred_at: isoAt(2) },
      store,
    );
    const second = await upsertEvent(
      { provider_id: OTHER_PROVIDER_ID, provider_event_id: "pe-shared", type: "delivered", occurred_at: isoAt(1) },
      store,
    );
    expect(second.id).not.toBe(first.id);
  });

  it("creates separate events when there is no provider_event_id to deduplicate on", async () => {
    const store = variant();
    await upsertEvent({ provider_id: PROVIDER_ID, type: "delivered", occurred_at: isoAt(2) }, store);
    await upsertEvent({ provider_id: PROVIDER_ID, type: "delivered", occurred_at: isoAt(1) }, store);
    expect(await listEvents({ provider_id: PROVIDER_ID }, store)).toHaveLength(2);
  });

  it("control: the store's own unique key refuses the losing side of a create race with a typed conflict", async () => {
    // The upsert's race branch rides this refusal (src/db/events.ts divergence 1), so
    // the refusal itself is pinned here: a second CREATE (not upsert) of the same
    // (provider_id, provider_event_id) must come back `conflict`, never a duplicate
    // row and never a fault.
    const store = variant();
    const write: ResourceInput = {
      email_id: null,
      provider_id: PROVIDER_ID,
      provider_event_id: "pe-conflict",
      type: "delivered",
      recipient: null,
      metadata: {},
      occurred_at: isoAt(0),
    };
    const first = await store.events.create(write);
    expect(first.ok).toBe(true);
    const second = await store.events.create(write);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("conflict");
  });

  it("answers the winner's row when the create loses the race between find and create", async () => {
    // The race cannot be staged for real in one thread, so the branch is driven
    // directly: a store whose find sees nothing, whose create then refuses with
    // `conflict`, and whose NEXT find surfaces the winner. The upsert must answer
    // that winner with `created: false` — not throw, and not claim a create.
    const winner: ResourceRow = {
      id: "evt-race-winner",
      email_id: null,
      provider_id: PROVIDER_ID,
      provider_event_id: "pe-race",
      type: "delivered",
      recipient: null,
      metadata: "{}",
      occurred_at: isoAt(3),
      created_at: isoAt(3),
    };
    let enumerations = 0;
    const base = sqliteStore();
    const racing: EmailStore = {
      ...base,
      events: {
        async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
          // First enumeration (the find): empty — nothing there yet. Everything after
          // the conflict serves the winner as a one-row table (the pager re-reads its
          // anchor row, so the row must stay servable, not be a one-shot).
          if ((opts?.offset ?? 0) === 0) enumerations += 1;
          if (enumerations <= 1) return { ok: true, value: [] };
          return { ok: true, value: (opts?.offset ?? 0) === 0 ? [winner] : [] };
        },
        async get(): Promise<Outcome<ResourceRow | null>> {
          return { ok: true, value: null };
        },
        async create(): Promise<Outcome<ResourceRow>> {
          return { ok: false, code: "conflict", status: 409, message: "the write conflicts with an existing row" };
        },
        async update(): Promise<Outcome<ResourceRow | null>> {
          return { ok: true, value: null };
        },
        async remove(): Promise<Outcome<boolean>> {
          return { ok: true, value: false };
        },
      },
    };
    const result = await upsertEventWithResult(
      { provider_id: PROVIDER_ID, provider_event_id: "pe-race", type: "delivered", occurred_at: isoAt(0) },
      racing,
    );
    expect(result.created).toBe(false);
    expect(result.event.id).toBe("evt-race-winner");
  });

  it("re-checks BOTH halves of the dedup key against a store that ignores filters", async () => {
    // The pushed-down (provider_id, provider_event_id) filters are a BOUND, not the
    // answer. A store or fixture that ignores equality filters serves the whole
    // table — including ANOTHER provider's event carrying the same provider event id
    // — and an upsert that trusted it would return that foreign row as "existing"
    // and silently drop this provider's delivery. Driven through a stand-in store
    // because both shipped stores DO apply the filters, which is exactly what made
    // the weakened re-check invisible to every other case (a mutation-test survivor
    // found it).
    const foreign: ResourceRow = {
      id: "evt-foreign",
      email_id: null,
      provider_id: OTHER_PROVIDER_ID,
      provider_event_id: "pe-cross",
      type: "delivered",
      recipient: null,
      metadata: "{}",
      occurred_at: isoAt(9),
      created_at: isoAt(9),
    };
    const base = sqliteStore();
    const filterBlind: EmailStore = {
      ...base,
      events: {
        ...base.events,
        async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
          // Every filter ignored; the foreign row is always served, then the end.
          return { ok: true, value: (opts?.offset ?? 0) === 0 ? [foreign] : [] };
        },
      },
    };
    const result = await upsertEventWithResult(
      { provider_id: PROVIDER_ID, provider_event_id: "pe-cross", type: "delivered", occurred_at: isoAt(0) },
      filterBlind,
    );
    expect(result.created).toBe(true);
    expect(result.event.id).not.toBe("evt-foreign");
    expect(result.event.provider_id).toBe(PROVIDER_ID);
  });

  it("surfaces the store's refusal when the dedup key cannot be asked about, instead of creating blindly", async () => {
    // A service older than the `provider_event_id` filter declaration is refused by
    // the HTTP store's contract check. The upsert must let that refusal out — an
    // "upsert" that cannot ask whether the event exists is a blind create — and must
    // not fall through to the write.
    let created = 0;
    const base = sqliteStore();
    const undeclared: EmailStore = {
      ...base,
      events: {
        ...base.events,
        async list(): Promise<Outcome<ResourceRow[]>> {
          return {
            ok: false,
            code: "invalid_input",
            status: 422,
            message: "events.list: /v1/events does not filter on provider_event_id",
          };
        },
        async create(input: ResourceInput): Promise<Outcome<ResourceRow>> {
          created += 1;
          return base.events.create(input);
        },
      },
    };
    await expect(
      upsertEventWithResult(
        { provider_id: PROVIDER_ID, provider_event_id: "pe-undeclared", type: "delivered", occurred_at: isoAt(0) },
        undeclared,
      ),
    ).rejects.toThrow(/does not filter on provider_event_id/);
    expect(created).toBe(0);
  });
});

describe.each(STORE_VARIANTS)("event reads (%s)", (_label, variant) => {
  it("presents occurred_at order, not either store's ingestion order", async () => {
    // Ingestion order DISAGREES with occurrence order: the most recently OCCURRED
    // event was ingested FIRST (a backfill), so SQLite's raw created_at order puts it
    // last and occurred_at order puts it first. A read that trusted either store's
    // raw window would present the wrong order on one of the two variants — which is
    // exactly why bounded reads cannot early-stop on the seam (divergence 6).
    seedEvent({ id: "evt-backfilled", occurred_at: isoAt(0), created_at: isoAt(500) });
    seedEvent({ id: "evt-middle", occurred_at: isoAt(10), created_at: isoAt(400) });
    seedEvent({ id: "evt-oldest", occurred_at: isoAt(20), created_at: isoAt(300) });

    const listed = await listEvents({}, variant());
    expect(listed.map((event) => event.id)).toEqual(["evt-backfilled", "evt-middle", "evt-oldest"]);
  });

  it("filters by email, provider, single type, multiple types, since and until — re-checked, not trusted", async () => {
    seedEmail("email-filter-1");
    seedEvent({ id: "evt-f1", email_id: "email-filter-1", type: "delivered", occurred_at: isoAt(40) });
    seedEvent({ id: "evt-f2", type: "bounced", occurred_at: isoAt(30) });
    seedEvent({ id: "evt-f3", type: "opened", occurred_at: isoAt(20) });
    seedEvent({ id: "evt-f4", provider_id: OTHER_PROVIDER_ID, type: "delivered", occurred_at: isoAt(10) });
    const store = variant();

    expect((await listEvents({ email_id: "email-filter-1" }, store)).map((e) => e.id)).toEqual(["evt-f1"]);
    expect((await listEvents({ provider_id: OTHER_PROVIDER_ID }, store)).map((e) => e.id)).toEqual(["evt-f4"]);
    expect((await listEvents({ type: "bounced" }, store)).map((e) => e.id)).toEqual(["evt-f2"]);
    expect((await listEvents({ type: ["delivered", "opened"] }, store)).map((e) => e.id)).toEqual([
      "evt-f4",
      "evt-f3",
      "evt-f1",
    ]);
    expect((await listEvents({ since: isoAt(25) }, store)).map((e) => e.id)).toEqual(["evt-f4", "evt-f3"]);
    expect((await listEvents({ until: isoAt(25) }, store)).map((e) => e.id)).toEqual(["evt-f2", "evt-f1"]);
    expect(await getEventsByEmail("email-filter-1", store)).toHaveLength(1);
  });

  it("applies a filter to the WHOLE table, not to one clamped page of it", async () => {
    // Every `opened` row is seeded OLDEST-INGESTED, so on the SQLite generic order all
    // 40 of them sit past the 500-row clamp: a filter applied after one page's
    // truncation finds none of them.
    seedEventRows(40, (index) => ({
      id: `evt-open-${pad(index)}`,
      type: "opened",
      occurred_at: isoAt(20_000 + index),
      created_at: isoAt(20_000 + index),
    }));
    seedEventRows(500, (index) => ({
      id: `evt-noise-${pad(index)}`,
      type: "delivered",
      occurred_at: isoAt(1_000 + index),
      created_at: isoAt(1_000 + index),
    }));
    const store = variant();

    // Control: one raw page is truncated and holds no `opened` row at all.
    const onePage = await store.events.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(STORE_LIST_PAGE_MAX);
    expect(onePage.value.some((row) => row["type"] === "opened")).toBe(false);

    expect(await listEvents({ type: "opened" }, store)).toHaveLength(40);
  });

  it("windows AFTER the whole-set sort: a deep window past the clamp holds exactly its rows", async () => {
    seedEventRows(800, (index) => ({
      id: `evt-w-${pad(index)}`,
      // occurred order equals id order; ingestion order is the REVERSE, so a window
      // taken from either store's raw order would hold the wrong rows.
      occurred_at: isoAt(index),
      created_at: isoAt(800 - index),
    }));
    const store = variant();

    const window = await listEvents({ limit: 100, offset: 700 }, store);
    expect(window).toHaveLength(100);
    expect(window[0]!.id).toBe("evt-w-000700");
    expect(window[99]!.id).toBe("evt-w-000799");

    const summaries = await listEventSummaries({ limit: 2, offset: 1 }, store);
    expect(summaries.map((event) => event.id)).toEqual(["evt-w-000001", "evt-w-000002"]);
  });

  it("answers a bounded read the table is too small to fill, and clamps nonsense paging", async () => {
    seedEventRows(5, (index) => ({ id: `evt-c-${pad(index)}`, occurred_at: isoAt(index) }));
    const store = variant();
    expect(await listEvents({ limit: 100 }, store)).toHaveLength(5);
    expect(await listEvents({ limit: 0 }, store)).toHaveLength(1);
    expect(await listEvents({ limit: -2 }, store)).toHaveLength(1);
    expect(await listEvents({ limit: Number.NaN }, store)).toHaveLength(5);
    expect(await listEvents({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }, store)).toHaveLength(5);
  });

  it("omits metadata payloads from the summary shape", async () => {
    seedEvent({
      id: "evt-lean",
      type: "clicked",
      recipient: "recipient@example.com",
      metadata: JSON.stringify({ url: "https://example.com/" + "large-metadata-".repeat(200) }),
      occurred_at: isoAt(0),
    });
    const [summary] = await listEventSummaries({}, variant());
    expect(summary).toMatchObject({ id: "evt-lean", type: "clicked", recipient: "recipient@example.com" });
    expect("metadata" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large-metadata");
  });

  it("coerces malformed metadata text to an empty object, as both deleted arms did", async () => {
    seedEvent({ id: "evt-bad-meta", metadata: "not-json", occurred_at: isoAt(0) });
    const [event] = await listEvents({}, variant());
    expect(event!.metadata).toEqual({});
  });

  it("answers null for an unknown event id while events exist", async () => {
    seedEvent({ id: "evt-exists", occurred_at: isoAt(0) });
    expect(await getEvent("missing", variant())).toBeNull();
  });
});

// ─── The refusal, once per store, at real size ────────────────────────────────
//
// Past STORE_ENUMERATION_PAGE_BUDGET pages the whole-set walk cannot prove it saw
// everything, and both the unbounded listing AND the bounded window refuse
// (divergence 6 in src/db/events.ts names what was traded away and why). Seeded once
// per variant at 20_050 rows — just past the 40 × 500 budget — inside a single
// transaction, so the seeding is fast; the HTTP variant genuinely walks 40 pages over
// the wire, which is the expensive path and the reason for the long timeout.
describe.each(STORE_VARIANTS)("the enumeration budget (%s)", (_label, variant) => {
  it("refuses both the unbounded listing and the bounded window past the budget, and still answers a narrowed read", async () => {
    const total = STORE_ENUMERATION_PAGE_BUDGET * STORE_LIST_PAGE_MAX + 50;
    seedEmail("email-narrow");
    seedEventRows(total, (index) => ({
      id: `evt-big-${pad(index)}`,
      email_id: index < 3 ? "email-narrow" : null,
      occurred_at: isoAt(index),
      created_at: isoAt(index),
    }));
    const store = variant();

    let unboundedRefusal = "";
    try {
      await listEvents({}, store);
    } catch (error) {
      unboundedRefusal = String(error);
    }
    expect(unboundedRefusal).toMatch(/partial event list/);
    expect(unboundedRefusal).toMatch(/LOWER BOUND/);
    expect(unboundedRefusal).toMatch(/budget ran out/);

    // A bound is NOT a way around the guard: without an ordering the seam can
    // request, the top of the window cannot be proven from a partial walk
    // (divergence 6), so the bounded read refuses too rather than guessing.
    await expect(listEvents({ limit: 100 }, store)).rejects.toThrow(/partial event list/);

    // Positive control: the refusal is about the unenumerable whole, not the family.
    // The narrowing the refusal text recommends works: the email_id filter pushes
    // down on both stores and the filtered set enumerates to its end.
    const narrowed = await listEvents({ email_id: "email-narrow" }, store);
    expect(narrowed).toHaveLength(3);
  }, 240_000);
});

describe("the store argument", () => {
  it("faults on an argument that is neither an EmailStore nor a Database, naming both", async () => {
    await expect(listEvents({}, {} as unknown as EventStore)).rejects.toThrow(
      /must be an EmailStore or a bun:sqlite Database/,
    );
    await expect(getEvent("x", null as unknown as EventStore)).rejects.toThrow(/received null/);
  });

  it("binds a bun:sqlite Database to a store scoped to exactly that database", async () => {
    seedEvent({ id: "evt-bound", occurred_at: isoAt(0) });
    const listed = await listEvents({}, db);
    expect(listed.map((event) => event.id)).toEqual(["evt-bound"]);
  });

  it("faults on a row missing a NOT NULL timestamp instead of reporting the current time", async () => {
    // Neither shipped schema can hold this row (created_at is NOT NULL on both), so
    // it is driven through a stand-in store: the mapper must fault naming the row,
    // never substitute "now" — the deleted arm's mapper did exactly that.
    const base = sqliteStore();
    const hollow: EmailStore = {
      ...base,
      events: {
        ...base.events,
        async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
          if ((opts?.offset ?? 0) > 0) return { ok: true, value: [] };
          return {
            ok: true,
            value: [{ id: "evt-hollow", provider_id: PROVIDER_ID, type: "delivered", occurred_at: isoAt(0), metadata: "{}" }],
          };
        },
      },
    };
    await expect(listEvents({}, hollow)).rejects.toThrow(/evt-hollow with no created_at/);
    await expect(listEvents({}, hollow)).rejects.toThrow(/refusing to report the current time/);
  });
});
