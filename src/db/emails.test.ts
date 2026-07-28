// The outbound sent ledger has ONE implementation, and every operation reaches storage
// through the store seam.
//
// The family used to be a 29-line facade dispatching SEVEN exports to a 282-line SQLite arm
// and a 188-line `curl`-bridge arm. Twelve divergences between those two arms are recorded in
// `src/db/emails.ts`; this suite is built around the ones that could hand a caller a wrong
// answer, plus the shapes this collapse could have introduced and did not.
//
// WHAT THE FIXTURE IS AND WHY IT IS NOT THE STUB. `src/test-support/v1-stub.ts` is what both
// deleted suites drove, and it is why the deleted arm's defects were invisible: its generic
// list handler ignores equality filters, its bespoke message route did not clamp the way
// production does, and its write handler persists any key it is handed and echoes it back —
// which is exactly how an arm that POSTed `direction: "outbound"` to a route whose schema
// declares `direction: { enum: ["inbound"] }` passed. This suite uses
// `src/test-support/v1-store-api.ts`: a `/v1` service that stores NOTHING and translates every
// request into the same store seam, backed by the same in-memory database the SQLite variant
// reads. Both variants answer from ONE dataset, so a client that mis-maps a column fails here
// rather than being handed its own mistake back.
//
// EVERY BEHAVIOURAL CASE THAT CAN RUN AGAINST A STORE RUNS TWICE, once per shipped store.
//
// THE CASES THAT CARRY THE MOST WEIGHT:
//
//   * READS ANSWERED OUT OF ONE CLAMPED PAGE. `searchEmails` and `resolveEmailId` on the
//     deleted HTTP arm asked for a single page and windowed it locally; both stores and the
//     service clamp a list to 500 rows, and `src/lib/export.ts` supplies a DEFAULT limit of
//     1000. There are 600-row cases below for every read where that matters, and each carries
//     the CONTROL that one clamped page really does miss the row.
//   * THE PROVIDER FILTER, IN BOTH DIRECTIONS. No message projection on the seam carries a
//     provider, so `listEmails` REFUSES the filter. The refusal is pinned — and so is its
//     complement, because an unconditional guard turns one refused filter into a total outage
//     of the list path. That regression was written during this collapse and caught by an
//     independent reviewer rather than by a test, so `undefined`, `""` and `"   "` each get one.
//   * ONE UNREADABLE ROW MUST NOT KILL A PAGE. The row mapper faults on a status outside the
//     five and on a missing `created_at`. Mapping the whole enumerated set before windowing
//     would make one such row anywhere in the ledger take down every listing; the mapping
//     therefore runs after the window, and there is a case that seeds an unreadable row
//     OUTSIDE the window and requires the listing to succeed.
//   * THE WRITE MAY NOT ACCEPT WHAT THE READ REFUSES. `updateEmailStatus` is held to the same
//     five states the mapper accepts, because this module ships as JavaScript and the REST
//     layer casts a query parameter straight into the type.
//   * OUTBOUND SCOPE. The SQLite arm read the `emails` table (outbound by construction); the
//     HTTP arm read `/v1/messages/<id>`, which serves BOTH directions, and then coerced the
//     received row's status to `sent`. Every read here is outbound-scoped and there is a case
//     per operation, including one proving `deleteEmail` cannot destroy received mail.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database as SqliteDatabase } from "bun:sqlite";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import {
  createEmail,
  deleteEmail,
  getEmail,
  listEmails,
  resolveEmailId,
  searchEmails,
  updateEmailStatus,
} from "./emails.js";
import { createSentEmailLedger } from "../lib/sent-ledger.local.js";
import { EmailNotFoundError, type EmailStatus } from "../types/index.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { MessageListRecord, Page } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
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
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Leave exactly ONE store configured, so the cases that pass no store can resolve.
 *
 * Named through the resolution's OWN exported constants rather than copied as literals: "a
 * database path AND an API are both configured" is a HARD BOOT ERROR with no precedence rule,
 * so a stray inherited API setting turns every default-store case into that error.
 */
function configureExactlyOneStore(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

const PROVIDER = "provider-under-test";

let db: Database;
let api: V1StoreApi | null = null;

/**
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
  // `emails.provider_id` is NOT NULL with `REFERENCES providers(id)` — which is the reason the
  // seam cannot carry this table's write at all — so the provider has to exist before any
  // ledger row does.
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'ses', 1)", [PROVIDER, PROVIDER]);
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "sent ledger fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (sent ledger test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

/** An ISO instant `seconds` after a fixed epoch, so seeded order is unambiguous. */
function stamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
}

/**
 * A ledger row written STRAIGHT INTO `emails`, with an id and a `sent_at` this suite chooses.
 *
 * Seeding rather than writing through `createSentEmailLedger` for every case that needs a
 * known id, a shared timestamp to the millisecond, or a column value the writer would never
 * produce. Both store variants read this same database, so a seeded row is visible through
 * both.
 */
