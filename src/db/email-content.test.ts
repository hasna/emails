// The email-content family has ONE implementation, and every fact it reports comes through
// the store seam.
//
// WHY THIS SUITE IS PARAMETERISED OVER BOTH STORES, and for this family it is not a
// formality. The suite it replaces ran against `src/test-support/v1-stub.ts`, whose patch
// handler is a BLIND MERGE — it persists any key it is handed and echoes it back — and on
// that fixture five `storeEmailContent` cases passed while the real service was silently
// discarding every one of those writes. A fixture more permissive than the service is how a
// no-op ships green. So every behavioural case below runs TWICE, once against a real SQLite
// store and once against a real HTTP store in front of the seam, and the assertions are
// identical.
//
// WHAT IS TESTED HARDEST, in order:
//
//  1. THE WRITE RETURNS A PROMISE AND READS BACK THE REPLACEMENT on both stores. The HTTP
//     harness uses the contract-pinned route fixture rather than the old blind-merge stub.
//  2. NULL MEANS "NO SUCH MESSAGE" AND ONLY THAT. A message that exists and carries no body
//     is a RECORD whose fields are null, not an absence. The two deleted arms disagreed about
//     this and one of them answered 404 for a real message.
//  3. A READ REFUSAL RAISES. `null`, `{}` and an empty string are the three values a read the store
//     would not answer must never be spelled as.
//  4. THE MIGRATION PATH STILL READS. Content written by the deleted arm's statement — a
//     legacy ledger row plus an `email_content` row — must still come back through the seam,
//     because that is the shape every existing installation's mail is in.
//  5. THAT TABLE STILL HAS A WRITER. The write moved to `src/lib/sent-ledger.local.ts`; a
//     collapse that dropped it would leave the table with a reader and no writer, and nothing
//     else in this suite would notice.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./database.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import type { EmailStore } from "../store/email-store.js";
import type { MessageRecord } from "../store/records.js";
import type { Outcome, Refusal } from "../store/outcome.js";
import { createProvider } from "./providers.local.js";
import { createSentEmailLedger, storeSentEmailContent } from "../lib/sent-ledger.local.js";
import {
  getEmailContent,
  storeEmailContent,
} from "./email-content.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;
export type StoreEmailContentReturnRegression =
  Assert<Equal<ReturnType<typeof storeEmailContent>, Promise<void>>>;

/**
 * Markers that appear NOWHERE else in this file or in the package.
 *
 * Their only job is the privacy assertions: a refusal is checked for the absence of this
 * exact text, and a token that could have come from anywhere would make that check
 * meaningless.
 */
const SECRET_BODY = "zzq-private-body-marker-8f3a1c";
const SECRET_HEADER_NAME = "X-Zzq-Private-Header-8f3a1c";
const SECRET_HEADER_VALUE = "zzq-private-header-value-8f3a1c";

interface SeedMessage {
  from?: string;
  to?: string[];
  subject?: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, unknown>;
}

/** One store, and the one fixture these cases need. */
interface Harness {
  readonly name: string;
  store(): EmailStore;
  /** Create a message THROUGH THIS HARNESS'S OWN STORE and return the store's id for it. */
  seedMessage(input: SeedMessage): Promise<string>;
}

let db: Database;
let api: V1StoreApi;
let INHERITED_ENV: NodeJS.ProcessEnv;

