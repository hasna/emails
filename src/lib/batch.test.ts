// The batch family has ONE implementation, and it reads its template through the
// store seam.
//
// The family used to be a facade over two modules that disagreed about what the
// operation MEANT: one rendered a template per CSV row and mailed it, the other threw
// because the caller was configured to talk to a service. The environment picked. What
// replaces that pick is the store's own answer — a store that cannot look a template up
// by name refuses, and the refusal is thrown, loudly, rather than being reported as a
// batch that sent nothing and hit no errors.
//
// The last distinction is the one worth testing hardest: `{ total: 1, sent: 0,
// failed: 0, suppressed: 0, errors: [] }` is the correct answer for an empty CSV, so it
// must never also be the answer for "this installation could not be asked".

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { Outcome } from "../store/outcome.js";
import type { ResourceRow } from "../store/records.js";
import type { Provider } from "../types/index.js";
import { batchSend, parseCsv, type BatchResult } from "./batch.js";

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
/**
 * A real provider row, minted through the seam.
 *
 * It has to be real: the sent-mail ledger's `emails.provider_id` is a foreign key, so
 * a made-up id makes every row fail with a constraint error — which the first run of
 * this suite duly reported, and which is exactly the per-row failure path that must
 * not be mistaken for a working batch.
 */
let SANDBOX_PROVIDER: Provider;

beforeEach(async () => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  const created = await realStore().providers.create({ name: "sandbox", type: "sandbox", active: 1 });
  if (!created.ok) throw new Error(`could not seed the provider: ${created.message}`);
  SANDBOX_PROVIDER = { id: String(created.value["id"]), name: "sandbox", type: "sandbox" } as unknown as Provider;
});

afterEach(() => {
  closeDatabase();
  restoreInheritedProcessEnv();
});

/** A real store over the test database. Everything below builds on this one. */
function realStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (batch test)" });
}

/**
 * The real store with ONE method replaced — the neutering pattern the store suites
 * use. A hand-rolled partial store cast to `EmailStore` would let a signature drift
 * without `tsc` noticing; this cannot, because `base` is checked against the seam.
 */
function storeAnsweringTemplateListWith(answer: Outcome<ResourceRow[]>): EmailStore {
  const base = realStore();
  return { ...base, templates: { ...base.templates, list: async () => answer } };
}

async function seedTemplate(store: EmailStore, row: ResourceRow): Promise<void> {
  const created = await store.templates.create(row);
  if (!created.ok) throw new Error(`could not seed the template: ${created.message}`);
}

