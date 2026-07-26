// `emails send-intent` — the operator-facing path out of an unknown send
// outcome. On 2026-07-25 seven messages sat in `send_state = 'uncertain'` with
// no command able to list them and no command able to resolve them, so they
// stayed visually identical to delivered mail. These tests drive the REAL
// commands against an out-of-process /v1 stub.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSendIntentCommands } from "./send-intent.js";

let stub: V1Stub;

async function runCommand(args: string[]) {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSendIntentCommands(program, (d, formatted) => { data = d; out.push(String(formatted ?? "")); });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: [...logs, ...out].join("\n") };
  } finally {
    console.log = originalLog;
  }
}

async function runCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => { throw new Error(`process.exit:${code ?? 0}`); }) as typeof process.exit;
  try {
    await runCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

const UNCERTAIN_ID = "11111111-1111-4111-8111-111111111111";
const SENT_ID = "22222222-2222-4222-8222-222222222222";

function message(id: string, sendState: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    direction: "outbound",
    from_addr: "andrei@example.com",
    to_addrs: ["accountant@external.example"],
    subject: "Q2 invoices",
    status: sendState,
    send_state: sendState,
    provider_message_id: null,
    is_read: true,
    labels: [],
    created_at: "2026-07-25T09:00:00.000Z",
    updated_at: "2026-07-25T09:00:00.000Z",
    ...extra,
  };
}

beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

describe("emails send-intent uncertain", () => {
  it("lists the sends whose outcome is unknown and says so unambiguously", async () => {
    await stub.seed({ messages: [message(UNCERTAIN_ID, "uncertain"), message(SENT_ID, "sent")] });

    const result = await runCommand(["send-intent", "uncertain"]);

    expect((result.data as { count: number }).count).toBe(1);
    expect(result.out).toContain("UNKNOWN provider outcome");
    expect(result.out).toContain(UNCERTAIN_ID);
    expect(result.out).not.toContain(SENT_ID);
  });

  it("says plainly when nothing is unresolved", async () => {
    await stub.seed({ messages: [message(SENT_ID, "sent")] });
    const result = await runCommand(["send-intent", "uncertain"]);
    expect(result.out).toContain("No send intents are uncertain");
  });
});

describe("emails send-intent reconcile", () => {
  it("records a NOT SENT outcome and flips the row to failed", async () => {
    await stub.seed({ messages: [message(UNCERTAIN_ID, "uncertain")] });

    const result = await runCommand([
      "send-intent", "reconcile", UNCERTAIN_ID,
      "--outcome", "not-sent",
      "--evidence", "no SES Send datapoint on 111122223333 in the window",
    ]);

    expect(result.out).toContain("recorded as NOT SENT");
    const rows = await stub.list("messages");
    expect(rows[0]?.send_state).toBe("failed");

    const remaining = await runCommand(["send-intent", "uncertain"]);
    expect((remaining.data as { count: number }).count).toBe(0);
  });

  it("records a SENT outcome with the provider message id that proves it", async () => {
    await stub.seed({ messages: [message(UNCERTAIN_ID, "uncertain")] });

    const result = await runCommand([
      "send-intent", "reconcile", UNCERTAIN_ID,
      "--outcome", "sent",
      "--provider-message-id", "0100019-ses-id",
      "--evidence", "SES SNS Delivery event for this MessageId",
    ]);

    expect(result.out).toContain("recorded as SENT");
    const rows = await stub.list("messages");
    expect(rows[0]?.send_state).toBe("sent");
    expect(rows[0]?.provider_message_id).toBe("0100019-ses-id");
  });

  it("refuses --outcome sent without the provider message id, and changes nothing", async () => {
    await stub.seed({ messages: [message(UNCERTAIN_ID, "uncertain")] });

    const result = await runCommandExpectingExit([
      "send-intent", "reconcile", UNCERTAIN_ID, "--outcome", "sent", "--evidence", "trust me",
    ]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("--provider-message-id is required");
    const rows = await stub.list("messages");
    expect(rows[0]?.send_state).toBe("uncertain");
  });

  it("refuses an outcome word it does not understand", async () => {
    await stub.seed({ messages: [message(UNCERTAIN_ID, "uncertain")] });
    const result = await runCommandExpectingExit([
      "send-intent", "reconcile", UNCERTAIN_ID, "--outcome", "maybe", "--evidence", "x",
    ]);
    expect(result.stderr).toContain("--outcome must be 'sent'");
    expect((await stub.list("messages"))[0]?.send_state).toBe("uncertain");
  });

  it("reports a rejected reconciliation without relaying the server body", async () => {
    await stub.seed({ messages: [message(SENT_ID, "sent")] });
    const result = await runCommandExpectingExit([
      "send-intent", "reconcile", SENT_ID, "--outcome", "not-sent", "--evidence", "x",
    ]);
    expect(result.stderr).toContain("Reconciliation failed (HTTP 409).");
    expect(result.stderr).not.toContain("only an 'uncertain' send intent can be reconciled");
    expect((await stub.list("messages"))[0]?.send_state).toBe("sent");
  });
});
