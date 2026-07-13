// Self-hosted-ONLY: the templates repo routes every read/write to the /v1
// `templates` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. DELETED test:
//   - "throws on duplicate name": this was a SQLite UNIQUE(name) constraint;
//     name uniqueness is now enforced server-side by /v1, not by the client
//     (createTemplate does no client-side dedup), so the client no longer throws.
//
// Also DROPPED: the SQL-projection inspection in the summary test (recording
// db.query, asserting the projected column list). The meaningful part — summaries
// carry has_html_template/has_text_template flags and never carry the body
// columns — is retained functionally.
//
// KEEP: field mapping + metadata coercion (cobj tolerates malformed JSON), name
// vs id lookup, summary shaping, ordering + pagination, delete-by-name/id, and the
// pure renderTemplate helper.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createTemplate,
  getTemplate,
  getTemplateByName,
  listTemplates,
  listTemplateSummaries,
  deleteTemplate,
  renderTemplate,
} from "./templates.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

/** A snake_case /v1 template row with the fields apiToTemplate reads. */
function tmpl(row: {
  id: string;
  name: string;
  subject_template?: string;
  html_template?: string | null;
  text_template?: string | null;
  metadata?: unknown;
  created_at?: string;
}): Record<string, unknown> {
  const ts = row.created_at ?? "2026-01-01T00:00:00.000Z";
  return {
    id: row.id,
    name: row.name,
    subject_template: row.subject_template ?? "Subject",
    html_template: row.html_template ?? null,
    text_template: row.text_template ?? null,
    metadata: row.metadata ?? {},
    created_at: ts,
    updated_at: ts,
  };
}

describe("createTemplate", () => {
  it("creates a template with all fields", () => {
    const t = createTemplate({
      name: "welcome",
      subject_template: "Welcome {{name}}",
      html_template: "<h1>Hello {{name}}</h1>",
      text_template: "Hello {{name}}",
    });
    expect(t.id).toHaveLength(36);
    expect(t.name).toBe("welcome");
    expect(t.subject_template).toBe("Welcome {{name}}");
    expect(t.html_template).toBe("<h1>Hello {{name}}</h1>");
    expect(t.text_template).toBe("Hello {{name}}");
    expect(t.metadata).toEqual({});
  });

  it("creates a template with only subject", () => {
    const t = createTemplate({
      name: "simple",
      subject_template: "Hello",
    });
    expect(t.html_template).toBeNull();
    expect(t.text_template).toBeNull();
  });
});

describe("getTemplate", () => {
  it("retrieves by id", () => {
    const t = createTemplate({ name: "byid", subject_template: "Test" });
    const found = getTemplate(t.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(t.id);
  });

  it("tolerates malformed metadata JSON stored on /v1", async () => {
    await stub.seed({
      templates: [tmpl({ id: "t-bad", name: "badmeta", subject_template: "Test", metadata: "not-json" })],
    });

    const found = getTemplate("t-bad");
    expect(found?.metadata).toEqual({});
  });

  it("retrieves by name", () => {
    createTemplate({ name: "byname", subject_template: "Test" });
    const found = getTemplate("byname");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("byname");
  });

  it("returns null for unknown", () => {
    expect(getTemplate("nonexistent")).toBeNull();
  });
});

describe("getTemplateByName", () => {
  it("retrieves by name", () => {
    createTemplate({ name: "lookup", subject_template: "Test" });
    const found = getTemplateByName("lookup");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("lookup");
  });

  it("returns null for unknown name", () => {
    expect(getTemplateByName("nope")).toBeNull();
  });
});

describe("listTemplates", () => {
  it("returns empty array when no templates", () => {
    expect(listTemplates()).toEqual([]);
  });

  it("lists all templates", () => {
    createTemplate({ name: "a", subject_template: "A" });
    createTemplate({ name: "b", subject_template: "B" });
    const list = listTemplates();
    expect(list.length).toBe(2);
  });

  it("paginates templates after ordering newest first", async () => {
    await stub.seed({
      templates: Array.from({ length: 5 }, (_v, i) =>
        tmpl({ id: `t${i}`, name: `page-${i}`, subject_template: `Subject ${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
    });

    const page = listTemplates({ limit: 2, offset: 1 });

    expect(page.map((template) => template.name)).toEqual(["page-3", "page-2"]);
  });
});

describe("listTemplateSummaries", () => {
  it("omits template body columns and carries has_* flags", () => {
    createTemplate({
      name: "large",
      subject_template: "Large {{name}}",
      html_template: `<main>${"large html body ".repeat(300)}</main>`,
      text_template: "large text body ".repeat(300),
    });

    const [summary] = listTemplateSummaries({ limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.name).toBe("large");
    expect(summary?.has_html_template).toBe(true);
    expect(summary?.has_text_template).toBe(true);
    expect("html_template" in summary!).toBe(false);
    expect("text_template" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large html body");
    expect(JSON.stringify(summary)).not.toContain("large text body");
  });

  it("paginates summaries after ordering newest first", async () => {
    await stub.seed({
      templates: Array.from({ length: 5 }, (_v, i) =>
        tmpl({
          id: `t${i}`,
          name: `summary-${i}`,
          subject_template: `Summary ${i}`,
          html_template: i % 2 === 0 ? "<p>html</p>" : null,
          created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      ),
    });

    const page = listTemplateSummaries({ limit: 2, offset: 1 });

    expect(page.map((template) => template.name)).toEqual(["summary-3", "summary-2"]);
    expect(page.map((template) => template.has_html_template)).toEqual([false, true]);
  });
});

describe("deleteTemplate", () => {
  it("deletes by name", () => {
    createTemplate({ name: "del", subject_template: "Test" });
    expect(deleteTemplate("del")).toBe(true);
    expect(getTemplate("del")).toBeNull();
  });

  it("deletes by id", () => {
    const t = createTemplate({ name: "delid", subject_template: "Test" });
    expect(deleteTemplate(t.id)).toBe(true);
    expect(getTemplate(t.id)).toBeNull();
  });

  it("returns false for unknown", () => {
    expect(deleteTemplate("nonexistent")).toBe(false);
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

  it("handles empty vars", () => {
    expect(renderTemplate("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  it("handles template with no variables", () => {
    expect(renderTemplate("No vars here", { name: "ignored" })).toBe("No vars here");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", { name: "World" })).toBe("");
  });
});
