// The owners family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/owners.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any filtered list or write — and reach SQLite
// through the real `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`:
// a `/v1` service that stores nothing and translates every request onto the same store
// seam, backed by the same in-memory database the SQLite variant reads. Both variants
// answer from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back.
//
// THE CASES SEEDED PAST 500 ROWS ARE THE POINT OF THE COLLAPSE. Both stores clamp a list
// page to 500 rows, and the deleted second arm answered every unaddressed read out of ONE
// such page: an owner past the clamp was "Owner not found" to every command that resolves
// names, invisible to the duplicate-external_id guard, and nameless in the sendkey
// listing; an address past the clamp was missing from every owner's printed scope. Each
// has a case below, with a raw one-page CONTROL proving the clamp is real so the
// whole-set discipline cannot pass vacuously.
//
// THE AUDIT TRAIL IS APPEND-ONLY LEDGER SEMANTICS: rows are written once with a
// client-minted id and a monotonic instant, read back exactly, and never presented in a
// different order than they were written. The unassign/transfer/assign ordering case is
// what keeps the monotonic clock load-bearing — three writes inside one millisecond
// would otherwise tie on `created_at` and present in uuid order.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  assignAddressOwner,
  createOwner,
  getAddressOwnership,
  getAddressOwnershipEvent,
  getOwner,
  getOwnerByContactEmail,
  getOwnerByExternalId,
  getOwnerByName,
  listAddressEmailsByOwner,
  listAddressOwnershipEvents,
  listAddressesByOwner,
  listAdministeredAddressesNotOwnedBy,
  listOwnerNamesByIds,
  listOwners,
  listOwnersByIds,
  transferAddressOwner,
  unassignAddressOwner,
  type OwnerStore,
} from "./owners.js";
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
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "owners row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (owners test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

// ─── Seeding straight into the shared tables ────────────────────────────────
//
// A case that needs chosen ids, chosen timestamps, or more rows than one page holds
// writes the tables directly. Both variants read this same data. Foreign keys are ON
// in the local schema, so addresses hang off one seeded provider row.

const pad = (value: number): string => String(value).padStart(3, "0");

