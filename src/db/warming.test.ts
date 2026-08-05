// The warming-schedule family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/warming.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any filtered list or write — and reach SQLite
// through the real `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`:
// a `/v1` service that stores nothing and translates every request onto the same store
// seam, backed by the same in-memory database the SQLite variant reads. Both variants
// answer from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back.
//
// THE CASES SEEDED PAST 500 ROWS ARE THE POINT OF THE COLLAPSE. Both stores clamp a list
// page to 500 rows, and the deleted second arm answered every read out of ONE such page:
// a schedule past the clamp was invisible to the SEND CAP, to `warm`'s duplicate guard,
// and to every warm-status/pause/resume/complete/delete lookup, and `listWarmingSchedules`
// applied its status filter AFTER the truncation. Each of those has a case below, with a
// raw one-page CONTROL proving the clamp is real so the whole-set discipline cannot pass
// vacuously.
//
// THE ORDERING CASES ARE THE OTHER HALF. The two stores' generic lists order this table
// differently (SQLite `updated_at DESC`, the service `created_at DESC`), so a status
// transition — which touches `updated_at` — JUMPS the row to the top of one store's raw
// order and not the other's. The collapse sorts the enumerated set itself; the cases
// that pause a schedule and then re-list are what keep that sort load-bearing.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  createWarmingSchedule,
  deleteWarmingSchedule,
  getWarmingSchedule,
  listWarmingSchedules,
  updateWarmingStatus,
  type WarmingStore,
} from "./warming.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceInput, ResourceRow } from "../store/records.js";
import type { ResourceRepository } from "../store/repositories.js";
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
 * error with deliberately no precedence rule, and it would turn every default-store
 * case into that error.
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "warming row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (warming test)" });
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
// A case that needs chosen ids, chosen timestamps, malformed payloads, or more rows
// than one page holds writes the table directly. Both variants read this same data.

function seedSchedule(row: {
  id: string;
  domain: string;
  status?: string;
  target?: number;
  start_date?: string;
  created_at?: string;
  updated_at?: string;
}): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    "INSERT INTO warming_schedules (id, domain, provider_id, target_daily_volume, start_date, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    [row.id, row.domain, row.target ?? 100, row.start_date ?? "2026-01-01", row.status ?? "active", at, row.updated_at ?? at],
  );
}

const pad = (value: number): string => String(value).padStart(3, "0");

