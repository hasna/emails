import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { getEmail } from "../db/emails.js";
import { createForwardingRule } from "../db/forwarding.js";
import { storeInboundEmail } from "../db/inbound.js";
import { processForwardingRules } from "./forwarding.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("processForwardingRules", () => {
  it("forwards pending inbound mail once through the injected sender", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      provider_id: provider.id,
      from_address: "user@example.com",
    });
    getDatabase().run("UPDATE forwarding_rules SET created_at = ? WHERE source_address = ?", ["2025-01-01T00:00:00.000Z", "user@example.com"]);
    storeInboundEmail({
      provider_id: null,
      message_id: "<msg@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["user@example.com"],
      cc_addresses: [],
      subject: "Verify",
      text_body: "123456",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 6,
      received_at: "2026-01-01T00:00:00.000Z",
    });

    const sends: unknown[] = [];
    const first = await processForwardingRules({
      send: async (_providerId, opts) => {
        sends.push(opts);
        return { messageId: "provider-message-1", providerId: provider.id, usedFailover: false };
      },
    });
    const second = await processForwardingRules({
      send: async () => {
        throw new Error("should not resend");
      },
    });

    expect(first.sent).toBe(1);
    expect(second.attempted).toBe(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      from: "user@example.com",
      to: "archive@example.net",
      subject: "Fwd: Verify",
    });
    expect(getEmail(first.items[0]!.sent_email_id!)).toMatchObject({
      provider_message_id: "provider-message-1",
      from_address: "user@example.com",
    });
  });
});
