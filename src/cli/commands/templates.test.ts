// Self-hosted-ONLY: the templates repo routes every read/write to `/v1/templates`,
// so these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore. Template rendering
// (`preview`) is a pure client-side transform of an API-fetched template, so it now
// runs against the self-hosted API instead of failing closed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createTemplate } from "../../db/templates.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerTemplateCommands } from "./templates.js";

let stub: V1Stub;

async function runTemplateCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  const originalLog = console.log;
  registerTemplateCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  console.log = ((...values: unknown[]) => {
    out.push(values.map(String).join(" "));
  }) as typeof console.log;
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: out.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("template list command", () => {
  it("paginates templates for human and structured output", async () => {
    await stub.seed({
      templates: [0, 1, 2, 3, 4].map((i) => ({
        id: `tpl-${i}`,
        name: `cli-template-${i}`,
        subject_template: `Template ${i}`,
        html_template: null,
        text_template: null,
        metadata: {},
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const result = await runTemplateCommand(["template", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((template) => template.name)).toEqual(["cli-template-3", "cli-template-2"]);
    expect(result.out).toContain("cli-template-3");
    expect(result.out).not.toContain("cli-template-4");
  });

  it("returns lean structured rows without template bodies", async () => {
    createTemplate({
      name: "body-heavy",
      subject_template: "Body heavy",
      html_template: `<main>${"CLI hidden html ".repeat(100)}</main>`,
      text_template: "CLI hidden text ".repeat(100),
    });

    const result = await runTemplateCommand(["template", "list", "--limit", "1"]);
    const data = result.data as Array<Record<string, unknown>>;

    expect(data[0]?.name).toBe("body-heavy");
    expect(data[0]?.has_html_template).toBe(true);
    expect(data[0]?.has_text_template).toBe(true);
    expect(data[0]).not.toHaveProperty("html_template");
    expect(data[0]).not.toHaveProperty("text_template");
    expect(JSON.stringify(data)).not.toContain("CLI hidden");
  });
});

describe("preview command", () => {
  it("renders a terminal template preview from the self-hosted API", async () => {
    createTemplate({
      name: "preview-tpl",
      subject_template: "Hello {{name}}",
      html_template: "<p>Hello {{name}}</p>",
    });

    const result = await runTemplateCommand(["preview", "preview-tpl", "--vars", "{\"name\":\"Ada\"}"]);

    expect(result.out).toContain("Subject:");
    expect(result.out).toContain("Hello Ada");
    expect(result.out).toContain("<p>Hello Ada</p>");
  });
});
