// The templates family — the message templates a send renders from — over the store
// seam, against BOTH shipped stores.
//
// WHAT CHANGED AND WHY THE FIXTURE CHANGED WITH IT. This suite used to drive the
// out-of-process `/v1` stub, because the family's second arm talked to `/v1` through a
// blocking bridge. `src/db/templates.ts` has collapsed onto the store seam, so the same
// operations now reach `/v1` through the REAL `HttpEmailStore` — which reads the
// service's published contract before any write — and reach SQLite through the real
// `SqliteEmailStore`. The fixture is `src/test-support/v1-store-api.ts`: a `/v1`
// service that stores nothing and translates every request onto the same store seam,
// backed by the same in-memory database the SQLite variant reads. Both variants answer
// from ONE dataset, so a client that mis-maps a field fails here instead of being
// handed its own mistake back.
//
// THE CASE SEEDED PAST 500 ROWS IS THE POINT OF THE COLLAPSE. Both stores clamp a list
// page to 500 rows, and the deleted second arm answered every NAME lookup out of ONE
// such page: a template past the clamp was unfindable by name — `template show` and
// `template remove` answered "not found" for a real template, and every send-flow
// resolution that names a template failed the same way. That case sits below with a
// raw one-page CONTROL proving the clamp is real, so the whole-set discipline cannot
// pass vacuously.
//
// THE PINNED CONTRACTS (deliberate, not legacy drift — src/db/templates.ts,
// divergences 4-6): malformed metadata maps to `{}`; an id always resolves before a
// name; a duplicate name is the store's own typed refusal; and `renderTemplate` leaves
// a placeholder with no value RAW rather than substituting an invented sample.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  getTemplateByName,
  listTemplates,
  listTemplateSummaries,
  renderTemplate,
  type TemplateStore,
} from "./templates.js";
import { createHttpEmailStore } from "../store-http/index.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
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
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Leave exactly ONE store configured, named through the resolution's OWN exported
 * constants: a stray inherited API setting beside the database path is a hard boot
 * error with deliberately no precedence rule, and it would turn every default-store
 * case into that error.
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

function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

beforeEach(() => {
  captureInheritedProcessEnv();
  configureExactlyOneStore();
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "template row fixture" }) });
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

function sqliteStore(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (templates test)" });
}

function httpStore(): EmailStore {
  return createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
}

const STORE_VARIANTS: ReadonlyArray<[string, () => EmailStore]> = [
  ["SQLite store", sqliteStore],
  ["HTTP store over /v1", httpStore],
];

// ─── Seeding straight into the shared table ─────────────────────────────────
//
// A case that needs chosen ids, chosen timestamps, or more rows than one page holds
// writes the table directly. Both variants read this same data.

