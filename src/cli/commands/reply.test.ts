// Self-hosted-ONLY: `reply`/`forward` read the parent through the mail-data-source
// seam and re-send via the server send API (POST /v1/messages/send). There is no
// local SQLite and no `resolveInboundOrSent` local id resolver anymore, so these
// tests drive the REAL commands against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { storeInboundEmail, type InboundEmail } from "../../db/inbound.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerReplyCommand } from "./reply.js";

let stub: V1Stub;

async function runReplyCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerReplyCommand(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runReplyCommandExpectingExit(args: string[]): Promise<string> {
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
    await expect(runReplyCommand(args)).rejects.toThrow(/process\.exit/);
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

function seedInbound(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return storeInboundEmail({
    provider_id: null,
    message_id: overrides.message_id ?? "<orig@ext.com>",
    in_reply_to_email_id: null,
    from_address: overrides.from_address ?? "ext@ext.com",
    to_addresses: overrides.to_addresses ?? ["me@acme.com"],
    cc_addresses: overrides.cc_addresses ?? [],
    subject: overrides.subject ?? "Quarterly report",
    text_body: overrides.text_body ?? "Here are the numbers.",
    html_body: overrides.html_body ?? null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: overrides.received_at ?? "2026-01-01T00:00:00.000Z",
  });
}

function outboundRows() {
  return stub.list("messages").then((rows) => rows.filter((row) => row["direction"] === "outbound"));
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

describe("forward command", () => {
  it("forwards an inbound email through the server send API with a quoted body", async () => {
    const inbound = seedInbound();

    const result = await runReplyCommand([
      "forward", inbound.id, "--to", "boss@acme.com", "--from", "me@acme.com", "--body", "FYI",
    ]);
    const data = result.data as { to: string[]; subject: string };

    expect(data.subject).toBe("Fwd: Quarterly report");
    expect(data.to).toEqual(["boss@acme.com"]);
    expect(result.out).toContain("forwarded to boss@acme.com");

    const sent = await outboundRows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "me@acme.com", subject: "Fwd: Quarterly report" });
    expect(sent[0]!["to"]).toEqual(["boss@acme.com"]);
    // Prepended note + quoted original both carried in the re-sent body.
    expect(String(sent[0]!["text"])).toContain("FYI");
    expect(String(sent[0]!["text"])).toContain("Here are the numbers.");
  });

  it("keeps an existing Fwd: prefix instead of doubling it", async () => {
    const inbound = seedInbound({ subject: "Fwd: Already forwarded" });

    const result = await runReplyCommand([
      "forward", inbound.id, "--to", "boss@acme.com", "--from", "me@acme.com",
    ]);
    const data = result.data as { subject: string };

    expect(data.subject).toBe("Fwd: Already forwarded");
  });

  it("fails a forward of an unknown id instead of sending", async () => {
    const errors = await runReplyCommandExpectingExit([
      "forward", "00000000-0000-0000-0000-000000000000", "--to", "boss@acme.com", "--from", "me@acme.com",
    ]);

    expect(errors).toContain("Email not found: 00000000-0000-0000-0000-000000000000");
    expect(await outboundRows()).toHaveLength(0);
  });
});

describe("reply command", () => {
  it("replies to an inbound email via the server send API with a Re: subject", async () => {
    const inbound = seedInbound({ subject: "Question", text_body: "Any update?" });

    const result = await runReplyCommand([
      "reply", inbound.id, "--body", "Yes, shipping today.", "--from", "me@acme.com",
    ]);
    const data = result.data as { thread_id: string | null; to: string[]; subject: string };

    expect(data.subject).toBe("Re: Question");
    expect(data.to).toEqual(["ext@ext.com"]);
    expect(data.thread_id).toBeNull();
    expect(result.out).toContain("replied to ext@ext.com");

    const sent = await outboundRows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "me@acme.com", subject: "Re: Question" });
    expect(sent[0]!["to"]).toEqual(["ext@ext.com"]);
    expect(String(sent[0]!["text"])).toContain("Yes, shipping today.");
  });

  it("reply-all folds in the other recipients, excluding the sender and de-duping", async () => {
    const inbound = seedInbound({
      subject: "Team sync",
      from_address: "ext@ext.com",
      to_addresses: ["me@acme.com", "other@acme.com"],
    });

    const result = await runReplyCommand([
      "reply", inbound.id, "--all", "--from", "me@acme.com", "--body", "Sounds good.",
    ]);
    const data = result.data as { to: string[] };

    expect(data.to).toEqual(["ext@ext.com", "other@acme.com"]);
  });

  it("fails a reply to an unknown id instead of sending", async () => {
    const errors = await runReplyCommandExpectingExit([
      "reply", "00000000-0000-0000-0000-000000000000", "--body", "hi", "--from", "me@acme.com",
    ]);

    expect(errors).toContain("Email not found: 00000000-0000-0000-0000-000000000000");
    expect(await outboundRows()).toHaveLength(0);
  });
});
