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

function outbound(id: string, subject: string, receivedAt: string, extra: MessageSeed = {}): MessageSeed {
  return {
    id,
    direction: "outbound",
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

describe("search — routes outbound search to /v1", () => {
  it("searches outbound mail only, ignoring matching inbound mail", async () => {
    await seed([
      outbound("out-a", "Searchable Alpha", "2026-01-01T00:00:00.000Z"),
      outbound("out-b", "Other Beta", "2026-01-02T00:00:00.000Z"),
      inbound("in-a", "Searchable Inbound", "2026-01-03T00:00:00.000Z"),
    ]);

    const { data } = await runEmailLogCommand(["search", "Searchable"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Searchable Alpha"]);
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
  it("shows a sent message thread as a single-message conversation", async () => {
    await seed([outbound("thr-1", "Thready", "2026-01-01T00:00:00.000Z", { body_text: "hi" })]);

    const { data, out } = await runEmailLogCommand(["email", "thread", "thr-1"]);
    const result = data as { thread_id: string | null; messages: Array<Record<string, unknown>> };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "thr-1", subject: "Thready", kind: "sent" });
    expect(out).toContain("Thread");
    expect(out).toContain("1 message");
  });

  it("shows the conversation thread for an inbound message", async () => {
    await seed([inbound("conv-1", "Convo", "2026-01-01T00:00:00.000Z", { body_text: "hey" })]);

    const { data, out } = await runEmailLogCommand(["conversation", "conv-1"]);
    const result = data as { messages: Array<Record<string, unknown>> };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: "conv-1", kind: "received" });
    expect(out).toContain("Conversation thread");
  });

  it("reports no replies for a sent message (replies are not thread-linked server-side)", async () => {
    await seed([outbound("rep-1", "Sent", "2026-01-01T00:00:00.000Z", { body_text: "hi" })]);

    const { data } = await runEmailLogCommand(["email", "replies", "rep-1"]);
    const result = data as { replies: unknown[]; total: number; has_more: boolean };

    expect(result.total).toBe(0);
    expect(result.replies).toHaveLength(0);
    expect(result.has_more).toBe(false);
  });
});

describe("server-only commands block in the self-hosted client", () => {
  const cases: Array<{ args: string[]; message: string }> = [
    {
      args: ["test"],
      message: "emails test is not available in the self-hosted client; it runs on the self-hosted server.",
    },
    {
      args: ["export", "emails"],
      message: "emails export is not available in the self-hosted client; it runs on the self-hosted server.",
    },
    {
      args: ["export", "events"],
      message: "emails export is not available in the self-hosted client; it runs on the self-hosted server.",
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
