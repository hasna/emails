// The recipient-group family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/groups.ts` has collapsed onto the store seam, so the same
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
// a group past the clamp was unfindable by name, members past it vanished from listings
// and from the `--to-group` recipient list, the membership predicate answered "not a
// member" for them, and every count stopped at 500. Each of those has a case below, with
// a raw one-page CONTROL proving the clamp is real so the whole-set discipline cannot
// pass vacuously.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  addMember,
  createGroup,
  deleteGroup,
  getGroup,
  getGroupByName,
  getMember,
  getMemberCount,
  getMemberCounts,
  listGroups,
  listMembers,
  listMemberSummaries,
  removeMember,
  type GroupStore,
} from "./groups.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { groupMembershipOf } from "../store-group-membership.js";
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "group row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (groups test)" });
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

function seedGroup(row: { id: string; name: string; created_at?: string; updated_at?: string }): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    "INSERT INTO groups (id, name, description, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
    [row.id, row.name, at, row.updated_at ?? at],
  );
}

function seedMember(row: { group_id: string; email: string; name?: string | null; vars?: string; added_at?: string }): void {
  db.run(
    "INSERT INTO group_members (group_id, email, name, vars, added_at) VALUES (?, ?, ?, ?, ?)",
    [row.group_id, row.email, row.name ?? null, row.vars ?? "{}", row.added_at ?? "2026-01-01T00:00:00.000Z"],
  );
}

const pad = (value: number): string => String(value).padStart(3, "0");

describe.each(STORE_VARIANTS)("groups CRUD (%s)", (_label, variant) => {
  it("creates, reads back by id and by name, and stores an empty description as null", async () => {
    const store = variant();
    const group = await createGroup("newsletter", undefined, store);
    expect(group.id).toHaveLength(36);
    expect(group.name).toBe("newsletter");
    expect(group.description).toBeNull();
    expect((await getGroup(group.id, store))?.name).toBe("newsletter");
    expect((await getGroupByName("newsletter", store))?.id).toBe(group.id);

    const described = await createGroup("vip", "VIP customers", store);
    expect(described.description).toBe("VIP customers");
    // Both deleted arms stored "" as null; the collapse preserves it.
    expect((await createGroup("blank-desc", "", store)).description).toBeNull();
  });

  it("answers null for an unknown id and an unknown name", async () => {
    const store = variant();
    // A group EXISTS while the unknown name is asked for: an implementation that
    // dropped the exact-name match would answer with whatever group sorts first
    // instead of null, and an empty table cannot see that.
    await createGroup("existing", undefined, store);
    expect(await getGroup("nonexistent", store)).toBeNull();
    expect(await getGroupByName("nonexistent", store)).toBeNull();
  });

  it("lists groups in name order and windows AFTER sorting", async () => {
    const store = variant();
    expect(await listGroups(undefined, store)).toEqual([]);
    for (const name of ["gamma", "alpha", "delta", "beta"]) await createGroup(name, undefined, store);
    expect((await listGroups(undefined, store)).map((group) => group.name)).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect((await listGroups({ limit: 2, offset: 1 }, store)).map((group) => group.name)).toEqual([
      "beta",
      "delta",
    ]);
  });

  it("deletes a group, answers false for a row that is not there, and stays deleted", async () => {
    const store = variant();
    const group = await createGroup("doomed", undefined, store);
    expect(await deleteGroup(group.id, store)).toBe(true);
    // Honest not-found-after-delete, by id AND by name — the lifecycle the live
    // validation pinned as this family's behavioural baseline.
    expect(await getGroup(group.id, store)).toBeNull();
    expect(await getGroupByName("doomed", store)).toBeNull();
    expect(await deleteGroup(group.id, store)).toBe(false);
    expect(await deleteGroup("nonexistent", store)).toBe(false);
  });
});

