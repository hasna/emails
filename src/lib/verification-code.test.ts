// The verification-code family has ONE implementation, and its candidate read goes
// through the store seam.
//
// The family used to be a facade over two modules. Two of its three exports were PURE —
// byte-for-byte identical in both arms — so the deployment word decided nothing about
// them except that the code-extraction regexes existed twice and were free to drift. The
// third, the candidate read, is where the arms disagreed about MEANING: one read SQLite,
// the other threw.
//
// What has to be tested hardest on this surface is the distinction between "no
// verification email has arrived" and "this installation could not be asked". Both used
// to be spellable as `[]`, and every caller polls on `[]` — the watch loop in
// `emails inbox code` and the latest-inbound tool both read it as "not yet". A store that
// refuses must therefore throw, never answer empty.
//
// The second thing tested hardest is RECIPIENT SCOPE. The seam's recipient filter is a
// substring match on both stores, and the deleted arm's was an exact equality. On a
// surface that hands back one-time codes, quietly inheriting the substring match would be
// a disclosure path, so there is an end-to-end proof that it did not happen — with a
// positive control showing the substring match really is a superset.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { type InboundEmail } from "../db/inbound.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { MessageListRecord, MessageRecord, Page } from "../store/records.js";
import {
  extractVerificationCodes,
  findVerificationCode,
  listVerificationCodeCandidates,
} from "./verification-code.js";

const libDir = import.meta.dir;
const repoRoot = join(libDir, "..", "..");

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

let db: Database;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  restoreInheritedProcessEnv();
});

/** A real store over the test database. Everything below builds on this one. */
function realStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (verification-code test)" });
}

/**
 * The real store with ONE method replaced — the neutering pattern the store suites use.
 * A hand-rolled partial store cast to `EmailStore` would let a signature drift without
 * `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeListingWith(answer: Outcome<Page<MessageListRecord>>): EmailStore {
  const base = realStore();
  return { ...base, messages: { ...base.messages, listMessages: async () => answer } };
}

function storeReadingMessageWith(answer: Outcome<MessageRecord | null>): EmailStore {
  const base = realStore();
  return { ...base, messages: { ...base.messages, getMessage: async () => answer } };
}

interface SeedInput {
  to: string[];
  from?: string;
  subject?: string;
  text?: string | null;
  html?: string | null;
  received_at?: string;
  /** `archived`, `spam` and `trash` are the folder labels the store files rows under. */
  labels?: string[];
  direction?: "inbound" | "outbound";
}

async function seedMessage(store: EmailStore, input: SeedInput): Promise<string> {
  const created = await store.messages.createMessage({
    direction: input.direction ?? "inbound",
    from_addr: input.from ?? "noreply@sender.test",
    to_addrs: input.to,
    subject: input.subject ?? "Your code",
    body_text: input.text === undefined ? "" : input.text,
    body_html: input.html ?? null,
    received_at: input.received_at ?? "2026-06-04T00:00:00.000Z",
    labels: input.labels ?? [],
  });
  if (!created.ok) throw new Error(`could not seed the message: ${created.message}`);
  return created.value.id;
}

/** The list record the real store produces for a seeded row, used as fixture data. */
async function listRecordFor(store: EmailStore, address: string): Promise<MessageListRecord> {
  const listed = await store.messages.listMessages({ direction: "inbound", to: address, limit: 10 });
  if (!listed.ok) throw new Error(`could not list the seeded rows: ${listed.message}`);
  const row = listed.value.items.find((item) => item.to_addrs.includes(address));
  if (!row) throw new Error("the seeded row was not listed; the fixture is wrong");
  return row;
}

