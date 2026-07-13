import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  exportEmailsCsv,
  exportEmailsJson,
  exportEventsCsv,
  exportEventsJson,
} from "./export.js";

// /v1 READ: every export function reads through the self-hosted resource store.
//   - exportEmails* -> listEmails() over the outbound `/v1/messages` ledger.
//   - exportEvents* -> listEvents() over the `/v1/events` resource.
// The exporters dropped their `db` parameter and take (filters) only; the removed
// local-SQLite `db.run("UPDATE ... sent_at ...")` timestamp mutations are replaced
// by seeding the rows with the timestamps the filters key on (sent_at derives from
// received_at, event windows from occurred_at).
let stub: V1Stub;
beforeAll(async () => { stub = await startV1Stub(); });
afterAll(() => stub.stop());
beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
afterEach(() => stub.clearEnv());

function outboundMessage(row: Record<string, unknown>): Record<string, unknown> {
  return { direction: "outbound", status: "sent", provider_id: "p1", from_addr: "a@example.com", ...row };
}

describe("export schema contracts", () => {
  it("defaults direct email exports to a bounded page", async () => {
    const rows = Array.from({ length: EXPORT_DEFAULT_LIMIT + 1 }, (_, i) => outboundMessage({
      id: `default-email-${i}`,
      to_addrs: [`user-${i}@example.com`],
      subject: `Default email export ${i}`,
      body_text: "hello",
      received_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    await stub.seed({ messages: rows });

    const json = JSON.parse(exportEmailsJson({ provider_id: "p1" })) as Array<{ id: string }>;
    const csv = exportEmailsCsv({ provider_id: "p1" });

    expect(json).toHaveLength(EXPORT_DEFAULT_LIMIT);
    expect(csv.split("\n")).toHaveLength(EXPORT_DEFAULT_LIMIT + 1);
  });

  it("caps direct email export limits and normalizes bad offsets", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => outboundMessage({
      id: `capped-email-${i}`,
      to_addrs: [`capped-${i}@example.com`],
      subject: `Capped email export ${i}`,
      body_text: "hello",
      received_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    await stub.seed({ messages: rows });

    const json = JSON.parse(exportEmailsJson({
      provider_id: "p1",
      limit: EXPORT_MAX_LIMIT + 1,
      offset: -100,
    })) as Array<{ subject: string }>;

    expect(json).toHaveLength(3);
    expect(json[0]?.subject).toBe("Capped email export 2");
  });

  it("keeps email CSV headers stable and honors provider/since filters", async () => {
    await stub.seed({
      messages: [
        outboundMessage({ id: "old-msg", provider_id: "p1", to_addrs: ["old@example.com"], subject: "Old", received_at: "2026-01-01T00:00:00.000Z" }),
        outboundMessage({ id: "new-msg", provider_id: "p1", to_addrs: ["new@example.com"], subject: "New", received_at: "2026-02-01T00:00:00.000Z" }),
        outboundMessage({ id: "other-msg", provider_id: "p2", from_addr: "b@example.com", to_addrs: ["other@example.com"], subject: "Other", received_at: "2026-02-01T00:00:00.000Z" }),
      ],
    });

    const csv = exportEmailsCsv({ provider_id: "p1", since: "2026-01-15T00:00:00.000Z" });
    expect(csv.split("\n")[0]).toBe("id,from,to,subject,status,sent_at");
    expect(csv).toContain("new-msg");
    expect(csv).toContain("new@example.com");
    expect(csv).not.toContain("old-msg");
    expect(csv).not.toContain("other@example.com");

    const json = JSON.parse(exportEmailsJson({ provider_id: "p1", since: "2026-01-15T00:00:00.000Z" })) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual(["new-msg"]);
  });

  it("paginates email exports and escapes CSV cells", async () => {
    await stub.seed({
      messages: [
        outboundMessage({ id: "old-msg", to_addrs: ["old@example.com"], subject: "Old", received_at: "2026-01-01T00:00:00.000Z" }),
        outboundMessage({ id: "mid-msg", to_addrs: ["middle@example.com", "audit@example.com"], subject: "Middle, quoted", received_at: "2026-02-01T00:00:00.000Z" }),
        outboundMessage({ id: "new-msg", to_addrs: ["new@example.com"], subject: "New", received_at: "2026-03-01T00:00:00.000Z" }),
      ],
    });

    const json = JSON.parse(exportEmailsJson({ provider_id: "p1", limit: 1, offset: 1 })) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual(["mid-msg"]);

    const csv = exportEmailsCsv({ provider_id: "p1", limit: 1, offset: 1 });
    expect(csv).toContain('"[""middle@example.com"",""audit@example.com""]"');
    expect(csv).toContain('"Middle, quoted"');
    expect(csv).not.toContain("new-msg");
  });

  it("filters email exports by canonical sender through display-name From values", async () => {
    await stub.seed({
      messages: [
        outboundMessage({ id: "kept-msg", from_addr: '"Ops Team" <ops@example.com>', to_addrs: ["kept@example.com"], subject: "Kept", received_at: "2026-02-01T00:00:00.000Z" }),
        outboundMessage({ id: "other-msg", from_addr: "other@example.com", to_addrs: ["other@example.com"], subject: "Other", received_at: "2026-02-01T00:00:00.000Z" }),
      ],
    });

    const json = JSON.parse(exportEmailsJson({ from_address: "ops@example.com" })) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual(["kept-msg"]);

    const csv = exportEmailsCsv({ from_address: "Ops Team <ops@example.com>" });
    expect(csv).toContain("kept-msg");
    expect(csv).not.toContain("Other");
  });

  it("defaults direct event exports to a bounded page", async () => {
    const rows = Array.from({ length: EXPORT_DEFAULT_LIMIT + 1 }, (_, i) => ({
      id: `default-event-${i}`,
      email_id: "msg",
      provider_id: "p1",
      type: "delivered",
      recipient: `user-${i}@example.com`,
      occurred_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      created_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    await stub.seed({ events: rows });

    const json = JSON.parse(exportEventsJson({ provider_id: "p1" })) as Array<{ id: string }>;
    const csv = exportEventsCsv({ provider_id: "p1" });

    expect(json).toHaveLength(EXPORT_DEFAULT_LIMIT);
    expect(csv.split("\n")).toHaveLength(EXPORT_DEFAULT_LIMIT + 1);
  });

  it("caps direct event export limits and normalizes bad offsets", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `capped-event-${i}`,
      email_id: "msg",
      provider_id: "p1",
      type: "delivered",
      recipient: `capped-${i}@example.com`,
      occurred_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    await stub.seed({ events: rows });

    const json = JSON.parse(exportEventsJson({
      provider_id: "p1",
      limit: EXPORT_MAX_LIMIT + 1,
      offset: -100,
    })) as Array<{ recipient: string }>;

    expect(json).toHaveLength(3);
    expect(json[0]?.recipient).toBe("capped-2@example.com");
  });

  it("keeps event CSV headers stable and honors provider/type/since filters", async () => {
    await stub.seed({
      events: [
        { id: "kept-evt", email_id: "msg", provider_id: "p1", type: "delivered", recipient: "user@example.com", occurred_at: "2026-02-01T00:00:00.000Z" },
        { id: "opened-evt", email_id: "msg", provider_id: "p1", type: "opened", recipient: "user@example.com", occurred_at: "2026-02-02T00:00:00.000Z" },
        { id: "other-evt", provider_id: "p2", type: "delivered", recipient: "other@example.com", occurred_at: "2026-02-03T00:00:00.000Z" },
      ],
    });

    const csv = exportEventsCsv({ provider_id: "p1", type: "delivered", since: "2026-01-15T00:00:00.000Z" });
    expect(csv.split("\n")[0]).toBe("id,email_id,type,recipient,occurred_at");
    expect(csv).toContain("kept-evt");
    expect(csv).toContain("user@example.com");
    expect(csv).not.toContain("opened");
    expect(csv).not.toContain("other@example.com");

    const json = JSON.parse(exportEventsJson({ provider_id: "p1", type: "delivered", since: "2026-01-15T00:00:00.000Z" })) as Array<{ id: string }>;
    expect(json.map((event) => event.id)).toEqual(["kept-evt"]);
  });

  it("paginates event exports and honors until filters", async () => {
    await stub.seed({
      events: [
        { id: "old-evt", email_id: "msg", provider_id: "p1", type: "delivered", recipient: "old@example.com", occurred_at: "2026-01-01T00:00:00.000Z" },
        { id: "mid-evt", email_id: "msg", provider_id: "p1", type: "delivered", recipient: "middle@example.com", occurred_at: "2026-02-01T00:00:00.000Z" },
        { id: "new-evt", email_id: "msg", provider_id: "p1", type: "delivered", recipient: "new@example.com", occurred_at: "2026-03-01T00:00:00.000Z" },
      ],
    });

    const json = JSON.parse(exportEventsJson({
      provider_id: "p1",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-15T00:00:00.000Z",
      limit: 1,
    })) as Array<{ id: string }>;
    expect(json.map((event) => event.id)).toEqual(["mid-evt"]);

    const csv = exportEventsCsv({ provider_id: "p1", until: "2026-02-15T00:00:00.000Z", limit: 1, offset: 1 });
    expect(csv).toContain("old-evt");
    expect(csv).not.toContain("mid-evt");
    expect(csv).not.toContain("new-evt");
  });
});
