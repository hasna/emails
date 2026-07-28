// The collapsed email-operation tool family, exercised against the local SQLite
// store.
//
// WHY THIS FILE EXISTS. This family used to be three modules: a facade that read
// the process-wide deployment word and two sibling arm modules that registered the
// SAME seventeen tool names. Sixteen of the seventeen differed only in which
// module layer they imported. The seventeenth, `send_email`, differed in what it
// would ACCEPT — and that asymmetry is the one this file pins, because it is the
// one a collapse can get wrong quietly.
//
// The self-hosted half of the same surface is covered in
// src/mcp/self-hosted-guards.test.ts against the out-of-process /v1 stub. This
// file covers the local half, because local is where the deleted arm honoured
// options the single send path cannot carry, and therefore where "collapsed and
// silently dropped an option" would look exactly like success.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { suppressContact } from "../../db/contacts.local.js";
import { getEmailContent } from "../../db/email-content.js";
import { createProvider } from "../../db/providers.local.js";
import { listSandboxEmails } from "../../db/sandbox.js";
import { createWarmingSchedule } from "../../db/warming.local.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { registerEmailOpsTools } from "./email-ops.js";

interface RegisteredTool {
  handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  inputSchema?: unknown;
}

/**
 * Register the family on a BARE server — no contract wrapper — so an assertion
 * reads the handler's own answer rather than the wrapper's reformatting of it.
 */