async function seedThrough(store: EmailStore, input: SeedMessage): Promise<string> {
  const created = await store.messages.createMessage({
    direction: "outbound",
    from_addr: input.from ?? "sender@example.test",
    to_addrs: input.to ?? ["recipient@example.test"],
    subject: input.subject ?? "seed",
    ...(input.text === undefined ? {} : { body_text: input.text }),
    ...(input.html === undefined ? {} : { body_html: input.html }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  if (!created.ok) throw new Error(`could not seed the message: ${created.message}`);
  return created.value.id;
}

const sqliteHarness: Harness = {
  name: "a local SQLite store",
  store: () => createSqliteEmailStore({ database: db, detail: "SQLite in-memory (email-content test)" }),
  seedMessage: (input) => seedThrough(sqliteHarness.store(), input),
};

// `src/test-support/v1-store-api.ts`, NOT `v1-stub.ts`, and for this family that choice is
// the whole point — see the header. The fixture stores nothing: it translates the service's
// real routes onto an `EmailStore`, with the route contract pinned to the server's own
// OpenAPI document, so the rows below are written THROUGH the client and read back through it.
const httpHarness: Harness = {
  name: "a real HTTP store in front of the seam",
  store: () => createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey }),
  seedMessage: (input) => seedThrough(httpHarness.store(), input),
};

beforeEach(() => {
  INHERITED_ENV = { ...process.env };
  // EXACTLY ONE store is configured for this file, and the key list comes from
  // `src/store-resolution.ts` rather than being re-spelled here, so a new setting cannot be
  // missed. Both a database path and an API configured together is a BOOT ERROR, not a
  // precedence rule, and an inherited API setting from a developer's shell would fail these
  // cases for the wrong reason.
  for (const key of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS, ...DATABASE_PATH_SETTINGS]) {
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "v1 fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_ENV);
});

const HARNESSES: readonly Harness[] = [sqliteHarness, httpHarness];

/**
 * A store that holds no message under the asked-for id and answers the RESOLVE step with
 * `refusal`. Otherwise the real store, so the reader's own paths are exercised.
 */
function resolvingStore(base: EmailStore, refusal: Refusal): EmailStore {
  return {
    ...base,
    messages: {
      ...base.messages,
      getMessage: async (): Promise<Outcome<MessageRecord | null>> => ({ ok: true, value: null }),
      resolveMessageId: async (): Promise<Outcome<{ id: string }>> => refusal,
    },
  };
}

/**
 * A store that answers the RESOLVE step and then refuses the re-read.
 *
 * The narrow case mutation testing found unasserted: a store that can resolve a prefix but
 * will not serve the row is refusing, and a reader that swallowed that would report a message
 * the caller can see as absent.
 */
function resolveThenRefuseStore(base: EmailStore, id: string): EmailStore {
  // STATEFUL, and that is the point. The FIRST read must answer "no such row" so the reader
  // falls through to the resolve step at all; only the SECOND read refuses. A fixture that
  // refused both would be caught by the first refusal check and would leave the second one
  // unasserted — which is exactly the hole this case exists to close, and the first version of
  // it had that bug.
  let reads = 0;
  return {
    ...base,
    messages: {
      ...base.messages,
      getMessage: async (): Promise<Outcome<MessageRecord | null>> => {
        reads += 1;
        if (reads === 1) return { ok: true, value: null };
        return {
          ok: false,
          code: "capability_unavailable",
          message: "this fixture store resolved the id and declines to serve the row",
          status: 501,
        };
      },
      resolveMessageId: async (): Promise<Outcome<{ id: string }>> => ({ ok: true, value: { id } }),
    },
  };
}

/** A store that records every id its single-message read is asked with. */
function observingStore(base: EmailStore, seen: string[]): EmailStore {
  return {
    ...base,
    messages: {
      ...base.messages,
      getMessage: async (id: string) => {
        seen.push(id);
        return base.messages.getMessage(id);
      },
    },
  };
}

/** A store whose single-message read refuses, and which is otherwise the real one. */
function refusingStore(base: EmailStore): EmailStore {
  return {
    ...base,
    messages: {
      ...base.messages,
      getMessage: async (): Promise<Outcome<MessageRecord | null>> => ({
        ok: false,
        code: "capability_unavailable",
        message: "this fixture store declines to read a message",
        status: 501,
      }),
    },
  };
}

for (const harness of HARNESSES) {
  describe(`getEmailContent against ${harness.name}`, () => {
    it("returns the body and the headers it was seeded with", async () => {
      const id = await harness.seedMessage({
        text: "line one\nline two",
        html: "<p>line one</p>",
        headers: { "X-Custom": "value", "X-Priority": "1" },
      });

      const content = await getEmailContent(id, harness.store());
      expect(content).not.toBeNull();
      expect(content!.email_id).toBe(id);
      expect(content!.text_body).toBe("line one\nline two");
      expect(content!.html).toBe("<p>line one</p>");
      expect(content!.headers).toMatchObject({ "X-Custom": "value", "X-Priority": "1" });
    });

    it("returns null for an id no message has", async () => {
      // A positive control first: the store must be answering reads at all, or the null below
      // proves nothing.
      const present = await harness.seedMessage({ text: "present" });
      expect((await getEmailContent(present, harness.store()))!.text_body).toBe("present");

      expect(await getEmailContent("00000000-0000-4000-8000-000000000000", harness.store())).toBeNull();
    });

    // THE STRONG DETECTOR for the null-semantics change. The deleted local arm returned null
    // here — its `SELECT` found no `email_content` row — and the deleted remote arm returned a
    // record with nulls, so the same message read as 404 on one configuration and 200 on the
    // other. A record is the answer: "this message has no body" and "there is no such message"
    // are different facts and only one of them is an absence.
    it("answers a message with no body with a RECORD, not with null", async () => {
      const id = await harness.seedMessage({ subject: "no body at all" });

      const content = await getEmailContent(id, harness.store());
      expect(content, "a message that exists must never read as absent").not.toBeNull();
      expect(content!.email_id).toBe(id);
      expect(content!.text_body).toBeNull();
      expect(content!.html).toBeNull();
      // Not asserted as `{}` — a store is free to carry server-added header keys. What must
      // hold is that it is an object rather than a null or a string.
      expect(typeof content!.headers).toBe("object");
      expect(content!.headers).not.toBeNull();
    });

    // THE ARM DIVERGENCE, ASSERTED ON BOTH STORES. The SQLite store's single-message read
    // matches the id exactly; the HTTP store's goes to a route that resolves an abbreviation
    // inside itself. The deleted arms inherited that split, so `emails show <shortid>` found a
    // body on one configuration and not the other. It is resolved toward the stronger arm, and
    // the returned `email_id` must be the store's id rather than the prefix it was asked with —
    // both deleted arms echoed the caller's argument straight back.
    it("resolves a unique id prefix and reports the full id, not the prefix", async () => {
      const id = await harness.seedMessage({ text: "resolved by prefix" });
      const prefix = id.slice(0, 8);
      expect(prefix).not.toBe(id);

      const content = await getEmailContent(prefix, harness.store());
      expect(content, "a unique prefix must resolve on BOTH stores").not.toBeNull();
      expect(content!.text_body).toBe("resolved by prefix");
      expect(content!.email_id, "the full id, never the prefix").toBe(id);
    });

    // AN AMBIGUOUS PREFIX RAISES. It must not answer null — the caller can see the messages —
    // and it must not answer the first match, which would show them somebody else's mail.
    //
    // INJECTED RATHER THAN SEEDED, and deliberately so. Two minted UUIDs share a first
    // character about one run in sixteen, so a version of this case that seeded two rows and
    // looked for a shared prefix would be VACUOUS most of the time while looking green. The
    // decision under test belongs to this family, not to a store: given the seam's
    // `ambiguous_id` refusal, does the reader raise or does it smooth it over.
    it("RAISES on an id prefix the store reports as ambiguous", async () => {
      const id = await harness.seedMessage({ text: "readable" });
      // Positive control: an unambiguous read through the same harness answers, so the raise
      // below is about the refusal and not about a broken fixture.
      expect((await getEmailContent(id, harness.store()))!.text_body).toBe("readable");

      await expect(getEmailContent("ab", resolvingStore(harness.store(), {
        ok: false,
        code: "ambiguous_id",
        message: "the id prefix ab matches more than one message",
        status: 409,
      }))).rejects.toThrow(/ambiguous_id/);
    });

    // The one refusal from the resolve step that IS an answer. A caller asked for a message and
    // there is none; that is an absence, and it is the only refusal allowed to become null.
    it("answers null when the store reports the id as not found", async () => {
      expect(await getEmailContent("nope", resolvingStore(harness.store(), {
        ok: false,
        code: "not_found",
        message: "no message matches nope",
        status: 404,
      }))).toBeNull();
    });

    // …and every other refusal from the resolve step must NOT become null.
    it("RAISES when the resolve step is refused for any other reason", async () => {
      await expect(getEmailContent("nope", resolvingStore(harness.store(), {
        ok: false,
        code: "scope_violation",
        message: "that message belongs to another tenant",
        status: 403,
      }))).rejects.toThrow(/cannot resolve a message id/i);
    });

    // The declared type widened from `Record<string, string>` to `Record<string, unknown>`
    // because both arms CAST rather than converted, and the service demonstrably puts
    // non-caller values in that map. Narrowing would have meant dropping the entry or
    // stringifying it; this asserts the value arrives intact.
    it("carries a non-string header value through without flattening it", async () => {
      const id = await harness.seedMessage({
        text: "body",
        headers: { "X-Retry-Count": 3, "X-Nested": { attempt: 1 } },
      });

      const content = await getEmailContent(id, harness.store());
      expect(content!.headers["X-Retry-Count"]).toBe(3);
      expect(content!.headers["X-Nested"]).toEqual({ attempt: 1 });
      expect(content!.headers["X-Nested"], "a structured value must not arrive as text").not.toBe("[object Object]");
    });

    // `null`, `{}` and `""` are the three answers a refused read must never be spelled as. The
    // one consumer that turns this value into an HTTP status answers 404 on null, and a store
    // that refused is not a 404.
    it("RAISES when the store refuses the read, and never returns null or an empty record", async () => {
      const id = await harness.seedMessage({ text: "readable" });
      // Positive control: the same id through the unrefusing store answers.
      expect((await getEmailContent(id, harness.store()))!.text_body).toBe("readable");

      await expect(getEmailContent(id, refusingStore(harness.store()))).rejects.toThrow(
        /cannot read a message's body/i,
      );
      await expect(getEmailContent(id, refusingStore(harness.store()))).rejects.toThrow(
        /capability_unavailable/,
      );
    });

    // Found unasserted by mutation testing. A store that resolves the id and then refuses to
    // serve the row is REFUSING, and swallowing the second refusal would report a message the
    // caller can plainly see as absent. The first refusal was covered; this one was not.
    it("RAISES when the store resolves the id and then refuses the re-read", async () => {
      const id = await harness.seedMessage({ text: "readable" });
      // Positive control: the row really is there, so the raise is about the second refusal.
      expect((await getEmailContent(id, harness.store()))!.text_body).toBe("readable");

      // The FIXTURE'S OWN TEXT, not just the shared "cannot read a message's body" prefix, which
      // `storeRefusal` also produces for the FIRST read. Without pinning which read refused, this
      // case would pass for the first read's reason and the second-read branch would be unproven
      // again — which is the same shape of hole that made the mutation stay green.
      await expect(getEmailContent("ab", resolveThenRefuseStore(harness.store(), id))).rejects.toThrow(
        /declines to serve the row/,
      );
    });

    // Also found unasserted by mutation testing: lowercasing or trimming the id passed nothing
    // in this fixture, because these ids are already lowercase UUIDs. A store's ids are OPAQUE,
    // so the reader must hand them over verbatim rather than normalising them on the way past.
    it("passes the id to the store verbatim, without trimming or case-folding it", async () => {
      const id = await harness.seedMessage({ text: "verbatim" });
      const seen: string[] = [];

      const content = await getEmailContent(id, observingStore(harness.store(), seen));
      expect(content!.text_body, "the read must still work").toBe("verbatim");
      expect(seen, "exactly one read for a full id").toEqual([id]);

      // …and a mixed-case variant must reach the store MIXED-CASE. What happens to it after that
      // belongs to the store and is deliberately NOT asserted here: SQLite's `LIKE` is
      // ASCII-case-insensitive, so its resolver really does fold `ABCD1234%` onto `abcd1234-…`,
      // while another store need not. The claim this family owns is the narrow one — the string it
      // was handed is the string it hands on — and that is all this asserts.
      const folded: string[] = [];
      const mixed = id.toUpperCase();
      expect(mixed).not.toBe(id);
      await getEmailContent(mixed, observingStore(harness.store(), folded)).catch(() => undefined);
      expect(folded[0], "the store sees what the caller wrote").toBe(mixed);
    });

    it("names no body and no header in the error it raises for a refused read", async () => {
      const id = await harness.seedMessage({
        text: SECRET_BODY,
        headers: { [SECRET_HEADER_NAME]: SECRET_HEADER_VALUE },
      });
      // POSITIVE CONTROL. Without it, the three absence assertions below would also hold for a
      // store that never held the marker in the first place.
      const readable = await getEmailContent(id, harness.store());
      expect(readable!.text_body).toBe(SECRET_BODY);
      expect(readable!.headers[SECRET_HEADER_NAME]).toBe(SECRET_HEADER_VALUE);

      let raised: unknown;
      try {
        await getEmailContent(id, refusingStore(harness.store()));
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(Error);
      const text = `${(raised as Error).message}\n${(raised as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET_BODY);
      expect(text).not.toContain(SECRET_HEADER_NAME);
      expect(text).not.toContain(SECRET_HEADER_VALUE);
    });
  });

  describe(`storeEmailContent against ${harness.name}`, () => {
    it("updates an existing message and returns only after the body and headers are readable", async () => {
      const id = await harness.seedMessage({
        text: "original",
        html: "<p>original</p>",
        headers: { Old: "yes" },
      });

      const result = storeEmailContent(id, {
        text: "replacement",
        html: "<p>replacement</p>",
        headers: { "X-Replaced": "yes" },
      }, harness.store());
      expect(typeof result.then, "the store seam is asynchronous on both arms").toBe("function");
      await result;

      const content = await getEmailContent(id, harness.store());
      expect(content).toMatchObject({
        email_id: id,
        text_body: "replacement",
        html: "<p>replacement</p>",
        headers: { "X-Replaced": "yes" },
      });
      expect(content!.headers).not.toHaveProperty("Old");
    });

    it("keeps 1.3.2 replacement semantics for omitted fields", async () => {
      const id = await harness.seedMessage({
        text: "original",
        html: "<p>original</p>",
        headers: { "X-Original": "yes" },
      });

      await storeEmailContent(id, { text: "replacement" }, harness.store());

      const content = await getEmailContent(id, harness.store());
      expect(content!.text_body).toBe("replacement");
      expect(content!.html).toBeNull();
      expect(content!.headers).toEqual({});
    });

    it("rejects a missing message instead of reporting a write that did not happen", async () => {
      const present = await harness.seedMessage({ text: "positive control" });
      await storeEmailContent(present, { text: "updated control" }, harness.store());
      expect((await getEmailContent(present, harness.store()))!.text_body).toBe("updated control");

      await expect(storeEmailContent(
        "00000000-0000-4000-8000-000000000000",
        { text: "must not be accepted" },
        harness.store(),
      )).rejects.toThrow(/no such message/i);
    });
  });
}

describe("a legacy API that returns 200 after dropping a content write", () => {
  const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";
  const ORIGINAL_MESSAGE = {
    id: MESSAGE_ID,
    direction: "outbound",
    from_addr: "sender@example.test",
    to_addrs: ["recipient@example.test"],
    cc_addrs: [],
    subject: "legacy silent drop",
    body_text: "original body",
    body_html: "<p>original body</p>",
    status: "sent",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: null,
    is_read: true,
    is_starred: false,
    labels: [],
    headers: { Original: "unchanged" },
    attachments: [],
    source_id: null,
    send_state: "sent",
    send_started_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("sends the complete replacement but rejects the unchanged 200 response without leaking it", async () => {
    let writtenBody: Record<string, unknown> | null = null;
    const store = createHttpEmailStore({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "test-credential",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(typeof input === "object" && "url" in input ? input.url : input);
        if (url.includes("/openapi.json")) return new Response("{}", { status: 404 });
        expect(init?.method).toBe("PATCH");
        writtenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ message: ORIGINAL_MESSAGE }, { status: 200 });
      },
    });

    let raised: unknown;
    try {
      await storeEmailContent(MESSAGE_ID, {
        text: SECRET_BODY,
        html: `<p>${SECRET_BODY}</p>`,
        headers: { [SECRET_HEADER_NAME]: SECRET_HEADER_VALUE },
      }, store);
    } catch (error) {
      raised = error;
    }

    // Positive control: the ordinary HTTP store really sent every new value. The failure is
    // therefore the unchanged response, not a client that omitted the fields itself.
    expect(writtenBody).toEqual({
      body_text: SECRET_BODY,
      body_html: `<p>${SECRET_BODY}</p>`,
      headers: { [SECRET_HEADER_NAME]: SECRET_HEADER_VALUE },
    });
    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toMatch(/without confirming the complete requested content replacement/);
    const errorText = `${(raised as Error).message}\n${(raised as Error).stack ?? ""}`;
    expect(errorText).not.toContain(SECRET_BODY);
    expect(errorText).not.toContain(SECRET_HEADER_NAME);
    expect(errorText).not.toContain(SECRET_HEADER_VALUE);
  });
});

// ---- a fabrication guard that would otherwise have lost its only test -----------
//
// The deleted suite asserted that a `/v1` response whose `headers` field is NOT AN OBJECT is
// rejected rather than tolerated — the local arm's JSON parser quietly produced `{}` for
// malformed input, and `{}` is a fabricated header set. That behaviour now lives one layer down,
// in the HTTP store's mapper, and adversarial review found it had **no test left anywhere in the
// repo** (`grep "non-object headers"` returned only the implementation).
//
// A FIRST ATTEMPT AT THIS WAS VACUOUS AND IS RECORDED HERE BECAUSE IT LOOKED FINE. It replaced
// `store.messages.getMessage` with a stub that threw the string `"a non-object headers map"`, and
// then asserted that string — so the mapper never ran, the assertion matched a literal the test
// itself had written three lines earlier, and both harness runs were byte-identical. It proved
// only that the reader has no `try/catch`. Adversarial review caught it. THE FIX IS TO LET THE
// MAPPER RUN: the malformed value is served over the wire by an injected `fetch`, so
// `messageRecord` really executes and really faults.

describe("a malformed header map from the service", () => {
  /**
   * A message that is COMPLETE AND VALID except for `headers`.
   *
   * Every other field is present and well-formed on purpose. A payload carrying only `headers`
   * would also fault once the guard was removed — on the missing `id` — so a test built on one
   * passes for the wrong reason and cannot tell "the header guard fired" from "some other field
   * was absent". That was true of the first version of the case below and mutation testing caught
   * it: removing the real guard left it green.
   */
  const MALFORMED = JSON.stringify({
    message: {
      id: "00000000-0000-4000-8000-000000000000",
      direction: "outbound",
      from_addr: "sender@example.test",
      to_addrs: ["recipient@example.test"],
      cc_addrs: [],
      subject: "malformed headers",
      body_text: "body",
      body_html: null,
      status: "sent",
      provider_message_id: null,
      message_id: null,
      in_reply_to: null,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: [],
      // The ONE thing wrong.
      headers: "not-json",
      attachments: [],
      source_id: null,
      send_state: "sent",
      send_started_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });

  it("faults rather than reading as an empty header set", async () => {
    let asked = 0;
    const store = createHttpEmailStore({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "test-credential",
      fetchImpl: async (input: string | URL | Request) => {
        asked += 1;
        const url = String(typeof input === "object" && "url" in input ? input.url : input);
        if (url.includes("/openapi.json")) return new Response("{}", { status: 404 });
        return new Response(MALFORMED, { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    // The REAL mapper runs and the REAL fault surfaces — `EmailsApiFault`, not a string this
    // test wrote. `{}` is the value the deleted local arm produced for exactly this input.
    const promise = getEmailContent("00000000-0000-4000-8000-000000000000", store);
    await expect(promise).rejects.toThrow(/non-object headers map/);
    // Non-vacuity: the request really was made, so the fault came from the response and not
    // from a store that declined to be built.
    expect(asked).toBeGreaterThan(0);
  });

  it("faults rather than answering null, which a caller reads as no-such-message", async () => {
    const store = createHttpEmailStore({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "test-credential",
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(typeof input === "object" && "url" in input ? input.url : input);
        if (url.includes("/openapi.json")) return new Response("{}", { status: 404 });
        return new Response(MALFORMED, { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    let settled: unknown = "did-not-settle";
    try {
      settled = await getEmailContent("00000000-0000-4000-8000-000000000000", store);
    } catch (error) {
      settled = error;
    }
    // The two values this must never be: null (no such message) and a record with `{}` headers.
    expect(settled).toBeInstanceOf(Error);
    expect(settled).not.toBeNull();
  });
});

// ---- the PUBLISHED surface ----------------------------------------------------
//
// `src/index.ts` is the package's entry point, and BOTH of this family's exports changed shape
// there. Nothing pinned either one before, which is how a published entry point changes
// silently. These cases exist so the break is a decision with a test under it rather than a
// side effect: they will fail the moment either shape moves again.

describe("the published entry point", () => {
  it("exports a getEmailContent that returns a PROMISE, and says so in a test", async () => {
    const entry = await import("../index.js");
    const returned = entry.getEmailContent("00000000-0000-4000-8000-000000000000", sqliteHarness.store());
    // A thenable, asserted directly. This is the half of the break that fails QUIETLY for a
    // consumer that does not await — `.text_body` on a promise is `undefined` and `if (content)`
    // is always truthy — so it is the half most worth pinning.
    expect(typeof (returned as Promise<unknown>).then).toBe("function");
    expect(await returned).toBeNull();
  });

  it("exports a storeEmailContent that truthfully updates and returns a promise", async () => {
    const entry = await import("../index.js");

    const id = await sqliteHarness.seedMessage({ text: "present" });
    const returned = entry.storeEmailContent(id, { text: "published write" });
    expect(typeof returned.then).toBe("function");
    await returned;
    expect((await entry.getEmailContent(id))!.text_body).toBe("published write");
  });
});

// ---- the migration path, and the table's remaining writer ---------------------
//
// SQLITE ONLY, and deliberately so: these cases are about rows in the shape every existing
// installation's mail is already in — the legacy `emails` ledger plus its `email_content`
// row — which is a property of that database and not of the seam.

describe("content written by the ledger writer, read back through the seam", () => {
  async function seedLegacyLedgerRow(subject: string): Promise<string> {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    return (await createSentEmailLedger(provider.id, {
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject,
    })).id;
  }

  // THE TEST THE COLLAPSE NEEDS MOST. `createEmail` writes the ledger row and records NO body;
  // `storeSentEmailContent` writes the body into `email_content`. The seam's SQLite message
  // stream reads that table by an outer join. If the write were dropped — the obvious
  // simplification when a family collapses — the table would have a reader and no writer, and
  // nothing else in this suite would notice.
  it("is still read after the write moved out of the deleted arm", async () => {
    const id = await seedLegacyLedgerRow("legacy ledger row");

    await storeSentEmailContent(id, {
      text: "recorded by the ledger writer",
      html: "<p>recorded by the ledger writer</p>",
      headers: { "X-Recorded-By": "sent-ledger" },
    });

    const content = await getEmailContent(id, sqliteHarness.store());
    expect(content, "a legacy ledger row must be readable").not.toBeNull();
    expect(content!.email_id).toBe(id);
    expect(content!.text_body).toBe("recorded by the ledger writer");
    expect(content!.html).toBe("<p>recorded by the ledger writer</p>");
    expect(content!.headers).toMatchObject({ "X-Recorded-By": "sent-ledger" });
  });

  it("replaces the recorded body on a second write, as the deleted arm did", async () => {
    const id = await seedLegacyLedgerRow("re-recorded");

    await storeSentEmailContent(id, { text: "first" });
    expect((await getEmailContent(id, sqliteHarness.store()))!.text_body).toBe("first");

    await storeSentEmailContent(id, { text: "second" });
    expect((await getEmailContent(id, sqliteHarness.store()))!.text_body).toBe("second");
  });

  // A ledger row whose body was never recorded reads as a RECORD with nulls, not as an absence
  // — the same rule as for a seam-created message, checked on the join that can actually
  // produce a missing right-hand side.
  it("answers an unrecorded ledger row with nulls rather than with null", async () => {
    const id = await seedLegacyLedgerRow("body never recorded");

    const content = await getEmailContent(id, sqliteHarness.store());
    expect(content, "the message exists, so this is not an absence").not.toBeNull();
    expect(content!.email_id).toBe(id);
    expect(content!.text_body).toBeNull();
    expect(content!.html).toBeNull();
  });
});