describe.each(STORE_VARIANTS)("warming CRUD (%s)", (_label, variant) => {
  it("creates a warming schedule with the declared defaults and store-stamped instants", async () => {
    const store = variant();
    const schedule = await createWarmingSchedule({ domain: "example-warm-create.com", target_daily_volume: 1000 }, store);
    expect(schedule.domain).toBe("example-warm-create.com");
    expect(schedule.target_daily_volume).toBe(1000);
    expect(schedule.status).toBe("active");
    expect(schedule.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(schedule.id).toBeTruthy();
    // The STORE'S stamps, as ISO instants — the generic path's own `now()`, never the
    // SQLite column DEFAULT's space-separated format, which would not sort against
    // ISO rows in the newest-first order every listing presents.
    expect(schedule.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(schedule.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("creates a warming schedule with a custom start_date", async () => {
    const schedule = await createWarmingSchedule(
      { domain: "custom.com", target_daily_volume: 500, start_date: "2025-01-01" },
      variant(),
    );
    expect(schedule.start_date).toBe("2025-01-01");
  });

  it("refuses a duplicate domain with the store's own typed refusal", async () => {
    // Both shipped schemas declare UNIQUE(domain). The deleted second arm never saw
    // this refusal — its duplicate guard was a one-page scan, and past the clamp it
    // happily issued the second POST.
    const store = variant();
    await createWarmingSchedule({ domain: "dup.example.com", target_daily_volume: 100 }, store);
    await expect(
      createWarmingSchedule({ domain: "dup.example.com", target_daily_volume: 999 }, store),
    ).rejects.toThrow(/cannot create a warming schedule/);
    // The original row is untouched and there is still exactly one.
    expect((await getWarmingSchedule("dup.example.com", store))?.target_daily_volume).toBe(100);
    expect(await listWarmingSchedules(undefined, store)).toHaveLength(1);
  });

  it("answers null for an unknown domain while a schedule exists", async () => {
    // A schedule EXISTS while the unknown domain is asked for: an implementation that
    // dropped the exact-domain re-check would answer with whatever row the store
    // returned instead of null, and an empty table cannot see that.
    const store = variant();
    await createWarmingSchedule({ domain: "existing.com", target_daily_volume: 100 }, store);
    expect(await getWarmingSchedule("notfound.com", store)).toBeNull();
  });

  it("retrieves a schedule by exact domain", async () => {
    const store = variant();
    await createWarmingSchedule({ domain: "get-test.com", target_daily_volume: 200 }, store);
    const result = await getWarmingSchedule("get-test.com", store);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("get-test.com");
  });

  it("lists newest-first and windows AFTER sorting", async () => {
    const store = variant();
    expect(await listWarmingSchedules(undefined, store)).toEqual([]);
    for (let i = 1; i <= 4; i++) {
      seedSchedule({
        id: `warm-${i}`,
        domain: `warm-${i}.example.com`,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }
    expect((await listWarmingSchedules(undefined, store)).map((schedule) => schedule.domain)).toEqual([
      "warm-4.example.com",
      "warm-3.example.com",
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
    expect(
      (await listWarmingSchedules(undefined, { limit: 2, offset: 1 }, store)).map((schedule) => schedule.domain),
    ).toEqual(["warm-3.example.com", "warm-2.example.com"]);
  });

  it("filters by status and paginates AFTER the filter", async () => {
    const store = variant();
    for (let i = 1; i <= 4; i++) {
      seedSchedule({
        id: `warm-${i}`,
        domain: `warm-${i}.example.com`,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }
    await updateWarmingStatus("warm-4.example.com", "paused", store);

    const active = await listWarmingSchedules("active", store);
    const paused = await listWarmingSchedules("paused", store);
    expect(active.every((schedule) => schedule.status === "active")).toBe(true);
    expect(paused.map((schedule) => schedule.domain)).toEqual(["warm-4.example.com"]);

    const page = await listWarmingSchedules("active", { limit: 2, offset: 1 }, store);
    expect(page.map((schedule) => schedule.domain)).toEqual([
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
  });

  it("keeps the created_at order after a status transition touches updated_at", async () => {
    // THE CROSS-STORE ORDERING PIN (divergence 2). The SQLite generic list orders
    // this table `updated_at DESC`; the service orders it `created_at DESC`. Pausing
    // the OLDEST schedule refreshes its updated_at, which jumps it to the TOP of the
    // SQLite raw order — so a listing that trusted either store's own page order
    // would present a different table on each store. The collapse sorts the
    // enumerated set itself.
    const store = variant();
    for (let i = 1; i <= 3; i++) {
      seedSchedule({
        id: `warm-${i}`,
        domain: `warm-${i}.example.com`,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }
    await updateWarmingStatus("warm-1.example.com", "paused", store);

    // CONTROL: the raw generic order really did move on the store that keys on
    // updated_at, so the assertion below cannot pass by the fixture never diverging.
    const raw = await sqliteStore().warming.list({ limit: 10 });
    if (!raw.ok) throw new Error(raw.message);
    expect((raw.value[0] as ResourceRow)["domain"]).toBe("warm-1.example.com");

    expect((await listWarmingSchedules(undefined, store)).map((schedule) => schedule.domain)).toEqual([
      "warm-3.example.com",
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
    // And a WINDOWED read after the jump: a window cut from the store's raw order
    // and sorted afterwards would present [warm-3, warm-1] here — the divergence is
    // only visible to a page, which is why the no-window assertion above cannot
    // carry this alone (a mutation run proved it: the window-before-sort mutant
    // survived every unwindowed case).
    expect(
      (await listWarmingSchedules(undefined, { limit: 2 }, store)).map((schedule) => schedule.domain),
    ).toEqual(["warm-3.example.com", "warm-2.example.com"]);
  });

  it("transitions status through the lifecycle and refreshes updated_at", async () => {
    const store = variant();
    const created = await createWarmingSchedule({ domain: "status-test.com", target_daily_volume: 300 }, store);
    const paused = await updateWarmingStatus("status-test.com", "paused", store);
    expect(paused).not.toBeNull();
    expect(paused!.status).toBe("paused");
    expect(paused!.updated_at >= created.updated_at).toBe(true);

    const completed = await updateWarmingStatus("status-test.com", "completed", store);
    expect(completed!.status).toBe("completed");
    expect((await getWarmingSchedule("status-test.com", store))?.status).toBe("completed");
  });

  it("answers null for a transition on a domain with no schedule", async () => {
    expect(await updateWarmingStatus("ghost.com", "paused", variant())).toBeNull();
  });

  it("deletes a schedule, answers false for one that is not there, and stays deleted", async () => {
    const store = variant();
    await createWarmingSchedule({ domain: "del.com", target_daily_volume: 100 }, store);
    expect(await deleteWarmingSchedule("del.com", store)).toBe(true);
    expect(await getWarmingSchedule("del.com", store)).toBeNull();
    expect(await deleteWarmingSchedule("del.com", store)).toBe(false);
    expect(await deleteWarmingSchedule("ghost.com", store)).toBe(false);
  });
});

describe("the schedule past one clamped page", () => {
  // 520 schedules; the needle sorts BELOW the first 500 of BOTH stores' raw orders
  // because its timestamps are the oldest — exactly the row the deleted arm's
  // single-page scan could never see.
  function seedLargeTable(): void {
    for (let i = 0; i < 520; i++) {
      seedSchedule({
        id: `warm-${pad(i)}`,
        domain: `bulk-${pad(i)}.example.com`,
        created_at: `2026-02-01T00:00:${pad(i)}Z`,
        updated_at: `2026-02-01T00:00:${pad(i)}Z`,
      });
    }
    seedSchedule({
      id: "warm-needle",
      domain: "needle.example.com",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }

  it("finds, transitions and deletes a schedule the deleted one-page scan could not", async () => {
    seedLargeTable();
    const store = httpStore();

    // CONTROL: one page really cannot see the whole table — without this the
    // whole-set claims below could pass over a fixture that never clamped anything.
    const onePage = await store.warming.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // The deleted arm answered null here — which skipped the SEND CAP for this
    // domain and let `warm` create a duplicate schedule.
    expect((await getWarmingSchedule("needle.example.com", store))?.id).toBe("warm-needle");

    // And it answered "not found" for every transition and for the delete.
    expect((await updateWarmingStatus("needle.example.com", "paused", store))?.status).toBe("paused");
    expect(await deleteWarmingSchedule("needle.example.com", store)).toBe(true);
    expect(await getWarmingSchedule("needle.example.com", store)).toBeNull();
  });

  it("lists the whole table, and filters by status BEFORE any truncation could bite", async () => {
    seedLargeTable();
    // The needle is the ONLY paused schedule, and it sits past the clamp: the
    // deleted arm filtered ONE page client-side and answered [] here.
    db.run("UPDATE warming_schedules SET status = 'paused' WHERE id = 'warm-needle'");
    const store = httpStore();

    const all = await listWarmingSchedules(undefined, store);
    expect(all.length).toBe(521);
    expect(all[all.length - 1]?.domain).toBe("needle.example.com");

    const paused = await listWarmingSchedules("paused", store);
    expect(paused.map((schedule) => schedule.id)).toEqual(["warm-needle"]);
  });
});

describe("the injectable and the argument orders", () => {
  it("accepts a bare Database handle and scopes the family to it", async () => {
    const schedule = await createWarmingSchedule({ domain: "handle.example.com", target_daily_volume: 100 }, db);
    expect(schedule.domain).toBe("handle.example.com");
    // The row really is in THAT database.
    expect((db.query("SELECT COUNT(*) AS n FROM warming_schedules").get() as { n: number }).n).toBe(1);
    expect((await getWarmingSchedule("handle.example.com", db))?.id).toBe(schedule.id);
  });

  it("resolves the configured store when no store is passed", async () => {
    // Only the database path is configured (see configureExactlyOneStore), so the
    // default resolution binds to the same process-wide connection `db` is.
    const schedule = await createWarmingSchedule({ domain: "default-store.example.com", target_daily_volume: 50 });
    expect(
      (db.query("SELECT domain FROM warming_schedules WHERE id = ?").get(schedule.id) as { domain: string }).domain,
    ).toBe("default-store.example.com");
  });

  it("refuses an argument that is neither store shape, naming both", async () => {
    await expect(getWarmingSchedule("any.example.com", 42 as unknown as WarmingStore)).rejects.toThrow(
      /EmailStore or a bun:sqlite Database/,
    );
  });

  it("serves every published listing argument order, windows intact", async () => {
    // The deleted facade's intersection type admitted (status, opts), (status, db,
    // opts) AND (status, undefined, opts) — this repo's own REST routes used the
    // last one — so all of them stay callable, decided by argument SHAPE.
    for (let i = 1; i <= 3; i++) {
      seedSchedule({
        id: `warm-${i}`,
        domain: `warm-${i}.example.com`,
        created_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }
    const window = { limit: 1, offset: 1 };
    const expected = ["warm-2.example.com"];
    expect((await listWarmingSchedules(undefined, window)).map((schedule) => schedule.domain)).toEqual(expected);
    expect((await listWarmingSchedules(undefined, db, window)).map((schedule) => schedule.domain)).toEqual(expected);
    expect((await listWarmingSchedules(undefined, undefined, window)).map((schedule) => schedule.domain)).toEqual(expected);
    expect((await listWarmingSchedules(undefined, window, sqliteStore())).map((schedule) => schedule.domain)).toEqual(expected);
  });
});

// ─── Hand-built stores for defences the honest fixtures cannot exercise ─────

/** A minimal resource repository over in-memory rows, service-shaped (TEXT `id`). */
function stubRepository(rows: ResourceRow[]): ResourceRepository<ResourceRow> & { updates: Array<[string, ResourceInput]> } {
  const updates: Array<[string, ResourceInput]> = [];
  const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
  return {
    updates,
    async list(opts?: { limit?: number; offset?: number; filters?: Record<string, string> }) {
      const filters = opts?.filters ?? {};
      const filtered = rows.filter((row) => Object.entries(filters).every(([key, value]) => String(row[key]) === value));
      const offset = opts?.offset ?? 0;
      return ok(filtered.slice(offset, offset + (opts?.limit ?? 500)));
    },
    async get(id: string) {
      return ok(rows.find((row) => String(row["id"]) === id) ?? null);
    },
    async create(input: ResourceInput) {
      const row = { id: `stub-${rows.length}`, ...input } as ResourceRow;
      rows.push(row);
      return ok(row);
    },
    async update(id: string, patch: ResourceInput) {
      updates.push([id, patch]);
      const row = rows.find((candidate) => String(candidate["id"]) === id);
      if (row === undefined) return ok(null);
      Object.assign(row, patch);
      return ok(row);
    },
    async remove(id: string) {
      const index = rows.findIndex((candidate) => String(candidate["id"]) === id);
      if (index < 0) return ok(false);
      rows.splice(index, 1);
      return ok(true);
    },
  };
}

/** An EmailStore-shaped handle carrying exactly the family this suite drives. */
function stubStore(rows: ResourceRow[]): { store: EmailStore; repo: ReturnType<typeof stubRepository> } {
  const repo = stubRepository(rows);
  const store = { messages: {}, warming: repo } as unknown as EmailStore;
  return { store, repo };
}

function stubRow(overrides: Partial<Record<string, unknown>> & { id: string; domain: string }): ResourceRow {
  return {
    provider_id: null,
    target_daily_volume: 100,
    start_date: "2026-01-01",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ResourceRow;
}

describe("defences a well-behaved fixture cannot exercise", () => {
  // Both real stores honour equality filters, advance their pages, and hold NOT NULL
  // timestamps, so the defences below are only observable against a store that does
  // not. Each wrapper or stub here misbehaves in exactly one way.

  it("re-checks the pushed-down filters rather than trusting the store", async () => {
    seedSchedule({ id: "warm-mine", domain: "mine.example.com", status: "active" });
    seedSchedule({ id: "warm-theirs", domain: "theirs.example.com", status: "paused" });
    const real = sqliteStore();
    // Ignores `filters` entirely and answers with the unfiltered list — the exact
    // behaviour of a route that silently drops a query parameter.
    const filterIgnoring = {
      ...real,
      warming: {
        ...real.warming,
        list: (opts?: { limit?: number; offset?: number }) =>
          real.warming.list({
            ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts?.offset === undefined ? {} : { offset: opts.offset }),
          }),
      },
    } as unknown as EmailStore;
    // Trusting the store here would gate mine.example.com's sends on ANOTHER
    // domain's ramp.
    expect((await getWarmingSchedule("mine.example.com", filterIgnoring))?.id).toBe("warm-mine");
    expect(await getWarmingSchedule("nowhere.example.com", filterIgnoring)).toBeNull();
    expect((await listWarmingSchedules("active", filterIgnoring)).map((schedule) => schedule.id)).toEqual([
      "warm-mine",
    ]);
  });

  it("refuses a read whose pages never advance instead of presenting the loop as the table", async () => {
    seedSchedule({ id: "warm-a", domain: "a.example.com" });
    seedSchedule({ id: "warm-b", domain: "b.example.com" });
    const real = sqliteStore();
    const stuck = {
      ...real,
      warming: {
        ...real.warming,
        list: (opts?: { limit?: number; offset?: number }) =>
          real.warming.list({ ...(opts ?? {}), offset: 0 }),
      },
    } as unknown as EmailStore;
    await expect(listWarmingSchedules(undefined, stuck)).rejects.toThrow(/LOWER BOUND/);
  });

  it("surfaces the store's own refusal instead of presenting it as an empty table", async () => {
    const real = sqliteStore();
    const refusing = {
      ...real,
      warming: {
        ...real.warming,
        list: async (): Promise<Outcome<ResourceRow[]>> => ({
          ok: false,
          code: "scope_violation",
          message: "outside the caller's scope",
          status: 403,
        }),
      },
    } as unknown as EmailStore;
    await expect(listWarmingSchedules(undefined, refusing)).rejects.toThrow(/scope_violation/);
    await expect(getWarmingSchedule("any.example.com", refusing)).rejects.toThrow(/scope_violation/);
  });

  it("faults an absent NOT NULL timestamp instead of reporting the current time", async () => {
    const missingCreated = stubStore([
      { id: "warm-1", domain: "undated.example.com", provider_id: null, target_daily_volume: 100, start_date: "2026-01-01", status: "active", updated_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(listWarmingSchedules(undefined, missingCreated.store)).rejects.toThrow(/no created_at/);
    const missingUpdated = stubStore([
      { id: "warm-1", domain: "undated.example.com", provider_id: null, target_daily_volume: 100, start_date: "2026-01-01", status: "active", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(getWarmingSchedule("undated.example.com", missingUpdated.store)).rejects.toThrow(/no updated_at/);
  });

  it("tolerates a null start_date and an empty status, as the service schema admits", async () => {
    // The service relaxed start_date to nullable and declares status's default;
    // the ramp math fails CLOSED on "" (src/lib/warming.ts), so tolerating these
    // here is safe and faulting the listing over them would lose the schedules the
    // read was for.
    const { store } = stubStore([stubRow({ id: "warm-1", domain: "relaxed.example.com", start_date: null, status: "" })]);
    const schedule = await getWarmingSchedule("relaxed.example.com", store);
    expect(schedule?.start_date).toBe("");
    expect(schedule?.status).toBe("active");
    // But the raw-text status filter does NOT match the coerced value — exactly what
    // the server's own pushed-down filter answers for this row. Asserted through a
    // filter-IGNORING wrapper, because a store that honours the pushed-down filter
    // hides the client-side comparison entirely (a mutation run proved it: the
    // compare-the-coerced-value mutant survived the honest stub).
    expect(await listWarmingSchedules("active", store)).toEqual([]);
    const raw = store.warming;
    const filterIgnoring = {
      ...store,
      warming: {
        ...raw,
        list: (opts?: { limit?: number; offset?: number }) =>
          raw.list({
            ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts?.offset === undefined ? {} : { offset: opts.offset }),
          }),
      },
    } as unknown as EmailStore;
    expect(await listWarmingSchedules("active", filterIgnoring)).toEqual([]);
  });

  it("faults a status outside the declared set, naming the row and the value", async () => {
    const { store } = stubStore([stubRow({ id: "warm-1", domain: "bogus.example.com", status: "warming" })]);
    await expect(getWarmingSchedule("bogus.example.com", store)).rejects.toThrow(/outside the declared set/);
    await expect(getWarmingSchedule("bogus.example.com", store)).rejects.toThrow(/"warming"/);
  });

  it("maps AFTER windowing and AFTER filtering, so one bad row faults only the read that presents it", async () => {
    const { store } = stubStore([
      stubRow({ id: "warm-2", domain: "good.example.com", created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" }),
      stubRow({ id: "warm-1", domain: "bad.example.com", status: "bogus" }),
    ]);
    // The window excludes the bad row: the page it is not on must still be served.
    expect((await listWarmingSchedules(undefined, { limit: 1 }, store)).map((schedule) => schedule.id)).toEqual([
      "warm-2",
    ]);
    // The raw status filter excludes it too.
    expect((await listWarmingSchedules("active", store)).map((schedule) => schedule.id)).toEqual(["warm-2"]);
    // The read that would actually present it faults.
    await expect(listWarmingSchedules(undefined, store)).rejects.toThrow(/outside the declared set/);
  });

  it("faults a row that carries neither id nor rowid on a write rather than guessing", async () => {
    const { store } = stubStore([
      { domain: "unaddressable.example.com", provider_id: null, target_daily_volume: 100, start_date: "2026-01-01", status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(updateWarmingStatus("unaddressable.example.com", "paused", store)).rejects.toThrow(
      /no id and no rowid/,
    );
  });

  it("answers false when every found row vanished before the remove, as the deleted arms' change count did", async () => {
    const { store } = stubStore([stubRow({ id: "warm-1", domain: "vanishing.example.com" })]);
    const raw = store.warming;
    const vanishing = {
      ...store,
      warming: { ...raw, remove: async () => ({ ok: true, value: false }) },
    } as unknown as EmailStore;
    // The row was FOUND, but the store's own remove answered "no such row" — the
    // honest aggregate is false, not "I found something earlier".
    expect(await deleteWarmingSchedule("vanishing.example.com", vanishing)).toBe(false);
  });

  it("declares the born status explicitly rather than leaning on a column default", async () => {
    // Both shipped stores default the column, so only a store WITHOUT the default
    // can see the difference: a create that stopped sending `status` would leave a
    // row the raw-text `active` filter cannot match. The stub stamps the NOT NULL
    // timestamps like any real store; it just declares no status default.
    const { store } = stubStore([]);
    const raw = store.warming;
    const stamping = {
      ...store,
      warming: {
        ...raw,
        create: (input: ResourceInput) =>
          raw.create({ created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...input }),
      },
    } as unknown as EmailStore;
    await createWarmingSchedule({ domain: "born.example.com", target_daily_volume: 100 }, stamping);
    expect((await listWarmingSchedules("active", stamping)).map((schedule) => schedule.domain)).toEqual([
      "born.example.com",
    ]);
  });

  it("breaks a created_at tie by row identity, so a window is the same window everywhere", async () => {
    // Two rows tied on created_at, handed back in ASCENDING id order — the reverse
    // of the tiebreaker's answer. A comparator without the identity term leaves a
    // tied pair in whatever order the store enumerated, and a one-row window then
    // presents a different schedule per store.
    const { store } = stubStore([
      stubRow({ id: "warm-alpha", domain: "alpha.example.com" }),
      stubRow({ id: "warm-omega", domain: "omega.example.com" }),
    ]);
    expect((await listWarmingSchedules(undefined, { limit: 1 }, store)).map((schedule) => schedule.id)).toEqual([
      "warm-omega",
    ]);
  });

  it("resolves duplicated domains deterministically: reads answer the newest, writes touch every row", async () => {
    // Reachable only through a store without the unique key both shipped stores
    // carry. The deleted SQLite arm's own WHERE-domain semantics touched all
    // matches; the deleted second arm updated whichever single row one clamped page
    // surfaced first.
    const rows = [
      stubRow({ id: "warm-old", domain: "twin.example.com", target_daily_volume: 100, created_at: "2026-01-01T00:00:00.000Z" }),
      stubRow({ id: "warm-new", domain: "twin.example.com", target_daily_volume: 900, created_at: "2026-02-01T00:00:00.000Z" }),
    ];
    const { store, repo } = stubStore(rows);
    expect((await getWarmingSchedule("twin.example.com", store))?.id).toBe("warm-new");

    const updated = await updateWarmingStatus("twin.example.com", "paused", store);
    expect(updated?.id).toBe("warm-new");
    expect(repo.updates.map(([id]) => id).sort()).toEqual(["warm-new", "warm-old"]);
    expect(rows.every((row) => row["status"] === "paused")).toBe(true);

    expect(await deleteWarmingSchedule("twin.example.com", store)).toBe(true);
    expect(await listWarmingSchedules(undefined, store)).toEqual([]);
  });
});
