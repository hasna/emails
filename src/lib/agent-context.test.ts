import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { getEmailSystemStatus, getEmailSystemStatusForRuntime, getNextEmailAction } from "./agent-context.js";

// The self-hosted status payload reads the operator's /v1 API. It used to
// hardcode provider/domain/address/provisioning aggregates as zeros, and the test
// that lived here ASSERTED those zeros — so the defect was green in CI. It is
// replaced by src/lib/agent-context.self-hosted.test.ts (real counts, honest
// unavailability) plus src/lib/status-fabrication-scan.test.ts (the class guard).
// What stays here is the inbox/mailbox/source behaviour that was always real.
let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

// A representative inbox: 4 inbox rows (3 unread), 1 archived, 1 spam, 1 sent.
async function seedRepresentativeInbox(): Promise<void> {
  await stub.seed({
    messages: [
      { id: "m1", direction: "inbound", from_addr: "a@x.com", to_addrs: ["ops@example.com"], subject: "one", status: "received", is_read: false, labels: [], received_at: "2026-07-01T00:00:00.000Z" },
      { id: "m2", direction: "inbound", from_addr: "b@x.com", to_addrs: ["ops@example.com"], subject: "two", status: "received", is_read: false, labels: [], received_at: "2026-07-02T00:00:00.000Z" },
      { id: "m3", direction: "inbound", from_addr: "c@x.com", to_addrs: ["ops@example.com"], subject: "three", status: "received", is_read: false, labels: [], received_at: "2026-07-03T00:00:00.000Z" },
      { id: "m4", direction: "inbound", from_addr: "d@x.com", to_addrs: ["ops@example.com"], subject: "four", status: "received", is_read: true, labels: [], received_at: "2026-07-04T00:00:00.000Z" },
      { id: "m5", direction: "inbound", from_addr: "e@x.com", to_addrs: ["ops@example.com"], subject: "arch", status: "received", is_read: true, labels: ["archived"], received_at: "2026-07-05T00:00:00.000Z" },
      { id: "m6", direction: "inbound", from_addr: "f@x.com", to_addrs: ["ops@example.com"], subject: "junk", status: "received", is_read: true, labels: ["spam"], received_at: "2026-07-06T00:00:00.000Z" },
      { id: "m7", direction: "outbound", from_addr: "ops@example.com", to_addrs: ["z@x.com"], subject: "sent one", status: "sent", labels: [], created_at: "2026-07-07T00:00:00.000Z" },
    ],
  });
}

describe("agent context", () => {
  it("summarizes inbox totals, unread, and latest timestamp from the /v1 messages store", async () => {
    await seedRepresentativeInbox();
    const status = await getEmailSystemStatus();

    // Received total = inbox + archived + spam + trash (4 + 1 + 1 + 0).
    expect(status.inbox.total).toBe(6);
    expect(status.inbox.unread).toBe(3);
    // Latest received-at includes archived/spam inbound (m6 is newest inbound).
    expect(status.inbox.latest_received_at).toBe("2026-07-06T00:00:00.000Z");
    expect(status.mailboxes.counts.inbox).toBe(4);
    expect(status.mailboxes.counts.unread).toBe(3);
    expect(status.mailboxes.counts.sent).toBe(1);
  });

  it("exposes the shared self-hosted store as a single ingestion source", async () => {
    await seedRepresentativeInbox();
    const status = await getEmailSystemStatus();

    expect(status.sources.total).toBe(1);
    expect(status.sources.items[0]).toMatchObject({ id: "self_hosted", total: 6 });
    // The realtime queue lives on the server: `queue_configured: false` would be a
    // fabricated negative claim about the operator's ingestion.
    expect(status.inbox.realtime.queue_configured).toBeNull();
    expect(status.inbox.realtime.queue_url).toBeNull();
    expect(status.inbox.realtime.availability.available).toBe(false);
    expect(status.unavailable).toContain("inbox.realtime.queue_configured");
  });

  it("reports the newest inbound timestamp even when the newest mail is archived", async () => {
    await stub.seed({
      messages: [
        { id: "a1", direction: "inbound", from_addr: "s@x.com", to_addrs: ["ops@example.com"], subject: "older", status: "received", is_read: false, labels: [], received_at: "2026-01-01T10:00:00.000Z" },
        { id: "a2", direction: "inbound", from_addr: "s@x.com", to_addrs: ["ops@example.com"], subject: "newer archived", status: "received", is_read: true, labels: ["archived"], received_at: "2026-01-05T10:00:00.000Z" },
      ],
    });

    const status = await getEmailSystemStatus();
    expect(status.inbox.latest_received_at).toBe("2026-01-05T10:00:00.000Z");
  });

  it("resolves the API source for runtime status without opening a local database", async () => {
    await seedRepresentativeInbox();
    const status = await getEmailSystemStatusForRuntime();

    // No local SQLite island exists in the self-hosted client — and the null now
    // carries a reason instead of standing on its own.
    expect(status.database.data_dir).toBeNull();
    expect(status.gaps["database.data_dir"]?.reason)
      .toMatch(/^not_applicable:local_database_absent_in_self_hosted/);
    expect(status.mode.current).toBe("self_hosted");
    expect(status.inbox.total).toBe(6);
    expect(status.inbox.unread).toBe(3);
    expect(status.sources.items[0]).toMatchObject({ id: "self_hosted", total: 6 });
  });

  it("suggests wait-code for verification goals", async () => {
    const next = await getNextEmailAction("need verification code");
    expect(next).toMatchObject({ command: "emails inbox wait-code <address> --timeout 120" });
  });
});
