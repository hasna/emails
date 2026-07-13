// Self-hosted-ONLY: the owners repo routes owner CRUD to /v1/owners, address
// ownership fields to /v1/addresses/<id>, and the audit trail to
// /v1/address-ownership-events. Exercises the REAL curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern: former tests mutated
// `db.run("UPDATE ... SET created_at ...")` to control ordering; here we seed
// the /v1 rows with explicit created_at instead. The `listOwners`/
// `listAddressesByOwner` pagination-option arity dropped its old `db` slot.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createAddress } from "./addresses.js";
import {
  createOwner, getOwner, getOwnerByName, listOwners,
  assignAddressOwner, getAddressOwnership, listAddressesByOwner, listAddressEmailsByOwner,
  listAdministeredAddressesNotOwnedBy, listOwnerNamesByIds, listOwnersByIds,
  listAddressOwnershipEvents, transferAddressOwner, unassignAddressOwner,
} from "./owners.js";

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

/** Seed address rows (with explicit created_at for deterministic ordering). */
function seededAddresses(rows: Array<{ id: string; email: string; created_at: string }>) {
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    status: "active",
    verified: true,
    owner_id: null,
    administrator_id: null,
    created_at: r.created_at,
    updated_at: r.created_at,
  }));
}

describe("owners", () => {
  it("registers a human and an agent owner", () => {
    const human = createOwner({ type: "human", name: "Example Person", contact_email: "person@example.com" });
    const agent = createOwner({ type: "agent", name: "Tiberius", external_id: "agent-503a" });
    expect(human.type).toBe("human");
    expect(agent.type).toBe("agent");
    expect(getOwner(human.id)!.contact_email).toBe("person@example.com");
    expect(getOwnerByName("Tiberius")!.id).toBe(agent.id);
    expect(listOwners("agent").map((o) => o.name)).toContain("Tiberius");
  });

  it("paginates owners after ordering newest first", async () => {
    await stub.seed({
      owners: Array.from({ length: 5 }, (_v, i) => ({
        id: `owner-${i}`,
        type: "agent",
        name: `Owner ${i}`,
        contact_email: null,
        external_id: null,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const page = listOwners("agent", { limit: 2, offset: 1 });

    expect(page.map((owner) => owner.name)).toEqual(["Owner 3", "Owner 2"]);
  });

  it("rejects an invalid owner type", () => {
    expect(() => createOwner({ type: "robot" as never, name: "X" })).toThrow();
  });

  it("rejects a duplicate external_id", () => {
    createOwner({ type: "agent", name: "First", external_id: "dup" });
    expect(() => createOwner({ type: "agent", name: "Second", external_id: "dup" })).toThrow(/external_id already exists/i);
  });
});

describe("assignAddressOwner — human-owned must be agent-administered", () => {
  it("agent-owned address is self-administered (administrator = owner)", () => {
    const agent = createOwner({ type: "agent", name: "Caesar" });
    const a = createAddress({ provider_id: "p1", email: "ops@x.com" });
    assignAddressOwner(a.id, agent.id);
    const own = getAddressOwnership(a.id)!;
    expect(own.owner_id).toBe(agent.id);
    expect(own.administrator_id).toBe(agent.id); // self-administered
  });

  it("human-owned address requires an agent administrator", () => {
    const human = createOwner({ type: "human", name: "Morgan" });
    const agent = createOwner({ type: "agent", name: "Tiberius" });
    const a = createAddress({ provider_id: "p1", email: "morgan@x.com" });
    // missing administrator → throws
    expect(() => assignAddressOwner(a.id, human.id)).toThrow(/human-owned.*agent administrator/i);
    // administrator must be an agent, not a human
    expect(() => assignAddressOwner(a.id, human.id, human.id)).toThrow(/administrator must be an agent/i);
    // valid: human owner + agent administrator
    assignAddressOwner(a.id, human.id, agent.id);
    const own = getAddressOwnership(a.id)!;
    expect(own.owner_id).toBe(human.id);
    expect(own.administrator_id).toBe(agent.id);
  });

  it("lists addresses by owner and by administrator", () => {
    const human = createOwner({ type: "human", name: "H" });
    const agent = createOwner({ type: "agent", name: "A" });
    const a1 = createAddress({ provider_id: "p1", email: "h1@x.com" });
    const a2 = createAddress({ provider_id: "p1", email: "h2@x.com" });
    assignAddressOwner(a1.id, human.id, agent.id);
    assignAddressOwner(a2.id, agent.id);
    expect(listAddressesByOwner(human.id).map((a) => a.email)).toEqual(["h1@x.com"]);
    // agent administers both (a1 as admin, a2 as owner=self-admin)
    expect(listAddressesByOwner(agent.id, "administrator").map((a) => a.email).sort()).toEqual(["h1@x.com", "h2@x.com"]);
  });

  it("paginates owner addresses after ordering newest first", async () => {
    await stub.seed({
      addresses: seededAddresses(Array.from({ length: 5 }, (_v, i) => ({
        id: `addr-${i}`, email: `address-${i}@x.com`, created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      }))),
    });
    const agent = createOwner({ type: "agent", name: "Paged" });
    for (let i = 0; i < 5; i++) assignAddressOwner(`addr-${i}`, agent.id);

    const page = listAddressesByOwner(agent.id, "owner", { limit: 2, offset: 1 });

    expect(page.map((address) => address.email)).toEqual(["address-3@x.com", "address-2@x.com"]);
  });

  it("paginates administered addresses after ordering newest first", async () => {
    await stub.seed({
      addresses: seededAddresses(Array.from({ length: 5 }, (_v, i) => ({
        id: `admin-${i}`, email: `admin-${i}@x.com`, created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      }))),
    });
    const human = createOwner({ type: "human", name: "Paged Human" });
    const agent = createOwner({ type: "agent", name: "Paged Agent" });
    for (let i = 0; i < 5; i++) assignAddressOwner(`admin-${i}`, human.id, agent.id);

    const page = listAddressesByOwner(agent.id, "administrator", { limit: 2, offset: 1 });

    expect(page.map((address) => address.email)).toEqual(["admin-3@x.com", "admin-2@x.com"]);
  });

  it("lists administered addresses without duplicating self-administered owned rows", () => {
    const human = createOwner({ type: "human", name: "H" });
    const agent = createOwner({ type: "agent", name: "A" });
    const administered = createAddress({ provider_id: "p1", email: "human@x.com" });
    const selfAdministered = createAddress({ provider_id: "p1", email: "agent@x.com" });
    assignAddressOwner(administered.id, human.id, agent.id);
    assignAddressOwner(selfAdministered.id, agent.id);

    expect(listAdministeredAddressesNotOwnedBy(agent.id).map((a) => a.email)).toEqual(["human@x.com"]);
  });

  it("lists only address email strings by owner role", () => {
    const human = createOwner({ type: "human", name: "H" });
    const agent = createOwner({ type: "agent", name: "A" });
    const a1 = createAddress({ provider_id: "p1", email: "h1@x.com" });
    const a2 = createAddress({ provider_id: "p1", email: "h2@x.com" });
    assignAddressOwner(a1.id, human.id, agent.id);
    assignAddressOwner(a2.id, agent.id);

    expect(listAddressEmailsByOwner(human.id)).toEqual(["h1@x.com"]);
    expect(listAddressEmailsByOwner(agent.id, "administrator").sort()).toEqual(["h1@x.com", "h2@x.com"]);
  });

  it("lists owner names for selected ids only", () => {
    const first = createOwner({ type: "human", name: "First" });
    const second = createOwner({ type: "agent", name: "Second" });
    createOwner({ type: "agent", name: "Other" });

    expect([...listOwnerNamesByIds([first.id, second.id, first.id]).entries()].sort()).toEqual([
      [first.id, "First"],
      [second.id, "Second"],
    ].sort());
    expect(listOwnerNamesByIds([]).size).toBe(0);
  });

  it("lists full owner rows for selected ids only", () => {
    const first = createOwner({ type: "human", name: "First", contact_email: "first@example.com" });
    const second = createOwner({ type: "agent", name: "Second", external_id: "agent-2" });
    createOwner({ type: "agent", name: "Other" });

    const owners = listOwnersByIds([first.id, second.id, first.id]);
    expect([...owners.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(owners.get(first.id)).toMatchObject({ name: "First", contact_email: "first@example.com" });
    expect(owners.get(second.id)).toMatchObject({ name: "Second", external_id: "agent-2" });
    expect(listOwnersByIds([]).size).toBe(0);
  });

  it("throws when owner does not exist", () => {
    const a = createAddress({ provider_id: "p1", email: "z@x.com" });
    expect(() => assignAddressOwner(a.id, "nonexistent")).toThrow(/owner not found/i);
  });
});

describe("assignAddressOwner — anti-hijack", () => {
  it("refuses to reassign an address already owned by another owner", () => {
    const a1 = createOwner({ type: "agent", name: "Galba" });
    const a2 = createOwner({ type: "agent", name: "Vitellius" });
    const addr = createAddress({ provider_id: "p1", email: "shared@x.com" });
    assignAddressOwner(addr.id, a1.id);
    expect(() => assignAddressOwner(addr.id, a2.id)).toThrow(/already owned/i);
    // re-assigning to the same owner stays allowed (idempotent)
    expect(() => assignAddressOwner(addr.id, a1.id)).not.toThrow();
  });
});

describe("address ownership audit", () => {
  it("records assign, transfer, and unassign events", () => {
    const first = createOwner({ type: "agent", name: "First" });
    const second = createOwner({ type: "agent", name: "Second" });
    const addr = createAddress({ provider_id: "p1", email: "audit@x.com" });

    assignAddressOwner(addr.id, first.id);
    transferAddressOwner(addr.id, second.id, undefined, { actor: "test", reason: "handoff" });
    unassignAddressOwner(addr.id, { actor: "test", reason: "retired" });

    const ownership = getAddressOwnership(addr.id);
    expect(ownership).toBeNull();

    const events = listAddressOwnershipEvents(addr.id);
    expect(events.map((event) => event.action)).toEqual(["unassign", "transfer", "assign"]);
    expect(events[0]!.previous_owner_id).toBe(second.id);
    expect(events[0]!.reason).toBe("retired");
    expect(events[1]!.previous_owner_id).toBe(first.id);
    expect(events[1]!.owner_id).toBe(second.id);
    expect(events[1]!.actor).toBe("test");
  });

  it("requires a reason for transfer and unassign", () => {
    const first = createOwner({ type: "agent", name: "Reasoned" });
    const second = createOwner({ type: "agent", name: "Other" });
    const addr = createAddress({ provider_id: "p1", email: "reason@x.com" });
    assignAddressOwner(addr.id, first.id);

    expect(() => transferAddressOwner(addr.id, second.id, undefined, { reason: "" })).toThrow(/requires a reason/i);
    expect(() => unassignAddressOwner(addr.id, { reason: " " })).toThrow(/requires a reason/i);
  });
});
