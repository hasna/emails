// Self-hosted-ONLY: `status` and `agent context` read mailbox counts/sources
// over the operator `/v1` API and never touch a local database. These tests
// drive the REAL commands against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts) seeded with messages that produce known counts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerStatusCommands } from "./status.js";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";

const LATEST = "2026-07-08T19:50:52.000Z";

// Seed: 2 inbound (1 unread + 1 read, newest is the unread one), 1 archived
// inbound, 1 outbound sent. => counts.inbox=2, unread=1, archived=1, sent=1,
// receivedTotal = inbox(2)+archived(1) = 3, latest_received_at = LATEST.
const SEED = {
  messages: [
    { id: "m-unread", direction: "inbound", from_addr: "a@example.com", to_addrs: "me@example.com", subject: "Newest unread", body_text: "hi", received_at: LATEST, is_read: false, labels: [] },
    { id: "m-read", direction: "inbound", from_addr: "b@example.com", to_addrs: "me@example.com", subject: "Older read", body_text: "hi", received_at: "2026-07-07T10:00:00.000Z", is_read: true, labels: [] },
    { id: "m-archived", direction: "inbound", from_addr: "c@example.com", to_addrs: "me@example.com", subject: "Archived", body_text: "hi", received_at: "2026-07-06T10:00:00.000Z", is_read: true, labels: ["archived"] },
    { id: "m-sent", direction: "outbound", from_addr: "me@example.com", to_addrs: "d@example.com", subject: "Sent", body_text: "hi", received_at: "2026-07-05T10:00:00.000Z", is_read: true, labels: ["sent"] },
  ],
};

let stub: V1Stub;

async function runStatusCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  let data: unknown;
  let formatted = "";
  registerStatusCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, formatted };
}

beforeAll(async () => {
  stub = await startV1Stub({ seed: SEED });
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("self-hosted status CLI commands", () => {
  it("prints a compact agent context by default and full JSON in verbose mode", async () => {
    const compact = await runStatusCommand(["agent", "context"]);
    expect(compact.formatted).toContain("Agent context summary");
    expect(compact.formatted).toContain("Details: use emails agent context --verbose");
    expect(compact.formatted.trim().startsWith("{")).toBe(false);
    expect(compact.data).toMatchObject({ workflows: expect.any(Object) });

    const verbose = await runStatusCommand(["agent", "context", "--verbose"]);
    expect(verbose.formatted.trim().startsWith("{")).toBe(true);
    expect(verbose.formatted).toContain('"workflows"');
  });

  it("does not expose removed cloud AI agent subcommands", async () => {
    await expect(runStatusCommand(["agent", "defaults"])).rejects.toThrow(/unknown command/);
    await expect(runStatusCommand(["agent", "run", "categorizer"])).rejects.toThrow(/unknown command/);
  });

  it("reports self-hosted status with inbox counts sourced from /v1", async () => {
    const result = await runStatusCommand(["status"]);
    expect(result.data).toMatchObject({
      mode: { current: "self_hosted" },
      database: { data_dir: null },
      inbox: {
        total: 3,
        unread: 1,
        latest_received_at: LATEST,
      },
    });
    expect(result.formatted).toContain("Mode:       self_hosted");
  });

  // G5: the operator-facing path end to end. `emails status --json` must carry
  // the gap signals AND real counts — the command used to emit hardcoded zeros
  // for every provider/domain/address aggregate.
  it("emits degraded/unavailable/gaps and REAL counts from the seeded server", async () => {
    await stub.seed({
      providers: [
        { id: "p1", name: "SES prod", type: "ses", region: "us-east-1", active: true },
        { id: "p2", name: "Sandbox", type: "sandbox", region: null, active: false },
      ],
      domains: [
        { id: "d1", domain: "one.example", provider: "p1", verified: true, provisioning_status: "ready" },
        { id: "d2", domain: "two.example", provider: "p1", verified: false, provisioning_status: "none" },
      ],
      addresses: [
        { id: "a1", email: "ops@one.example", domain: "one.example", domain_id: "d1", status: "active", verified: true, owner_id: "o1", provisioning_status: "ready" },
      ],
    });

    const result = await runStatusCommand(["status"]);
    const payload = result.data as {
      degraded: boolean;
      limited: boolean;
      limitations: string[];
      unavailable: string[];
      gaps: Record<string, { reason: string; available: boolean }>;
      providers: { total: number | null; active: number | null; availability: { available: boolean } };
      domains: { total: number | null; verified: number | null; send_ready: number | null };
      addresses: { total: number | null; owned: number | null; usable_from: unknown };
    };

    expect(payload.providers).toMatchObject({ total: 2, active: 1 });
    expect(payload.providers.availability.available).toBe(true);
    expect(payload.domains).toMatchObject({ total: 2, verified: 1, send_ready: null });
    expect(payload.addresses).toMatchObject({ total: 1, owned: 1, usable_from: null });

    // A healthy server is not `degraded`; the fields it cannot answer are
    // published as structural limitations (see src/lib/status-availability.ts).
    expect(payload.degraded).toBe(false);
    expect(payload.limited).toBe(true);
    expect(payload.limitations).toContain("addresses.usable_from");
    expect(payload.unavailable).toContain("addresses.usable_from");
    // Send eligibility is `getAddressSendability`, gated on the `outboundPolicy`
    // capability that BOTH store implementations declare false — so the reason now
    // names the store's own declaration rather than one API route.
    expect(payload.gaps["addresses.usable_from"]?.reason)
      .toMatch(/^not_modelled_on_store:store_capability_outboundPolicy/);

    expect(result.formatted).toContain("Capabilities: 1/2 active provider credential(s)");
    expect(result.formatted).not.toContain("0/0 active provider credential(s)");
    expect(result.formatted).toContain("Data gaps");
  });

  it("reports self-hosted inbox counts inside agent context", async () => {
    const result = await runStatusCommand(["agent", "context"]);
    expect(result.data).toMatchObject({
      status: {
        mode: { current: "self_hosted" },
        database: { data_dir: null },
        inbox: { total: 3, unread: 1 },
      },
    });
    expect(result.formatted).toContain("Agent context summary");
  });
});
