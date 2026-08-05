// Task db244cd4 — the top-level `emails search` verb, on the LOCAL SQLite store.
//
// The self-hosted surface carried this defect through `listMailbox("sent")`;
// this surface carried the SAME defect by a different route, calling
// `searchEmails`, which enumerates the outbound ledger. Two implementations,
// one blindness — so both now run the single shared `mailboxSearch`, and both
// are tested, because a fix proven on one surface says nothing about the other.
//
// This file exists rather than extending `email-log.local.test.ts` because that
// suite cannot run: every one of its 10 tests fails in `setupDb` with
// `SQLiteError: FOREIGN KEY constraint failed` on unmodified main (measured
// 2026-08-04 at d3ece11, `0 pass, 10 fail`). That is a pre-existing fixture
// defect, out of scope here, and it would have left this change with no local
// coverage at all. The harness below is the one from `inbox.local.test.ts`,
// which passes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { storeInboundEmail } from "../../db/inbound.local.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { EMAILS_CLIENT_ENV_SECRET_ENV } from "../../lib/client-env.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";
import { registerEmailLogCommands } from "./email-log.local.js";

// Cleared by SHAPE, not by name, so this file adds no fresh spelling of the
// deployment-word variable the axis ratchet is retiring (same rule as
// inbox.local.test.ts, from which this harness is taken).
const DEPLOYMENT_WORD_ENV = /^(?:HASNA_)?EMAILS_[A-Z_]*MODE$/;
function pinLocalStore(): void {
  for (const key of Object.keys(process.env)) {
    if (DEPLOYMENT_WORD_ENV.test(key)) delete process.env[key];
  }
  delete process.env[EMAILS_CLIENT_ENV_SECRET_ENV];
  delete process.env[API_BASE_URL_SETTING];
  for (const key of API_CREDENTIAL_SETTINGS) delete process.env[key];
  for (const key of DATABASE_PATH_SETTINGS) delete process.env[key];
  process.env.EMAILS_DB_PATH = ":memory:";
}

let originalEnv: NodeJS.ProcessEnv;
let sequence = 0;

beforeEach(() => {
  originalEnv = { ...process.env };
  pinLocalStore();
  resetMailDataSource();
  resetDatabase();
  getDatabase();
  sequence = 0;
});

afterEach(() => {
  resetMailDataSource();
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  process.exitCode = 0;
});

// SENT MAIL IS MARKED WITH THE `SENT` LABEL, never with an `is_sent` field.
// `storeInboundEmail` Omit<>s `is_sent` from its input and derives it solely
// from label_ids — so passing `is_sent: 1` is silently ignored and every seeded
// row lands in the inbox.
//
// That is not a footnote: the first version of this file did exactly that, and
// the "received AND sent together" test below PASSED ANYWAY, because both rows
// were inbound and both matched on the inbox side. A fixture that cannot
// express the sent shape produces a green test that proves nothing about it —
// the same coverage-bounded-by-axes failure this whole task is about, one level
// down. Only the --folder test, which asks for sent ALONE, could see it.
function seedMessage(subject: string, opts: { sent?: boolean } = {}) {
  sequence += 1;
  return storeInboundEmail({
    provider_id: null,
    message_id: `<local-${sequence}@example.com>`,
    in_reply_to_email_id: null,
    from_address: `sender-${sequence}@example.com`,
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject,
    text_body: `body ${sequence}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: `2026-07-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    label_ids: opts.sent ? ["SENT"] : [],
  }, getDatabase());
}

async function runSearch(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerEmailLogCommands(program, (payload, formatted) => {
    data = payload;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

describe("local `emails search` covers received mail (db244cd4)", () => {
  it("finds a term that exists ONLY in received mail", async () => {
    seedMessage("Your account is past due");

    const { data } = await runSearch(["search", "past due"]);
    const rows = data as Array<Record<string, unknown>>;

    // Returned [] before the fix: `searchEmails` reads the outbound ledger.
    expect(rows.map((row) => row.subject)).toEqual(["Your account is past due"]);
  });

  it("returns received AND sent matches together", async () => {
    seedMessage("Invoice needle received", { sent: false });
    seedMessage("Invoice needle sent", { sent: true });

    const { data } = await runSearch(["search", "Invoice needle"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject).sort()).toEqual([
      "Invoice needle received",
      "Invoice needle sent",
    ]);
    // Assert the SIDES, not just the count: two inbound rows would satisfy the
    // subject assertion above and prove nothing about sent coverage. This is
    // the check that caught the fixture bug described on seedMessage.
    //
    // Discriminated by FOLDER, deliberately not by the `kind` field: in local
    // mode `kind` reports STORAGE ORIGIN, so an imported sent message reads
    // "inbound" while correctly living in the Sent folder (data.local.ts labels
    // the synced_sent branch 'inbound'). In self-hosted mode `kind` reports
    // DIRECTION. Asserting on it would be a mode-specific truth dressed as a
    // general one.
    const inboxOnly = await runSearch(["search", "Invoice needle", "--folder", "inbox"]);
    expect((inboxOnly.data as Array<Record<string, unknown>>).map((row) => row.subject))
      .toEqual(["Invoice needle received"]);
  });

  it("narrows to one folder on --folder", async () => {
    seedMessage("Reconciliation needle received", { sent: false });
    seedMessage("Reconciliation needle sent", { sent: true });

    const { data } = await runSearch(["search", "Reconciliation needle", "--folder", "sent"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Reconciliation needle sent"]);
  });

  it("names the folders it searched when it finds nothing", async () => {
    seedMessage("Nothing relevant");

    const { data, out } = await runSearch(["search", "no-such-string-anywhere-zzz"]);

    expect(data).toEqual([]);
    expect(out).toContain("inbox");
    expect(out).toContain("sent");
  });
});