function seedTemplate(row: {
  id: string;
  name: string;
  subject_template?: string;
  html_template?: string | null;
  text_template?: string | null;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
}): void {
  const at = row.created_at ?? "2026-01-01T00:00:00.000Z";
  db.run(
    `INSERT INTO templates (id, name, subject_template, html_template, text_template, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.subject_template ?? "Subject",
      row.html_template ?? null,
      row.text_template ?? null,
      row.metadata ?? "{}",
      at,
      row.updated_at ?? at,
    ],
  );
}

/** Raw rows for one name, straight from the table — the duplicate detector. */
function rowsNamed(name: string): Array<{ id: string }> {
  return db.query("SELECT id FROM templates WHERE name = ?").all(name) as Array<{ id: string }>;
}

const pad = (value: number): string => String(value).padStart(3, "0");

describe.each(STORE_VARIANTS)("template CRUD (%s)", (_label, variant) => {
  it("creates a template with every field and empty metadata", async () => {
    const t = await createTemplate(
      {
        name: "welcome",
        subject_template: "Welcome {{name}}",
        html_template: "<h1>Hello {{name}}</h1>",
        text_template: "Hello {{name}}",
      },
      variant(),
    );
    expect(t.id).toHaveLength(36);
    expect(t.name).toBe("welcome");
    expect(t.subject_template).toBe("Welcome {{name}}");
    expect(t.html_template).toBe("<h1>Hello {{name}}</h1>");
    expect(t.text_template).toBe("Hello {{name}}");
    expect(t.metadata).toEqual({});
    expect(t.created_at).toBeTruthy();
    expect(t.updated_at).toBeTruthy();
  });

  it("stores an absent or empty body as null", async () => {
    const store = variant();
    const bare = await createTemplate({ name: "bare", subject_template: "Hello" }, store);
    expect(bare.html_template).toBeNull();
    expect(bare.text_template).toBeNull();
    // The `|| null` both deleted arms applied: empty string is not a body.
    const blank = await createTemplate(
      { name: "blank-bodies", subject_template: "Hello", html_template: "", text_template: "" },
      store,
    );
    expect(blank.html_template).toBeNull();
    expect(blank.text_template).toBeNull();
  });

  it("refuses a duplicate name with the store's own refusal — never a second row", async () => {
    const store = variant();
    await createTemplate({ name: "taken", subject_template: "First" }, store);
    // UNIQUE(name) is the STORE's constraint on both shipped schemas (divergence 5);
    // the deleted facade's suite dropped this as "server-side now", which left the
    // local island's behaviour unpinned.
    await expect(createTemplate({ name: "taken", subject_template: "Second" }, store)).rejects.toThrow(
      /cannot create a template/,
    );
    expect(rowsNamed("taken")).toHaveLength(1);
  });

  it("resolves an id before a name, which never shadows an id (divergence 5)", async () => {
    seedTemplate({ id: "t-ref", name: "alpha", subject_template: "By id" });
    // A template NAMED like another's id — reachable, and the reason the precedence
    // must be pinned: both deleted arms tried the id first.
    seedTemplate({ id: "t-shadow", name: "t-ref", subject_template: "By name" });
    const store = variant();
    expect((await getTemplate("t-ref", store))?.id).toBe("t-ref");
    expect((await getTemplate("alpha", store))?.id).toBe("t-ref");
    expect((await getTemplate("t-shadow", store))?.id).toBe("t-shadow");
  });

  it("answers null for an unknown or blank reference", async () => {
    const store = variant();
    seedTemplate({ id: "t-real", name: "real" });
    expect(await getTemplate("nonexistent", store)).toBeNull();
    // Blank is not a reference — and through an API, a blank path segment is a
    // DIFFERENT route (the list), whose answer must not become "some template".
    expect(await getTemplate("   ", store)).toBeNull();
    expect(await getTemplate("", store)).toBeNull();
  });

  it("resolves getTemplateByName by exact name only — never by id", async () => {
    seedTemplate({ id: "t-name", name: "lookup", subject_template: "Named" });
    const store = variant();
    expect((await getTemplateByName("lookup", store))?.id).toBe("t-name");
    expect(await getTemplateByName("t-name", store)).toBeNull();
    expect(await getTemplateByName("nope", store)).toBeNull();
  });

  it("tolerates malformed metadata and maps it to {} (divergence 4)", async () => {
    seedTemplate({ id: "t-bad", name: "badmeta", metadata: "not-json" });
    const found = await getTemplate("t-bad", variant());
    expect(found?.metadata).toEqual({});
  });

  it("deletes by name and by id; false for a row that is not there", async () => {
    const store = variant();
    seedTemplate({ id: "t-del-name", name: "del-by-name" });
    seedTemplate({ id: "t-del-id", name: "del-by-id" });
    expect(await deleteTemplate("del-by-name", store)).toBe(true);
    expect(await getTemplate("del-by-name", store)).toBeNull();
    expect(await deleteTemplate("t-del-id", store)).toBe(true);
    expect(await getTemplate("t-del-id", store)).toBeNull();
    expect(await deleteTemplate("nonexistent", store)).toBe(false);
    expect(await deleteTemplate("  ", store)).toBe(false);
  });
});

describe.each(STORE_VARIANTS)("template listings (%s)", (_label, variant) => {
  it("lists newest-CREATED first whatever order the store serves (divergence 2)", async () => {
    // The SQLite store's generic list serves `updated_at DESC`; the service serves
    // `created_at DESC`. These rows INVERT the two orders — a listing that trusted
    // either store's own order would answer differently per store, and the family
    // promised created_at. The id tiebreaker resolves the shared instant (divergence
    // 3) without `localeCompare`.
    seedTemplate({ id: "t-a", name: "old-created-fresh-touch", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z" });
    seedTemplate({ id: "t-b", name: "new-created-stale-touch", created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" });
    seedTemplate({ id: "t-tie-1", name: "tie-low", created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z" });

    const listed = await listTemplates(undefined, variant());
    expect(listed.map((template) => template.id)).toEqual(["t-tie-1", "t-b", "t-a"]);
  });

  it("windows AFTER sorting the whole set; no limit means every row", async () => {
    for (let i = 0; i < 5; i++) {
      seedTemplate({ id: `t-page-${i}`, name: `page-${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    const store = variant();
    const page = await listTemplates({ limit: 2, offset: 1 }, store);
    expect(page.map((template) => template.name)).toEqual(["page-3", "page-2"]);
    // The deleted SQLite arm's LIMIT-gated clause ignored a bare offset; preserved.
    expect(await listTemplates({ offset: 3 }, store)).toHaveLength(5);
  });

  it("accepts both published argument orders for the listing exports", async () => {
    seedTemplate({ id: "t-order", name: "either-order" });
    const store = variant();
    // The deleted SQLite arm took (store, opts); the facade's shim took (opts, store);
    // the facade's intersection type made both compile for the whole 1.x line.
    expect((await listTemplates(store, { limit: 1 })).map((t) => t.name)).toEqual(["either-order"]);
    expect((await listTemplates({ limit: 1 }, store)).map((t) => t.name)).toEqual(["either-order"]);
    expect((await listTemplateSummaries(store, { limit: 1 })).map((t) => t.name)).toEqual(["either-order"]);
  });

  it("summarises without the bodies: flags present, text ABSENT", async () => {
    seedTemplate({
      id: "t-large",
      name: "large",
      subject_template: "Large {{name}}",
      html_template: `<main>${"large html body ".repeat(300)}</main>`,
      text_template: "",
      created_at: "2026-01-02T00:00:00.000Z",
    });
    seedTemplate({ id: "t-bodyless", name: "bodyless", created_at: "2026-01-01T00:00:00.000Z" });

    const [summary, bodyless] = await listTemplateSummaries(undefined, variant());
    expect(summary?.name).toBe("large");
    expect(summary?.has_html_template).toBe(true);
    // An EMPTY body counts as no body — the SQL both arms agreed on (`!= ''`).
    expect(summary?.has_text_template).toBe(false);
    expect(bodyless?.has_html_template).toBe(false);
    expect("html_template" in summary!).toBe(false);
    expect("text_template" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large html body");
  });
});

