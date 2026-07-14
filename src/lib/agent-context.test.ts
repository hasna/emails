import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { getEmailSystemStatus, getEmailSystemStatusForRuntime, getNextEmailAction } from "./agent-context.js";

// The client is self-hosted-ONLY. getEmailSystemStatus / getEmailSystemStatusForRuntime
// are now async and parameterless: they resolve the /v1 mail data source for the
// inbox/mailbox/source summaries and report the former local-SQLite provider,
// domain, address, and provisioning aggregates as empty (the operator server owns
// those). The old tests that seeded providers/addresses/domains and asserted
// non-empty aggregates, proxied `db.query`/`db.run` to assert SQL shape, or bulk-
// inserted rows via `db.run` validated REMOVED local behavior and are dropped.
// getNextEmailAction is likewise async now.
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
    expect(status.inbox.realtime).toMatchObject({ queue_configured: false, queue_url: null });
  });

  it("reports empty provider/domain/address/provisioning aggregates (operator-owned)", async () => {
    await seedRepresentativeInbox();
    const status = await getEmailSystemStatus();

    expect(status.providers.total).toBe(0);
    expect(status.domains.total).toBe(0);
    expect(status.domains.usable).toEqual([]);
    expect(status.addresses.total).toBe(0);
    expect(status.addresses.usable_from).toEqual([]);
    expect(status.provisioning).toMatchObject({ domains_failed: 0, addresses_failed: 0 });
    expect(status.next_actions).toEqual([]);
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

    // No local SQLite island exists in the self-hosted client.
    expect(status.database.data_dir).toBeNull();
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
