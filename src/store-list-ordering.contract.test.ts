// THE SEAM'S LIST-ORDER CONTRACT FOR THE UNIFORM FAMILIES: ORDER IS NOT PART OF IT.
//
// `ListOptions` (src/store/records.ts) admits `limit` and `offset` and NOTHING that
// names an ordering, and the two arms do not agree on one:
//
//   * The SQLite arm derives ONE recipe for every family from the table's own shape
//     (src/store-sqlite/resources.ts, `describeTable`): `updated_at DESC` when the
//     table has it, else `created_at DESC`, tie-broken by the id DESCENDING.
//   * The API arm serves each family with a PER-RESOURCE order from the server's spec
//     table (src/server/self-hosted/resources.ts, `resourceListOrderBy`): `name ASC`
//     for groups, `scheduled_at ASC` for scheduled sends, `updated_at DESC` for
//     contacts, … — always tie-broken by the resource key ASCENDING.
//
// So for the SAME rows the two stores hand back DIFFERENT sequences — different
// tiebreak directions even where the leading term happens to match — and no store
// swap can preserve a consumer's row order. The collapsed families already live by
// this: every full-scan consumer enumerates and re-sorts locally before windowing.
//
// THE CONTRACT, therefore, is the one this file pins:
//
//   A uniform-family `list` promises WHICH rows come back, never in WHAT order.
//   A consumer that needs an order MUST enumerate (page to exhaustion) and sort
//   the rows itself. Trusting the order of one bounded page is a store-swap bug
//   waiting to fire, and the divergence test below is its counterexample.
//
// This paragraph belongs on `ListOptions` itself; src/store/ is byte-frozen in this
// change, so it lives here and the guard below fails the build the moment someone
// grows `ListOptions` an ordering knob without deciding cross-store semantics first.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDatabase, getDatabase, resetDatabase } from "./db/database.js";
import {
  SELF_HOSTED_RESOURCES,
  resourceKeyColumn,
  resourceListOrderBy,
  resourceSpecForPath,
} from "./server/self-hosted/resources.js";
import type { EmailStore } from "./store/email-store.js";
import type { Outcome } from "./store/outcome.js";
import type { ResourceRow } from "./store/records.js";
import { createHttpEmailStore } from "./store-http/index.js";
import { createSqliteEmailStore } from "./store-sqlite/index.js";
import { startV1StoreApi, type V1StoreApi } from "./test-support/v1-store-api.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: Database;
let api: V1StoreApi;

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "ordering fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "ordering fixture" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

/** Unwrap a success or fail the test with the refusal — an Outcome is never ignored. */
function must<TValue>(outcome: Outcome<TValue>, what: string): TValue {
  if (!outcome.ok) throw new Error(`${what} refused: ${outcome.code} ${outcome.message}`);
  return outcome.value;
}

/** A timestamp shared by every row of a case, so the leading ORDER BY term ties. */
const TIED_INSTANT = "2020-05-05T05:05:05.000Z";

