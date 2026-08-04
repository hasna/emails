// Self-hosted-ONLY: the sent-email log/search/show/thread commands route every
// read through the mail-data-source seam to `/v1/messages` (direction=outbound
// for the "sent log"). There is no local SQLite island. Local-only surfaces
// (test-send, export/reporting, the webhook listener) have no /v1 equivalent and
// fail loud. These tests drive the REAL commands against an out-of-process /v1
// stub (see src/test-support/v1-stub.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub, type V1StubResources } from "../../test-support/v1-stub.js";
import { registerEmailLogCommands } from "./email-log.js";

let stub: V1Stub;

type MessageSeed = Record<string, unknown>;

// A SEEDED OUTBOUND ROW CARRIES A DELIVERY STATUS, because a real one always does.
//
// The stub defaults an unset `status` to `received`, and nothing used to look: the deleted
// arm's mapper coerced any unrecognised status to `sent`. `src/db/emails` now FAULTS on a
// status outside the five delivery states rather than reporting a received message as a sent
// one, so an outbound row with no status is a fixture that could not exist in either real
// store — SQLite derives `sent` from `is_sent` and the service writes a send status — and
// leaving it unset would be testing the fault instead of the export.
function outbound(id: string, subject: string, receivedAt: string, extra: MessageSeed = {}): MessageSeed {
  return {
    id,
    direction: "outbound",
    status: "sent",
    from_addr: "agent@example.com",
    to_addrs: ["dest@example.com"],
    subject,
    body_text: "body",
    received_at: receivedAt,
    is_read: true,
    labels: [],
    ...extra,
  };
}

function inbound(id: string, subject: string, receivedAt: string, extra: MessageSeed = {}): MessageSeed {
  return {
    id,
    direction: "inbound",
    from_addr: "ext@example.com",
    to_addrs: ["me@example.com"],
    subject,
    body_text: "body",
    received_at: receivedAt,
    is_read: false,
    labels: [],
    ...extra,
  };
}

async function seed(messages: MessageSeed[]): Promise<void> {
  await stub.seed({ messages } as V1StubResources);
}