function tools(): Record<string, RegisteredTool> {
  const server = new McpServer({ name: "email-ops-test", version: "1.0.0" });
  registerEmailOpsTools(server);
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

async function call(name: string, input: Record<string, unknown>) {
  const tool = tools()[name];
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return await tool.handler(input);
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

/** The seventeen tools this family owns. Spelled out so a LOSS is a failure. */
const FAMILY_TOOLS = [
  "send_email",
  "list_emails",
  "search_emails",
  "get_email",
  "get_email_content",
  "pull_events",
  "get_stats",
  "list_templates",
  "get_template",
  "add_template",
  "remove_template",
  "list_contacts",
  "suppress_contact",
  "unsuppress_contact",
  "schedule_email",
  "list_scheduled",
  "cancel_scheduled",
];

let providerId: string;

beforeEach(() => {
  resetDatabase();
  resetMailDataSource();
  providerId = createProvider({ name: "email-ops-sandbox", type: "sandbox", active: true }).id;
});

afterEach(() => {
  closeDatabase();
  resetMailDataSource();
});

describe("collapsed email-ops tool family", () => {
  it("registers every tool unconditionally, from one implementation", () => {
    // "Why is this tool missing?" must never have an answer that depends on the
    // environment. Registration is not a place to express a limitation.
    const registered = tools();
    for (const name of FAMILY_TOOLS) {
      expect(registered[name], `${name} must be registered`).toBeDefined();
    }
    // Non-emptiness, so a registration path that silently registered nothing
    // could not satisfy the loop above by vacuous truth.
    expect(FAMILY_TOOLS.length).toBe(17);
  });

  it("refuses each send option the one send path cannot carry, instead of ignoring it", async () => {
    // THE REGRESSION THIS PINS. The deleted local arm passed these four straight
    // into the provider-adapter send path, which honoured them. The one send path
    // this family now uses cannot carry them (src/lib/mail-data-source.ts, the
    // send input shape), so passing them through would DROP them and still report
    // success. For `auth_token` that is an authorization check that never ran.
    //
    // On the module this replaced, `auth_token` was honoured and the other three
    // were accepted and sent — so every assertion below is new behaviour, not a
    // restatement of the old.
    const cases: Array<[string, unknown]> = [
      ["auth_token", "esk_this_key_does_not_exist"],
      ["unsubscribe_url", "https://example.test/unsubscribe/1"],
      ["headers", { "X-Custom": "1" }],
      ["tags", { campaign: "spring" }],
    ];

    for (const [option, value] of cases) {
      const result = await call("send_email", {
        from: "agent@example.test",
        to: "recipient@example.test",
        subject: "uncarried",
        text: "hi",
        provider_id: providerId,
        [option]: value,
      });

      expect(result.isError, `${option} must be refused`).toBe(true);
      const message = text(result);
      // Machine-readable: the caller can branch on the code without matching prose.
      expect(message).toContain("option_not_carried");
      expect(message).toContain("status=422");
      // Actionable: it names the option at fault.
      expect(message).toContain(option);
      // A refusal must never teach its own circumvention. No setting, no
      // variable assignment, no "run it the other way".
      expect(message).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]*=/);
      // And it must be a REFUSAL, not a quiet success: nothing was sent.
      expect(await listSandboxEmails(providerId, 10), `${option} must not send`).toHaveLength(0);
    }
  });

  it("still refuses a suppressed recipient, with no force escape", async () => {
    // Carried over from the deleted local arm, which was the ONLY arm that had it.
    // The canonical comparison matters: a display-name form is the same recipient.
    suppressContact("blocked@example.test");

    const result = await call("send_email", {
      from: "agent@example.test",
      to: "Blocked Person <blocked@example.test>",
      subject: "Hi",
      text: "x",
      provider_id: providerId,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("suppressed recipient(s)");
    expect(await listSandboxEmails(providerId, 10)).toHaveLength(0);

    // No `force` escape. Asserted BEHAVIOURALLY rather than by inspecting the
    // schema: an absent key in a serialized zod object is vacuously true, so a
    // schema check would keep passing if a `force` branch were added to the
    // handler. Passing it must still refuse and still send nothing.
    const forced = await call("send_email", {
      from: "agent@example.test",
      to: "blocked@example.test",
      subject: "Hi",
      text: "x",
      provider_id: providerId,
      force: true,
    });
    expect(forced.isError).toBe(true);
    expect(text(forced)).toContain("suppressed recipient(s)");
    expect(await listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("still blocks a send that a warming schedule forbids", async () => {
    // POSITIVE CONTROL for a guard this collapse deleted from THIS module. The
    // deleted local arm re-implemented a warming pre-check here; the single send
    // path already enforces it downstream (src/lib/send.local.ts:40-52), so the
    // duplicate went away. If that reasoning were wrong, this test is where it
    // shows up — an unwarmed domain would send.
    //
    // A schedule that has not started yet has a limit of zero, so any send from
    // the domain is over it. That is the guard's fail-closed branch, not a fixture
    // trick: an unusable or future start date must not mean "go".
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    createWarmingSchedule({ domain: "warming.example.test", provider_id: providerId, target_daily_volume: 500, start_date: tomorrow });

    const result = await call("send_email", {
      from: "agent@warming.example.test",
      to: "recipient@example.test",
      subject: "over the warming limit",
      text: "x",
      provider_id: providerId,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Warming limit reached for warming.example.test");
    expect(await listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("sends a plain-text message without fabricating an HTML part", async () => {
    // The two arms disagreed about this and the disagreement was invisible: one
    // sent the text as given, the other markdown-rendered it into an HTML body the
    // caller never wrote. The collapse picks the first, explicitly, because this
    // tool has a separate `html` parameter for callers who want one.
    const sent = await call("send_email", {
      from: "agent@example.test",
      to: "recipient@example.test",
      subject: "text only",
      text: "line one\nline two",
      provider_id: providerId,
    });

    expect(sent.isError).not.toBe(true);
    const payload = JSON.parse(text(sent)) as { success: boolean; email_id: string };
    expect(payload.success).toBe(true);
    const content = await getEmailContent(payload.email_id);
    expect(content?.text_body).toBe("line one\nline two");
    expect(content?.html ?? null).toBeNull();
  });

  it("carries a template and its variables through the one send path", async () => {
    await call("add_template", {
      name: "collapse-welcome",
      subject_template: "Hello {{name}}",
      text_template: "Hi {{name}}.",
    });

    const sent = await call("send_email", {
      from: "agent@example.test",
      to: "recipient@example.test",
      template: "collapse-welcome",
      template_vars: { name: "Ada" },
      provider_id: providerId,
    });

    expect(sent.isError).not.toBe(true);
    const captured = await listSandboxEmails(providerId, 10);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).toContain("Hello Ada");
  });

  it("refuses a template that does not exist rather than sending an empty subject", async () => {
    const result = await call("send_email", {
      from: "agent@example.test",
      to: "recipient@example.test",
      template: "no-such-template",
      provider_id: providerId,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Template not found: no-such-template");
    expect(await listSandboxEmails(providerId, 10)).toHaveLength(0);
  });

  it("round-trips templates, contacts and the scheduled queue through one implementation", async () => {
    // The sixteen data tools were byte-identical between the two arms apart from
    // which module layer they imported, so what needs proving is that ONE
    // implementation still serves them end to end.
    await call("add_template", { name: "round-trip", subject_template: "S", text_template: "B" });
    const listed = JSON.parse(text(await call("list_templates", {}))) as Array<Record<string, unknown>>;
    expect(listed.map((row) => row["name"])).toContain("round-trip");
    // A lean summary on the list, the full row on the detail read. This projection
    // difference is why `list_templates` did NOT move to the store seam's generic
    // resource path, which cannot project — so it is asserted rather than assumed.
    // Compared on KEYS, not on a substring: the summary carries the boolean
    // `has_text_template`, and a substring check reads that as the body itself.
    expect(Object.keys(listed[0] ?? {})).not.toContain("text_template");
    expect(Object.keys(listed[0] ?? {})).toContain("has_text_template");
    const detail = JSON.parse(text(await call("get_template", { name_or_id: "round-trip" }))) as Record<string, unknown>;
    expect(Object.keys(detail)).toContain("text_template");
    expect(detail["text_template"]).toBe("B");
    expect(text(await call("remove_template", { name_or_id: "round-trip" }))).toContain("Template removed");

    await call("suppress_contact", { email: "someone@example.test" });
    const contacts = JSON.parse(text(await call("list_contacts", { suppressed: true }))) as Array<{ email: string }>;
    expect(contacts.map((row) => row.email)).toContain("someone@example.test");
    expect(text(await call("unsuppress_contact", { email: "someone@example.test" }))).toContain("unsuppressed");

    const scheduled = JSON.parse(text(await call("schedule_email", {
      from: "agent@example.test",
      to: ["a@example.test", "b@example.test"],
      subject: "later",
      text: "x",
      provider_id: providerId,
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    }))) as { id: string; to_addresses: string[] };
    expect(scheduled.to_addresses).toEqual(["a@example.test", "b@example.test"]);
    const queue = JSON.parse(text(await call("list_scheduled", { status: "pending" }))) as Array<{ id: string }>;
    expect(queue.map((row) => row.id)).toContain(scheduled.id);
    expect(text(await call("cancel_scheduled", { id: scheduled.id }))).toContain("cancelled");
  });

  it("reads a sent message back through list, search, get and content", async () => {
    const sent = await call("send_email", {
      from: "agent@example.test",
      to: "recipient@example.test",
      subject: "readback subject",
      text: "readback body",
      provider_id: providerId,
    });
    const emailId = (JSON.parse(text(sent)) as { email_id: string }).email_id;

    // The provider filter is a REAL filter, not decoration. This is the pair the
    // store seam's message list cannot express (no provider filter on its list
    // options), which is why this tool did not move onto it — so both halves are
    // asserted: the matching id returns the row, a foreign id returns none.
    const mine = JSON.parse(text(await call("list_emails", { provider_id: providerId, limit: 10 }))) as unknown[];
    expect(mine).toHaveLength(1);
    const otherProvider = createProvider({ name: "email-ops-other", type: "sandbox", active: false }).id;
    const theirs = JSON.parse(text(await call("list_emails", { provider_id: otherProvider, limit: 10 }))) as unknown[];
    expect(theirs).toHaveLength(0);
    // ...and the status filter, the other one the seam cannot express.
    const bounced = JSON.parse(text(await call("list_emails", { status: "bounced", limit: 10 }))) as unknown[];
    expect(bounced).toHaveLength(0);
    const sent2 = JSON.parse(text(await call("list_emails", { status: "sent", limit: 10 }))) as unknown[];
    expect(sent2).toHaveLength(1);

    const found = JSON.parse(text(await call("search_emails", { query: "readback subject" }))) as unknown[];
    expect(found).toHaveLength(1);

    expect(text(await call("get_email", { email_id: emailId }))).toContain("readback subject");
    expect(text(await call("get_email_content", { email_id: emailId }))).toContain("readback body");
  });

  it("answers an unknown id with a not-found refusal, never with an empty result", async () => {
    // The failure mode this rules out: a read that cannot find its subject and
    // answers `null`, `{}` or `[]`. An empty answer is indistinguishable from a
    // real empty result, so the caller cannot tell "no such message" from "no
    // content", and an agent reports the wrong thing to the operator.
    for (const name of ["get_email", "get_email_content"]) {
      const result = await call(name, { email_id: "00000000-0000-4000-8000-000000000000" });
      expect(result.isError, `${name} must refuse an unknown id`).toBe(true);
      const message = text(result);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe("[]");
      expect(message).not.toBe("null");
    }

    const missing = await call("cancel_scheduled", { id: "00000000-0000-4000-8000-000000000000" });
    expect(missing.isError).toBe(true);
  });
});