describe("uniform-family list order — the divergence that keeps order out of the contract", () => {
  it("the two arms declare different total orders for the same tied rows (STRONG detector)", async () => {
    // Three contacts whose created_at/updated_at all tie, with ids whose lexicographic
    // order is unambiguous. The fixture is seeded BELOW the seam: neither arm accepts a
    // caller-supplied id or timestamp any more (server-owned columns are refused on
    // both), and this test needs tied rows with chosen ids precisely to observe the
    // arms' own orderings — so it inserts them with its own SQL against the database
    // both stores read.
    const store = sqliteStore();
    for (const id of ["order-aa", "order-bb", "order-cc"]) {
      db.query(
        "INSERT INTO contacts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(id, `${id}@ordering.example.test`, TIED_INSTANT, TIED_INSTANT);
    }
    const listed = must(await store.contacts.list({ limit: 500 }), "contacts.list");
    const observed = listed
      .map((row) => String((row as ResourceRow)["id"]))
      .filter((id) => id.startsWith("order-"));

    // The SQLite arm's tiebreak is the id DESCENDING — observed, not assumed.
    expect(observed).toEqual(["order-cc", "order-bb", "order-aa"]);

    // The API arm's DECLARED order for the same family tie-breaks the key ASCENDING,
    // so a Postgres-backed service returns these tied rows in exactly the reverse
    // sequence. Asserted against the server's own spec table so this cannot go stale.
    const spec = resourceSpecForPath("contacts");
    if (!spec) throw new Error("the contacts resource spec disappeared from the server table");
    expect(resourceListOrderBy(spec)).toBe("updated_at DESC, id ASC");
    const declaredForTies = [...observed].sort(); // key ASC once the leading term ties
    expect(declaredForTies).toEqual(["order-aa", "order-bb", "order-cc"]);

    // THE POINT: the same rows, two different sequences. Order is therefore not a
    // property a consumer may carry across the seam.
    expect(declaredForTies).not.toEqual(observed);
  });

  it("the API arm's per-family orders are heterogeneous while ListOptions offers no ordering (WEAK detector)", () => {
    // The server's spec table orders some families by a time column and others by a
    // NAME or ADDRESS column — proof by inspection that no single cross-family order
    // exists for the SQLite arm's uniform time-descending recipe to agree with.
    const orders = new Map(SELF_HOSTED_RESOURCES.map((spec) => [spec.path, resourceListOrderBy(spec)]));
    expect(orders.get("groups")).toBe("name ASC, id ASC");
    expect(orders.get("scheduled")).toBe("scheduled_at ASC, id ASC");
    // Every declared order is made total by the resource's own key, ascending — the
    // opposite direction from the SQLite arm's descending id tiebreak.
    for (const spec of SELF_HOSTED_RESOURCES) {
      const key = resourceKeyColumn(spec);
      const order = resourceListOrderBy(spec);
      expect(
        order.includes(`${key} ASC`),
        `${spec.path} declares "${order}", which never orders by its key ${key} ascending`,
      ).toBe(true);
    }
  });
});

describe("uniform-family list — what IS promised: enumeration, compared sorted", () => {
  // The contract case, run against BOTH arms: every created row comes back exactly
  // once, and the comparison is done on a SORTED copy because sortedness is the
  // consumer's job. A case that compared unsorted sequences here would be asserting
  // the very property the divergence test above proves no store can promise.
  const ARMS: Array<{ label: string; make: () => EmailStore }> = [
    { label: "SQLite arm", make: () => sqliteStore() },
    { label: "API arm", make: () => httpStore() },
  ];

  for (const arm of ARMS) {
    it(`${arm.label}: list is an enumeration — full set back, exactly once, order not asserted`, async () => {
      const store = arm.make();
      const created: string[] = [];
      for (const tag of ["enum-a", "enum-b", "enum-c"]) {
        const row = must(
          await store.contacts.create({ email: `${tag}@ordering.example.test`, name: tag }),
          `contacts.create ${tag}`,
        );
        created.push(String((row as ResourceRow)["id"]));
      }
      const listed = must(await store.contacts.list({ limit: 500 }), "contacts.list");
      const ours = listed
        .map((row) => String((row as ResourceRow)["id"]))
        .filter((id) => created.includes(id));
      // Set equality via sorted copies — the enumerate-and-sort discipline itself.
      expect([...ours].sort()).toEqual([...created].sort());
      // Exactly once: an enumeration that repeats a row is as wrong as one that drops one.
      expect(new Set(ours).size).toBe(ours.length);
    });
  }
});

describe("ListOptions stays order-free until cross-store order semantics exist", () => {
  it("grows no ordering knob silently (guard on the frozen declaration)", () => {
    const source = readFileSync(join(import.meta.dir, "store", "records.ts"), "utf8");
    const block = /export interface ListOptions \{([\s\S]*?)\}/.exec(source);
    if (!block || !block[1]) throw new Error("ListOptions declaration not found in src/store/records.ts");
    const fields = [...block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((match) => match[1]);
    // EXACTLY limit and offset. A new field here — `order`, `sort`, anything — must
    // arrive together with a cross-store ordering decision and conformance coverage,
    // and this failure is the reminder. (Also the positive control: an empty or
    // mis-parsed block would yield [] and fail, not pass.)
    expect(fields).toEqual(["limit", "offset"]);
  });
});