function seedProvider(id = "prov-1"): void {
  db.run(
    "INSERT OR IGNORE INTO providers (id, name, type, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, ?)",
    [id, `provider-${id}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  );
}

function seedOwner(row: {
  id: string;
  type?: string;
  name: string;
  contact_email?: string | null;
  external_id?: string | null;
  created_at?: string;
}): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    "INSERT INTO owners (id, type, name, contact_email, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.type ?? "agent", row.name, row.contact_email ?? null, row.external_id ?? null, at, at],
  );
}

function seedAddress(row: { id: string; email: string; created_at?: string }): void {
  seedProvider();
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    "INSERT INTO addresses (id, provider_id, email, verified, created_at, updated_at) VALUES (?, 'prov-1', ?, 1, ?, ?)",
    [row.id, row.email, at, at],
  );
}

describe.each(STORE_VARIANTS)("owner registry (%s)", (_label, variant) => {
  it("registers a human and an agent owner and resolves them", async () => {
    const store = variant();
    const human = await createOwner(
      { type: "human", name: "Example Person", contact_email: "person@example.com" },
      store,
    );
    const agent = await createOwner({ type: "agent", name: "Tiberius", external_id: "agent-503a" }, store);
    expect(human.type).toBe("human");
    expect(agent.type).toBe("agent");
    // The STORE'S stamps, as ISO instants.
    expect(human.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((await getOwner(human.id, store))!.contact_email).toBe("person@example.com");
    expect((await getOwnerByName("Tiberius", store))!.id).toBe(agent.id);
    expect((await getOwnerByExternalId("agent-503a", store))!.id).toBe(agent.id);
    expect((await getOwnerByContactEmail("PERSON@example.com", store))!.id).toBe(human.id);
    expect((await listOwners("agent", undefined, store)).map((o) => o.name)).toContain("Tiberius");
  });

  it("rejects an invalid owner type", async () => {
    await expect(createOwner({ type: "robot" as never, name: "X" }, variant())).rejects.toThrow(
      /invalid owner type/i,
    );
  });

  it("rejects a duplicate external_id and leaves one row", async () => {
    const store = variant();
    await createOwner({ type: "agent", name: "First", external_id: "dup" }, store);
    await expect(createOwner({ type: "agent", name: "Second", external_id: "dup" }, store)).rejects.toThrow(
      /external_id already exists/i,
    );
    expect((await listOwners(undefined, undefined, store)).filter((o) => o.external_id === "dup")).toHaveLength(1);
  });

  it("answers null for unknown and blank references", async () => {
    const store = variant();
    await createOwner({ type: "agent", name: "Existing" }, store);
    expect(await getOwner("no-such-owner", store)).toBeNull();
    // A blank id addresses no row; through an API it is a DIFFERENT route (the list).
    expect(await getOwner("   ", store)).toBeNull();
    expect(await getOwnerByName("nobody", store)).toBeNull();
    expect(await getOwnerByExternalId("  ", store)).toBeNull();
    expect(await getOwnerByContactEmail("", store)).toBeNull();
  });

  it("paginates owners newest-first, windowing AFTER the sort", async () => {
    for (let i = 0; i < 5; i++) {
      seedOwner({ id: `owner-${i}`, name: `Owner ${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const page = await listOwners("agent", { limit: 2, offset: 1 }, variant());
    expect(page.map((owner) => owner.name)).toEqual(["Owner 3", "Owner 2"]);
  });

  it("resolves a duplicated name to the OLDEST registration, deterministically", async () => {
    // The deleted SQLite arm's own ORDER BY created_at ASC. Under newest-wins, a
    // second registration of the same name would quietly capture every subsequent
    // `--owner <name>` — which feeds send-key issuance.
    seedOwner({ id: "owner-new", name: "andrei", created_at: "2026-02-01T00:00:00.000Z" });
    seedOwner({ id: "owner-old", name: "andrei", created_at: "2026-01-01T00:00:00.000Z" });
    expect((await getOwnerByName("andrei", variant()))!.id).toBe("owner-old");
  });

  it("lists owner names and rows for selected ids only, tolerating orphaned nulls", async () => {
    const store = variant();
    const first = await createOwner({ type: "human", name: "First", contact_email: "first@example.com" }, store);
    const second = await createOwner({ type: "agent", name: "Second", external_id: "agent-2" }, store);
    await createOwner({ type: "agent", name: "Other" }, store);

    const names = await listOwnerNamesByIds([first.id, second.id, first.id], store);
    expect([...names.entries()].sort()).toEqual([
      [first.id, "First"],
      [second.id, "Second"],
    ].sort());
    expect((await listOwnerNamesByIds([], store)).size).toBe(0);

    // `send_keys.owner_id` is nullable on the seam — a key can outlive its owner —
    // so a null in the batch is dropped rather than faulting the whole listing.
    const withNull = await listOwnerNamesByIds([first.id, null as unknown as string], store);
    expect([...withNull.keys()]).toEqual([first.id]);

    const owners = await listOwnersByIds([first.id, second.id], store);
    expect([...owners.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(owners.get(first.id)).toMatchObject({ name: "First", contact_email: "first@example.com" });
    expect(owners.get(second.id)).toMatchObject({ name: "Second", external_id: "agent-2" });
    expect((await listOwnersByIds([], store)).size).toBe(0);
  });
});

describe.each(STORE_VARIANTS)("address ownership (%s)", (_label, variant) => {
  it("agent-owned address is self-administered (administrator = owner)", async () => {
    const store = variant();
    const agent = await createOwner({ type: "agent", name: "Caesar" }, store);
    seedAddress({ id: "addr-ops", email: "ops@x.com" });
    await assignAddressOwner("addr-ops", agent.id, undefined, store);
    const own = (await getAddressOwnership("addr-ops", store))!;
    expect(own.owner_id).toBe(agent.id);
    expect(own.administrator_id).toBe(agent.id); // self-administered
  });

  it("human-owned address requires an agent administrator", async () => {
    const store = variant();
    const human = await createOwner({ type: "human", name: "Morgan" }, store);
    const agent = await createOwner({ type: "agent", name: "Tiberius" }, store);
    seedAddress({ id: "addr-morgan", email: "morgan@x.com" });
    await expect(assignAddressOwner("addr-morgan", human.id, undefined, store)).rejects.toThrow(
      /human-owned.*agent administrator/i,
    );
    await expect(assignAddressOwner("addr-morgan", human.id, human.id, store)).rejects.toThrow(
      /administrator must be an agent/i,
    );
    await assignAddressOwner("addr-morgan", human.id, agent.id, store);
    const own = (await getAddressOwnership("addr-morgan", store))!;
    expect(own.owner_id).toBe(human.id);
    expect(own.administrator_id).toBe(agent.id);
  });

  it("throws for a missing owner and for a missing address", async () => {
    const store = variant();
    seedAddress({ id: "addr-z", email: "z@x.com" });
    await expect(assignAddressOwner("addr-z", "nonexistent", undefined, store)).rejects.toThrow(
      /owner not found/i,
    );
    const agent = await createOwner({ type: "agent", name: "Ghost Admin" }, store);
    await expect(assignAddressOwner("addr-ghost", agent.id, undefined, store)).rejects.toThrow(
      /address not found/i,
    );
    expect(await getAddressOwnership("addr-ghost", store)).toBeNull();
  });

  it("refuses to reassign an address already owned by another owner", async () => {
    const store = variant();
    const a1 = await createOwner({ type: "agent", name: "Galba" }, store);
    const a2 = await createOwner({ type: "agent", name: "Vitellius" }, store);
    seedAddress({ id: "addr-shared", email: "shared@x.com" });
    await assignAddressOwner("addr-shared", a1.id, undefined, store);
    await expect(assignAddressOwner("addr-shared", a2.id, undefined, store)).rejects.toThrow(/already owned/i);
    // re-assigning to the same owner stays allowed (idempotent)
    await assignAddressOwner("addr-shared", a1.id, undefined, store);
    expect((await getAddressOwnership("addr-shared", store))!.owner_id).toBe(a1.id);
  });

  it("lists addresses by owner and by administrator, paginated newest-first", async () => {
    const store = variant();
    const human = await createOwner({ type: "human", name: "H" }, store);
    const agent = await createOwner({ type: "agent", name: "A" }, store);
    for (let i = 0; i < 5; i++) {
      seedAddress({ id: `addr-${i}`, email: `address-${i}@x.com`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
      await assignAddressOwner(`addr-${i}`, human.id, agent.id, store);
    }
    expect((await listAddressesByOwner(human.id, "owner", undefined, store)).map((a) => a.email)).toEqual([
      "address-4@x.com",
      "address-3@x.com",
      "address-2@x.com",
      "address-1@x.com",
      "address-0@x.com",
    ]);
    const page = await listAddressesByOwner(agent.id, "administrator", { limit: 2, offset: 1 }, store);
    expect(page.map((address) => address.email)).toEqual(["address-3@x.com", "address-2@x.com"]);
    // The seam's address record has no provider association (named loss); status is
    // the narrowed binary, never a raw cast.
    expect(page[0]!.provider_id).toBe("");
    expect(page[0]!.status).toBe("active");
  });

  it("lists administered addresses without duplicating self-administered owned rows", async () => {
    const store = variant();
    const human = await createOwner({ type: "human", name: "H" }, store);
    const agent = await createOwner({ type: "agent", name: "A" }, store);
    seedAddress({ id: "addr-human", email: "human@x.com" });
    seedAddress({ id: "addr-agent", email: "agent@x.com" });
    await assignAddressOwner("addr-human", human.id, agent.id, store);
    await assignAddressOwner("addr-agent", agent.id, undefined, store);
    expect((await listAdministeredAddressesNotOwnedBy(agent.id, undefined, store)).map((a) => a.email)).toEqual([
      "human@x.com",
    ]);
    expect(await listAddressEmailsByOwner(human.id, "owner", store)).toEqual(["human@x.com"]);
    expect((await listAddressEmailsByOwner(agent.id, "administrator", store)).sort()).toEqual([
      "agent@x.com",
      "human@x.com",
    ]);
  });
});

describe.each(STORE_VARIANTS)("address ownership audit trail (%s)", (_label, variant) => {
  it("records assign, transfer and unassign, newest first, inside one millisecond", async () => {
    const store = variant();
    const first = await createOwner({ type: "agent", name: "First" }, store);
    const second = await createOwner({ type: "agent", name: "Second" }, store);
    seedAddress({ id: "addr-audit", email: "audit@x.com" });

    await assignAddressOwner("addr-audit", first.id, undefined, store);
    await transferAddressOwner("addr-audit", second.id, undefined, { actor: "test", reason: "handoff" }, store);
    await unassignAddressOwner("addr-audit", { actor: "test", reason: "retired" }, store);

    expect(await getAddressOwnership("addr-audit", store)).toBeNull();

    const events = await listAddressOwnershipEvents("addr-audit", 20, store);
    expect(events.map((event) => event.action)).toEqual(["unassign", "transfer", "assign"]);
    // STRICTLY monotonic instants: three writes land inside one millisecond, and
    // presenting them in write order is the client-minted clock's whole job.
    expect(events[0]!.created_at > events[1]!.created_at).toBe(true);
    expect(events[1]!.created_at > events[2]!.created_at).toBe(true);
    expect(events[0]!.previous_owner_id).toBe(second.id);
    expect(events[0]!.reason).toBe("retired");
    expect(events[1]!.previous_owner_id).toBe(first.id);
    expect(events[1]!.owner_id).toBe(second.id);
    expect(events[1]!.actor).toBe("test");
    // The row reads back by its client-minted id, exactly as written.
    const byId = await getAddressOwnershipEvent(events[1]!.id, store);
    expect(byId).toEqual(events[1]!);
    expect(await getAddressOwnershipEvent("", store)).toBeNull();
  });

  it("requires a reason for transfer and unassign", async () => {
    const store = variant();
    const first = await createOwner({ type: "agent", name: "Reasoned" }, store);
    const second = await createOwner({ type: "agent", name: "Other" }, store);
    seedAddress({ id: "addr-reason", email: "reason@x.com" });
    await assignAddressOwner("addr-reason", first.id, undefined, store);

    await expect(
      transferAddressOwner("addr-reason", second.id, undefined, { reason: "" }, store),
    ).rejects.toThrow(/requires a reason/i);
    await expect(unassignAddressOwner("addr-reason", { reason: " " }, store)).rejects.toThrow(
      /requires a reason/i,
    );
  });

  it("records nothing for a no-op re-assign, and scopes the trail to one address", async () => {
    const store = variant();
    const agent = await createOwner({ type: "agent", name: "Idempotent" }, store);
    seedAddress({ id: "addr-a", email: "a@x.com" });
    seedAddress({ id: "addr-b", email: "b@x.com" });
    await assignAddressOwner("addr-a", agent.id, undefined, store);
    await assignAddressOwner("addr-a", agent.id, undefined, store); // unchanged: no event
    await assignAddressOwner("addr-b", agent.id, undefined, store);
    expect(await listAddressOwnershipEvents("addr-a", 20, store)).toHaveLength(1);
    expect((await listAddressOwnershipEvents("addr-b", 20, store)).map((e) => e.address_id)).toEqual(["addr-b"]);
  });

  it("caps the history limit at 100 and defaults it to 20", async () => {
    const store = variant();
    const agent = await createOwner({ type: "agent", name: "Busy" }, store);
    seedAddress({ id: "addr-busy", email: "busy@x.com" });
    // 102 events, so the 100-row CAP actually bites — 100 or fewer would let a
    // deleted cap answer the same length and pass.
    for (let i = 0; i < 51; i++) {
      await assignAddressOwner("addr-busy", agent.id, undefined, store);
      await unassignAddressOwner("addr-busy", { reason: `cycle ${i}` }, store);
    }
    expect(await listAddressOwnershipEvents("addr-busy", 9999, store)).toHaveLength(100);
    expect(await listAddressOwnershipEvents("addr-busy", undefined as unknown as number, store)).toHaveLength(20);
    // 102 writes through a real HTTP round trip per operation outrun the default
    // 5s case budget on a loaded machine; the bound is generous, not load-bearing.
  }, 60000);
});

describe("the owner past one clamped page", () => {
  // 520 owners; the needle sorts BELOW the first 500 of BOTH stores' raw orders
  // because its timestamps are the oldest — exactly the row the deleted arm's
  // single-page scan could never see.
  function seedLargeOwnersTable(): void {
    for (let i = 0; i < 520; i++) {
      seedOwner({
        id: `owner-${pad(i)}`,
        name: `Bulk Owner ${pad(i)}`,
        created_at: `2026-02-01T00:00:${pad(i)}Z`,
      });
    }
    seedOwner({
      id: "owner-needle",
      name: "Needle",
      external_id: "needle-ext",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  }

  it("resolves a name, an external id and a batch name past the clamp", async () => {
    seedLargeOwnersTable();
    const store = httpStore();

    // CONTROL: one page really cannot see the whole table — without this the
    // whole-set claims below could pass over a fixture that never clamped anything.
    const onePage = await store.owners.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // The deleted arm answered null here — "Owner not found" for a real owner.
    expect((await getOwnerByName("Needle", store))?.id).toBe("owner-needle");
    expect((await getOwnerByExternalId("needle-ext", store))?.id).toBe("owner-needle");
    // And it silently dropped this name from the sendkey listing's map.
    const names = await listOwnerNamesByIds(["owner-needle"], store);
    expect(names.get("owner-needle")).toBe("Needle");
    // The duplicate guard saw one page too: a clash past the clamp got a second POST.
    await expect(
      createOwner({ type: "agent", name: "Clash", external_id: "needle-ext" }, store),
    ).rejects.toThrow(/external_id already exists/i);
  });

  it("lists an owner's address past the clamp of the address registry", async () => {
    seedProvider();
    seedOwner({ id: "owner-scope", name: "Scoped", created_at: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < 520; i++) {
      seedAddress({ id: `addr-${pad(i)}`, email: `bulk-${pad(i)}@x.com`, created_at: `2026-02-01T00:00:${pad(i)}Z` });
    }
    seedAddress({ id: "addr-needle", email: "needle@x.com", created_at: "2026-01-01T00:00:00.000Z" });
    db.run("UPDATE addresses SET owner_id = 'owner-scope', administrator_id = 'owner-scope' WHERE id = 'addr-needle'");
    const store = httpStore();

    // CONTROL: the registry really clamps at 500.
    const onePage = await store.addresses.listAddresses({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // The deleted arm filtered ONE page and answered [] — the owner's real address
    // was invisible to `owner addresses` and to the sendkey scope printout.
    expect((await listAddressesByOwner("owner-scope", "owner", undefined, store)).map((a) => a.id)).toEqual([
      "addr-needle",
    ]);
    expect(await listAddressEmailsByOwner("owner-scope", "administrator", store)).toEqual(["needle@x.com"]);
  });
});

describe("the injectable and the argument orders", () => {
  it("accepts a bare Database handle and scopes the family to it", async () => {
    const owner = await createOwner({ type: "agent", name: "Handle Agent" }, db);
    expect((db.query("SELECT COUNT(*) AS n FROM owners").get() as { n: number }).n).toBe(1);
    expect((await getOwnerByName("Handle Agent", db))?.id).toBe(owner.id);
  });

  it("resolves the configured store when no store is passed", async () => {
    // Only the database path is configured (see configureExactlyOneStore), so the
    // default resolution binds to the same process-wide connection `db` is.
    const owner = await createOwner({ type: "agent", name: "Default Store" });
    expect(
      (db.query("SELECT name FROM owners WHERE id = ?").get(owner.id) as { name: string }).name,
    ).toBe("Default Store");
  });

  it("refuses an argument that is neither store shape, naming both", async () => {
    await expect(getOwnerByName("anyone", 42 as unknown as OwnerStore)).rejects.toThrow(
      /EmailStore or a bun:sqlite Database/,
    );
  });

  it("serves every published listing argument order, windows intact", async () => {
    for (let i = 0; i < 3; i++) {
      seedOwner({ id: `owner-${i}`, name: `Owner ${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const window = { limit: 1, offset: 1 };
    const expected = ["Owner 1"];
    expect((await listOwners(undefined, window)).map((o) => o.name)).toEqual(expected);
    expect((await listOwners(undefined, db, window)).map((o) => o.name)).toEqual(expected);
    expect((await listOwners(undefined, undefined, window)).map((o) => o.name)).toEqual(expected);
    expect((await listOwners(undefined, window, sqliteStore())).map((o) => o.name)).toEqual(expected);

    seedAddress({ id: "addr-orders", email: "orders@x.com" });
    db.run("UPDATE addresses SET owner_id = 'owner-0', administrator_id = 'owner-0' WHERE id = 'addr-orders'");
    expect((await listAddressesByOwner("owner-0", "owner", db)).map((a) => a.id)).toEqual(["addr-orders"]);
    expect((await listAddressesByOwner("owner-0", "owner", db, { limit: 1 })).map((a) => a.id)).toEqual([
      "addr-orders",
    ]);
    expect((await listAddressesByOwner("owner-0", "owner", { limit: 1 }, db)).map((a) => a.id)).toEqual([
      "addr-orders",
    ]);
    expect((await listAdministeredAddressesNotOwnedBy("owner-1", db)).map((a) => a.id)).toEqual([]);
    expect((await listAdministeredAddressesNotOwnedBy("owner-1", { limit: 5 }, db)).map((a) => a.id)).toEqual([]);
  });
});

// ─── Hand-built stores for defences the honest fixtures cannot exercise ─────

/** A minimal resource repository over in-memory rows, service-shaped (TEXT `id`). */
function stubRepository(rows: ResourceRow[]): ResourceRepository<ResourceRow> {
  const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
  return {
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

/** An EmailStore-shaped handle carrying exactly the owners family this suite drives. */
function stubStore(ownerRows: ResourceRow[]): EmailStore {
  return { messages: {}, owners: stubRepository(ownerRows) } as unknown as EmailStore;
}

function stubOwnerRow(overrides: Partial<Record<string, unknown>> & { id: string; name: string }): ResourceRow {
  return {
    type: "agent",
    contact_email: null,
    external_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ResourceRow;
}

describe("defences a well-behaved fixture cannot exercise", () => {
  // Both real stores honour equality filters, advance their pages, and hold NOT NULL
  // timestamps, so the defences below are only observable against a store that does
  // not. Each wrapper or stub here misbehaves in exactly one way.

  it("re-checks the pushed-down type filter rather than trusting the store", async () => {
    seedOwner({ id: "owner-agent", name: "Agent", type: "agent" });
    seedOwner({ id: "owner-human", name: "Human", type: "human" });
    const real = sqliteStore();
    const filterIgnoring = {
      ...real,
      owners: {
        ...real.owners,
        list: (opts?: { limit?: number; offset?: number }) =>
          real.owners.list({
            ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts?.offset === undefined ? {} : { offset: opts.offset }),
          }),
      },
    } as unknown as EmailStore;
    expect((await listOwners("human", undefined, filterIgnoring)).map((o) => o.id)).toEqual(["owner-human"]);
  });

  it("re-checks the pushed-down address_id filter on the audit trail", async () => {
    seedOwner({ id: "owner-x", name: "X" });
    seedAddress({ id: "addr-mine", email: "mine@x.com" });
    seedAddress({ id: "addr-theirs", email: "theirs@x.com" });
    db.run(
      `INSERT INTO address_ownership_events
        (id, address_id, action, previous_owner_id, previous_administrator_id, owner_id, administrator_id, actor, reason, created_at)
       VALUES ('evt-mine', 'addr-mine', 'assign', NULL, NULL, 'owner-x', 'owner-x', NULL, NULL, '2026-01-02T00:00:00.000Z'),
              ('evt-theirs', 'addr-theirs', 'assign', NULL, NULL, 'owner-x', 'owner-x', NULL, NULL, '2026-01-03T00:00:00.000Z')`,
    );
    const real = sqliteStore();
    const raw = (real as unknown as { addressOwnershipEvents: ResourceRepository<ResourceRow> }).addressOwnershipEvents;
    const filterIgnoring = {
      ...real,
      addressOwnershipEvents: {
        ...raw,
        list: (opts?: { limit?: number; offset?: number }) =>
          raw.list({
            ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts?.offset === undefined ? {} : { offset: opts.offset }),
          }),
      },
    } as unknown as EmailStore;
    // Trusting the store here would splice addr-theirs's history into addr-mine's.
    expect((await listAddressOwnershipEvents("addr-mine", 20, filterIgnoring)).map((e) => e.id)).toEqual([
      "evt-mine",
    ]);
  });

  it("refuses a read whose pages never advance instead of presenting the loop as the table", async () => {
    seedOwner({ id: "owner-a", name: "A" });
    seedOwner({ id: "owner-b", name: "B" });
    const real = sqliteStore();
    const stuck = {
      ...real,
      owners: {
        ...real.owners,
        list: (opts?: { limit?: number; offset?: number }) => real.owners.list({ ...(opts ?? {}), offset: 0 }),
      },
    } as unknown as EmailStore;
    await expect(listOwners(undefined, undefined, stuck)).rejects.toThrow(/LOWER BOUND/);
  });

  it("surfaces the store's own refusal instead of presenting it as an empty table", async () => {
    const real = sqliteStore();
    const refusing = {
      ...real,
      owners: {
        ...real.owners,
        list: async (): Promise<Outcome<ResourceRow[]>> => ({
          ok: false,
          code: "scope_violation",
          message: "outside the caller's scope",
          status: 403,
        }),
      },
    } as unknown as EmailStore;
    await expect(getOwnerByName("anyone", refusing)).rejects.toThrow(/scope_violation/);
    await expect(listOwnerNamesByIds(["owner-1"], refusing)).rejects.toThrow(/scope_violation/);
  });

  it("faults an absent NOT NULL timestamp instead of reporting the current time", async () => {
    const missingCreated = stubStore([
      { id: "owner-1", type: "agent", name: "Undated", contact_email: null, external_id: null, updated_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(getOwnerByName("Undated", missingCreated)).rejects.toThrow(/no created_at/);
    const missingUpdated = stubStore([
      { id: "owner-1", type: "agent", name: "Undated", contact_email: null, external_id: null, created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(getOwnerByName("Undated", missingUpdated)).rejects.toThrow(/no updated_at/);
  });

  it("presents an out-of-set owner type as human — the coercion both arms agreed on", async () => {
    // The service schema declares DEFAULT 'human' and no CHECK; a garbage type
    // must not become an administrator.
    const store = stubStore([stubOwnerRow({ id: "owner-weird", name: "Weird", type: "robot" })]);
    expect((await getOwnerByName("Weird", store))?.type).toBe("human");
  });

  it("faults an audit action outside the declared set, naming the row and the value", async () => {
    seedOwner({ id: "owner-x", name: "X" });
    seedAddress({ id: "addr-bogus", email: "bogus@x.com" });
    db.run(
      `INSERT INTO address_ownership_events
        (id, address_id, action, previous_owner_id, previous_administrator_id, owner_id, administrator_id, actor, reason, created_at)
       VALUES ('evt-good', 'addr-bogus', 'assign', NULL, NULL, 'owner-x', 'owner-x', NULL, NULL, '2026-01-02T00:00:00.000Z')`,
    );
    // The local schema CHECK forbids this row, so it is built on a stub — which is
    // exactly the reachable path (the service schema carries no CHECK).
    const events = stubRepository([
      { id: "evt-bad", address_id: "addr-bogus", action: "seize", previous_owner_id: null, previous_administrator_id: null, owner_id: null, administrator_id: null, actor: null, reason: null, created_at: "2026-01-03T00:00:00.000Z" },
    ]);
    const store = { messages: {}, addressOwnershipEvents: events } as unknown as EmailStore;
    await expect(listAddressOwnershipEvents("addr-bogus", 20, store)).rejects.toThrow(/outside the declared set/);
    await expect(listAddressOwnershipEvents("addr-bogus", 20, store)).rejects.toThrow(/"seize"/);
  });

  it("refuses an ownership WRITE up front when the store carries no audit ledger", async () => {
    seedOwner({ id: "owner-x", name: "X" });
    seedAddress({ id: "addr-unrecorded", email: "unrecorded@x.com" });
    const real = sqliteStore();
    const ledgerless = { ...real, addressOwnershipEvents: undefined } as unknown as EmailStore;
    await expect(assignAddressOwner("addr-unrecorded", "owner-x", undefined, ledgerless)).rejects.toThrow(
      /audit ledger/,
    );
    // REFUSED BEFORE THE PATCH: the address is untouched, not silently reassigned.
    const row = db.query("SELECT owner_id FROM addresses WHERE id = 'addr-unrecorded'").get() as {
      owner_id: string | null;
    };
    expect(row.owner_id).toBeNull();
    await expect(listAddressOwnershipEvents("addr-unrecorded", 20, ledgerless)).rejects.toThrow(/audit ledger/);
  });

  it("breaks a created_at tie by row identity, so a window is the same window everywhere", async () => {
    const store = stubStore([
      stubOwnerRow({ id: "owner-alpha", name: "Alpha" }),
      stubOwnerRow({ id: "owner-omega", name: "Omega" }),
    ]);
    expect((await listOwners(undefined, { limit: 1 }, store)).map((o) => o.id)).toEqual(["owner-omega"]);
  });

  it("narrows an out-of-set address status to active instead of casting it (divergence 6)", async () => {
    // Neither schema CHECK-constrains address status, so "pending" is a reachable
    // stored value — and the published shape declares the binary. The deleted SQLite
    // arm CAST the raw column behind the type (the #137 class); the narrowing keeps
    // "suspended" and presents everything else as "active". A mutation run proved no
    // other case could see this mapping.
    seedOwner({ id: "owner-status", name: "Status" });
    seedAddress({ id: "addr-pending", email: "pending@x.com", created_at: "2026-01-02T00:00:00.000Z" });
    seedAddress({ id: "addr-suspended", email: "suspended@x.com", created_at: "2026-01-01T00:00:00.000Z" });
    db.run("UPDATE addresses SET owner_id = 'owner-status', status = 'pending' WHERE id = 'addr-pending'");
    db.run("UPDATE addresses SET owner_id = 'owner-status', status = 'suspended' WHERE id = 'addr-suspended'");
    const listed = await listAddressesByOwner("owner-status", "owner", undefined, sqliteStore());
    expect(listed.map((address) => [address.id, address.status])).toEqual([
      ["addr-pending", "active"],
      ["addr-suspended", "suspended"],
    ]);
  });
});