function inboundFixture(partial: Partial<InboundEmail>): InboundEmail {
  return {
    id: partial.id ?? "id",
    provider_id: null,
    message_id: null,
    in_reply_to_email_id: null,
    provider_thread_id: null,
    thread_id: null,
    provider_history_id: null,
    provider_internal_date: null,
    label_ids: [],
    raw_s3_url: null,
    metadata_s3_url: null,
    from_address: partial.from_address ?? "noreply@example.com",
    to_addresses: partial.to_addresses ?? ["me@example.com"],
    cc_addresses: [],
    subject: partial.subject ?? "Code",
    text_body: partial.text_body ?? "",
    html_body: partial.html_body ?? null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 0,
    is_read: false,
    read_at: null,
    is_archived: false,
    is_starred: false,
    is_sent: false,
    received_at: partial.received_at ?? "2026-06-04T00:00:00.000Z",
    created_at: partial.created_at ?? "2026-06-04T00:00:00.000Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure: the arms are gone and nothing reaches past a facade.
// ─────────────────────────────────────────────────────────────────────────────

describe("the verification-code family has one implementation", () => {
  it("ships no second implementation arm beside the facade", () => {
    const siblings = [
      "verification-code.local.ts",
      "verification-code.remote.ts",
      "verification-code.local.tsx",
      "verification-code.remote.tsx",
    ];
    expect(siblings.filter((file) => existsSync(join(libDir, file)))).toEqual([]);
    // Positive control for the check itself: the detector must be able to SEE a sibling,
    // or "none present" is vacuous. `verification-code.ts` is a file in the same
    // directory and must be found by the same predicate.
    expect(existsSync(join(libDir, "verification-code.ts"))).toBe(true);
  });

  /**
   * The one implementation must not reach PAST a facade into one of its arms, and must not
   * read the deployment-mode module this program is deleting.
   *
   * "Reaches past a facade" is the hazard, and it is not the same as "imports a suffixed
   * module": a module with no facade and no second arm bypasses no dispatch. So the check
   * RESOLVES each suffixed specifier and asks whether a facade sibling exists, which is
   * the condition under which the import skips a dispatch other callers go through.
   *
   * Both predicates carry fixtures, checked against the predicate rather than against
   * repo state. A source scan that stops matching passes everything silently, and this
   * repo has already shipped that failure twice.
   */
  it("reaches past no facade into an arm, and reads no deployment-mode module", () => {
    const suffixedImport = /from\s+["'](\.[^"']*)\.(?:local|remote)\.js["']/g;
    const modeModuleImport = /from\s+["'][^"']*\/(?:self-hosted-store|mode)\.js["']/g;

    const pastFacade = (text: string, dir: string): string[] =>
      [...text.matchAll(suffixedImport)]
        .map((match) => match[1] as string)
        .filter((base) => existsSync(join(dir, `${base}.ts`)) || existsSync(join(dir, `${base}.tsx`)));

    // Positive controls: another family's arm, and the two this family used to have. The
    // deleted names must still be RECOGNISED by the predicate even though the files are
    // gone, or the check would stop being able to see the very thing it bans.
    expect(pastFacade('import { x } from "../db/inbound.local.js";', libDir)).toEqual(["../db/inbound"]);
    expect(pastFacade('import * as local from "./mail-data-source.local.js";', libDir)).toEqual([
      "./mail-data-source",
    ]);
    // Negative controls: a suffixed module with no facade sibling, and a plain module.
    expect(pastFacade('import { x } from "./sent-ledger.local.js";', libDir)).toEqual([]);
    expect(pastFacade('import { safeLimit } from "../db/pagination.js";', libDir)).toEqual([]);
    expect(new RegExp(modeModuleImport.source).test('import { m } from "../db/self-hosted-store.js";')).toBe(true);
    expect(new RegExp(modeModuleImport.source).test('import { safeLimit } from "../db/pagination.js";')).toBe(false);

    const source = readFileSync(join(libDir, "verification-code.ts"), "utf8");
    expect(source.length).toBeGreaterThan(500);
    expect(pastFacade(source, libDir)).toEqual([]);
    expect(source.match(modeModuleImport) ?? []).toEqual([]);
  });

  /**
   * A MODULE SPECIFIER naming one of the deleted arms — the thing that would still be a
   * live bug after this collapse, because it resolves to nothing and only fails on the
   * path that reaches it.
   *
   * This is deliberately NOT "the text `verification-code.local` appears somewhere". Two
   * legitimate occurrences exist and must keep existing: the header of the collapsed
   * module explains which two files were deleted, and the sibling detector above needs the
   * filenames it looks for. Banning the bare text would have flagged both, and the fix
   * would then have been to exempt files by name — weakening the check to get green.
   * Resolving the predicate to "a quoted `.js` specifier" is the honest version: it is the
   * only form that can be imported.
   */
  const armSpecifier = new RegExp(String.raw`["'][^"']*verification-code\.(?:local|remote)\.js["']`);

  it("no longer reaches into an arm from the local mail data source", () => {
    const source = readFileSync(join(libDir, "mail-data-source.ts"), "utf8");
    expect(source).toContain('from "./verification-code.js"');
    expect(armSpecifier.test(source)).toBe(false);
  });

  it("leaves no import of either deleted arm anywhere in the tracked tree", () => {
    // Positive controls on the predicate itself, checked against fixtures rather than
    // against repo state — the repo count is supposed to be zero, so a check that only
    // reads the repo cannot prove it is still able to see anything.
    //
    // The fixtures are COMPOSED, and that is the whole trick that lets this scan cover its
    // own file. A literal banned specifier written here would be a real occurrence in a
    // tracked file, and the only ways out would be exempting this path by name or dropping
    // the control — both of which weaken the check. Composing keeps the string handed to
    // the predicate byte-identical to the banned form while the source holds no such text.
    const staticImport = (arm: string): string => `import * as x from "./verification-code.${arm}.js";`;
    const dynamicImport = (arm: string): string => `await import("../../lib/verification-code.${arm}.js")`;
    expect(armSpecifier.test(staticImport("local"))).toBe(true);
    expect(armSpecifier.test(staticImport("remote"))).toBe(true);
    expect(armSpecifier.test(dynamicImport("remote"))).toBe(true);
    // Negative controls: the facade, and a prose mention of a deleted FILE.
    expect(armSpecifier.test('import { x } from "./verification-code.js";')).toBe(false);
    expect(armSpecifier.test("// verification-code.local.ts held the real implementation")).toBe(false);

    const tracked = execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx", "*.mjs", "*.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((path) => path.length > 0);
    // A floor, so a scan that stopped resolving files cannot pass over nothing.
    expect(tracked.length).toBeGreaterThan(200);
    expect(tracked.filter((path) => armSpecifier.test(readFileSync(join(repoRoot, path), "utf8")))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pure functions. PARITY COVERAGE, not change detection: these ran on both
// deleted arms, byte-identically, and must keep behaving exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

describe("verification code extraction", () => {
  it("extracts context-backed temporary verification codes", () => {
    expect(extractVerificationCodes("Enter this temporary verification code to continue:\n\n492255")[0]).toBe("492255");
  });

  it("finds the newest matching email and honors filters", () => {
    const match = findVerificationCode([
      inboundFixture({
        id: "old",
        from_address: "noreply@other.com",
        text_body: "code 111111",
        received_at: "2026-06-04T10:00:00.000Z",
      }),
      inboundFixture({
        id: "new",
        from_address: "ChatGPT <noreply@tm.openai.com>",
        subject: "Your temporary ChatGPT verification code",
        text_body: "Enter this temporary verification code to continue:\n\n958450",
        received_at: "2026-06-04T11:00:00.000Z",
      }),
    ], { from: "openai", subject: "verification" });

    expect(match?.code).toBe("958450");
    expect(match?.email.id).toBe("new");
    expect(match?.confidence).toBe("high");
  });

  it("keeps ONE copy of the extraction patterns", () => {
    // The deleted arms each held their own copy of both patterns, which is the drift
    // hazard this collapse removes. Asserted on the source rather than on behaviour,
    // because a second copy that has not drifted YET is behaviourally invisible.
    const source = readFileSync(join(libDir, "verification-code.ts"), "utf8");
    const occurrences = (needle: string): number => source.split(needle).length - 1;
    expect(occurrences("one[-\\s]?time")).toBe(1);
    expect(occurrences("(?<!\\d)(\\d{4,10})(?!\\d)")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The candidate read, through the seam.
// ─────────────────────────────────────────────────────────────────────────────

describe("listVerificationCodeCandidates reads the store seam", () => {
  it("returns the inbound mail addressed to the recipient, newest first, over the configured store", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["me@example.com"],
      subject: "Older code",
      text: "Your code is 111111",
      received_at: "2026-06-04T10:00:00.000Z",
    });
    await seedMessage(store, {
      to: ["Me <me@example.com>"],
      subject: "Newer code",
      text: "Your verification code is 222222",
      received_at: "2026-06-04T11:00:00.000Z",
    });

    // NO injected store: this exercises `createConfiguredEmailStore()` and therefore the
    // whole resolution path, not just the seam call.
    const candidates = await listVerificationCodeCandidates("me@example.com");

    expect(candidates.map((candidate) => candidate.subject)).toEqual(["Newer code", "Older code"]);
    // The body is carried, which is the whole point: the list projection has none, so a
    // detail read per candidate is required and a snippet would not do.
    expect(candidates[0]?.text_body).toBe("Your verification code is 222222");
    expect(findVerificationCode(candidates)?.code).toBe("222222");
  });

  it("includes archived, spam and trash mail, as the deleted local read did", async () => {
    const store = realStore();
    await seedMessage(store, { to: ["me@example.com"], subject: "Filed", labels: ["archived"], text: "code 333333" });
    // `spam` and `trash` are applied as a SECOND call on purpose, and it is a finding
    // rather than a preference: this store's create path writes the two flags and then its
    // own AFTER INSERT trigger re-derives them from the label list the create just
    // stripped, so a one-call seed lands in the inbox. The label write is an UPDATE and
    // runs after that trigger, so it sticks. Reported rather than worked around — the
    // create path belongs to the SQLite store, not to this family.
    const junk = await seedMessage(store, { to: ["me@example.com"], subject: "Junk", text: "code 444444" });
    const binned = await seedMessage(store, { to: ["me@example.com"], subject: "Binned", text: "code 555555" });
    expect((await store.inbound.addInboundLabel(junk, "spam")).ok).toBe(true);
    expect((await store.inbound.addInboundLabel(binned, "trash")).ok).toBe(true);

    const subjects = (await listVerificationCodeCandidates("me@example.com")).map((c) => c.subject);
    expect(subjects.slice().sort()).toEqual(["Binned", "Filed", "Junk"]);

    // POSITIVE CONTROL for the choice of seam operation. The inbox-folder read excludes
    // all three, so this proves the rows really are outside the inbox — and that the
    // candidate read above is not passing because the labels failed to take.
    const inboxOnly = await store.inbound.listInbound({ to: "me@example.com", limit: 10 });
    expect(inboxOnly.ok).toBe(true);
    if (inboxOnly.ok) expect(inboxOnly.value.items).toEqual([]);
  });

  it("never offers a sent message as a received code", async () => {
    const store = realStore();
    await seedMessage(store, {
      direction: "outbound",
      to: ["me@example.com"],
      subject: "What I typed",
      text: "I entered code 666666",
    });
    expect(await listVerificationCodeCandidates("me@example.com")).toEqual([]);
  });

  it("scopes to an EXACT recipient even though the store's filter is a substring match", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["notme@example.com"],
      subject: "Someone else's code",
      text: "Your verification code is 777777",
    });

    // POSITIVE CONTROL, and the reason this test is not vacuous: the store's own recipient
    // filter DOES match the neighbour address, so the exclusion below is the client-side
    // exact check doing work rather than the store never having offered the row.
    const listed = await store.messages.listMessages({ direction: "inbound", to: "me@example.com", limit: 10 });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.items.map((row) => row.to_addrs)).toEqual([["notme@example.com"]]);

    const candidates = await listVerificationCodeCandidates("me@example.com");
    expect(candidates).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain("777777");
  });

  it("does not let a store that ignores the recipient filter leak another mailbox's code", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["neighbour@example.com"],
      subject: "Neighbour's code",
      text: "Your verification code is 888888",
    });
    const foreign = await listRecordFor(store, "neighbour@example.com");

    // A store that answers a filtered read with an unfiltered page. The exact recipient
    // re-assertion is the only thing between that and a disclosed code.
    const leaky = storeListingWith({ ok: true, value: { items: [foreign], next_cursor: null } });
    const candidates = await listVerificationCodeCandidates("me@example.com", {}, leaky);
    expect(candidates).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain("888888");
  });

  it("re-checks the record it actually returns, not only the list row that selected it", async () => {
    const store = realStore();
    await seedMessage(store, { to: ["me@example.com"], subject: "Mine", text: "code 101010" });
    await seedMessage(store, {
      to: ["stranger@elsewhere.test"],
      subject: "Stranger's code",
      text: "Your verification code is 202020",
    });
    const foreign = await store.messages.listMessages({ direction: "inbound", to: "stranger@elsewhere.test" });
    expect(foreign.ok).toBe(true);
    const foreignId = foreign.ok ? (foreign.value.items[0]?.id as string) : "";
    const foreignRecord = await store.messages.getMessage(foreignId);
    expect(foreignRecord.ok && foreignRecord.value !== null).toBe(true);

    // The BODY — the part that carries the code — arrives from the by-id read, so a store
    // that answers it with a different row slips a foreign mailbox's code past a scope check
    // that already passed on a different object. The re-check on the returned record is the
    // only thing standing there.
    const base = realStore();
    const swapping: EmailStore = {
      ...base,
      messages: { ...base.messages, getMessage: async () => foreignRecord },
    };

    let thrown = "";
    try {
      await listVerificationCodeCandidates("me@example.com", {}, swapping);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toMatch(/different message than the one requested/);
    // And the swapped body's code is not in the diagnostic either.
    expect(thrown).not.toContain("202020");
  });

  it("re-asserts the sender and subject filters the caller asked for", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["me@example.com"],
      from: "phisher@evil.test",
      subject: "Your verification code",
      text: "Your verification code is 999999",
    });
    const row = await listRecordFor(store, "me@example.com");

    // A store whose filters are looser than the question. Answering with this row would
    // hand a caller who asked for a code from one sender a code from another — which on
    // this surface is the phishing case, not a cosmetic filter miss.
    const loose = storeListingWith({ ok: true, value: { items: [row], next_cursor: null } });
    expect(await listVerificationCodeCandidates("me@example.com", { from: "trusted.test" }, loose)).toEqual([]);
    expect(await listVerificationCodeCandidates("me@example.com", { subject: "invoice" }, loose)).toEqual([]);
    // Matching values still pass, so the re-assertion is a filter and not a wall.
    expect(await listVerificationCodeCandidates("me@example.com", { from: "evil.test" }, loose)).toHaveLength(1);
    expect(await listVerificationCodeCandidates("me@example.com", { subject: "verification" }, loose)).toHaveLength(1);
  });

  it("honors the since filter and the candidate budget", async () => {
    const store = realStore();
    for (const day of ["01", "02", "03"]) {
      await seedMessage(store, {
        to: ["me@example.com"],
        subject: `Day ${day}`,
        received_at: `2026-06-${day}T00:00:00.000Z`,
      });
    }

    const since = await listVerificationCodeCandidates("me@example.com", { since: "2026-06-02T00:00:00.000Z" });
    expect(since.map((candidate) => candidate.subject)).toEqual(["Day 03", "Day 02"]);

    const budgeted = await listVerificationCodeCandidates("me@example.com", { limit: 1 });
    expect(budgeted.map((candidate) => candidate.subject)).toEqual(["Day 03"]);
  });

  it("finds mail addressed to a dotless mailbox the deleted read could not", async () => {
    // The inbound family's address parser requires a dotted domain, and the deleted local
    // read used it as a GATE: an address it rejected produced an empty list, silently, for
    // a mailbox the database was perfectly able to hold. Both sides of the comparison now
    // fall back to the trimmed text, so the scope is unchanged for every normal address
    // and this one becomes reachable.
    const store = realStore();
    await seedMessage(store, { to: ["me@localhost"], subject: "Local code", text: "code 121212" });
    const candidates = await listVerificationCodeCandidates("Me@LocalHost");
    expect(candidates.map((candidate) => candidate.subject)).toEqual(["Local code"]);
  });

  it("reads without consuming: no flag is flipped and no row is removed", async () => {
    const store = realStore();
    const id = await seedMessage(store, { to: ["me@example.com"], text: "Your verification code is 131313" });
    const flags = (): Record<string, unknown> =>
      db.query("SELECT is_read, is_archived, is_trash, is_spam FROM inbound_emails WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    const before = flags();

    // Read it twice. A single-use read would make the second call empty, and an
    // implementation that marked the row read would change the flags.
    expect(await listVerificationCodeCandidates("me@example.com")).toHaveLength(1);
    expect(await listVerificationCodeCandidates("me@example.com")).toHaveLength(1);

    expect(flags()).toEqual(before);
    expect((db.query("SELECT count(*) AS n FROM inbound_emails").get() as { n: number }).n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals. The bug this family could ship is "answered empty when it could not
// check", so every refusal path is asserted to throw.
// ─────────────────────────────────────────────────────────────────────────────

describe("a candidate read that cannot be performed refuses", () => {
  it("throws the store's refusal instead of reporting that no code has arrived", async () => {
    const refusing = storeListingWith({
      ok: false,
      code: "capability_unavailable",
      message: "the api store does not provide keysetPagination",
      status: 501,
    });

    await expect(listVerificationCodeCandidates("me@example.com", {}, refusing)).rejects.toThrow(
      /capability_unavailable, 501/,
    );
    // The point of the test: it must not be an empty list. An empty list is the correct
    // answer for "nothing has arrived yet", and every caller polls on exactly that.
    await expect(listVerificationCodeCandidates("me@example.com", {}, refusing)).rejects.toThrow(
      /cannot read the inbound mail/,
    );
  });

  it("throws when the single-message read refuses, rather than dropping the candidate", async () => {
    const store = realStore();
    await seedMessage(store, { to: ["me@example.com"], text: "Your verification code is 141414" });
    const refusing = storeReadingMessageWith({
      ok: false,
      code: "capability_unavailable",
      message: "the api store does not provide rawMessage",
      status: 501,
    });

    // Silently skipping a candidate whose body could not be read is the same lie one level
    // down: the mail is there and the code cannot be seen, which is not "no code".
    await expect(listVerificationCodeCandidates("me@example.com", {}, refusing)).rejects.toThrow(
      /cannot read a stored inbound message/,
    );
  });

  it("refuses an unparseable since instead of filtering every row out", async () => {
    const store = realStore();
    await seedMessage(store, { to: ["me@example.com"], text: "Your verification code is 151515" });
    // The store refuses a timestamp it cannot parse, precisely because comparing against
    // it silently removes every row — an empty page indistinguishable from an empty
    // mailbox. That refusal has to reach the caller.
    await expect(listVerificationCodeCandidates("me@example.com", { since: "yesterday" })).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("refuses a blank recipient instead of answering that no code has arrived", async () => {
    await expect(listVerificationCodeCandidates("   ")).rejects.toThrow(/needs a recipient address/);
  });

  it("puts no code, body, subject or setting name into a refusal", async () => {
    const store = realStore();
    const code = "161616";
    await seedMessage(store, {
      to: ["me@example.com"],
      subject: `Secret subject ${code}`,
      text: `Your verification code is ${code}`,
      html: `<p>${code}</p>`,
    });
    // The refusal happens AFTER the row (and its snippet) is in hand, which is exactly
    // when an implementation is tempted to name the row it was working on.
    const refusing = storeReadingMessageWith({
      ok: false,
      code: "not_found",
      message: "the message could not be read",
      status: 404,
    });

    let thrown = "";
    try {
      await listVerificationCodeCandidates("me@example.com", {}, refusing);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).not.toBe("");
    expect(thrown).not.toContain(code);
    expect(thrown).not.toContain("Secret subject");
    // No run of 4-10 digits at all: a refusal that quotes any candidate digits is one log
    // line away from disclosing a code.
    expect(thrown).not.toMatch(/(?<!\d)\d{4,10}(?!\d)/);
    // And no refusal may name a setting the caller could flip to reach other behaviour.
    // This repo has already had to delete a refusal that advertised its own bypass.
    expect(thrown).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}\s*=/);
  });

  it("keeps an empty answer meaning exactly one thing", async () => {
    // The positive half of every refusal test above: with a working store and a mailbox
    // that genuinely holds nothing, the answer IS the empty list. Without this, the suite
    // could be satisfied by an implementation that never answered empty at all.
    expect(await listVerificationCodeCandidates("nobody@example.com")).toEqual([]);
  });

  it("keeps paging past a page that holds no candidate, rather than stopping at it", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["notme@example.com"],
      subject: "Not mine",
      text: "Your verification code is 171717",
    });
    await seedMessage(store, { to: ["me@example.com"], subject: "Mine", text: "Your verification code is 181818" });
    const foreign = await listRecordFor(store, "notme@example.com");
    expect(foreign.to_addrs).toEqual(["notme@example.com"]);

    // A store whose first page is entirely rows this read must reject, with the real page
    // behind it. Stopping at the first page would answer "no code has arrived" for a
    // mailbox that has one — the substring recipient filter makes that page reachable.
    const base = realStore();
    let calls = 0;
    const paging: EmailStore = {
      ...base,
      messages: {
        ...base.messages,
        listMessages: async (opts) => {
          calls += 1;
          if (calls === 1) return { ok: true, value: { items: [foreign], next_cursor: "next" } };
          return base.messages.listMessages({ ...opts, cursor: undefined });
        },
      },
    };

    const candidates = await listVerificationCodeCandidates("me@example.com", {}, paging);
    expect(candidates.map((candidate) => candidate.subject)).toEqual(["Mine"]);
    expect(calls).toBeGreaterThan(1);
  });

  it("refuses an incomplete scan rather than presenting it as an empty mailbox", async () => {
    const store = realStore();
    await seedMessage(store, {
      to: ["notme@example.com"],
      subject: "Not mine",
      text: "Your verification code is 191919",
    });
    const foreign = await listRecordFor(store, "notme@example.com");

    // A store that never runs out of pages and never contributes a candidate. Returning
    // the empty list here would tell a polling caller "no code has arrived" when the truth
    // is "I stopped looking" — the two answers have opposite meanings on this surface.
    const endless = storeListingWith({ ok: true, value: { items: [foreign], next_cursor: "more" } });
    await expect(listVerificationCodeCandidates("me@example.com", {}, endless)).rejects.toThrow(/incomplete/);
  });
});