async function runEmailLogCommand(args: string[]) {
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

async function runEmailLogCommandExpectingExit(args: string[]): Promise<string> {
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  (console as unknown as { error: (...v: unknown[]) => void }).error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never;
  try {
    await expect(runEmailLogCommand(args)).rejects.toThrow(/process\.exit/);
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
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

describe("email list / log — routes to the /v1 sent log", () => {
  it("paginates outbound mail newest-first and never leaks idempotency keys", async () => {
    await seed([
      outbound("out-0", "Paged sent 0", "2026-01-01T00:00:00.000Z", { idempotency_key: "list-secret-0" }),
      outbound("out-1", "Paged sent 1", "2026-01-01T00:01:00.000Z", { idempotency_key: "list-secret-1" }),
      outbound("out-2", "Paged sent 2", "2026-01-01T00:02:00.000Z", { idempotency_key: "list-secret-2" }),
    ]);

    const { data } = await runEmailLogCommand(["email", "list", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Paged sent 1", "Paged sent 0"]);
    expect(rows[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(rows)).not.toContain("list-secret");
  });

  it("returns only outbound mail (direction=outbound) and titles the list", async () => {
    await seed([
      inbound("in-1", "Inbound only", "2026-01-02T00:00:00.000Z"),
      outbound("out-1", "Server sent subject", "2026-01-03T00:00:00.000Z"),
    ]);

    const { data, out } = await runEmailLogCommand(["email", "list"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "out-1", subject: "Server sent subject" });
    expect(out).toContain("Self-hosted sent mail");
  });

  it("rejects local-only sent-log filters that have no /v1 surface", async () => {
    const errors = await runEmailLogCommandExpectingExit(["log", "--provider", "local-provider"]);
    expect(errors).toContain("does not support local sent-log filter(s): --provider");
  });

  it("rejects --status and --from sent-log filters together", async () => {
    const errors = await runEmailLogCommandExpectingExit(["email", "list", "--status", "bounced", "--from", "a@x.com"]);
    expect(errors).toContain("--status");
    expect(errors).toContain("--from");
  });
});

describe("search — routes search to /v1", () => {
  // CONTRACT REVERSED 2026-08-04, task db244cd4. This test previously read
  // "searches outbound mail only, ignoring matching inbound mail" and asserted
  // `["Searchable Alpha"]` — i.e. it LOCKED IN the defect: the top-level verb
  // dropping every inbound match. The sent-only contract still exists and is
  // still tested, on `emails email search`, whose namespace declares it.
  //
  // Recorded rather than quietly rewritten because the reversal is the finding:
  // the blindness was not an oversight, it was asserted behaviour, so anyone
  // re-reading this file needs to see that the expectation moved on purpose.
  it("returns inbound as well as outbound matches", async () => {
    await seed([
      outbound("out-a", "Searchable Alpha", "2026-01-01T00:00:00.000Z"),
      outbound("out-b", "Other Beta", "2026-01-02T00:00:00.000Z"),
      inbound("in-a", "Searchable Inbound", "2026-01-03T00:00:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["search", "Searchable"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Searchable Inbound", "Searchable Alpha"]);
  });

  it("paginates sent search results", async () => {
    await seed([
      outbound("s-0", "Searchable sent 0", "2026-01-01T00:00:00.000Z"),
      outbound("s-1", "Searchable sent 1", "2026-01-01T00:01:00.000Z"),
      outbound("s-2", "Searchable sent 2", "2026-01-01T00:02:00.000Z"),
      outbound("s-3", "Searchable sent 3", "2026-01-01T00:03:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["email", "search", "Searchable", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Searchable sent 2", "Searchable sent 1"]);
  });
});

// ── task db244cd4 ────────────────────────────────────────────────────────────
//
// `emails search <q>` searched the SENT folder ONLY while calling itself
// "Search email by subject, from, or to". On the fleet mailbox that is ~691
// sent messages against ~173,000 inbound: a confident, rc=0 zero over 0.4% of
// the corpus.
//
// THESE TESTS ASSERT THE LITERAL OUTCOME — that a term carried ONLY by inbound
// mail IS RETURNED — never that some banner or marker appears. The defect
// already printed the word "sent" in its own header ('Self-hosted sent search
// "past due"') and that demonstrably did not save two workers on 2026-08-04, so
// a test keyed on wording would pass against the broken build.
//
// THE OBVIOUS POSITIVE CONTROL PASSES ANYWAY, which is why this needs its own
// regression: a vendor name appears in sent mail too, so searching one returns
// hits and certifies the INSTRUMENT while it is pointed at the wrong
// POPULATION. Every fixture below therefore carries a needle that exists on
// exactly one side of the inbound/outbound line.
describe("search — the top-level verb covers received mail, not just sent (db244cd4)", () => {
  it("finds a term that exists ONLY in inbound mail", async () => {
    await seed([
      outbound("out-unrelated", "Quarterly plan", "2026-01-01T00:00:00.000Z"),
      inbound("in-only", "Your account is past due", "2026-01-02T00:00:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["search", "past due"]);
    const rows = data as Array<Record<string, unknown>>;

    // The whole defect in one assertion: this returned [] before the fix.
    expect(rows.map((row) => row.id)).toEqual(["in-only"]);
  });

  it("returns inbound AND outbound matches together, newest first", async () => {
    await seed([
      outbound("out-hit", "Invoice reminder sent", "2026-01-01T00:00:00.000Z"),
      inbound("in-hit", "Invoice reminder received", "2026-01-03T00:00:00.000Z"),
      inbound("in-miss", "Something else entirely", "2026-01-04T00:00:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["search", "Invoice reminder"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.id)).toEqual(["in-hit", "out-hit"]);
    expect(rows.map((row) => row.kind)).toEqual(["inbound", "sent"]);
  });

  it("paginates across the merged inbound+outbound result, not one side of it", async () => {
    await seed([
      outbound("m-0", "Merged needle 0", "2026-01-01T00:00:00.000Z"),
      inbound("m-1", "Merged needle 1", "2026-01-01T00:01:00.000Z"),
      outbound("m-2", "Merged needle 2", "2026-01-01T00:02:00.000Z"),
      inbound("m-3", "Merged needle 3", "2026-01-01T00:03:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["search", "Merged needle", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.id)).toEqual(["m-2", "m-1"]);
  });

  it("narrows to one folder on --folder, so sent-only search stays reachable", async () => {
    await seed([
      outbound("f-sent", "Reconciliation thread", "2026-01-01T00:00:00.000Z"),
      inbound("f-in", "Reconciliation thread", "2026-01-02T00:00:00.000Z"),
    ]);

    const sent = await runEmailLogCommand(["search", "Reconciliation", "--folder", "sent"]);
    expect((sent.data as Array<Record<string, unknown>>).map((row) => row.id)).toEqual(["f-sent"]);

    const inbox = await runEmailLogCommand(["search", "Reconciliation", "--folder", "inbox"]);
    expect((inbox.data as Array<Record<string, unknown>>).map((row) => row.id)).toEqual(["f-in"]);
  });

  it("names the folders it searched when it finds nothing, so a zero is not bare", async () => {
    await seed([inbound("z-1", "Nothing relevant", "2026-01-01T00:00:00.000Z")]);

    const { data, out } = await runEmailLogCommand(["search", "no-such-string-anywhere-zzz"]);

    expect(data).toEqual([]);
    // A zero must state the population it covered — and the one it did not.
    expect(out).toContain("inbox");
    expect(out).toContain("sent");
  });

  it("rejects an unknown --folder by name instead of silently searching the inbox", async () => {
    const errors = await runEmailLogCommandExpectingExit(["search", "anything", "--folder", "bogus"]);
    expect(errors).toContain("bogus");
  });
});

describe("email search — the namespaced verb stays sent-only (db244cd4)", () => {
  // `emails email` is documented as "Sent email log, search, and history", so
  // the namespace IS the scoping signal and this verb keeps its old contract.
  // It is also the compatible escape hatch for any caller that wanted sent-only.
  it("still ignores matching inbound mail", async () => {
    await seed([
      outbound("ns-out", "Searchable Alpha", "2026-01-01T00:00:00.000Z"),
      inbound("ns-in", "Searchable Inbound", "2026-01-03T00:00:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["email", "search", "Searchable"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.id)).toEqual(["ns-out"]);
  });
});

describe("email show — routes to /v1", () => {
  it("renders stored HTML as readable text", async () => {
    await seed([
      outbound("show-html", "HTML body", "2026-01-01T00:00:00.000Z", {
        body_text: null,
        body_html: "<p>Hello <strong>there</strong> &amp; welcome</p>",
      }),
    ]);

    const { data, out } = await runEmailLogCommand(["email", "show", "show-html"]);

    expect(data).toMatchObject({ id: "show-html", subject: "HTML body" });
    expect(out).toContain("Hello there & welcome");
    expect(out).not.toContain("<strong>");
  });

  it("shows a sent message body through the API", async () => {
    await seed([
      outbound("srv-show-1", "Server show subject", "2026-01-04T00:00:00.000Z", { body_text: "server show body" }),
    ]);

    const { data, out } = await runEmailLogCommand(["email", "show", "srv-show-1"]);

    expect(data).toMatchObject({ id: "srv-show-1", subject: "Server show subject" });
    expect(out).toContain("server show body");
  });

  it("fails show for an unknown id instead of returning empty", async () => {
    const errors = await runEmailLogCommandExpectingExit(["show", "00000000-0000-0000-0000-000000000000"]);
    expect(errors).toContain("Email not found: 00000000-0000-0000-0000-000000000000");
  });
});

describe("email thread / conversation / replies — routes to /v1", () => {
  it("shows a lone sent message as a one-message thread", async () => {
    await seed([outbound("thr-1", "Thready", "2026-01-01T00:00:00.000Z", { body_text: "hi" })]);

    const { data, out } = await runEmailLogCommand(["email", "thread", "thr-1"]);
    const result = data as { thread_id: string | null; messages: Array<Record<string, unknown>> };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "thr-1", subject: "Thready", kind: "sent" });
    expect(result.thread_id).toBe("thready");
    expect(out).toContain("Thread");
    expect(out).toContain("1 of 1 message");
  });

  it("shows the conversation thread for an inbound message", async () => {
    await seed([inbound("conv-1", "Convo", "2026-01-01T00:00:00.000Z", { body_text: "hey" })]);

    const { data, out } = await runEmailLogCommand(["conversation", "conv-1"]);
    const result = data as { messages: Array<Record<string, unknown>> };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "conv-1", kind: "received" });
    expect(out).toContain("Conversation thread");
  });

  it("reports no replies for a sent message that genuinely has none", async () => {
    await seed([outbound("rep-1", "Sent", "2026-01-01T00:00:00.000Z", { body_text: "hi" })]);

    const { data } = await runEmailLogCommand(["email", "replies", "rep-1"]);
    const result = data as { replies: unknown[]; total: number; has_more: boolean };

    expect(result.total).toBe(0);
    expect(result.replies).toHaveLength(0);
    expect(result.has_more).toBe(false);
  });

  // The reported failure: mail was sent to an external accountant, the
  // accountant replied twice, and `emails email replies <id>` printed
  // "No replies." with {"replies":[],"total":0} because the remote seam
  // answered the thread query with the one message it was handed.
  it("finds the replies a sent message actually received", async () => {
    await seed([
      outbound("sent-1", "Declaratii TVA 06.2026", "2026-01-01T00:00:00.000Z", {
        message_id: "<sent-1@example.com>",
        body_text: "please find attached",
      }),
      inbound("reply-1", "Re: Declaratii TVA 06.2026", "2026-01-02T00:00:00.000Z", {
        message_id: "<reply-1@kpmg.example>",
        in_reply_to: "<sent-1@example.com>",
      }),
      inbound("reply-2", "RE: declaratii tva 06.2026", "2026-01-03T00:00:00.000Z", {
        message_id: "<reply-2@kpmg.example>",
        in_reply_to: "<reply-1@kpmg.example>",
      }),
      inbound("other", "Unrelated question", "2026-01-04T00:00:00.000Z"),
    ]);

    const { data, out } = await runEmailLogCommand(["email", "replies", "sent-1"]);
    const result = data as { replies: Array<{ id: string }>; total: number; has_more: boolean };

    expect(result.replies.map((r) => r.id)).toEqual(["reply-1", "reply-2"]);
    expect(result.total).toBe(2);
    expect(result.has_more).toBe(false);
    expect(out).not.toContain("No replies");
  });

  it("renders the whole thread, not a permanent 1-message header", async () => {
    await seed([
      outbound("sent-2", "Q2 statements", "2026-02-01T00:00:00.000Z", { message_id: "<sent-2@example.com>" }),
      inbound("reply-3", "Re: Q2 statements", "2026-02-02T00:00:00.000Z", { in_reply_to: "<sent-2@example.com>" }),
    ]);

    const { data, out } = await runEmailLogCommand(["email", "thread", "sent-2"]);
    const result = data as { thread_id: string | null; messages: Array<{ id: string }>; total: number };

    expect(result.messages.map((m) => m.id)).toEqual(["sent-2", "reply-3"]);
    expect(result.total).toBe(2);
    expect(result.thread_id).toBe("q2 statements");
    expect(out).toContain("2 of 2 messages");
    expect(out).toContain('"q2 statements"');
  });

  it("applies the --limit/--offset it advertises on thread instead of ignoring them", async () => {
    await seed([
      outbound("sent-3", "Payroll March", "2026-03-01T00:00:00.000Z", { message_id: "<sent-3@example.com>" }),
      inbound("reply-4", "Re: Payroll March", "2026-03-02T00:00:00.000Z", { in_reply_to: "<sent-3@example.com>" }),
      inbound("reply-5", "Re: Payroll March", "2026-03-03T00:00:00.000Z", { in_reply_to: "<sent-3@example.com>" }),
    ]);

    const { data } = await runEmailLogCommand(["email", "thread", "sent-3", "--limit", "1", "--offset", "1"]);
    const result = data as { messages: Array<{ id: string }>; total: number; has_more: boolean };

    expect(result.messages.map((m) => m.id)).toEqual(["reply-4"]);
    expect(result.total).toBe(3);
    expect(result.has_more).toBe(true);
  });

  it("never counts the selected inbound message as a reply to itself", async () => {
    await seed([
      inbound("root", "Bank reconciliation", "2026-04-01T00:00:00.000Z", { message_id: "<root@kpmg.example>" }),
      inbound("follow", "Re: Bank reconciliation", "2026-04-02T00:00:00.000Z", { in_reply_to: "<root@kpmg.example>" }),
    ]);

    const { data } = await runEmailLogCommand(["replies", "root"]);
    const result = data as { replies: Array<{ id: string }>; total: number };

    expect(result.replies.map((r) => r.id)).toEqual(["follow"]);
    expect(result.total).toBe(1);
  });
});

describe("server-only commands block in the self-hosted client", () => {
  const cases: Array<{ args: string[]; message: string }> = [
    {
      args: ["test"],
      message: "emails test is not available in the self-hosted client; it runs on the self-hosted server.",
    },
    {
      args: ["webhook", "listen", "--port", "19877"],
      message: "emails webhook listen is not available in the self-hosted client; it runs on the self-hosted server.",
    },
  ];

  for (const { args, message } of cases) {
    it(`blocks \`${args.join(" ")}\``, async () => {
      const errors = await runEmailLogCommandExpectingExit(args);
      expect(errors).toContain(message);
    });
  }
});

// ─── export (previously refused; now routed to /v1) ──────────────────────────
//
// `emails export` refused in this mode while the MCP `export_emails` /
// `export_events` tools ran the SAME src/lib/export.ts over the SAME routed
// repositories and worked. These tests are the proof the CLI reaches the API:
// they assert seeded rows come back, so a re-introduced guard (or a read that
// silently returns nothing) fails here.

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("emails export routes to /v1 in the self-hosted client", () => {
  it("exports outbound messages as JSON from GET /v1/messages", async () => {
    await seed([
      outbound("export-1", "March invoice", "2026-03-01T00:00:00.000Z"),
      outbound("export-2", "April invoice", "2026-04-01T00:00:00.000Z"),
    ]);

    // The JSON export now flows through output(parsed, raw) — the structured
    // channel carries the rows and the text channel carries the raw document —
    // instead of console.log (which the --json wrapper double-encoded).
    const { data, out } = await runEmailLogCommand(["export", "emails", "--limit", "10"]);
    const rows = data as Array<{ id: string; subject: string }>;
    expect(JSON.parse(out)).toEqual(data);

    expect(rows.map((row) => row.id).sort()).toEqual(["export-1", "export-2"]);
    expect(rows.map((row) => row.subject).sort()).toEqual(["April invoice", "March invoice"]);
  });

  it("exports outbound messages as CSV", async () => {
    await seed([outbound("export-csv", "CSV invoice", "2026-05-01T00:00:00.000Z")]);

    const stdout = await captureStdout(() => runEmailLogCommand(["export", "emails", "--format", "csv", "--limit", "10"]));

    expect(stdout.split("\n")[0]).toBe("id,from,to,subject,status,sent_at");
    expect(stdout).toContain("export-csv");
    expect(stdout).toContain("CSV invoice");
  });

  it("exports delivery events from GET /v1/events", async () => {
    await stub.seed({
      events: [{
        id: "event-1",
        email_id: "export-1",
        provider_id: "provider-1",
        type: "delivered",
        recipient: "dest@example.com",
        occurred_at: "2026-03-01T01:00:00.000Z",
      }],
    } as V1StubResources);

    const { data: eventData } = await runEmailLogCommand(["export", "events", "--limit", "10"]);
    const stdout = JSON.stringify(eventData);
    const rows = JSON.parse(stdout) as Array<{ id: string; type: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "event-1", type: "delivered", recipient: "dest@example.com" });
  });

  it("still rejects an unknown export type instead of exporting nothing", async () => {
    const errors = await runEmailLogCommandExpectingExit(["export", "contacts"]);
    expect(errors).toContain("Export type must be 'emails' or 'events'");
  });
});
