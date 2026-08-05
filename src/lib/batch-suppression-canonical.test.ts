// A suppressed contact stays suppressed however the CSV spells the address.
//
// `getSuppressedEmailSet` returns a set holding the STORED spelling and the
// CANONICAL (lowercased addr-spec) form of every suppressed contact — and the CLI
// send path already compares recipients canonically for exactly this reason. The
// batch path tested the RAW CSV string against that set, so a CSV row spelled
// `Blocked@Ext.com` (or `Blocked Person <blocked@ext.com>`) against a suppressed
// contact `blocked@ext.com` matched neither entry, was MAILED, and was counted
// sent. That is a compliance failure: suppression means "never mail this person",
// not "never mail this exact byte string".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Provider } from "../types/index.js";
import { batchSend } from "./batch.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: Database;
let SANDBOX_PROVIDER: Provider;

function realStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (batch suppression case test)" });
}

beforeEach(async () => {
  INHERITED_PROCESS_ENV = { ...process.env };
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  const store = realStore();
  const created = await store.providers.create({ name: "sandbox", type: "sandbox", active: 1 });
  if (!created.ok) throw new Error(`could not seed the provider: ${created.message}`);
  SANDBOX_PROVIDER = { id: String(created.value["id"]), name: "sandbox", type: "sandbox" } as unknown as Provider;
  const template = await store.templates.create({ name: "tpl", subject_template: "S", text_template: "B" });
  if (!template.ok) throw new Error(`could not seed the template: ${template.message}`);
  const contact = await store.contacts.create({ email: "blocked@ext.com", suppressed: 1 });
  if (!contact.ok) throw new Error(`could not seed the contact: ${contact.message}`);
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

/** Run the batch over one CSV body, capturing every address the adapter mails. */
async function runBatch(csvContent: string): Promise<{ sent: string[]; suppressed: number; sentCount: number }> {
  const sent: string[] = [];
  const result = await batchSend({
    csvPath: "unused.csv",
    templateName: "tpl",
    from: "agent@acme.com",
    provider: SANDBOX_PROVIDER,
    _csvContent: csvContent,
    _adapter: {
      sendEmail: async (opts) => {
        sent.push((opts as { to: string }).to);
        return "mid";
      },
    },
  });
  return { sent, suppressed: result.suppressed, sentCount: result.sent };
}

describe("batchSend suppression is canonical, matching the CLI send path", () => {
  it("suppresses a CSV row whose spelling differs from the stored contact only in case", async () => {
    const outcome = await runBatch("email\nBlocked@Ext.com\n");

    // The whole defect: the raw-string test mailed this row and counted it sent.
    expect(outcome.sent).toEqual([]);
    expect(outcome.suppressed).toBe(1);
    expect(outcome.sentCount).toBe(0);
  });

  it("suppresses a CSV row that wraps the suppressed address in a display name", async () => {
    // No quotes: this repo's CSV parser is comma-split, and the display-name form
    // carries no comma. The value reaches the suppression test verbatim.
    const outcome = await runBatch("email\nBlocked Person <blocked@ext.com>\n");

    expect(outcome.sent).toEqual([]);
    expect(outcome.suppressed).toBe(1);
    expect(outcome.sentCount).toBe(0);
  });

  it("still suppresses the exact stored spelling and still mails an unrelated recipient", async () => {
    const outcome = await runBatch("email\nblocked@ext.com\nfine@ext.com\n");

    expect(outcome.sent).toEqual(["fine@ext.com"]);
    expect(outcome.suppressed).toBe(1);
    expect(outcome.sentCount).toBe(1);
  });
});