function seedLedger(id: string, sentAt: string, overrides: Record<string, unknown> = {}): void {
  db.run(
    `INSERT INTO emails
       (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses,
        bcc_addresses, reply_to, subject, status, has_attachments, attachment_count, tags,
        sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      PROVIDER,
      (overrides["provider_message_id"] as string | null) ?? null,
      (overrides["from_address"] as string) ?? "ops@example.com",
      (overrides["to_addresses"] as string) ?? JSON.stringify(["rcpt@example.com"]),
      (overrides["cc_addresses"] as string) ?? "[]",
      (overrides["bcc_addresses"] as string) ?? "[]",
      (overrides["reply_to"] as string | null) ?? null,
      (overrides["subject"] as string) ?? `seeded ${id}`,
      (overrides["status"] as string) ?? "sent",
      (overrides["has_attachments"] as number) ?? 0,
      (overrides["attachment_count"] as number) ?? 0,
      (overrides["tags"] as string) ?? "{}",
      sentAt,
      sentAt,
      sentAt,
    ],
  );
}

/**
 * A row in the UNIFIED table, in either direction.
 *
 * `inbound_emails` has held both directions since `is_sent` landed, and — unlike `emails`, whose
 * status column carries a CHECK — its `status` is a bare nullable TEXT. That is what makes an
 * unrecognised status a reachable state rather than a hypothetical one.
 */
function seedUnified(
  id: string,
  receivedAt: string,
  options: { sent?: boolean; status?: string | null; subject?: string; from?: string; to?: string[] } = {},
): void {
  db.run(
    `INSERT INTO inbound_emails
       (id, provider_id, from_address, to_addresses, cc_addresses, subject, text_body,
        attachments_json, headers_json, received_at, is_sent, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, 'body', '[]', '{}', ?, ?, ?, ?, ?)`,
    [
      id,
      PROVIDER,
      options.from ?? "them@example.com",
      JSON.stringify(options.to ?? ["me@example.com"]),
      options.subject ?? `unified ${id}`,
      receivedAt,
      options.sent === true ? 1 : 0,
      options.status ?? null,
      receivedAt,
      receivedAt,
    ],
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw, and it resolved");
}

/**
 * The real store with the messages repository patched — the neutering pattern the store suites
 * use. A hand-rolled partial store cast to `EmailStore` would let a signature drift without
 * `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeWithMessages(patch: Partial<EmailStore["messages"]>): EmailStore {
  const base = sqliteStore();
  return { ...base, messages: { ...base.messages, ...patch } };
}

/** A minimal list row, so a hand-built page cannot drift from the seam's shape. */
function listRow(id: string, receivedAt: string): MessageListRecord {
  return {
    id,
    direction: "outbound",
    from_addr: "ops@example.com",
    to_addrs: ["rcpt@example.com"],
    cc_addrs: [],
    subject: `row ${id}`,
    status: "sent",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: receivedAt,
    is_read: true,
    is_starred: false,
    labels: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: receivedAt,
    updated_at: receivedAt,
    snippet: null,
    attachment_count: 0,
    policy_denial: null,
  };
}

// ── behaviour, against both shipped stores ────────────────────────────────────────────────

for (const [label, makeStore] of STORE_VARIANTS) {
  describe(`sent ledger — ${label}`, () => {
    describe("listEmails", () => {
      it("returns the outbound ledger newest first", async () => {
        seedLedger("a", stamp(1));
        seedLedger("b", stamp(3));
        seedLedger("c", stamp(2));

        const rows = await listEmails({}, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["b", "c", "a"]);
      });

      it("orders rows sharing a timestamp by id, which neither deleted arm did", async () => {
        // Both arms ordered `sent_at DESC` with NO tiebreaker — one in SQL under BINARY
        // collation, the other in JavaScript with `localeCompare`. Rows written in a tight
        // loop share a millisecond, so the tie was reachable in production.
        const tie = stamp(9);
        seedLedger("id-a", tie);
        seedLedger("id-c", tie);
        seedLedger("id-b", tie);

        const rows = await listEmails({}, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["id-c", "id-b", "id-a"]);
      });

      it("publishes an empty ledger as an empty list", async () => {
        expect(await listEmails({}, makeStore())).toEqual([]);
      });

      it("reads PAST the 500-row page clamp instead of answering out of one page", async () => {
        // The measured production defect: `src/lib/export.ts` defaults `limit` to 1000, every
        // list route clamps to 500, and a 600-row ledger exported 500 rows and called it the
        // export.
        for (let index = 0; index < 600; index += 1) {
          seedLedger(`row-${String(index).padStart(4, "0")}`, stamp(index));
        }
        const store = makeStore();

        // THE CONTROL: one page really does stop at the clamp, so the assertion below is not
        // passing for some unrelated reason.
        const onePage = await store.messages.listMessages({ direction: "outbound", limit: 1000 });
        expect(onePage.ok).toBe(true);
        expect(onePage.ok && onePage.value.items.length).toBe(500);

        const rows = await listEmails({}, store);

        expect(rows).toHaveLength(600);
        expect(new Set(rows.map((row) => row.id)).size).toBe(600);
      });

      it("windows rows that lie past the clamp, where the deleted arm emitted nothing", async () => {
        for (let index = 0; index < 600; index += 1) {
          seedLedger(`row-${String(index).padStart(4, "0")}`, stamp(index));
        }

        // Newest first, so offset 550 lands on the OLDEST 50 rows — the tail a single-page read
        // could never reach.
        const rows = await listEmails({ limit: 50, offset: 550 }, makeStore());

        expect(rows).toHaveLength(50);
        expect(rows[0]?.id).toBe("row-0049");
        expect(rows[49]?.id).toBe("row-0000");
      });

      it("applies a since/until window to rows past the clamp", async () => {
        for (let index = 0; index < 600; index += 1) {
          seedLedger(`row-${String(index).padStart(4, "0")}`, stamp(index));
        }

        const rows = await listEmails({ since: stamp(0), until: stamp(9) }, makeStore());

        expect(rows.map((row) => row.id)).toEqual([
          "row-0009", "row-0008", "row-0007", "row-0006", "row-0005",
          "row-0004", "row-0003", "row-0002", "row-0001", "row-0000",
        ]);
      });

      it("filters `from_address` by canonical EQUALITY, not by the seam's substring match", async () => {
        seedLedger("exact", stamp(2), { from_address: "ops@example.com" });
        seedLedger("superstring", stamp(1), { from_address: "xops@example.com" });
        const store = makeStore();

        // THE CONTROL: the seam's own `from` filter is a substring match on both stores, so
        // pushing this filter down would have returned both rows.
        const pushedDown = await store.messages.listMessages({
          direction: "outbound",
          from: "ops@example.com",
          limit: 500,
        });
        expect(pushedDown.ok && pushedDown.value.items.map((row) => row.id).sort()).toEqual([
          "exact",
          "superstring",
        ]);

        const rows = await listEmails({ from_address: "ops@example.com" }, store);

        expect(rows.map((row) => row.id)).toEqual(["exact"]);
      });

      it("treats a BLANK sender filter as absent rather than as a filter matching nothing", async () => {
        // `--from "   "` is truthy and canonicalises to the empty string. Compared against every
        // row's real address it returns an EMPTY ledger for a filter the operator did not
        // really give — a fabricated empty. `""` was always treated as absent; `"   "` agrees.
        seedLedger("a", stamp(1), { from_address: "ops@example.com" });
        const store = makeStore();

        expect((await listEmails({ from_address: "   " }, store)).map((row) => row.id)).toEqual(["a"]);
        expect((await listEmails({ from_address: "" }, store)).map((row) => row.id)).toEqual(["a"]);
        // ...and a non-blank sender nothing matches is still a REAL empty, not an absent filter.
        expect(await listEmails({ from_address: "nobody@example.com" }, store)).toEqual([]);
      });

      it("accepts a display-name sender and compares the address inside it", async () => {
        seedLedger("exact", stamp(1), { from_address: "ops@example.com" });

        const rows = await listEmails({ from_address: "Ops Team <ops@example.com>" }, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["exact"]);
      });

      it("filters by a single status and by a status list", async () => {
        seedLedger("sent-row", stamp(1), { status: "sent" });
        seedLedger("bounced-row", stamp(2), { status: "bounced" });
        seedLedger("failed-row", stamp(3), { status: "failed" });
        const store = makeStore();

        expect((await listEmails({ status: "bounced" }, store)).map((row) => row.id)).toEqual([
          "bounced-row",
        ]);
        expect(
          (await listEmails({ status: ["bounced", "failed"] }, store)).map((row) => row.id),
        ).toEqual(["failed-row", "bounced-row"]);
      });

      it("applies `until`, which the seam's list options do not carry at all", async () => {
        seedLedger("inside", stamp(1));
        seedLedger("outside", stamp(5));

        const rows = await listEmails({ until: stamp(2) }, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["inside"]);
      });

      it("excludes received mail from the sent ledger", async () => {
        seedLedger("outbound-row", stamp(2));
        seedUnified("inbound-row", stamp(3), { sent: false });

        const rows = await listEmails({}, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["outbound-row"]);
      });

      it("includes a unified-table row marked sent", async () => {
        seedUnified("sent-unified", stamp(4), { sent: true, status: "sent" });

        const rows = await listEmails({}, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["sent-unified"]);
      });
    });

    describe("listEmails and the provider filter", () => {
      it("REFUSES a provider filter rather than ignoring it", async () => {
        seedLedger("a", stamp(1));

        const error = await rejection(listEmails({ provider_id: PROVIDER }, makeStore()));

        expect(error.message).toContain("filtered by provider");
        expect(error.message).toContain("provider_id");
      });

      // THE COMPLEMENT OF THE REFUSAL, and the reason it is three cases rather than one: an
      // unconditional guard does not refuse one filter, it takes down every read of the sent
      // ledger. That is what an early draft of this collapse shipped — every `/api/emails*`
      // route answered 500, including requests naming no provider at all — and it was found by
      // an independent reviewer rather than by a test, so it gets tests.
      for (const [what, value] of [
        ["absent", undefined],
        ["empty", ""],
        ["blank", "   "],
      ] as ReadonlyArray<[string, string | undefined]>) {
        it(`still reads the ledger when the provider filter is ${what}`, async () => {
          seedLedger("a", stamp(1));

          const rows = await listEmails({ provider_id: value }, makeStore());

          expect(rows.map((row) => row.id)).toEqual(["a"]);
        });
      }
    });

    describe("searchEmails", () => {
      it("matches subject, sender and recipients, case-insensitively", async () => {
        seedLedger("by-subject", stamp(1), { subject: "Quarterly REPORT" });
        seedLedger("by-sender", stamp(2), { from_address: "report@example.com", subject: "hello" });
        seedLedger("by-recipient", stamp(3), {
          subject: "hello",
          to_addresses: JSON.stringify(["report@corp.example"]),
        });
        seedLedger("no-match", stamp(4), { subject: "unrelated" });

        const rows = await searchEmails("report", undefined, makeStore());

        expect(rows.map((row) => row.id).sort()).toEqual(["by-recipient", "by-sender", "by-subject"]);
      });

      it("does NOT match a message body, which the seam's own search does", async () => {
        // Divergence 11: both deleted arms matched three fields. The seam's `search` matches
        // more, and matches a DIFFERENT more on each store, so pushing it down would make the
        // result set depend on which store answered.
        seedUnified("body-only", stamp(1), { sent: true, status: "sent", subject: "nothing here" });
        db.run("UPDATE inbound_emails SET text_body = 'needle in the body' WHERE id = 'body-only'");
        const store = makeStore();

        // THE CONTROL: the seam does find it.
        const pushedDown = await store.messages.listMessages({
          direction: "outbound",
          search: "needle",
          limit: 500,
        });
        expect(pushedDown.ok && pushedDown.value.items.map((row) => row.id)).toEqual(["body-only"]);

        expect(await searchEmails("needle", undefined, store)).toEqual([]);
      });

      it("finds a match that lies past the 500-row clamp", async () => {
        for (let index = 0; index < 600; index += 1) {
          seedLedger(`row-${String(index).padStart(4, "0")}`, stamp(index), {
            subject: index === 3 ? "the needle" : `row ${index}`,
          });
        }
        const store = makeStore();

        // THE CONTROL: newest-first, so the needle at index 3 is near the END of the stream and
        // one clamped page cannot see it.
        const onePage = await store.messages.listMessages({ direction: "outbound", limit: 1000 });
        expect(onePage.ok && onePage.value.items.some((row) => row.id === "row-0003")).toBe(false);

        const rows = await searchEmails("needle", undefined, store);

        expect(rows.map((row) => row.id)).toEqual(["row-0003"]);
      });

      it("applies `since` and windows the survivors", async () => {
        seedLedger("old", stamp(1), { subject: "needle old" });
        seedLedger("new", stamp(9), { subject: "needle new" });

        expect(
          (await searchEmails("needle", { since: stamp(5) }, makeStore())).map((row) => row.id),
        ).toEqual(["new"]);
        expect(
          (await searchEmails("needle", { limit: 1, offset: 1 }, makeStore())).map((row) => row.id),
        ).toEqual(["old"]);
      });

      it("never returns received mail", async () => {
        seedUnified("inbound-needle", stamp(1), { sent: false, subject: "needle" });

        expect(await searchEmails("needle", undefined, makeStore())).toEqual([]);
      });
    });

    describe("getEmail", () => {
      it("reads one sent email", async () => {
        seedLedger("target", stamp(2), { subject: "hello", provider_message_id: "pm-1" });

        const email = await getEmail("target", makeStore());

        expect(email).not.toBeNull();
        expect(email?.subject).toBe("hello");
        expect(email?.provider_message_id).toBe("pm-1");
        expect(email?.sent_at).toBe(stamp(2));
        expect(email?.status).toBe("sent");
      });

      it("answers null for a received message rather than calling it sent", async () => {
        // Divergence 8. The deleted HTTP arm read `/v1/messages/<id>` in BOTH directions and
        // then coerced the received row's status to `sent`, so `emails log show <inbound-id>`
        // printed an inbound message as an outbound one.
        seedUnified("received", stamp(1), { sent: false, status: "received" });
        const store = makeStore();

        // THE CONTROL: the row exists and the seam serves it.
        const raw = await store.messages.getMessage("received");
        expect(raw.ok && raw.value?.id).toBe("received");

        expect(await getEmail("received", store)).toBeNull();
      });

      it("answers null for an id nothing holds, and for a blank id", async () => {
        const store = makeStore();
        expect(await getEmail("no-such-id", store)).toBeNull();
        // The two stores disagree about an empty id — SQLite matches no row, the API store puts
        // an empty segment on the path — so it is answered before either is asked.
        expect(await getEmail("", store)).toBeNull();
        expect(await getEmail("   ", store)).toBeNull();
      });

      it("reports the fields the seam does not publish as null, not as empty", async () => {
        // Divergence 2. The deleted HTTP arm filled these with `"self_hosted"`, `[]` and `{}` —
        // three comfortable values indistinguishable from three real ones. The columns below
        // are POPULATED in the table, which is the point: the seam does not project them, so
        // this family cannot see them and must not pretend the absence is an emptiness.
        seedLedger("rich", stamp(1), {
          bcc_addresses: JSON.stringify(["hidden@example.com"]),
          reply_to: "replies@example.com",
          tags: JSON.stringify({ campaign: "spring" }),
        });

        const email = await getEmail("rich", makeStore());

        expect(email?.provider_id).toBeNull();
        expect(email?.bcc_addresses).toBeNull();
        expect(email?.tags).toBeNull();
      });

      it("never surfaces an idempotency key", async () => {
        seedLedger("keyed", stamp(1));
        db.run("UPDATE emails SET idempotency_key = 'k-1' WHERE id = 'keyed'");

        const email = await getEmail("keyed", makeStore());

        expect(email).not.toBeNull();
        expect(email?.idempotency_key ?? null).toBeNull();
      });

      // THE SELF-HOSTED SERVICE'S OWN SEND STATES, which are NOT the local ledger's five.
      //
      // `messages.status` is `TEXT NOT NULL DEFAULT 'queued'` on the service
      // (src/server/self-hosted/migrations.ts) and its send path writes `queued` on every
      // reservation and re-arm, `blocked` on a policy refusal and `uncertain` when a provider
      // call's outcome could not be established (src/server/self-hosted/store.ts). A read that
      // refused those would take `emails log list`, the export and `GET /api/emails` down on
      // every reserved-but-unsent message — the rows an operator most wants to see. This is a
      // schema divergence the TypeScript types cannot show (`MessageRecord.status` is a bare
      // string), and the first draft of this collapse would have shipped the fault.
      for (const state of ["queued", "blocked", "uncertain"] as const) {
        it(`reads a message the service left in '${state}' instead of faulting`, async () => {
          seedUnified("service-state", stamp(1), { sent: true, status: state });

          const email = await getEmail("service-state", makeStore());

          expect(email).not.toBeNull();
          expect(email?.status).toBe(state);
          expect((await listEmails({}, makeStore())).map((row) => row.id)).toEqual(["service-state"]);
        });
      }

      it("FAULTS on a status outside the five rather than reporting it as sent", async () => {
        // Divergence 5. `inbound_emails.status` has no CHECK constraint, so an arbitrary value
        // is reachable — and `delivered-maybe` is one NEITHER store produces, which is what
        // makes it the right probe now that the service's own `queued`, `blocked` and
        // `uncertain` are legal reads.
        seedUnified("odd", stamp(1), { sent: true, status: "delivered-maybe" });

        const error = await rejection(getEmail("odd", makeStore()));

        expect(error.message).toContain("delivered-maybe");
        expect(error.message).toContain("refusing to report it as sent");
      });
    });

    describe("resolveEmailId", () => {
      it("confirms a full-length id that names a sent email", async () => {
        const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        seedLedger(id, stamp(1));

        expect(await resolveEmailId(id, makeStore())).toBe(id);
      });

      it("answers null for a full-length id that names a received message", async () => {
        const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        seedUnified(id, stamp(1), { sent: false });

        expect(await resolveEmailId(id, makeStore())).toBeNull();
      });

      it("resolves a unique prefix", async () => {
        seedLedger("abc123", stamp(1));
        seedLedger("zzz999", stamp(2));

        expect(await resolveEmailId("abc", makeStore())).toBe("abc123");
      });

      it("resolves a prefix whose only match lies past the 500-row clamp", async () => {
        for (let index = 0; index < 600; index += 1) {
          seedLedger(`row-${String(index).padStart(4, "0")}`, stamp(index + 1));
        }
        seedLedger("needle-row", stamp(0));
        const store = makeStore();

        // THE CONTROL: `stamp(0)` is the oldest instant, so newest-first the needle is at the
        // very end of the stream and one clamped page cannot see it.
        const onePage = await store.messages.listMessages({ direction: "outbound", limit: 1000 });
        expect(onePage.ok && onePage.value.items.some((row) => row.id === "needle-row")).toBe(false);

        expect(await resolveEmailId("needle", store)).toBe("needle-row");
      });

      it("THROWS on an ambiguous prefix instead of reporting it as not found", async () => {
        // Divergence 9. Both arms answered null for "no such id" AND for "your prefix matched
        // several", and both callers print `Email not found` — so an operator with two matching
        // sends was told the message did not exist.
        seedLedger("dup-1", stamp(1));
        seedLedger("dup-2", stamp(2));

        const error = await rejection(resolveEmailId("dup", makeStore()));

        expect(error.message).toContain("Ambiguous sent email id 'dup'");
        expect(error.message).toContain("dup-1");
        expect(error.message).toContain("dup-2");
      });

      it("answers null for a prefix nothing matches, and for a blank id", async () => {
        seedLedger("abc123", stamp(1));
        const store = makeStore();

        expect(await resolveEmailId("zzz", store)).toBeNull();
        expect(await resolveEmailId("   ", store)).toBeNull();
      });

      it("does not resolve a prefix that only matches received mail", async () => {
        seedUnified("inbound-prefix", stamp(1), { sent: false });

        expect(await resolveEmailId("inbound", makeStore())).toBeNull();
      });
    });

    describe("updateEmailStatus", () => {
      it("moves a sent email to a new delivery state and reports the stored row", async () => {
        seedLedger("target", stamp(1), { status: "sent" });
        const store = makeStore();

        const updated = await updateEmailStatus("target", "delivered", store);

        expect(updated.status).toBe("delivered");
        expect((await getEmail("target", store))?.status).toBe("delivered");
      });

      it("throws EmailNotFoundError for an id nothing holds", async () => {
        await expect(updateEmailStatus("missing", "delivered", makeStore())).rejects.toBeInstanceOf(
          EmailNotFoundError,
        );
      });

      it("throws EmailNotFoundError for a received message rather than writing to it", async () => {
        seedUnified("received", stamp(1), { sent: false, status: "received" });
        const store = makeStore();

        await expect(updateEmailStatus("received", "delivered", store)).rejects.toBeInstanceOf(
          EmailNotFoundError,
        );
        const raw = await store.messages.getMessage("received");
        expect(raw.ok && raw.value?.status).toBe("received");
      });

      it("REFUSES a service-only state the local ledger's CHECK cannot hold", async () => {
        // The inverse of the split below, and deliberate: the READ accepts every state a store
        // can produce (eight) and the WRITE accepts every state both stores can accept (five).
        // `queued` is readable and unwritable, because writing it to the local `emails` table
        // violates that table's CHECK constraint.
        seedLedger("target", stamp(1), { status: "sent" });
        const store = makeStore();

        const error = await rejection(updateEmailStatus("target", "queued", store));

        expect(error).not.toBeInstanceOf(EmailNotFoundError);
        expect(error.message).toContain("queued");
        expect((await getEmail("target", store))?.status).toBe("sent");
      });

      it("REFUSES a status the read would not accept, and leaves the row alone", async () => {
        // The accept-on-write / refuse-on-read split. `EmailStatus` constrains a TypeScript
        // caller and nothing else: this module ships as JavaScript and
        // `src/server/routes/core.ts` casts a query parameter straight into the type.
        seedLedger("target", stamp(1), { status: "sent" });
        const store = makeStore();

        const error = await rejection(updateEmailStatus("target", "queued" as EmailStatus, store));

        expect(error).not.toBeInstanceOf(EmailNotFoundError);
        expect(error.message).toContain("queued");
        expect((await getEmail("target", store))?.status).toBe("sent");
      });
    });

    describe("deleteEmail", () => {
      it("deletes a sent email and reports it", async () => {
        seedLedger("target", stamp(1));
        const store = makeStore();

        expect(await deleteEmail("target", store)).toBe(true);
        expect(await getEmail("target", store)).toBeNull();
      });

      it("answers false for an id nothing holds", async () => {
        expect(await deleteEmail("missing", makeStore())).toBe(false);
      });

      it("REFUSES to destroy received mail, and the row survives", async () => {
        seedUnified("received", stamp(1), { sent: false, status: "received" });
        const store = makeStore();

        expect(await deleteEmail("received", store)).toBe(false);

        const raw = await store.messages.getMessage("received");
        expect(raw.ok && raw.value?.id).toBe("received");
      });
    });

    describe("one unreadable row must not take down a page", () => {
      it("lists a window that excludes an unreadable row", async () => {
        // The mapper faults on a status outside the five. Mapping the whole enumerated set
        // before windowing would make that one row take down every listing in the ledger,
        // including listings that would never have shown it.
        seedLedger("readable-new", stamp(9));
        seedUnified("unreadable-old", stamp(1), { sent: true, status: "delivered-maybe" });

        const rows = await listEmails({ limit: 1 }, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["readable-new"]);
      });

      it("still faults when the unreadable row is INSIDE the window", async () => {
        seedLedger("readable-new", stamp(9));
        seedUnified("unreadable-old", stamp(1), { sent: true, status: "delivered-maybe" });

        const error = await rejection(listEmails({}, makeStore()));

        expect(error.message).toContain("unreadable-old");
        expect(error.message).toContain("delivered-maybe");
      });

      it("excludes an unreadable row that merely fails a filter, without faulting", async () => {
        // The filter runs on the RAW record, so a row whose status this family cannot present
        // is excluded by a status filter rather than faulting the whole read.
        seedLedger("kept", stamp(9), { status: "delivered" });
        seedUnified("odd", stamp(1), { sent: true, status: "delivered-maybe" });

        const rows = await listEmails({ status: "delivered" }, makeStore());

        expect(rows.map((row) => row.id)).toEqual(["kept"]);
      });

      it("faults on a row a date window cannot place, rather than dropping it", async () => {
        seedUnified("undateable", stamp(1), { sent: true, status: "sent" });
        db.run("UPDATE inbound_emails SET received_at = '', created_at = '' WHERE id = 'undateable'");

        const error = await rejection(listEmails({ since: stamp(0) }, makeStore()));

        expect(error.message).toContain("undateable");
        expect(error.message).toContain("refusing to drop it silently");
      });
    });
  });
}

// ── refusals and faults, driven through a patched store, so they run once ─────────────────

describe("the sent ledger refuses what it cannot answer", () => {
  it("createEmail refuses by name and writes nothing", async () => {
    const error = await rejection(
      createEmail(PROVIDER, { from: "ops@example.com", to: ["a@b.com"], subject: "s" }),
    );

    expect(error.message).toContain("not available through the store seam");
    expect(error.message).toContain("createSentEmailLedger");
    expect(db.query("SELECT COUNT(*) AS n FROM emails").get()).toEqual({ n: 0 });
  });

  it("turns a store refusal into a thrown error naming the operation and the code", async () => {
    const store = storeWithMessages({
      listMessages: async () => ({
        ok: false,
        code: "capability_unavailable",
        message: "keysetPagination is unavailable",
        status: 501,
      }),
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("list the sent ledger");
    expect(error.message).toContain("capability_unavailable");
    expect(error.message).toContain("501");
  });

  it("refuses rather than truncating when the page budget runs out", async () => {
    // A store that never reports a last page. `Email[]` has nowhere to record "this is a lower
    // bound", and `src/lib/export.ts` writes the array to a file, so the only honest answer is
    // to refuse.
    let served = 0;
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => {
        served += 1;
        return {
          ok: true,
          value: {
            items: [listRow(`endless-${served}`, stamp(served))],
            next_cursor: `cursor-${served}`,
          },
        };
      },
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("incomplete read of the sent ledger");
    expect(error.message).toContain("200-page budget");
    expect(served).toBe(200);
  });

  it("refuses when the store repeats a row, which proves its page order is not total", async () => {
    let served = 0;
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => {
        served += 1;
        return {
          ok: true,
          value: {
            items: [listRow("same-row", stamp(1))],
            next_cursor: served >= 2 ? null : "cursor-1",
          },
        };
      },
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("returned 1 row(s) twice");
    expect(error.message).toContain("other rows were skipped");
  });

  it("refuses when the store hands back a cursor it cannot advance past", async () => {
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
        ok: true,
        value: { items: [], next_cursor: "stuck" },
      }),
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("cursor it could not advance past");
  });

  it("reports a transport fault rather than an empty ledger", async () => {
    // `rows` is `[]` for THREE different reasons — the stream is empty, the store refused, or
    // the read threw — and only the first of them is an empty ledger. A thrown fault reported
    // as `[]` is what `src/lib/export.ts` would write to a file and `src/lib/warming.ts` would
    // count against a daily send cap, so a broken connection would RAISE the cap.
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => {
        throw new Error("connection reset by peer");
      },
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("failed while reading the sent ledger");
    expect(error.message).toContain("connection reset by peer");
  });

  it("FAULTS on a row with no created_at rather than dating it to now", async () => {
    // Divergence 6. The deleted HTTP arm read every timestamp through a coercion answering
    // `new Date().toISOString()` for a MISSING value, so a row whose timestamp could not be
    // read was reported as having been sent at the moment it was read.
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
        ok: true,
        value: {
          items: [{ ...listRow("dateless", stamp(1)), received_at: null, created_at: "" }],
          next_cursor: null,
        },
      }),
    });

    const error = await rejection(listEmails({}, store));

    expect(error.message).toContain("dateless");
    expect(error.message).toContain("no created_at");
  });

  // THE `id` TIEBREAKER IS LOAD-BEARING AND NEITHER REAL STORE CAN SHOW IT.
  //
  // Mutation testing removed `|| compareText(b.id, a.id)` from the comparator and all 100
  // cases stayed green, including the one above that seeds three ledger rows on one
  // timestamp. The reason is not that the term is dead: both store variants already serve a
  // tie in id-DESCENDING order (`src/store-sqlite/messages-sql.ts`), and `Array.prototype.sort`
  // is stable, so the store's order survived the sort and happened to be the answer.
  //
  // THE SERVER ORDERS THE SAME TIE THE OTHER WAY. `src/server/self-hosted/store.ts` orders its
  // message list `id ASC` within a timestamp, so against a real service the mutant reverses
  // three rows that a caller is told are newest-first. The store below serves exactly that
  // order — a CONSISTENT TOTAL order applied before the window, so it pages cleanly and trips
  // no shift detector — which is the only fixture that can tell the two comparators apart.
  it("imposes its own total order on a tie the store serves ASCENDING", async () => {
    const tie = stamp(5);
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
        ok: true,
        value: {
          items: [listRow("id-a", tie), listRow("id-b", tie), listRow("id-c", tie)],
          next_cursor: null,
        },
      }),
    });

    expect((await listEmails({}, store)).map((row) => row.id)).toEqual(["id-c", "id-b", "id-a"]);
  });

  it("re-checks direction on the row that came back, not only in the query", async () => {
    // The push-down is the STORE's predicate. A store that widened it — or a fixture that
    // ignored the filter, which is precisely what `v1-stub.ts` does with equality filters —
    // must not be able to leak received mail into the sent ledger.
    const store = storeWithMessages({
      listMessages: async (): Promise<Outcome<Page<MessageListRecord>>> => ({
        ok: true,
        value: {
          items: [
            listRow("outbound-row", stamp(2)),
            { ...listRow("inbound-row", stamp(3)), direction: "inbound" },
          ],
          next_cursor: null,
        },
      }),
    });

    expect((await listEmails({}, store)).map((row) => row.id)).toEqual(["outbound-row"]);
  });
});

