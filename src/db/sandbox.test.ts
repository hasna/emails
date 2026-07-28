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
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi;

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
  api.stop();
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (sandbox test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
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

      it("answers null for a BLANK id without asking the store", async () => {
        // The SQLite arm answered null (no row has an empty id). The API path would build
        // `GET /v1/sandbox-emails/`, whose trailing slash the service strips before
        // dispatching, landing on the LIST route and handing back an envelope the mapper
        // faults on. The store below throws if it is touched at all, so this asserts the
        // ABSENCE of the request and not only the shape of the answer.
        const store = makeStore();
        const refuses: EmailStore = {
          ...store,
          sandbox: {
            ...store.sandbox,
            get: async () => {
              throw new Error("the store must not be asked for a blank id");
            },
          },
        };

        expect(await getSandboxEmail("", refuses)).toBeNull();
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

      it("FAULTS on an unreadable header map rather than reporting no headers", async () => {
        const store = makeStore();
        seedCapture("sbx-bad-headers", stamp(1), { headers_json: "not-json" });

        const error = await rejection(getSandboxEmail("sbx-bad-headers", store));
        expect(error.message).toContain("sbx-bad-headers");
        expect(error.message).toContain("headers_json");
      });

      it("FAULTS on an attachment column that parses to something other than a list", async () => {
        const store = makeStore();
        seedCapture("sbx-bad-att", stamp(1), { attachments_json: '{"not":"a list"}' });

        const error = await rejection(getSandboxEmail("sbx-bad-att", store));
        expect(error.message).toContain("attachments_json");
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

describe("the configured store", () => {
  it("is resolved when no store is injected", async () => {
    // Every case above injects a store so both variants can be driven from one file. This one
    // takes the path every production caller takes, so a module that only worked with an
    // explicit argument would be caught.
    const written = await storeSandboxEmail(input({ subject: "configured" }));
    expect((await getSandboxEmail(written.id))?.subject).toBe("configured");
    expect(await getSandboxCount()).toBe(1);
    expect(await clearSandboxEmails()).toBe(1);
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