describe.each(STORE_VARIANTS)("membership (%s)", (_label, variant) => {
  it("adds a member with email only, and with name and vars", async () => {
    const store = variant();
    const group = await createGroup("test", undefined, store);
    const bare = await addMember(group.id, "alice@example.com", undefined, undefined, store);
    expect(bare.group_id).toBe(group.id);
    expect(bare.email).toBe("alice@example.com");
    expect(bare.name).toBeNull();
    expect(bare.vars).toEqual({});
    // An ISO instant, explicitly sent (divergence 5) — the local column's DEFAULT
    // writes a space-separated format whose interleaving would not sort against it.
    expect(bare.added_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const full = await addMember(group.id, "bob@example.com", "Bob", { company: "Acme" }, store);
    expect(full.name).toBe("Bob");
    expect(full.vars).toEqual({ company: "Acme" });
    expect(await getMember(group.id, "bob@example.com", store)).toMatchObject({
      group_id: group.id,
      email: "bob@example.com",
      vars: { company: "Acme" },
    });
    expect(await getMember(group.id, "missing@example.com", store)).toBeNull();
  });

  it("refreshes name, vars and added_at on a re-add instead of duplicating the row", async () => {
    const store = variant();
    const group = await createGroup("test", undefined, store);
    const first = await addMember(group.id, "alice@example.com", "Alice", { tier: "old" }, store);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await addMember(group.id, "alice@example.com", "Alice Updated", { tier: "new" }, store);
    const members = await listMembers(group.id, undefined, store);
    expect(members.length).toBe(1);
    expect(members[0]!.name).toBe("Alice Updated");
    expect(members[0]!.vars).toEqual({ tier: "new" });
    // Both deleted arms refreshed the membership timestamp on a re-add.
    expect(second.added_at >= first.added_at).toBe(true);
  });

  it("removes a member and answers false for one that is not there", async () => {
    const store = variant();
    const group = await createGroup("test", undefined, store);
    await addMember(group.id, "alice@example.com", undefined, undefined, store);
    expect(await removeMember(group.id, "alice@example.com", store)).toBe(true);
    expect(await listMembers(group.id, undefined, store)).toEqual([]);
    expect(await removeMember(group.id, "alice@example.com", store)).toBe(false);
    expect(await removeMember(group.id, "unknown@example.com", store)).toBe(false);
  });

  it("lists members in email order and windows AFTER sorting", async () => {
    const store = variant();
    const group = await createGroup("test", undefined, store);
    expect(await listMembers(group.id, undefined, store)).toEqual([]);
    for (const email of ["dave@example.com", "charlie@example.com", "alice@example.com", "bob@example.com"]) {
      await addMember(group.id, email, undefined, undefined, store);
    }
    expect((await listMembers(group.id, undefined, store)).map((member) => member.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com",
      "dave@example.com",
    ]);
    expect((await listMembers(group.id, { limit: 2, offset: 1 }, store)).map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(
      (await listMemberSummaries(group.id, { limit: 2, offset: 1 }, store)).map((member) => member.email),
    ).toEqual(["bob@example.com", "charlie@example.com"]);
  });

  it("omits member vars from the summary shape entirely", async () => {
    const store = variant();
    const group = await createGroup("summary-test", undefined, store);
    await addMember(group.id, "alice@example.com", "Alice", { notes: "large vars ".repeat(200) }, store);

    const [summary] = await listMemberSummaries(group.id, undefined, store);

    expect(summary).toMatchObject({ group_id: group.id, email: "alice@example.com", name: "Alice" });
    expect("vars" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large vars");
  });

  it("counts members exactly, batched and zero-filled", async () => {
    const store = variant();
    const empty = await createGroup("empty", undefined, store);
    expect(await getMemberCount(empty.id, store)).toBe(0);

    const first = await createGroup("first", undefined, store);
    const second = await createGroup("second", undefined, store);
    const unrequested = await createGroup("unrequested", undefined, store);
    await addMember(first.id, "a@example.com", undefined, undefined, store);
    await addMember(first.id, "b@example.com", undefined, undefined, store);
    await addMember(second.id, "c@example.com", undefined, undefined, store);
    await addMember(unrequested.id, "d@example.com", undefined, undefined, store);
    expect(await getMemberCount(first.id, store)).toBe(2);

    const counts = await getMemberCounts([first.id, second.id, empty.id], store);
    expect(counts.get(first.id)).toBe(2);
    expect(counts.get(second.id)).toBe(1);
    expect(counts.get(empty.id)).toBe(0);
    // EXACTLY the requested groups, even though a populated unrequested group is in
    // the enumerated table — a map that grows keys the caller never named would leak
    // other group ids through a count.
    expect(counts.size).toBe(3);
    expect(counts.has(unrequested.id)).toBe(false);
    expect((await getMemberCounts([], store)).size).toBe(0);
  });

  it("tolerates malformed member vars stored on either side, as both deleted arms did", async () => {
    const store = variant();
    seedGroup({ id: "grp-malformed", name: "malformed" });
    seedMember({ group_id: "grp-malformed", email: "alice@example.com", name: "Alice", vars: "not-json" });
    const members = await listMembers("grp-malformed", undefined, store);
    expect(members[0]?.vars).toEqual({});
    expect((await getMember("grp-malformed", "alice@example.com", store))?.vars).toEqual({});
  });
});

describe("group name resolution past one clamped page", () => {
  it("finds a group the deleted one-page scan could not, and the clamp is real", async () => {
    // 520 groups; the target sorts BELOW the first 500 of the store's newest-first
    // order because its updated_at is the oldest.
    for (let i = 0; i < 520; i++) {
      seedGroup({ id: `grp-${pad(i)}`, name: `bulk-${pad(i)}`, updated_at: `2026-02-01T00:00:${pad(i)}Z` });
    }
    seedGroup({ id: "grp-target", name: "needle", updated_at: "2026-01-01T00:00:00.000Z" });

    const store = httpStore();
    // CONTROL: one page really cannot see the whole table — without this the whole-set
    // claim below could pass over a fixture that never clamped anything.
    const onePage = await store.groups.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    expect((await getGroupByName("needle", store))?.id).toBe("grp-target");
  });
});

describe("membership past one clamped page", () => {
  // One group holding 520 members. The needle is inserted LAST, so it sits past the
  // first 500 of the local generic order (insertion order) — exactly the row the
  // deleted arm's single-page scan could never see.
  function seedLargeGroup(): void {
    seedGroup({ id: "grp-big", name: "big" });
    for (let i = 0; i < 519; i++) {
      seedMember({ group_id: "grp-big", email: `member-${pad(i)}@example.com` });
    }
    seedMember({ group_id: "grp-big", email: "zzz-needle@example.com", name: "Needle" });
  }

  it("lists and summarises the whole group — the --to-group recipient guarantee", async () => {
    seedLargeGroup();
    const store = httpStore();

    // CONTROL: the clamp is real for the filtered read too.
    const membership = groupMembershipOf(createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey }) as EmailStore);
    if (membership === null) throw new Error("the HTTP store lost its membership ledger");
    const onePage = await membership.groupMembers.list({ limit: 1000, filters: { group_id: "grp-big" } });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    const members = await listMembers("grp-big", undefined, store);
    expect(members.length).toBe(520);
    expect(members[members.length - 1]?.email).toBe("zzz-needle@example.com");

    // No-options summaries are what `emails send --to-group` mails: the whole group.
    const summaries = await listMemberSummaries("grp-big", undefined, store);
    expect(summaries.length).toBe(520);
    expect(summaries[summaries.length - 1]?.email).toBe("zzz-needle@example.com");
  });

  it("answers the membership predicate, the counts and the re-add for a member past the clamp", async () => {
    seedLargeGroup();
    const store = httpStore();

    // The deleted arm said "not a member" here.
    expect((await getMember("grp-big", "zzz-needle@example.com", store))?.name).toBe("Needle");

    // The deleted arm counted 500 here.
    expect(await getMemberCount("grp-big", store)).toBe(520);
    expect((await getMemberCounts(["grp-big"], store)).get("grp-big")).toBe(520);

    // The deleted arm's existing-row check missed the needle and re-sent a CREATE for
    // a natural key the store already holds. The collapse refreshes the one row.
    const refreshed = await addMember("grp-big", "zzz-needle@example.com", "Needle Updated", undefined, store);
    expect(refreshed.name).toBe("Needle Updated");
    const rows = db
      .query("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND email = ?")
      .get("grp-big", "zzz-needle@example.com") as { n: number };
    expect(rows.n).toBe(1);

    // And the deleted arm reported "not a member" instead of removing it.
    expect(await removeMember("grp-big", "zzz-needle@example.com", store)).toBe(true);
    expect(await getMemberCount("grp-big", store)).toBe(519);
  });
});

describe("the injectable and the membership boundary", () => {
  it("accepts a bare Database handle and scopes both tables to it", async () => {
    const group = await createGroup("handle-group", undefined, db);
    await addMember(group.id, "handle@example.com", undefined, undefined, db);
    expect((await listMembers(group.id, undefined, db)).map((member) => member.email)).toEqual([
      "handle@example.com",
    ]);
    // The rows really are in THAT database.
    expect((db.query("SELECT COUNT(*) AS n FROM group_members").get() as { n: number }).n).toBe(1);
  });

  it("resolves the configured store when no store is passed", async () => {
    // Only the database path is configured (see configureExactlyOneStore), so the
    // default resolution binds to the same process-wide connection `db` is.
    const group = await createGroup("default-store");
    expect((db.query("SELECT name FROM groups WHERE id = ?").get(group.id) as { name: string }).name)
      .toBe("default-store");
  });

  it("refuses an argument that is neither store shape, naming both", async () => {
    await expect(listGroups(undefined, {} as unknown as GroupStore)).rejects.toThrow(
      /EmailStore or a bun:sqlite Database/,
    );
  });

  it("refuses membership operations by name on a store that carries none", async () => {
    // A seam-only store: every declared repository, none of the extension. The groups
    // table still works; membership refuses rather than fabricating an empty group.
    const bare = { ...sqliteStore() } as unknown as Record<string, unknown>;
    delete bare["groupMembers"];
    const store = bare as unknown as EmailStore;
    expect((await listGroups(undefined, store)).length).toBe(0);
    await expect(listMembers("any", undefined, store)).rejects.toThrow(/group membership ledger/);
    await expect(addMember("any", "x@example.com", undefined, undefined, store)).rejects.toThrow(
      /group membership ledger/,
    );
    await expect(getMemberCounts(["any"], store)).rejects.toThrow(/group membership ledger/);
  });

  it("answers null for an empty group id without asking any store", async () => {
    // Through an API a blank path segment is a DIFFERENT route (the list), whose
    // answer must not be presented as a record — so no request may be issued at all.
    const before = service().requestCount();
    expect(await getGroup("   ", httpStore())).toBeNull();
    expect(service().requestCount()).toBe(before);
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

/** An EmailStore-shaped handle carrying exactly the two families this suite drives. */
function stubStore(groups: ResourceRow[], members: ResourceRow[]): {
  store: EmailStore;
  memberRepo: ReturnType<typeof stubRepository>;
} {
  const memberRepo = stubRepository(members);
  const store = {
    messages: {},
    groups: stubRepository(groups),
    groupMembers: memberRepo,
  } as unknown as EmailStore;
  return { store, memberRepo };
}

describe("defences a well-behaved fixture cannot exercise", () => {
  // Both real stores honour equality filters, advance their pages, and hold NOT NULL
  // timestamps, so the defences below are only observable against a store that does
  // not. Each wrapper or stub here misbehaves in exactly one way.

  it("re-checks the pushed-down membership filters rather than trusting the store", async () => {
    seedGroup({ id: "grp-mine", name: "mine" });
    seedGroup({ id: "grp-theirs", name: "theirs" });
    seedMember({ group_id: "grp-mine", email: "mine@example.com" });
    seedMember({ group_id: "grp-theirs", email: "theirs@example.com" });
    const real = sqliteStore();
    const membership = groupMembershipOf(real);
    if (membership === null) throw new Error("the SQLite store lost its membership ledger");
    // Ignores `filters` entirely and answers with the unfiltered list — the exact
    // behaviour of a route that silently drops a query parameter.
    const filterIgnoring = {
      ...real,
      groupMembers: {
        ...membership.groupMembers,
        list: (opts?: { limit?: number; offset?: number }) =>
          membership.groupMembers.list({
            ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts?.offset === undefined ? {} : { offset: opts.offset }),
          }),
      },
    } as unknown as EmailStore;
    expect((await listMembers("grp-mine", undefined, filterIgnoring)).map((member) => member.email)).toEqual([
      "mine@example.com",
    ]);
    expect(await getMemberCount("grp-mine", filterIgnoring)).toBe(1);
    expect(await getMember("grp-mine", "theirs@example.com", filterIgnoring)).toBeNull();
  });

  it("refuses a read whose pages never advance instead of presenting the loop as the table", async () => {
    seedGroup({ id: "grp-stuck", name: "stuck" });
    // TWO rows, so a window pinned to the first page can never legitimately reach the
    // empty page that means "end of table" — the anchored re-read comes back holding
    // rows that are not the anchor, which is the proof the window moved.
    seedMember({ group_id: "grp-stuck", email: "a@example.com" });
    seedMember({ group_id: "grp-stuck", email: "b@example.com" });
    const real = sqliteStore();
    const membership = groupMembershipOf(real);
    if (membership === null) throw new Error("the SQLite store lost its membership ledger");
    const stuck = {
      ...real,
      groupMembers: {
        ...membership.groupMembers,
        list: (opts?: { limit?: number; offset?: number }) =>
          membership.groupMembers.list({ ...(opts ?? {}), offset: 0 }),
      },
    } as unknown as EmailStore;
    await expect(listMembers("grp-stuck", undefined, stuck)).rejects.toThrow(/LOWER BOUND/);
  });

  it("surfaces the store's own refusal instead of presenting it as an empty group", async () => {
    const real = sqliteStore();
    const membership = groupMembershipOf(real);
    if (membership === null) throw new Error("the SQLite store lost its membership ledger");
    const refusing = {
      ...real,
      groupMembers: {
        ...membership.groupMembers,
        list: async (): Promise<Outcome<ResourceRow[]>> => ({
          ok: false,
          code: "scope_violation",
          message: "outside the caller's scope",
          status: 403,
        }),
      },
    } as unknown as EmailStore;
    await expect(listMembers("any", undefined, refusing)).rejects.toThrow(/scope_violation/);
    await expect(getMemberCount("any", refusing)).rejects.toThrow(/scope_violation/);
  });

  it("addresses a service-shaped row by its minted id on the re-add refresh", async () => {
    // Rows straight off an Emails API carry a TEXT `id` (the local generic path
    // projects `rowid` instead); the refresh must address exactly that row.
    const { store, memberRepo } = stubStore(
      [],
      [{ id: "gm-1", group_id: "grp-1", email: "alice@example.com", name: "Alice", vars: "{}", added_at: "2026-01-01T00:00:00.000Z" }],
    );
    const refreshed = await addMember("grp-1", "alice@example.com", "Alice Updated", { tier: "new" }, store);
    expect(refreshed.name).toBe("Alice Updated");
    expect(memberRepo.updates.map(([id]) => id)).toEqual(["gm-1"]);
    expect(await removeMember("grp-1", "alice@example.com", store)).toBe(true);
  });

  it("faults a membership row that carries neither id nor rowid rather than guessing", async () => {
    const { store } = stubStore(
      [],
      [{ group_id: "grp-1", email: "alice@example.com", name: null, vars: "{}", added_at: "2026-01-01T00:00:00.000Z" }],
    );
    await expect(removeMember("grp-1", "alice@example.com", store)).rejects.toThrow(/no id and no rowid/);
  });

  it("faults an absent NOT NULL timestamp instead of reporting the current time", async () => {
    const { store } = stubStore(
      [{ id: "grp-1", name: "undated", description: null, updated_at: "2026-01-01T00:00:00.000Z" }],
      [{ id: "gm-1", group_id: "grp-1", email: "alice@example.com", name: null, vars: "{}" }],
    );
    await expect(listGroups(undefined, store)).rejects.toThrow(/no created_at/);
    await expect(listMembers("grp-1", undefined, store)).rejects.toThrow(/no added_at/);
  });

  it("resolves a duplicated name deterministically, newest first", async () => {
    // Reachable only through a store without the local UNIQUE(name) — the service
    // schema does not promise it, so two groups sharing a name are presentable.
    const { store } = stubStore(
      [
        { id: "grp-old", name: "twin", description: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "grp-new", name: "twin", description: null, created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" },
      ],
      [],
    );
    expect((await getGroupByName("twin", store))?.id).toBe("grp-new");
  });
});

describe("cascade on the local store", () => {
  it("deleting a group removes its membership rows through the schema's own keys", async () => {
    const store = sqliteStore();
    const group = await createGroup("cascade", undefined, store);
    await addMember(group.id, "cascade@example.com", undefined, undefined, store);
    expect(await deleteGroup(group.id, store)).toBe(true);
    expect((db.query("SELECT COUNT(*) AS n FROM group_members").get() as { n: number }).n).toBe(0);
    // And the member listing over the deleted group is honestly empty, not an error.
    expect(await listMembers(group.id, undefined, store)).toEqual([]);
  });
});