describe("the injectable accepts BOTH published shapes", () => {
  // `Database` injection is the shape this package has published for its whole 1.x life, and
  // `src/index.test.ts` compiles a synthetic consumer that uses it. Narrowing the parameter to
  // `EmailStore` is a breaking change to that surface — it was narrowed in an earlier revision
  // of this branch and the entrypoint contract test is what caught it. Both arms are pinned
  // here so neither can be dropped quietly.
  it("reads through a caller-supplied Database, scoped to that handle", async () => {
    seedLedger("by-handle", stamp(1), { subject: "handle scoped" });

    const email = await getEmail("by-handle", db);

    expect(email?.subject).toBe("handle scoped");
    expect((await listEmails({}, db)).map((row) => row.id)).toEqual(["by-handle"]);
  });

  it("reads through a caller-supplied EmailStore", async () => {
    seedLedger("by-store", stamp(1), { subject: "store scoped" });

    const email = await getEmail("by-store", sqliteStore());

    expect(email?.subject).toBe("store scoped");
  });

  it("USES the handle it was given rather than resolving the configured store", async () => {
    // THE HALF THAT MAKES THE FIRST CASE MEAN SOMETHING. A boundary that recognised a
    // `Database` and then ignored it — resolving the configured store instead — would pass
    // the case above, because in this suite the configured store IS that same database. A
    // CLOSED handle cannot be confused with a working one: if the argument were dropped, this
    // read would quietly return the seeded row instead of faulting.
    seedLedger("configured-row", stamp(1));
    const closed = new SqliteDatabase(":memory:");
    closed.close();

    await expect(listEmails({}, closed)).rejects.toThrow();
    // ...and the configured read still answers, so the fault above is about the handle rather
    // than about the suite's state.
    expect((await listEmails({}, db)).map((row) => row.id)).toEqual(["configured-row"]);
  });

  it("FAULTS on an argument that is neither, rather than silently reading the configured store", async () => {
    const error = await rejection(listEmails({}, 42 as unknown as EmailStore));

    expect(error.message).toContain("EmailStore");
    expect(error.message).toContain("Database");
  });
});

