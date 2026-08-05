// The sandbox capture family, over the store seam — against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub (`src/test-support/v1-stub.ts`), because the family's second arm
// talked to `/v1` through a `curl` bridge. `src/db/sandbox.ts` has collapsed onto the store
// seam, so the same operations now reach `/v1` through the REAL `HttpEmailStore`, which reads
// `GET /v1/openapi.json` before any filtered list or write — the published contract is its
// only source of truth for which columns a resource accepts and which query parameters its
// list route filters on. That stub serves the document only on request, and when it does, its
// generic list handler still IGNORES equality filters and answers with the unfiltered list,
// which this module correctly treats as a FAULT. The stub's own header points at
// `src/test-support/v1-store-api.ts` for filtered or paged store-seam work, and that is what
// this file uses: a `/v1` service that stores nothing and translates every request into the
// same store seam, backed by the same in-memory database the SQLite variant reads. Both
// variants therefore answer from ONE dataset, and a client that mis-maps a column fails here
// rather than being handed its own mistake back.
//
// EVERY CASE THAT CAN RUN AGAINST BOTH STORES DOES. The two stores disagree about ordering,
// about which columns a write may name and about the JSON shape a column comes back in, and
// those disagreements are the whole reason this family had two arms.

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  storeSandboxEmail,
  listSandboxEmails,
  listSandboxEmailSummaries,
  getSandboxEmail,
  clearSandboxEmails,
  getSandboxCount,
  type StoreSandboxEmailInput,
} from "./sandbox.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions, ResourceInput, ResourceRow } from "../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

const P1 = "provider-1";
const P2 = "provider-2";

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
 * Leave exactly ONE store configured, so the cases that pass no store can resolve.
 *
 * The settings are named through the resolution's OWN exported constants rather than copied
 * as literals: this is the list that decides which store a caller with no injected store
 * gets, and a second copy here would go stale the first time the resolution learned another
 * setting. A database path AND an API together are a hard boot error with deliberately no
 * precedence rule, so a stray inherited API setting would turn every default-store case into
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

/**
 * The running `/v1` fixture, or a clear failure.
 *
 * The handle is nullable so a `beforeEach` that dies before it is assigned reports its own
 * error rather than a `TypeError` from the teardown; this is the accessor every case uses, so
 * "not started" can never read as "started and empty".
 */
function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  // `sandbox_emails.provider_id` is a real foreign key into `providers` locally (the
  // self-hosted schema declares the same reference), so both providers this file writes for
  // have to exist before anything captures mail for them.
  for (const id of [P1, P2]) {
    db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'sandbox', 1)", [id, id]);
  }
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "sandbox row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (sandbox test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

function input(overrides: Partial<StoreSandboxEmailInput> = {}): StoreSandboxEmailInput {
  return {
    provider_id: P1,
    from_address: "a@a.com",
    to_addresses: ["b@b.com"],
    cc_addresses: [],
    bcc_addresses: [],
    reply_to: null,
    subject: "subject",
    html: null,
    text_body: "t",
    attachments: [],
    headers: {},
    ...overrides,
  };
}

/**
 * A capture written STRAIGHT INTO THE TABLE, with an id and a `created_at` this suite chooses.
 *
 * Neither store lets a caller name the id on a create — the API's request schema does not
 * declare the column and refuses it — so a case that needs to know which id a row has, or that
 * needs two rows to share a timestamp exactly, has to seed. Both store variants read this same
 * database, so a seeded row is visible through both.
 */