describe("template name lookups past one clamped page", () => {
  it("finds, deletes ONCE, and lists whole — and the clamp is real", async () => {
    // 520 templates; the needle sorts BELOW the first 500 of the store's own
    // updated_at order because its updated_at is the oldest.
    for (let i = 0; i < 520; i++) {
      seedTemplate({ id: `t-${pad(i)}`, name: `bulk-${pad(i)}`, updated_at: `2026-02-01T00:00:${pad(i)}Z`, created_at: "2026-01-02T00:00:00.000Z" });
    }
    seedTemplate({ id: "t-needle", name: "needle", updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" });

    const store = httpStore();
    // CONTROL: one page really cannot see the whole table — without this the
    // whole-set claims below could pass over a fixture that never clamped anything.
    const onePage = await store.templates.list({ limit: 1000 });
    if (!onePage.ok) throw new Error(onePage.message);
    expect(onePage.value.length).toBe(500);

    // The deleted arm's one-page name scan answered "not found" for all three of
    // these — and `template remove` therefore refused to remove a real template.
    expect((await getTemplate("needle", store))?.id).toBe("t-needle");
    expect((await getTemplateByName("needle", store))?.id).toBe("t-needle");

    // A listing is the whole table, never 500 of 521.
    expect(await listTemplates(undefined, store)).toHaveLength(521);

    expect(await deleteTemplate("needle", store)).toBe(true);
    expect(rowsNamed("needle")).toHaveLength(0);
    expect(await listTemplates(undefined, store)).toHaveLength(520);
  });
});

describe("the store argument", () => {
  it("refuses a value that is neither an EmailStore nor a Database, naming both", async () => {
    await expect(
      listTemplates(undefined, { not: "a store" } as unknown as TemplateStore),
    ).rejects.toThrow(/EmailStore or a bun:sqlite Database/);
  });
});

// ─── Stores the shipped pair does not exhibit, driven through the seam ──────
//
// The published surface accepts ANY `EmailStore`, so the behaviours below are part of
// the contract even though neither shipped store shows them: a pager whose window
// cannot be walked to the end honestly, and a projection that loses a NOT NULL column.

describe("a store whose pages cannot be read to the end", () => {
  it("is refused with the lower-bound explanation, never presented as a short answer", async () => {
    seedTemplate({ id: "t-x", name: "x" });
    seedTemplate({ id: "t-y", name: "y" });
    const base = sqliteStore();
    // Every page is the same two rows whatever the offset: the window never moves, so
    // the enumeration proves duplicates/shift and must refuse rather than answer.
    const dishonest: EmailStore = {
      ...base,
      templates: {
        ...base.templates,
        list: () => base.templates.list({ limit: 2, offset: 0 }),
      },
    };
    await expect(listTemplates(undefined, dishonest)).rejects.toThrow(/LOWER BOUND/);
    // A name lookup rides the same enumeration; a "not found" from a partial read
    // would be the deleted arm's bug again, so it refuses the same way.
    await expect(getTemplateByName("y", dishonest)).rejects.toThrow(/LOWER BOUND/);
  });
});

describe("a store that loses a NOT NULL timestamp", () => {
  it("is a named projection fault, never the current time (divergence 4)", async () => {
    seedTemplate({ id: "t-dated", name: "dated" });
    const base = sqliteStore();
    const undated: EmailStore = {
      ...base,
      templates: {
        ...base.templates,
        list: async (opts) => {
          const outcome = await base.templates.list(opts);
          if (!outcome.ok) return outcome;
          return { ...outcome, value: outcome.value.map(({ created_at: _lost, ...rest }) => rest) };
        },
      },
    };
    await expect(listTemplates(undefined, undated)).rejects.toThrow(
      /refusing to report the current time/,
    );
  });
});

describe("renderTemplate", () => {
  it("replaces single variable", () => {
    expect(renderTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
  });

  it("replaces multiple variables", () => {
    const result = renderTemplate("{{greeting}} {{name}}, your order #{{order}} is ready", {
      greeting: "Hi",
      name: "Alice",
      order: "12345",
    });
    expect(result).toBe("Hi Alice, your order #12345 is ready");
  });

  it("leaves unknown variables as-is", () => {
    expect(renderTemplate("Hello {{name}} {{unknown}}", { name: "World" })).toBe(
      "Hello World {{unknown}}",
    );
  });

  it("leaves a placeholder raw for empty vars — pinned contract, not an accident (divergence 6)", () => {
    expect(renderTemplate("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  it("handles template with no variables", () => {
    expect(renderTemplate("No vars here", { name: "ignored" })).toBe("No vars here");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", { name: "World" })).toBe("");
  });
});