describe("the local ledger writer, which is what still records a send", () => {
  it("writes every column the seam cannot carry", async () => {
    const email = await createSentEmailLedger(
      PROVIDER,
      {
        from: "ops@example.com",
        to: ["a@b.com"],
        cc: ["c@b.com"],
        bcc: ["hidden@b.com"],
        reply_to: "replies@example.com",
        subject: "with everything",
        tags: { campaign: "spring" },
      },
      "pm-9",
      db,
    );

    expect(email.provider_id).toBe(PROVIDER);
    expect(email.bcc_addresses).toEqual(["hidden@b.com"]);
    expect(email.reply_to).toBe("replies@example.com");
    expect(email.tags).toEqual({ campaign: "spring" });
    expect(email.provider_message_id).toBe("pm-9");
    // It lands in `emails` — the table `email_content.email_id` and `events.email_id` hold
    // foreign keys into, and the one `messages.createMessage` never writes to.
    const row = db.query("SELECT id FROM emails WHERE id = ?").get(email.id) as { id: string } | null;
    expect(row?.id).toBe(email.id);
  });

  it("fences a repeat on the idempotency key both stores refuse", async () => {
    const options = {
      from: "ops@example.com",
      to: ["a@b.com"],
      subject: "forwarded",
      idempotency_key: "forward:rule-1:inbound-1",
    };

    const first = await createSentEmailLedger(PROVIDER, options, "pm-1", db);
    const second = await createSentEmailLedger(PROVIDER, options, "pm-2", db);

    expect(second.id).toBe(first.id);
    expect(db.query("SELECT COUNT(*) AS n FROM emails").get()).toEqual({ n: 1 });
  });

  it("returns the STORED row, not one assembled from its own arguments", async () => {
    // The write reads the row back rather than echoing the input, so a store that persisted
    // something else is not taken at this module's word. `idempotency_key` is the column that
    // shows the difference: the caller supplies it, the TABLE holds it, and an object built
    // from the arguments would not carry it back.
    const email = await createSentEmailLedger(
      PROVIDER,
      { from: "ops@example.com", to: ["a@b.com"], subject: "stored", idempotency_key: "fence-1" },
      undefined,
      db,
    );

    expect(email.idempotency_key).toBe("fence-1");
    const stored = db.query("SELECT idempotency_key AS key, created_at AS created FROM emails WHERE id = ?")
      .get(email.id) as { key: string; created: string } | null;
    expect(stored?.key).toBe("fence-1");
    expect(email.created_at).toBe(stored?.created);
  });

  it("is readable back through the collapsed family", async () => {
    const email = await createSentEmailLedger(
      PROVIDER,
      { from: "ops@example.com", to: ["a@b.com"], subject: "round trip" },
      undefined,
      db,
    );

    const read = await getEmail(email.id, sqliteStore());

    expect(read?.subject).toBe("round trip");
    expect(read?.from_address).toBe("ops@example.com");
    // And the fields the seam does not publish come back null through the READ even though the
    // WRITE returned them, which is the shape note in `src/types/index.ts` made concrete.
    expect(read?.provider_id).toBeNull();
    expect(email.provider_id).toBe(PROVIDER);
  });
});