describe("parseCsv", () => {
  it("parses CSV with headers", () => {
    const csv = "email,name,company\nalice@example.com,Alice,Acme\nbob@example.com,Bob,Corp";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice", company: "Acme" });
    expect(rows[1]).toEqual({ email: "bob@example.com", name: "Bob", company: "Corp" });
  });

  it("handles empty values", () => {
    const csv = "email,name\nalice@example.com,";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "" });
  });

  it("returns empty array for header-only CSV", () => {
    const csv = "email,name";
    expect(parseCsv(csv)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("trims whitespace from headers and values", () => {
    const csv = " email , name \n alice@example.com , Alice ";
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice" });
  });
});

describe("the batch family has one implementation", () => {
  it("ships no second implementation arm beside the facade", () => {
    const siblings = ["batch.local.ts", "batch.remote.ts", "batch.local.tsx", "batch.remote.tsx"];
    const present = siblings.filter((file) => existsSync(join(libDir, file)));
    expect(present).toEqual([]);
    // Positive control for the check itself: the detector must be able to SEE a
    // sibling, or "none present" is vacuous. `batch.ts` is a file in the same
    // directory and must be found by the same predicate.
    expect(existsSync(join(libDir, "batch.ts"))).toBe(true);
  });

  /**
   * The facade must not reach PAST a facade into one of its arms, and must not read
   * the deployment-mode axis module this program is deleting.
   *
   * "Reaches past a facade" is the hazard, and it is not the same as "imports a
   * `.local` module": `./sent-ledger.local.js` has no facade and no second arm, so
   * importing it bypasses nothing. So the check resolves each suffixed specifier and
   * asks whether a facade sibling EXISTS — which is the condition under which the
   * import skips a dispatch that other callers go through, and is what the deleted
   * `batch.local.ts` did to four separate families.
   *
   * Both checks carry fixtures. A source scan that stops matching passes everything
   * silently, and this repo has already shipped that failure twice.
   */
  it("reaches past no facade into an arm, and reads no deployment-mode module", () => {
    const suffixedImport = /from\s+["'](\.[^"']*)\.(?:local|remote)\.js["']/g;
    const axisImport = /from\s+["'][^"']*\/mode\.js["']/g;

    /** Specifiers in `text` whose family also ships a facade, resolved from `dir`. */
    const pastFacade = (text: string, dir: string): string[] =>
      [...text.matchAll(suffixedImport)]
        .map((match) => match[1] as string)
        .filter((base) => existsSync(join(dir, `${base}.ts`)) || existsSync(join(dir, `${base}.tsx`)));

    // Positive controls, checked against the predicate and not against repo state.
    expect(pastFacade('import * as local from "./batch.local.js";', libDir)).toEqual(["./batch"]);
    expect(pastFacade('import * as remote from "./batch.remote.js";', libDir)).toEqual(["./batch"]);
    expect(pastFacade('import { x } from "../db/contacts.local.js";', libDir)).toEqual(["../db/contacts"]);
    // Negative controls: no facade sibling, and a plain module.
    expect(pastFacade('import { x } from "./sent-ledger.local.js";', libDir)).toEqual([]);
    expect(pastFacade('import { parseCsv } from "./csv.js";', libDir)).toEqual([]);
    expect(new RegExp(axisImport.source).test('import { readTheMode } from "./mode.js";')).toBe(true);
    expect(new RegExp(axisImport.source).test('import { parseCsv } from "./csv.js";')).toBe(false);

    const source = readFileSync(join(libDir, "batch.ts"), "utf8");
    expect(source.length).toBeGreaterThan(500);
    expect(pastFacade(source, libDir)).toEqual([]);
    expect(source.match(axisImport) ?? []).toEqual([]);
  });

  it("no longer reaches into an arm from the CLI command that runs a batch", () => {
    const source = readFileSync(join(repoRoot, "src", "cli", "commands", "misc.local.ts"), "utf8");
    expect(source).toContain('import("../../lib/batch.js")');
    expect(source).not.toContain("lib/batch.local.js");
  });
});

describe("batchSend reads its template through the store seam", () => {
  it("renders the stored template and mails every row, over the configured store", async () => {
    await seedTemplate(realStore(), {
      name: "tpl",
      subject_template: "Hello {{name}}",
      text_template: "Body for {{email}}",
    });

    const sent: { to: string; subject: string; text?: string }[] = [];
    // NO `_store`: this exercises `createConfiguredEmailStore()` and therefore the
    // whole resolution path, not just the seam call.
    const result = await batchSend({
      csvPath: "unused.csv",
      templateName: "tpl",
      from: "agent@acme.com",
      provider: SANDBOX_PROVIDER,
      _csvContent: "email,name\nalice@example.com,Alice\nbob@example.com,Bob\n",
      _adapter: {
        sendEmail: async (opts) => {
          sent.push(opts as { to: string; subject: string; text?: string });
          return "mid";
        },
      },
    });

    expect(result).toEqual({ total: 2, sent: 2, failed: 0, suppressed: 0, errors: [] });
    expect(sent.map((message) => message.to)).toEqual(["alice@example.com", "bob@example.com"]);
    expect(sent.map((message) => message.subject)).toEqual(["Hello Alice", "Hello Bob"]);
    expect(sent[0]?.text).toBe("Body for alice@example.com");
    // The send was ledgered, which is what makes this the real path rather than a
    // rendering exercise.
    const ledgered = db.query("SELECT count(*) AS n FROM emails").get() as { n: number };
    expect(ledgered.n).toBe(2);
  });

  it("skips a suppressed row and counts it, rather than mailing it", async () => {
    const store = realStore();
    await seedTemplate(store, { name: "tpl", subject_template: "S", text_template: "B" });
    const contact = await store.contacts.create({ email: "blocked@ext.com", suppressed: 1 });
    expect(contact.ok).toBe(true);

    const sent: string[] = [];
    const result = await batchSend({
      csvPath: "unused.csv",
      templateName: "tpl",
      from: "agent@acme.com",
      provider: SANDBOX_PROVIDER,
      _csvContent: "email\nblocked@ext.com\nfine@ext.com\n",
      _adapter: {
        sendEmail: async (opts) => {
          sent.push((opts as { to: string }).to);
          return "mid";
        },
      },
    });

    expect(result.suppressed).toBe(1);
    expect(result.sent).toBe(1);
    expect(sent).toEqual(["fine@ext.com"]);
  });

  it("throws the store's refusal instead of reporting a batch that sent nothing", async () => {
    const store = storeAnsweringTemplateListWith({
      ok: false,
      code: "invalid_input",
      message: "/v1/templates does not filter on name",
      status: 422,
    });

    let outcome: BatchResult | Error;
    try {
      outcome = await batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
        _store: store,
      });
    } catch (error) {
      outcome = error as Error;
    }

    // The assertion that matters: NOT a `BatchResult`. A refusal reported as zero
    // sends and zero errors is indistinguishable from an empty CSV.
    expect(outcome).toBeInstanceOf(Error);
    const thrown = outcome as Error;
    expect(thrown.message).toContain("invalid_input");
    expect(thrown.message).toContain("/v1/templates does not filter on name");
    expect(thrown.message).toContain("tpl");
  });

  it("does not mail anything when the store refuses", async () => {
    const store = storeAnsweringTemplateListWith({
      ok: false,
      code: "capability_unavailable",
      message: "this store does not provide template reads",
      status: 501,
    });
    const sent: string[] = [];

    await expect(
      batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: {
          sendEmail: async (opts) => {
            sent.push((opts as { to: string }).to);
            return "mid";
          },
        },
        _store: store,
      }),
    ).rejects.toThrow(/capability_unavailable/);
    expect(sent).toEqual([]);
    const ledgered = db.query("SELECT count(*) AS n FROM emails").get() as { n: number };
    expect(ledgered.n).toBe(0);
  });

  it("reports a template the store does not hold as not found", async () => {
    await expect(
      batchSend({
        csvPath: "unused.csv",
        templateName: "absent",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
        _store: realStore(),
      }),
    ).rejects.toThrow("Template not found: absent");
  });

  it("refuses to guess when a filtered read answers with a row of another name", async () => {
    // A store that ignored the name filter and answered with the newest template
    // would otherwise have this batch render the WRONG template's subject.
    //
    // The database DOES hold a usable `tpl`, deliberately: without it, a batch that
    // ignored the store entirely and read SQLite itself would also refuse, and this
    // case would pass for a reason that has nothing to do with the seam.
    await seedTemplate(realStore(), { name: "tpl", subject_template: "Yours", text_template: "b" });
    const store = storeAnsweringTemplateListWith({
      ok: true,
      value: [{ name: "someone-elses", subject_template: "Not yours", text_template: "x" }],
    });

    await expect(
      batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
        _store: store,
      }),
    ).rejects.toThrow("Template not found: tpl");
  });

  it("refuses an ambiguous name rather than picking one of the matches", async () => {
    const store = storeAnsweringTemplateListWith({
      ok: true,
      value: [
        { name: "tpl", subject_template: "First", text_template: "x" },
        { name: "tpl", subject_template: "Second", text_template: "y" },
      ],
    });

    await expect(
      batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
        _store: store,
      }),
    ).rejects.toThrow(/matched 2 stored templates/);
  });

  it("refuses a stored subject that is not text rather than mailing its coercion", async () => {
    const store = storeAnsweringTemplateListWith({
      ok: true,
      value: [{ name: "tpl", subject_template: { toString: () => "surprise" }, text_template: "x" }],
    });

    await expect(
      batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
        _store: store,
      }),
    ).rejects.toThrow(/non-text subject_template/);
  });
});

describe("batchSend inherits the storage configuration contract", () => {
  it("refuses to run when the configuration names both a local database and an API", async () => {
    // The URL alone is enough: the contradiction is checked BEFORE the credential, so
    // this case needs no credential setting at all.
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
    try {
      const failure = batchSend({
        csvPath: "unused.csv",
        templateName: "tpl",
        from: "agent@acme.com",
        provider: SANDBOX_PROVIDER,
        _csvContent: "email\nalice@example.com\n",
        _adapter: { sendEmail: async () => "mid" },
      });
      await expect(failure).rejects.toThrow(/two configured places to keep its mail/);
    } finally {
      delete process.env["EMAILS_SELF_HOSTED_URL"];
    }
  });
});
