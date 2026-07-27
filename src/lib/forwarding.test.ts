// The app-level forwarding pipeline, driven for real against a local SQLite database.
//
// WHAT THIS FILE USED TO BE. Two cases against the DELETED HTTP arm, asserting that it threw.
// That arm is gone, so those two assertions are replaced by the thing they were standing in
// for: THE REFUSAL IS STILL A REFUSAL on an installation that reads its mail through an Emails
// API, and it is now derived from STORAGE CONFIGURATION rather than from the deployment word.
// The comfortable wrong answer it must never become is `{ attempted: 0, sent: 0, failed: 0,
// skipped: 0 }` — the shape of a healthy run over an already-forwarded inbox.
//
// EVERY STORAGE SETTING IS NAMED THROUGH THE RESOLUTION'S OWN EXPORTED CONSTANTS
// (`src/store-resolution.ts`), never as a literal, so this suite configures storage without
// naming the deployment word. Two absences are deliberate and are NOT gaps:
//
//   * there is no case that SETS the deployment word to prove it no longer decides. Writing it
//     here — in any form, including through an exported constant, because the ratchet's env
//     metric is a substring match — would RAISE `emailsModeEnvReferences`, a counter that may
//     only fall. The absence of that read is enforced by the ratchet
//     (`src/mode-axis-ratchet.test.ts`) with zero slack, which is the guard designed for it.
//   * for the same reason there is no assertion that the module text no longer contains the
//     dispatch helper or the mode read: naming either identifier here would raise its own
//     counter. The ratchet counts them tree-wide, this file included.
//
// `HOME` IS REDIRECTED IN EVERY CASE, and that is a safety property rather than tidiness. When
// no database path is configured, the database layer resolves `~/.hasna/emails/emails.db` and
// CREATES it. A case that asserts a refusal for an API-configured installation must not be
// able to touch a developer's real mailbox on the way to failing.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createForwardingRule, recordForwardingDelivery } from "../db/forwarding.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import { processForwardingRules, type ForwardingRunOptions } from "./forwarding.js";

const root = join(import.meta.dir, "..", "..");

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let home: string;
let db: Database;

/**
 * Every storage setting cleared, BY NAME FROM THE RESOLVER, plus the pointer that stands in for
 * a whole credential set. The hazard this covers: a value inherited from the developer's shell
 * decides the gate below, and the case then passes or fails for a reason that is not in this
 * file.
 */
function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