function seedCapture(id: string, createdAt: string, overrides: Record<string, string> = {}): void {
  db.run(
    `INSERT INTO sandbox_emails
       (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to,
        subject, html, text_body, attachments_json, headers_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides["provider_id"] ?? P1,
      overrides["from_address"] ?? "a@a.com",
      overrides["to_addresses"] ?? JSON.stringify(["b@b.com"]),
      overrides["cc_addresses"] ?? "[]",
      overrides["bcc_addresses"] ?? "[]",
      overrides["reply_to"] ?? null,
      overrides["subject"] ?? "seeded",
      overrides["html"] ?? null,
      overrides["text_body"] ?? null,
      overrides["attachments_json"] ?? "[]",
      overrides["headers_json"] ?? "{}",
      createdAt,
    ],
  );
}

/** An ISO instant `seconds` after a fixed epoch, so seeded order is unambiguous. */
function stamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
}

/** Rows as the TABLE holds them, read without going through this module. */
function tableRows(): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM sandbox_emails ORDER BY id ASC").all() as Array<Record<string, unknown>>;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw, and it resolved");
}

// ── behaviour, against both shipped stores ──────────────────────────────────────────────

for (const [label, makeStore] of STORE_VARIANTS) {
  describe(`sandbox capture — ${label}`, () => {
    describe("storeSandboxEmail", () => {
      it("round-trips every column and hands back the row the store persisted", async () => {
        const store = makeStore();
        const email = await storeSandboxEmail(
          input({
            from_address: "from@example.com",
            to_addresses: ["to@example.com", "second@example.com"],
            cc_addresses: ["cc@example.com"],
            bcc_addresses: ["bcc@example.com"],
            reply_to: "reply@example.com",
            subject: "Hello sandbox",
            html: "<p>Hello</p>",
            text_body: "Hello",
            headers: { "X-Custom": "value" },
          }),
          store,
        );

        expect(email.provider_id).toBe(P1);
        expect(email.from_address).toBe("from@example.com");
        expect(email.to_addresses).toEqual(["to@example.com", "second@example.com"]);
        expect(email.cc_addresses).toEqual(["cc@example.com"]);
        expect(email.bcc_addresses).toEqual(["bcc@example.com"]);
        expect(email.reply_to).toBe("reply@example.com");
        expect(email.subject).toBe("Hello sandbox");
        expect(email.html).toBe("<p>Hello</p>");
        expect(email.text_body).toBe("Hello");
        expect(email.attachments).toEqual([]);
        expect(email.headers).toEqual({ "X-Custom": "value" });

        // The row really is in the table, not only in the answer.
        const rows = tableRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!["id"]).toBe(email.id);
        expect(rows[0]!["subject"]).toBe("Hello sandbox");
      });

      it("lets the STORE mint the id — nothing sends one", async () => {
        // Divergence 5. The deleted second arm generated a uuid and sent it as `id`; the API's
        // request schema declares twelve writable columns, `id` is not one of them, and it is
        // `additionalProperties: false` — so the real API store REFUSES that write. That the
        // API variant succeeds at all is half the proof; these two facts are the other half.
        const store = makeStore();
        const first = await storeSandboxEmail(input({ subject: "one" }), store);
        const second = await storeSandboxEmail(input({ subject: "two" }), store);

        expect(first.id).toHaveLength(36);
        expect(second.id).toHaveLength(36);
        expect(first.id).not.toBe(second.id);
      });

      it("writes created_at as an ISO-8601 instant rather than the SQLite table default", async () => {
        // Divergence 6. The deleted SQLite arm omitted the column, so the table default
        // produced `YYYY-MM-DD HH:MM:SS` — no `T`, no `Z`, no milliseconds.
        const store = makeStore();
        const email = await storeSandboxEmail(input(), store);

        expect(email.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(email.created_at).not.toMatch(/^\d{4}-\d{2}-\d{2} /);
        expect(tableRows()[0]!["created_at"]).toBe(email.created_at);
      });

      it("REFUSES a capture it would not be able to read back, and writes nothing", async () => {
        // The write path checks what the read path checks. Without this, a JavaScript caller
        // (the compiler is not present at the call site of a published package) could store a
        // row this module then faults on — and ONE such row makes every listing of the table
        // fault until somebody clears it. The deleted SQLite arm accepted all four of these
        // because its reader validated nothing at all.
        const store = makeStore();
        const cases: Array<[string, Partial<StoreSandboxEmailInput>]> = [
          ["to_addresses", { to_addresses: [42] as unknown as string[] }],
          ["cc_addresses", { cc_addresses: "not-a-list" as unknown as string[] }],
          ["attachments", { attachments: {} as unknown as [] }],
          ["headers", { headers: [] as unknown as Record<string, string> }],
        ];

        for (const [column, override] of cases) {
          const error = await rejection(storeSandboxEmail(input(override), store));
          expect(error.message, column).toContain("Refusing to capture");
          // The message names the offending column, so a caller can fix the input rather than
          // guess which of four it was.
          expect(error.message, column).toContain(column);
        }

        // AND NOTHING WAS WRITTEN. The refusal has to happen before the store is asked, or the
        // row it refuses to report is in the table anyway.
        expect(tableRows()).toHaveLength(0);
      });

      it("keeps an empty subject as a value", async () => {
        const store = makeStore();
        const email = await storeSandboxEmail(input({ subject: "" }), store);
        expect(email.subject).toBe("");
        expect((await getSandboxEmail(email.id, store))?.subject).toBe("");
      });
    });

    describe("listSandboxEmails", () => {
      it("returns every capture when no provider is named", async () => {
        const store = makeStore();
        await storeSandboxEmail(input({ provider_id: P1, subject: "Email 1" }), store);
        await storeSandboxEmail(input({ provider_id: P2, subject: "Email 2" }), store);

        expect(await listSandboxEmails(undefined, 50, 0, store)).toHaveLength(2);
      });

      it("filters by provider_id, pushed down to the store", async () => {
        const store = makeStore();
        await storeSandboxEmail(input({ provider_id: P1, subject: "P1 Email" }), store);
        await storeSandboxEmail(input({ provider_id: P2, subject: "P2 Email" }), store);

        expect((await listSandboxEmails(P1, 50, 0, store)).map((email) => email.subject)).toEqual(["P1 Email"]);
        expect((await listSandboxEmails(P2, 50, 0, store)).map((email) => email.subject)).toEqual(["P2 Email"]);
      });

      it("treats an EMPTY provider id as no filter at all", async () => {
        // Preserved verbatim from both arms, which tested the argument for truthiness. It is
        // pinned because the alternative reading — an empty string scoping the read to a
        // provider named `""` — is the change `src/db/aliases.ts` made by accident in the
        // other direction and had to revert.
        const store = makeStore();
        await storeSandboxEmail(input({ provider_id: P1 }), store);
        await storeSandboxEmail(input({ provider_id: P2 }), store);

        expect(await listSandboxEmails("", 50, 0, store)).toHaveLength(2);
      });

      it("orders newest first and breaks a tie on the id, descending", async () => {
        // Divergences 2 and 3. `created_at` alone is NOT a total order and this table's stamps
        // collide readily — a send loop captures many rows inside one millisecond — so neither
        // arm's page boundary was reproducible. The three tied ids below are seeded in
        // ASCENDING order, which is the order the deleted SQLite arm returned them in.
        const store = makeStore();
        seedCapture("sbx-a", stamp(2), { subject: "tie a" });
        seedCapture("sbx-b", stamp(2), { subject: "tie b" });
        seedCapture("sbx-c", stamp(2), { subject: "tie c" });
        seedCapture("sbx-newest", stamp(3), { subject: "newest" });
        seedCapture("sbx-oldest", stamp(1), { subject: "oldest" });

        expect((await listSandboxEmails(undefined, 50, 0, store)).map((email) => email.id)).toEqual([
          "sbx-newest",
          "sbx-c",
          "sbx-b",
          "sbx-a",
          "sbx-oldest",
        ]);
      });

      it("windows the whole ordered listing rather than a store page", async () => {
        const store = makeStore();
        for (let index = 0; index < 5; index += 1) seedCapture(`sbx-${index}`, stamp(index));

        expect((await listSandboxEmails(undefined, 2, 0, store)).map((email) => email.id))
          .toEqual(["sbx-4", "sbx-3"]);
        expect((await listSandboxEmails(undefined, 2, 2, store)).map((email) => email.id))
          .toEqual(["sbx-2", "sbx-1"]);
        expect((await listSandboxEmails(undefined, 2, 4, store)).map((email) => email.id))
          .toEqual(["sbx-0"]);
      });

      it("clamps a negative limit to one row and a negative offset to the start", async () => {
        const store = makeStore();
        for (let index = 0; index < 3; index += 1) seedCapture(`sbx-${index}`, stamp(index));

        expect((await listSandboxEmails(undefined, -5, -10, store)).map((email) => email.id))
          .toEqual(["sbx-2"]);
      });

      it("drops the two bodies and the header map from a summary and keeps everything else", async () => {
        const store = makeStore();
        const written = await storeSandboxEmail(
          input({
            subject: "Large summary",
            html: `<p>${"large html ".repeat(200)}</p>`,
            text_body: "large body ".repeat(200),
            headers: { "x-large": "header" },
          }),
          store,
        );

        const [summary] = await listSandboxEmailSummaries(P1, 1, 0, store);

        expect(summary?.id).toBe(written.id);
        expect(summary?.subject).toBe("Large summary");
        expect(summary?.to_addresses).toEqual(["b@b.com"]);
        expect(summary?.created_at).toBe(written.created_at);
        expect("html" in summary!).toBe(false);
        expect("text_body" in summary!).toBe(false);
        expect("headers" in summary!).toBe(false);
      });

      it("a row that cannot be read breaks ONLY the page that contains it", async () => {
        // The defect this replaces: an earlier version mapped the WHOLE filtered set before
        // cutting the window, so one unreadable row made every listing throw — including pages
        // that did not contain it — and the only remedy the module offered was deleting all
        // captured mail. Adversarial review measured it. The ordering keys are still validated
        // over the whole set, because a row that cannot be placed really does break the order
        // of everything around it; nothing else is.
        const store = makeStore();
        seedCapture("sbx-good-old", stamp(1), { subject: "readable, older" });
        seedCapture("sbx-broken", stamp(2), { to_addresses: "not-json" });
        seedCapture("sbx-good-new", stamp(3), { subject: "readable, newer" });

        // Pages that avoid the broken row answer normally...
        expect((await listSandboxEmails(undefined, 1, 0, store)).map((email) => email.subject))
          .toEqual(["readable, newer"]);
        expect((await listSandboxEmails(undefined, 1, 2, store)).map((email) => email.subject))
          .toEqual(["readable, older"]);

        // ...and the page that DOES contain it faults, naming the row.
        const error = await rejection(listSandboxEmails(undefined, 1, 1, store));
        expect(error.message).toContain("sbx-broken");
        expect(error.message).toContain("to_addresses");
      });

      it("FAULTS the WHOLE listing on a row that cannot be ordered, unlike one that cannot be read", async () => {
        // The other half of the split above, and the reason it is a split rather than a
        // blanket relaxation: a row with no readable `created_at` cannot be PLACED, and ''
        // sorts before every real instant — so admitting it would silently report it as the
        // oldest capture and shift every page boundary around it. That breaks the order of
        // rows it does not contain, which an unreadable body does not.
        const store = makeStore();
        seedCapture("sbx-ok-1", stamp(1));
        seedCapture("sbx-ok-2", stamp(2));
        seedCapture("sbx-unplaceable", "");

        // Even the page that holds only readable rows refuses, and that is deliberate.
        const error = await rejection(listSandboxEmails(undefined, 1, 0, store));
        expect(error.message).toContain("sbx-unplaceable");
        expect(error.message).toContain("created_at");

        // CONTROL: with that row gone the same page answers, so the fault is about the row
        // and not about the fixture.
        expect(await clearSandboxEmails(undefined, store)).toBe(3);
        seedCapture("sbx-ok-3", stamp(3));
        expect((await listSandboxEmails(undefined, 1, 0, store)).map((email) => email.id))
          .toEqual(["sbx-ok-3"]);
      });

      it("windows summaries by the same order as the full listing", async () => {
        const store = makeStore();
        for (let index = 0; index < 4; index += 1) seedCapture(`sbx-${index}`, stamp(index));

        expect((await listSandboxEmailSummaries(undefined, 2, 1, store)).map((row) => row.id))
          .toEqual(["sbx-2", "sbx-1"]);
      });
    });

    describe("getSandboxEmail", () => {
      it("reads one capture back by id", async () => {
        const store = makeStore();
        const stored = await storeSandboxEmail(input({ subject: "Find me", text_body: null }), store);

        const found = await getSandboxEmail(stored.id, store);
        expect(found?.id).toBe(stored.id);
        expect(found?.subject).toBe("Find me");
        expect(found?.text_body).toBeNull();
      });

      it("answers null for an id no row has", async () => {
        expect(await getSandboxEmail("nonexistent-id", makeStore())).toBeNull();
      });

      it("answers null for a BLANK id, decided at the seam", async () => {
        // A blank id is absence, and that answer now belongs to the SEAM on both arms:
        // the SQLite arm's `WHERE id = ''` matches nothing, and the HTTP arm answers
        // null BEFORE building a request — `GET /v1/sandbox-emails/` is the LIST route
        // in disguise once the service strips the trailing slash, and it is never sent.
        // The hand-written caller guard this module carried is retired for that reason,
        // the same way the alias/group/template readers were handled.
        const store = makeStore();
        seedCapture("sbx-present", stamp(1));

        expect(await getSandboxEmail("", store)).toBeNull();
        // And the control: the seam still answers a real id, so null above is the
        // blank-id decision and not a broken reader.
        expect((await getSandboxEmail("sbx-present", store))?.id).toBe("sbx-present");
      });

      it("FAULTS on a recipient list that is not readable JSON rather than reporting none", async () => {
        // Divergence 7, and the one place this collapse follows NEITHER arm. The SQLite arm's
        // helper answered `[]` — every recipient silently dropped — and the second arm's
        // answered `[<the raw text>]`, inventing a recipient that was never addressed.
        const store = makeStore();
        seedCapture("sbx-bad-to", stamp(1), { to_addresses: "not-json" });

        const error = await rejection(getSandboxEmail("sbx-bad-to", store));
        expect(error.message).toContain("sbx-bad-to");
        expect(error.message).toContain("to_addresses");
      });

      it("INHERITED DEFECT: an unreadable header map or attachment list is reported as EMPTY", async () => {
        // BOTH DELETED ARMS ANSWERED `{}` AND `[]` HERE — `parseJsonObject`/`parseJsonArray`
        // locally and `cobj`/`carray` remotely agree on every one of these inputs — so there is
        // no divergence to resolve and this module preserves the behaviour, fabrication and
        // all. An earlier version of this file FAULTED on all of them, which is a product
        // decision dressed as a collapse; adversarial review measured the two arms and caught
        // it. Pinned in both directions so nobody changes it silently either way, and named a
        // defect so nobody mistakes it for a decision.
        const store = makeStore();
        seedCapture("sbx-bad-headers", stamp(1), { headers_json: "not-json" });
        seedCapture("sbx-bad-att", stamp(2), { attachments_json: '{"not":"a list"}' });
        seedCapture("sbx-list-headers", stamp(3), { headers_json: '["x-not", "a-map"]' });

        expect((await getSandboxEmail("sbx-bad-headers", store))?.headers).toEqual({});
        expect((await getSandboxEmail("sbx-bad-att", store))?.attachments).toEqual([]);
        expect((await getSandboxEmail("sbx-list-headers", store))?.headers).toEqual({});
      });

      it("INHERITED DEFECT: an EMPTY recipient column is reported as no recipients", async () => {
        // `''` is not JSON, but both arms answered `[]` for it (`parseJsonArray` short-circuits
        // on a falsy string; `cstrArray` requires `v.trim()`), so it is preserved. Only a
        // NON-EMPTY string that does not parse is a fault — that is the one input the two arms
        // answered differently.
        const store = makeStore();
        seedCapture("sbx-empty-to", stamp(1), { to_addresses: "" });

        expect((await getSandboxEmail("sbx-empty-to", store))?.to_addresses).toEqual([]);
      });

      it("FAULTS on a recipient list whose entries are not text", async () => {
        // A well-formed JSON array is not automatically a list of recipients. Both deleted
        // mappers took the entries as given — one through an unchecked cast, one by coercing
        // each entry with `String(...)`, which turns the number 42 into the address "42".
        const store = makeStore();
        seedCapture("sbx-numeric-to", stamp(1), { to_addresses: "[1, 2]" });

        const error = await rejection(getSandboxEmail("sbx-numeric-to", store));
        expect(error.message).toContain("to_addresses");
        expect(error.message).toContain("number");
      });

      it("still reads a row carrying the OLD SQLite timestamp format", async () => {
        // The positive control for the format change: divergence 6 changes what this module
        // WRITES and must not change what it can READ. A row written by an older version is
        // still a capture.
        const store = makeStore();
        seedCapture("sbx-legacy", "2026-01-01 00:00:00", { subject: "legacy stamp" });

        const found = await getSandboxEmail("sbx-legacy", store);
        expect(found?.created_at).toBe("2026-01-01 00:00:00");
        expect(found?.subject).toBe("legacy stamp");
      });
    });

    describe("clearSandboxEmails", () => {
      it("deletes every capture and reports how many", async () => {
        const store = makeStore();
        await storeSandboxEmail(input({ subject: "S1" }), store);
        await storeSandboxEmail(input({ subject: "S2" }), store);

        expect(await clearSandboxEmails(undefined, store)).toBe(2);
        expect(tableRows()).toHaveLength(0);
      });

      it("deletes only the named provider's captures and LEAVES the others in the table", async () => {
        const store = makeStore();
        await storeSandboxEmail(input({ provider_id: P1, subject: "P1 Email" }), store);
        await storeSandboxEmail(input({ provider_id: P2, subject: "P2 Email" }), store);

        expect(await clearSandboxEmails(P1, store)).toBe(1);

        const remaining = tableRows();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!["provider_id"]).toBe(P2);
        expect(remaining[0]!["subject"]).toBe("P2 Email");
      });

      it("reports zero when there is nothing to delete", async () => {
        expect(await clearSandboxEmails(undefined, makeStore())).toBe(0);
      });

      it("deletes a capture whose stored JSON cannot be read", async () => {
        // The read path faults on this row (above). The clear path deliberately does NOT map,
        // so a corrupt row stays recoverable — the trap `src/db/aliases.ts` fell into, where a
        // row its own writer had committed became permanently un-deletable.
        const store = makeStore();
        seedCapture("sbx-bad-to", stamp(1), { to_addresses: "not-json" });

        expect(await clearSandboxEmails(undefined, store)).toBe(1);
        expect(tableRows()).toHaveLength(0);
      });
    });

    describe("getSandboxCount", () => {
      it("counts an empty table as zero and a written one exactly", async () => {
        const store = makeStore();
        expect(await getSandboxCount(undefined, store)).toBe(0);
        await storeSandboxEmail(input({ subject: "S1" }), store);
        await storeSandboxEmail(input({ subject: "S2" }), store);
        expect(await getSandboxCount(undefined, store)).toBe(2);
      });

      it("counts one provider's captures", async () => {
        const store = makeStore();
        await storeSandboxEmail(input({ provider_id: P1 }), store);
        await storeSandboxEmail(input({ provider_id: P1 }), store);
        await storeSandboxEmail(input({ provider_id: P2 }), store);

        expect(await getSandboxCount(P1, store)).toBe(2);
        expect(await getSandboxCount(P2, store)).toBe(1);
      });
    });

    it(`is reachable at all through ${label}`, () => {
      // A named, trivial assertion so a variant whose store constructor throws is visible as a
      // failure of that variant rather than as a hundred identical ones.
      expect(makeStore().descriptor).toBeTruthy();
    });
  });
}

// ── the configured store, with no argument at all ───────────────────────────────────────
//
// Every case above injects a store so both variants can be driven from one file. THIS BLOCK
// INJECTS NOTHING and takes the path every production caller takes. It is also where the
// behavioural difference from the deleted implementation is visible without a fixture: the
// arguments are the ones the old signatures accepted, so the deleted arm RUNS and answers —
// differently.

describe("the configured store", () => {
  it("is resolved when no store is injected", async () => {
    const written = await storeSandboxEmail(input({ subject: "configured" }));
    expect((await getSandboxEmail(written.id))?.subject).toBe("configured");
    expect(await getSandboxCount()).toBe(1);
    expect(await clearSandboxEmails()).toBe(1);
  });

  it("PARITY: a tie on created_at comes back id-descending, as it did before", async () => {
    // THIS ONE PASSES ON UNMODIFIED MAIN AND KILLS NO MUTANT, and it is labelled so nobody
    // reads it as evidence for divergence 3. Adversarial review measured both facts. The
    // deleted SQLite arm had no tiebreaker in its SQL, but SQLite walks `idx_sandbox_created`
    // BACKWARDS for a `created_at DESC` scan, so ties came back in descending rowid order —
    // which for these three rows coincides with descending id. The old order was an accident
    // of an index rather than a guarantee, which is exactly why the tiebreaker is now
    // explicit; the case that actually PROVES it is in the store-fixture block, where the
    // store hands ties back the other way round. This one pins that the accident's outcome is
    // preserved.
    seedCapture("sbx-a", stamp(2));
    seedCapture("sbx-b", stamp(2));
    seedCapture("sbx-c", stamp(2));

    expect((await listSandboxEmails()).map((email) => email.id)).toEqual(["sbx-c", "sbx-b", "sbx-a"]);
  });

  it("FAULTS on an unreadable recipient list rather than answering that there are none", async () => {
    // Divergence 7. The deleted SQLite arm's helper answered `[]` here — every recipient
    // silently dropped, with no error and nothing in any log.
    seedCapture("sbx-bad-to", stamp(1), { to_addresses: "not-json" });

    const error = await rejection(getSandboxEmail("sbx-bad-to"));
    expect(error.message).toContain("to_addresses");
  });

  it("writes created_at as an ISO instant, not the table's own default format", async () => {
    // Divergence 6. The deleted SQLite arm omitted the column entirely, so the row took the
    // table default and carried `YYYY-MM-DD HH:MM:SS`.
    const written = await storeSandboxEmail(input());

    expect(written.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(tableRows()[0]!["created_at"]).toBe(written.created_at);
  });

  it("counts the whole table rather than one page of it", async () => {
    // 520 rows: one more than a page of 500 and then some. The deleted arm that read a single
    // page answered exactly 500 here; the one that ran `COUNT(*)` answered 520.
    for (let index = 0; index < 520; index += 1) {
      seedCapture(`sbx-${String(index).padStart(4, "0")}`, stamp(index));
    }

    expect(await getSandboxCount()).toBe(520);
  });
});

// ── beyond ONE page: the defect the deleted second arm shipped ──────────────────────────

describe("a capture table larger than one store page", () => {
  const OVER_A_PAGE = 520;

  beforeEach(() => {
    for (let index = 0; index < OVER_A_PAGE; index += 1) {
      seedCapture(`sbx-${String(index).padStart(4, "0")}`, stamp(index));
    }
  });

  it("CONTROL: one list call really does stop at 500, so the deleted arm really did miss rows", async () => {
    // Without this, every assertion below would pass against a store with no clamp at all, and
    // the claim "the deleted arm answered out of ONE clamped page" would be untested. The
    // request asks for 1000 — exactly what that arm asked for.
    for (const [, makeStore] of STORE_VARIANTS) {
      const onePage = await makeStore().sandbox.list({ limit: 1000 });
      expect(onePage.ok).toBe(true);
      if (onePage.ok) expect(onePage.value).toHaveLength(500);
    }
  });

  for (const [label, makeStore] of STORE_VARIANTS) {
    it(`counts all ${OVER_A_PAGE} rather than the 500 one page holds — ${label}`, async () => {
      expect(await getSandboxCount(undefined, makeStore())).toBe(OVER_A_PAGE);
    });

    it(`windows past the first page — ${label}`, async () => {
      const page = await listSandboxEmails(undefined, 3, 505, makeStore());
      expect(page.map((email) => email.id)).toEqual(["sbx-0014", "sbx-0013", "sbx-0012"]);
    });

    it(`deletes all ${OVER_A_PAGE} and reports that number — ${label}`, async () => {
      expect(await clearSandboxEmails(undefined, makeStore())).toBe(OVER_A_PAGE);
      expect(tableRows()).toHaveLength(0);
    });
  }
});

// ── a store that refuses, faults, truncates or ignores its filter ───────────────────────

describe("a store that cannot answer", () => {
  const REFUSAL = {
    ok: false as const,
    code: "capability_unavailable" as const,
    message: "this store does not keep captured sandbox mail",
    status: 501 as const,
  };

  function withSandbox(overrides: Partial<EmailStore["sandbox"]>): EmailStore {
    const store = sqliteStore();
    return { ...store, sandbox: { ...store.sandbox, ...overrides } };
  }

  /**
   * A store whose list IGNORES the offset, so the enumeration can never reach an empty page
   * and exhausts its budget.
   *
   * A real installation reaches the same state at ~99,800 captures, which no test can seed;
   * the mechanism under test — "the pager did not get to the end, so the rows it holds are a
   * lower bound" — is identical, and this reaches it in twenty rows.
   */
  function truncatingStore(): EmailStore {
    for (let index = 0; index < 20; index += 1) seedCapture(`sbx-t-${String(index).padStart(2, "0")}`, stamp(index));
    const base = sqliteStore();
    return {
      ...base,
      sandbox: {
        ...base.sandbox,
        list: async (opts?: ListOptions & { filters?: Record<string, string> }) =>
          base.sandbox.list({ ...opts, limit: 2, offset: 0 }),
      },
    };
  }

  it("turns a list refusal into a throw carrying the store's code, status and message", async () => {
    const store = withSandbox({ list: async () => REFUSAL });

    for (const call of [
      () => listSandboxEmails(undefined, 50, 0, store),
      () => listSandboxEmailSummaries(undefined, 50, 0, store),
      () => getSandboxCount(undefined, store),
      () => clearSandboxEmails(undefined, store),
    ]) {
      const error = await rejection(call());
      expect(error.message).toContain("capability_unavailable");
      expect(error.message).toContain("501");
      expect(error.message).toContain("this store does not keep captured sandbox mail");
    }
  });

  it("turns a list fault into a throw naming the fault", async () => {
    const store = withSandbox({
      list: async () => {
        throw new Error("connection reset");
      },
    });

    const error = await rejection(listSandboxEmails(undefined, 50, 0, store));
    expect(error.message).toContain("faulted");
    expect(error.message).toContain("connection reset");
  });

  it("turns a create refusal into a throw rather than a fabricated capture", async () => {
    const store = withSandbox({ create: async () => REFUSAL });

    const error = await rejection(storeSandboxEmail(input(), store));
    expect(error.message).toContain("capture a sandbox email");
    expect(error.message).toContain("capability_unavailable");
    expect(tableRows()).toHaveLength(0);
  });

  for (const column of ["provider_id", "from_address", "subject", "to_addresses"] as const) {
    it(`throws when the store echoes a create back with a different ${column}`, async () => {
      // The generic write path is the one place a field can be ACCEPTED AND DROPPED: the
      // service's generic route ignores a body key it has no column for. Each field is checked
      // on its own, because one fixture differing in several at once would kill the whole
      // condition while leaving every individual term deletable.
      const base = sqliteStore();
      const store: EmailStore = {
        ...base,
        sandbox: {
          ...base.sandbox,
          create: async (row: ResourceInput) => {
            const written = await base.sandbox.create(row);
            if (!written.ok) return written;
            const tampered: ResourceRow = { ...written.value };
            tampered[column] = column === "to_addresses"
              ? JSON.stringify(["elsewhere@example.com"])
              : "tampered";
            return { ok: true as const, value: tampered };
          },
        },
      };

      const error = await rejection(storeSandboxEmail(input(), store));
      expect(error.message).toContain(column);
      expect(error.message).toContain("refusing to report the capture as written");
    });
  }

  it("refuses a read it could not finish instead of answering from part of the table", async () => {
    const store = truncatingStore();

    const error = await rejection(listSandboxEmails(undefined, 50, 0, store));
    expect(error.message).toContain("LOWER BOUND");
    expect(error.message).toContain("budget ran out");
    // The number of rows it DID see is named, so an operator can tell a small table from a
    // truncated read of a large one.
    expect(error.message).toContain("2 row(s) read");
  });

  it("answers a COUNT it could not finish with null — never a lower bound and never zero", async () => {
    const store = truncatingStore();

    const counted = await getSandboxCount(undefined, store);
    expect(counted).toBeNull();
    // The two answers this replaces: `2` is what the pager actually saw, and `0` is what an
    // empty-array-on-truncation implementation would report.
    expect(counted).not.toBe(2);
    expect(counted).not.toBe(0);
  });

  it("refuses a CLEAR it could not finish and deletes NOTHING", async () => {
    const store = truncatingStore();
    const before = tableRows().length;
    expect(before).toBe(20);

    const error = await rejection(clearSandboxEmails(undefined, store));
    expect(error.message).toContain("NOTHING HAS BEEN DELETED");
    expect(tableRows()).toHaveLength(before);
  });

  it("treats a filtered read answered with another provider's rows as a fault, and deletes nothing", async () => {
    // A store that accepts an equality filter and does not apply it answers with the unfiltered
    // list — a superset presented as a filtered result. No type rules that out, and here it
    // would be destructive.
    const base = sqliteStore();
    const ignoresFilter: EmailStore = {
      ...base,
      sandbox: {
        ...base.sandbox,
        list: async (opts?: ListOptions & { filters?: Record<string, string> }) =>
          base.sandbox.list({ limit: opts?.limit, offset: opts?.offset }),
      },
    };
    seedCapture("sbx-mine", stamp(1), { provider_id: P1 });
    seedCapture("sbx-theirs", stamp(2), { provider_id: P2 });

    expect((await rejection(listSandboxEmails(P1, 50, 0, ignoresFilter))).message).toContain(P2);

    const clearError = await rejection(clearSandboxEmails(P1, ignoresFilter));
    expect(clearError.message).toContain(P2);
    expect(tableRows()).toHaveLength(2);

    // POSITIVE CONTROL: the same call over the same data on a store that DOES honour the filter
    // deletes exactly one row, so the case above is about the filter and not about a fixture
    // that could never have deleted anything.
    expect(await clearSandboxEmails(P1, base)).toBe(1);
    expect(tableRows().map((row) => row["id"])).toEqual(["sbx-theirs"]);
  });

  it("breaks a tie on the id even when the store hands ties back the OTHER way round", async () => {
    // WITHOUT THIS THE TIEBREAKER IS UNTESTED, which mutation testing established rather than
    // guessing: `Array.prototype.sort` is stable, both shipped stores already return ties in
    // descending id order, and the `/v1` fixture delegates to one of them — so deleting the
    // tiebreaker changed no answer anywhere in this file. The service's own spec orders this
    // resource `created_at DESC` with NO tiebreaker, so a real operator's Postgres may hand
    // ties back in any order at all; this store hands them back in the worst one.
    const base = sqliteStore();
    // Ordered `created_at DESC, id ASC` — the service's declared order with the tie resolved
    // the other way — and windowed from that one consistent sequence, so the pager still sees
    // a stable table. Reversing each PAGE instead would have made the window move under the
    // enumeration, which this module reports as an incomplete read rather than as an order.
    const tiesAscending: EmailStore = {
      ...base,
      sandbox: {
        ...base.sandbox,
        list: async (opts?: ListOptions & { filters?: Record<string, string> }) => {
          const all = await base.sandbox.list({ ...opts, limit: 500, offset: 0 });
          if (!all.ok) return all;
          const ordered = [...all.value].sort((left, right) => {
            const byTime = String(right["created_at"]).localeCompare(String(left["created_at"]));
            return byTime !== 0 ? byTime : String(left["id"]).localeCompare(String(right["id"]));
          });
          const start = opts?.offset ?? 0;
          return { ok: true as const, value: ordered.slice(start, start + (opts?.limit ?? 100)) };
        },
      },
    };
    seedCapture("sbx-a", stamp(2));
    seedCapture("sbx-b", stamp(2));
    seedCapture("sbx-c", stamp(2));

    // CONTROL: the store really does answer in the other order, so the assertion below is
    // about this module's sort and not about the fixture agreeing with it already.
    const raw = await tiesAscending.sandbox.list({ limit: 500 });
    expect(raw.ok && raw.value.map((row) => row["id"])).toEqual(["sbx-a", "sbx-b", "sbx-c"]);

    expect((await listSandboxEmails(undefined, 50, 0, tiesAscending)).map((email) => email.id))
      .toEqual(["sbx-c", "sbx-b", "sbx-a"]);
  });

  it("does not count a row that had already gone by the time it was deleted", async () => {
    // `remove` answers `false` for a row that is no longer there. The deleted SQLite arm
    // reported `changes`, which counted the same way; counting the attempt instead would
    // report a clear of rows another writer had already removed.
    const base = sqliteStore();
    seedCapture("sbx-1", stamp(1));
    seedCapture("sbx-2", stamp(2));
    const store: EmailStore = {
      ...base,
      sandbox: {
        ...base.sandbox,
        remove: async (id: string) => (id === "sbx-1" ? { ok: true as const, value: false } : base.sandbox.remove(id)),
      },
    };

    expect(await clearSandboxEmails(undefined, store)).toBe(1);
  });

  for (const column of ["provider_id", "subject", "reply_to", "from_address", "html"] as const) {
    it(`FAULTS on a row the store answered WITHOUT its ${column} column`, async () => {
      // Neither shipped store can produce this today — SQLite projects every column of the
      // table and the service selects them all — so it is reachable only through a store that
      // stopped projecting one, which is exactly the case where an absent column would
      // otherwise be read as "no value". Both deleted mappers did read it that way.
      const base = sqliteStore();
      seedCapture("sbx-partial", stamp(1));
      const store: EmailStore = {
        ...base,
        sandbox: {
          ...base.sandbox,
          get: async (id: string) => {
            const found = await base.sandbox.get(id);
            if (!found.ok || found.value === null) return found;
            const stripped = { ...found.value };
            delete stripped[column];
            return { ok: true as const, value: stripped };
          },
        },
      };

      const error = await rejection(getSandboxEmail("sbx-partial", store));
      expect(error.message).toContain(column);
      expect(error.message).toContain("column at all");
    });
  }

  it("FAULTS on a row whose id or created_at is present but EMPTY", async () => {
    // `NOT NULL` does not cover an empty string. A row with no id cannot be fetched or
    // deleted, and `''` as a timestamp sorts before every real instant, so it would be
    // reported as the oldest capture rather than as an unreadable one.
    const base = sqliteStore();
    seedCapture("sbx-empty-stamp", "");

    const error = await rejection(getSandboxEmail("sbx-empty-stamp", base));
    expect(error.message).toContain("created_at");
    expect(error.message).toContain("no readable");
  });

  it("names how many rows were already deleted when a removal FAULTS part way through", async () => {
    // The refusal path carried this accounting and the FAULT path did not, which adversarial
    // review measured: a locked database, a full disk or a transport reset propagated with no
    // count, so a clear that had already deleted half the table reported only the raw error.
    const base = sqliteStore();
    seedCapture("sbx-1", stamp(1));
    seedCapture("sbx-2", stamp(2));
    seedCapture("sbx-3", stamp(3));
    const store: EmailStore = {
      ...base,
      sandbox: {
        ...base.sandbox,
        remove: async (id: string) => {
          if (id === "sbx-1") throw new Error("database is locked");
          return base.sandbox.remove(id);
        },
      },
    };

    const error = await rejection(clearSandboxEmails(undefined, store));
    expect(error.message).toContain("database is locked");
    expect(error.message).toContain("2 row(s) were already deleted");
    expect(tableRows().map((row) => row["id"])).toEqual(["sbx-1"]);
  });

  it("REFUSES a legacy three-argument call that still passes a database handle", async () => {
    // The deleted signature took `Database | number` in the third slot. `safeOffset` would
    // coerce a handle to offset 0 and the call would be answered from the CONFIGURED store —
    // a plausible wrong page, possibly from a different database, with no error. TypeScript
    // callers cannot reach this; a JavaScript consumer of the published package can.
    const error = await rejection(
      listSandboxEmails(P1, 10, db as unknown as number),
    );
    expect(error.message).toContain("the OFFSET");
    expect(error.message).toContain("fourth position");
  });

  it("names how many rows were already deleted when a removal refuses part way through", async () => {
    const base = sqliteStore();
    seedCapture("sbx-1", stamp(1));
    seedCapture("sbx-2", stamp(2));
    seedCapture("sbx-3", stamp(3));
    const store: EmailStore = {
      ...base,
      sandbox: {
        ...base.sandbox,
        remove: async (id: string) => (id === "sbx-1" ? REFUSAL : base.sandbox.remove(id)),
      },
    };

    const error = await rejection(clearSandboxEmails(undefined, store));
    // Newest first, so `sbx-3` and `sbx-2` are gone before `sbx-1` refuses.
    expect(error.message).toContain("2 row(s) were already deleted");
    expect(tableRows().map((row) => row["id"])).toEqual(["sbx-1"]);
  });
});