/** Storage configured as a local in-memory database, which is what the pipeline needs. */
function configureLocalStore(): void {
  clearStoreSettings();
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

/** Storage configured as an Emails API, and NO database path. */
function configureApiStore(): void {
  clearStoreSettings();
  process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
  process.env[API_CREDENTIAL_SETTINGS[0]] = "not-a-real-credential";
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "forwarding-home-"));
  process.env["HOME"] = home;
  configureLocalStore();
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
  rmSync(home, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────
//
// TIMESTAMPS ARE STAMPED EXPLICITLY wherever more than one row of a kind is written, because
// rows seeded in a tight loop share a timestamp to the millisecond and the tie-break then
// falls through to a random uuid — which makes an ordering assertion hold by luck and lets it
// steal an unrelated mutant's kill.

function seedProvider(id: string, createdAt = "2026-01-01T00:00:00.000Z"): string {
  db.run(
    "INSERT INTO providers (id, name, type, api_key, active, created_at, updated_at) VALUES (?, ?, 'resend', 'k', 1, ?, ?)",
    [id, id, createdAt, createdAt],
  );
  return id;
}

function seedInbound(
  id: string,
  address: string,
  options: { receivedAt?: string; subject?: string; textBody?: string; from?: string } = {},
): string {
  const receivedAt = options.receivedAt ?? "2026-06-01T12:00:00.000Z";
  db.run(
    `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at, is_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      options.from ?? "sender@elsewhere.test",
      JSON.stringify([address]),
      options.subject ?? "Hello",
      options.textBody ?? "body",
      receivedAt,
      receivedAt,
    ],
  );
  // `inbound_recipients` is DERIVED by an AFTER INSERT trigger, so this is `OR IGNORE` — and
  // the row is ASSERTED rather than assumed. The pending-forward join is on this table, so a
  // silently absent recipient would make every run below report zero and pass for the wrong
  // reason.
  db.run(
    "INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain) VALUES (?, ?, ?)",
    [id, address, address.split("@")[1] ?? ""],
  );
  const recipients = db
    .query("SELECT COUNT(*) AS n FROM inbound_recipients WHERE inbound_email_id = ?")
    .get(id) as { n: number };
  expect(recipients.n, "the pending-forward join has no recipient row to match").toBe(1);
  return id;
}

/** A rule written through the real (collapsed) create path, then given a deliberate `created_at`. */
async function seedRule(
  source: string,
  target: string,
  options: { providerId?: string | null; fromAddress?: string | null; createdAt?: string } = {},
): Promise<string> {
  const rule = await createForwardingRule({
    source_address: source,
    target_address: target,
    provider_id: options.providerId ?? null,
    from_address: options.fromAddress ?? null,
  });
  const createdAt = options.createdAt ?? "2026-01-01T00:00:00.000Z";
  db.run("UPDATE forwarding_rules SET created_at = ?, updated_at = ? WHERE id = ?", [createdAt, createdAt, rule.id]);
  return rule.id;
}

interface SendCall {
  providerId: string;
  opts: Record<string, unknown>;
  db: Database;
}

/** A send seam that records its three arguments and reports success from `providerId`. */
function recordingSend(calls: SendCall[], providerId?: string): NonNullable<ForwardingRunOptions["send"]> {
  return async (calledProviderId, opts, handle) => {
    calls.push({ providerId: calledProviderId, opts: opts as unknown as Record<string, unknown>, db: handle });
    return { messageId: `m-${calls.length}`, providerId: providerId ?? calledProviderId, usedFailover: false };
  };
}

interface LedgerRow {
  rule_id: string;
  inbound_email_id: string;
  status: string;
  sent_email_id: string | null;
  error: string | null;
}

function ledgerRows(): LedgerRow[] {
  return db
    .query("SELECT rule_id, inbound_email_id, status, sent_email_id, error FROM forwarding_deliveries ORDER BY rowid")
    .all() as LedgerRow[];
}

// ── the storage-configuration gate ──────────────────────────────────────────────────────

describe("processForwardingRules storage gate", () => {
  it("REFUSES on an API-configured installation instead of reporting an empty run", async () => {
    // THE DETECTOR. On the two-arm tree this call reaches the local arm, opens a local database
    // that has nothing in it, and answers `{ attempted: 0, sent: 0, failed: 0, skipped: 0 }` —
    // indistinguishable from "your mail is fully forwarded". A refusal is never an answer.
    closeDatabase();
    configureApiStore();

    await expect(processForwardingRules()).rejects.toThrow(/reads its mail through an Emails API/);
    await expect(processForwardingRules()).rejects.toThrow(/exist only in a local database/);
  });

  it("REFUSES a contradictory storage configuration instead of silently picking one", async () => {
    // Both an API origin and a database path. The resolver refuses this with no precedence
    // rule; the deleted dispatcher never asked, and picked the arm the deployment word named.
    closeDatabase();
    clearStoreSettings();
    process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
    process.env[API_CREDENTIAL_SETTINGS[0]] = "not-a-real-credential";
    process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";

    await expect(processForwardingRules()).rejects.toThrow(/does not name one store/);
    // The refusal carries the resolver's own settings list, so the operator learns WHICH
    // settings contradict each other rather than that something is wrong.
    await expect(processForwardingRules()).rejects.toThrow(new RegExp(API_BASE_URL_SETTING));
    await expect(processForwardingRules()).rejects.toThrow(new RegExp(DATABASE_PATH_SETTINGS[1]));
  });

  it("runs against the local database the configuration names", async () => {
    // Parity with the deleted local arm: nothing pending is an honest empty result.
    await expect(processForwardingRules()).resolves.toEqual({
      attempted: 0, sent: 0, failed: 0, skipped: 0, items: [],
    });
  });

  it("skips the gate when the caller states its storage, which is the documented contract", async () => {
    // A caller holding local storage keeps today's behaviour regardless of configuration —
    // `src/db/forwarding.ts`'s rule, one level up. The gate answers for callers that did not.
    const handle = db;
    configureApiStore();
    await expect(processForwardingRules({ db: handle })).resolves.toMatchObject({ attempted: 0 });
  });
});

// ── the pipeline ────────────────────────────────────────────────────────────────────────

describe("processForwardingRules pipeline", () => {
  it("forwards a pending message, records the delivery, and threads ONE database through the send", async () => {
    const provider = seedProvider("p-1");
    const ruleId = await seedRule("user@example.com", "archive@example.net", { providerId: provider });
    seedInbound("inbound-1", "user@example.com", { subject: "Hello", textBody: "body" });
    const calls: SendCall[] = [];

    const result = await processForwardingRules({ db, send: recordingSend(calls) });

    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      rule_id: ruleId,
      inbound_email_id: "inbound-1",
      target_address: "archive@example.net",
      status: "sent",
      error: null,
    });
    const sentEmailId = result.items[0]?.sent_email_id;
    expect(typeof sentEmailId, "a sent item must carry the ledger row it created").toBe("string");

    // THE INJECTION POINT'S THIRD ARGUMENT. The deleted HTTP arm declared a two-parameter
    // `send` and never called it, while the published type was the local three-parameter one.
    // The handle the pipeline threads is asserted to be the SAME object, because a second
    // handle would be a second database.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerId).toBe(provider);
    expect(calls[0]?.db, "the send seam must receive the pipeline's own database").toBe(db);
    expect(calls[0]?.opts).toMatchObject({
      from: "user@example.com",
      to: "archive@example.net",
      subject: "Fwd: Hello",
      idempotency_key: `forward:${ruleId}:inbound-1`,
      headers: { "X-Hasna-Forwarded-For": "user@example.com", "X-Hasna-Inbound-Id": "inbound-1" },
    });

    expect(ledgerRows()).toEqual([
      { rule_id: ruleId, inbound_email_id: "inbound-1", status: "sent", sent_email_id: sentEmailId ?? null, error: null },
    ]);
    const stored = db.query("SELECT id, subject, idempotency_key FROM emails").all() as Array<{
      id: string; subject: string; idempotency_key: string | null;
    }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(sentEmailId);
    expect(stored[0]?.idempotency_key).toBe(`forward:${ruleId}:inbound-1`);
    const content = db
      .query("SELECT text_body, html FROM email_content WHERE email_id = ?")
      .all(sentEmailId ?? "") as Array<{ text_body: string | null; html: string | null }>;
    expect(content, "the forwarded body must be recorded in the local ledger").toHaveLength(1);
    expect(content[0]?.text_body).toContain("---------- Forwarded message ----------");
  });

  it("does not double-prefix a subject that already says it is a forward", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    seedInbound("inbound-1", "user@example.com", { subject: "Fwd: already" });
    seedInbound("inbound-2", "user@example.com", { subject: "Fw: short", receivedAt: "2026-06-01T12:00:01.000Z" });
    seedInbound("inbound-3", "user@example.com", { subject: "plain", receivedAt: "2026-06-01T12:00:02.000Z" });
    seedInbound("inbound-4", "user@example.com", { subject: "  Fwd: padded", receivedAt: "2026-06-01T12:00:03.000Z" });
    const calls: SendCall[] = [];

    await processForwardingRules({ db, send: recordingSend(calls) });

    // Ordered by `received_at ASC`, which the pending scan guarantees.
    expect(calls.map((call) => call.opts["subject"])).toEqual([
      "Fwd: already",
      "Fw: short",
      "Fwd: plain",
      // The TRIMMED subject is tested for the prefix and the UNTRIMMED one is sent. That is the
      // deleted arm's behaviour exactly, and it is asserted rather than corrected.
      "  Fwd: padded",
    ]);
  });

  it("quotes the original message and escapes it for the HTML part", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    seedInbound("inbound-1", "user@example.com", {
      from: "orig@sender.test",
      receivedAt: "2026-06-01T12:00:00.000Z",
      textBody: "a <b> & c",
    });
    const calls: SendCall[] = [];

    await processForwardingRules({ db, send: recordingSend(calls) });

    const text = String(calls[0]?.opts["text"]);
    expect(text).toBe(
      "---------- Forwarded message ----------\nFrom: orig@sender.test\nDate: 2026-06-01T12:00:00.000Z\n\na <b> & c",
    );
    // `&` IS ESCAPED FIRST, so the escaped `<` is not re-escaped into `&amp;lt;`.
    expect(String(calls[0]?.opts["html"])).toContain("a &lt;b&gt; &amp; c");
    expect(String(calls[0]?.opts["html"])).not.toContain("&amp;lt;");
    expect(String(calls[0]?.opts["html"]).startsWith("<pre>")).toBe(true);
    expect(String(calls[0]?.opts["html"]).endsWith("</pre>")).toBe(true);
  });

  it("forwards an EMPTY body rather than skipping the message", async () => {
    // `text_body` is nullable and the deleted arm forwarded `""` for it. A message with no text
    // part is still a message a rule says to copy.
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    db.run(
      `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at, is_sent)
       VALUES ('inbound-1', 'sender@elsewhere.test', '["user@example.com"]', 'Hi', NULL,
               '2026-06-01T12:00:00.000Z', '2026-06-01T12:00:00.000Z', 0)`,
    );
    db.run(
      "INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain) VALUES ('inbound-1', 'user@example.com', 'example.com')",
    );
    const calls: SendCall[] = [];

    const result = await processForwardingRules({ db, send: recordingSend(calls) });

    expect(result).toMatchObject({ attempted: 1, sent: 1, skipped: 0 });
    expect(String(calls[0]?.opts["text"]).endsWith("\n\n")).toBe(true);
  });

  it("records a FAILED delivery and sends NOTHING when no provider is available", async () => {
    await seedRule("user@example.com", "archive@example.net");
    seedInbound("inbound-1", "user@example.com");
    const calls: SendCall[] = [];

    const result = await processForwardingRules({ db, send: recordingSend(calls) });

    expect(result).toMatchObject({ attempted: 1, sent: 0, failed: 1, skipped: 0 });
    expect(result.items[0]).toMatchObject({ status: "failed", sent_email_id: null });
    expect(result.items[0]?.error).toContain("No active provider available");
    // THE POSITIVE CONTROL THAT MATTERS: nothing was sent. A `failed` count with a delivered
    // copy behind it is the worst outcome this pipeline has.
    expect(calls, "no provider must mean no send").toHaveLength(0);
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.sent_email_id).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM emails").get()).toEqual({ n: 0 });
  });

  it("resolves the provider as override, then the rule's own, then the latest active", async () => {
    seedProvider("p-old", "2026-01-01T00:00:00.000Z");
    seedProvider("p-new", "2026-02-01T00:00:00.000Z");
    seedProvider("p-rule", "2026-01-15T00:00:00.000Z");

    await seedRule("a@example.com", "t@example.net", { providerId: "p-rule" });
    await seedRule("b@example.com", "t@example.net");
    seedInbound("inbound-a", "a@example.com", { receivedAt: "2026-06-01T12:00:00.000Z" });
    seedInbound("inbound-b", "b@example.com", { receivedAt: "2026-06-01T12:00:01.000Z" });

    const calls: SendCall[] = [];
    await processForwardingRules({ db, send: recordingSend(calls) });
    // The rule's own provider for the first; the newest ACTIVE provider for the rule with none.
    expect(calls.map((call) => call.providerId)).toEqual(["p-rule", "p-new"]);

    // The override beats both.
    db.run("DELETE FROM forwarding_deliveries");
    const overridden: SendCall[] = [];
    await processForwardingRules({ db, providerId: "p-old", send: recordingSend(overridden) });
    expect(overridden.map((call) => call.providerId)).toEqual(["p-old", "p-old"]);
  });

  it("ignores an INACTIVE provider when falling back", async () => {
    seedProvider("p-active", "2026-01-01T00:00:00.000Z");
    seedProvider("p-inactive", "2026-05-01T00:00:00.000Z");
    db.run("UPDATE providers SET active = 0 WHERE id = 'p-inactive'");
    await seedRule("user@example.com", "archive@example.net");
    seedInbound("inbound-1", "user@example.com");
    const calls: SendCall[] = [];

    await processForwardingRules({ db, send: recordingSend(calls) });

    expect(calls.map((call) => call.providerId)).toEqual(["p-active"]);
  });

  it("resolves the From address as override, then the rule's own, then the source address", async () => {
    seedProvider("p-1");
    await seedRule("a@example.com", "t@example.net", { providerId: "p-1", fromAddress: "bounce@example.com" });
    await seedRule("b@example.com", "t@example.net", { providerId: "p-1" });
    seedInbound("inbound-a", "a@example.com", { receivedAt: "2026-06-01T12:00:00.000Z" });
    seedInbound("inbound-b", "b@example.com", { receivedAt: "2026-06-01T12:00:01.000Z" });

    const calls: SendCall[] = [];
    await processForwardingRules({ db, send: recordingSend(calls) });
    expect(calls.map((call) => call.opts["from"])).toEqual(["bounce@example.com", "b@example.com"]);

    db.run("DELETE FROM forwarding_deliveries");
    const overridden: SendCall[] = [];
    await processForwardingRules({ db, fromAddress: "one@example.com", send: recordingSend(overridden) });
    expect(overridden.map((call) => call.opts["from"])).toEqual(["one@example.com", "one@example.com"]);
  });

  it("excludes mail received BEFORE the rule was created unless backfill is asked for", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", {
      providerId: "p-1",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    seedInbound("inbound-old", "user@example.com", { receivedAt: "2026-05-31T23:59:59.000Z" });

    await expect(processForwardingRules({ db, send: recordingSend([]) })).resolves.toMatchObject({ attempted: 0 });
    // The negative control and the positive control on the SAME row, so "attempted 0" cannot be
    // the fixture failing to produce a candidate at all.
    await expect(processForwardingRules({ db, backfill: true, send: recordingSend([]) }))
      .resolves.toMatchObject({ attempted: 1, sent: 1 });
  });

  it("does not offer a pair whose delivery already succeeded", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    seedInbound("inbound-1", "user@example.com");
    const calls: SendCall[] = [];

    await expect(processForwardingRules({ db, send: recordingSend(calls) })).resolves.toMatchObject({ sent: 1 });
    await expect(processForwardingRules({ db, send: recordingSend(calls) })).resolves.toMatchObject({ attempted: 0 });
    expect(calls, "a successfully forwarded message must not be sent twice").toHaveLength(1);
  });

  it("RE-OFFERS a pair whose delivery FAILED, which is the retry this pipeline exists to allow", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    seedInbound("inbound-1", "user@example.com");

    const failing: NonNullable<ForwardingRunOptions["send"]> = async () => {
      throw new Error("provider is down");
    };
    await expect(processForwardingRules({ db, send: failing })).resolves.toMatchObject({ failed: 1 });
    expect(ledgerRows()[0]?.status).toBe("failed");
    expect(ledgerRows()[0]?.error).toBe("provider is down");

    const calls: SendCall[] = [];
    await expect(processForwardingRules({ db, send: recordingSend(calls) })).resolves.toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(1);
  });

  it("refuses a non-finite limit rather than scanning the whole table", async () => {
    // `Math.trunc(NaN)` binds as SQL NULL and `LIMIT NULL` means NO LIMIT in SQLite. The refusal
    // lives in `src/db/forwarding.ts`; this asserts the pipeline SURFACES it instead of
    // defaulting the limit and hiding it.
    await expect(processForwardingRules({ db, limit: Number.NaN })).rejects.toThrow(/must be a finite number/);
    await expect(processForwardingRules({ db, limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /must be a finite number/,
    );
  });

  it("bounds one run by the limit and leaves the rest pending for the next", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    for (let index = 0; index < 3; index += 1) {
      seedInbound(`inbound-${index}`, "user@example.com", { receivedAt: `2026-06-01T12:00:0${index}.000Z` });
    }

    const first: SendCall[] = [];
    await expect(processForwardingRules({ db, limit: 2, send: recordingSend(first) }))
      .resolves.toMatchObject({ attempted: 2, sent: 2 });
    // A FULL PAGE IS NOT THE END OF THE TABLE, and `attempted` is not claimed to be a total.
    const second: SendCall[] = [];
    await expect(processForwardingRules({ db, limit: 2, send: recordingSend(second) }))
      .resolves.toMatchObject({ attempted: 1, sent: 1 });
    expect([...first, ...second]).toHaveLength(3);
  });

  it("does not forward through a DISABLED rule", async () => {
    seedProvider("p-1");
    const ruleId = await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    db.run("UPDATE forwarding_rules SET enabled = 0 WHERE id = ?", [ruleId]);
    seedInbound("inbound-1", "user@example.com");

    await expect(processForwardingRules({ db, send: recordingSend([]) })).resolves.toMatchObject({ attempted: 0 });
  });

  it("does not forward a message this installation SENT", async () => {
    seedProvider("p-1");
    await seedRule("user@example.com", "archive@example.net", { providerId: "p-1" });
    seedInbound("inbound-1", "user@example.com");
    db.run("UPDATE inbound_emails SET is_sent = 1 WHERE id = 'inbound-1'");

    await expect(processForwardingRules({ db, send: recordingSend([]) })).resolves.toMatchObject({ attempted: 0 });
  });
});

// ── inherited defects, pinned so neither direction of change is silent ──────────────────

describe("processForwardingRules inherited defects", () => {
  it("PINNED DEFECT: a ledger write that fails AFTER a successful send makes the next run send a SECOND copy", async () => {
    // A LIVE DEFECT, PRESERVED VERBATIM BY THIS COLLAPSE AND ASSERTED SO IT CANNOT BE "fixed"
    // SILENTLY IN EITHER DIRECTION. The `try` in `processForwardingRules` spans the provider
    // call and the two local ledger writes after it, and its `catch` records `status: "failed"`.
    // The pending join excludes a pair only when its row says `sent`, so a copy that was
    // DELIVERED and then failed to be ledgered stays pending and goes out again.
    //
    // THE FIX IS NOT to widen the pending join to exclude `failed` rows too — that would strand
    // every genuine retry, which the "RE-OFFERS a pair whose delivery FAILED" case protects. It
    // is the idempotency-fenced ledger described in this module's header and in
    // `src/db/forwarding.ts`, where `sent` is TERMINAL for a pair.
    const provider = seedProvider("p-real");
    await seedRule("user@example.com", "archive@example.net", { providerId: provider });
    seedInbound("inbound-1", "user@example.com");

    // The send SUCCEEDS and reports a provider that does not exist, so the sent-mail ledger's
    // foreign key refuses the row — a post-send throw, which is the shape of the defect.
    const calls: SendCall[] = [];
    const first = await processForwardingRules({ db, send: recordingSend(calls, "p-does-not-exist") });

    expect(calls, "the copy WAS delivered").toHaveLength(1);
    expect(first).toMatchObject({ attempted: 1, sent: 0, failed: 1 });
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status, "a delivered copy is recorded as failed").toBe("failed");
    expect(db.query("SELECT COUNT(*) AS n FROM emails").get(), "and no ledger row exists for it").toEqual({ n: 0 });

    // AND HERE IS THE DUPLICATE. Nothing concurrent happened.
    const second = await processForwardingRules({ db, send: recordingSend(calls) });
    expect(second).toMatchObject({ attempted: 1, sent: 1 });
    expect(calls.length, "the provider was called twice for one inbound message").toBe(2);
  });

  it("PINNED DEFECT: a later FAILURE replaces an earlier SUCCESS, and the sent-mail ledger then HIDES the duplicate", async () => {
    // TWO INHERITED DEFECTS IN ONE SEQUENCE, both named in this module's header.
    //
    // 1. `recordForwardingDelivery` is an `INSERT OR REPLACE` keyed on
    //    `(rule_id, inbound_email_id)` while the pending join excludes a pair only on `sent`,
    //    so a later `failed` — which two concurrent runs produce — re-opens the pair.
    // 2. `idempotency_key` is consumed by `createEmail` AFTER the provider call, so it cannot
    //    stop the second SEND; it only makes the second send reuse the FIRST ledger row. The
    //    recipient has two copies and the local ledger shows one message, which is worse than
    //    no key at all because the evidence is erased on the only side that could report it.
    const provider = seedProvider("p-1");
    const ruleId = await seedRule("user@example.com", "archive@example.net", { providerId: provider });
    seedInbound("inbound-1", "user@example.com");

    const calls: SendCall[] = [];
    await expect(processForwardingRules({ db, send: recordingSend(calls) })).resolves.toMatchObject({ sent: 1 });
    const afterFirst = ledgerRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.status).toBe("sent");

    // What a concurrent run's losing half writes.
    recordForwardingDelivery(
      { rule_id: ruleId, inbound_email_id: "inbound-1", status: "failed", error: "a concurrent run lost the race" },
      db,
    );
    const afterRace = ledgerRows();
    expect(afterRace, "the successful delivery is GONE, not kept alongside").toHaveLength(1);
    expect(afterRace[0]?.status).toBe("failed");

    await expect(processForwardingRules({ db, send: recordingSend(calls) })).resolves.toMatchObject({ sent: 1 });
    expect(calls.length, "two provider calls for one inbound message").toBe(2);

    const stored = db.query("SELECT id, idempotency_key FROM emails").all() as Array<{
      id: string; idempotency_key: string | null;
    }>;
    expect(stored, "and only ONE ledger row records them").toHaveLength(1);
    expect(stored[0]?.idempotency_key).toBe(`forward:${ruleId}:inbound-1`);
  });
});

// ── module shape (weak: signature, not behaviour) ────────────────────────────────────────

describe("the forwarding family has one implementation", () => {
  it("has no arm modules left", () => {
    // Checked by EXPLICIT NAME rather than by a glob, because `forwarding.*.ts` also matches
    // this file.
    expect(existsSync(join(root, "src/lib/forwarding.local.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/forwarding.remote.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/forwarding.ts"))).toBe(true);
  });
});
