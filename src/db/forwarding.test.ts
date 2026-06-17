import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { createForwardingRule, listForwardingRules, listPendingForwarding, recordForwardingDelivery } from "./forwarding.js";
import { storeInboundEmail } from "./inbound.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("forwarding rules", () => {
  it("creates and updates app-copy rules by source/target/mode", () => {
    const first = createForwardingRule({
      source_address: "User@Example.com",
      target_address: "archive@example.net",
      from_address: "user@example.com",
    });
    const second = createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      enabled: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.source_address).toBe("user@example.com");
    expect(second.target_address).toBe("archive@example.net");
    expect(second.enabled).toBe(false);
    expect(listForwardingRules()).toHaveLength(1);
  });

  it("lists pending inbound messages once until delivery is recorded", () => {
    const rule = createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    });
    getDatabase().run("UPDATE forwarding_rules SET created_at = ? WHERE id = ?", ["2025-01-01T00:00:00.000Z", rule.id]);
    const updatedRule = listForwardingRules()[0]!;
    const inbound = storeInboundEmail({
      provider_id: null,
      message_id: "<msg@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["User@Example.com"],
      cc_addresses: [],
      subject: "hello",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-01-01T00:00:00.000Z",
    });

    expect(listPendingForwarding()).toEqual([{ rule: updatedRule, inbound_email_id: inbound.id }]);

    recordForwardingDelivery({
      rule_id: updatedRule.id,
      inbound_email_id: inbound.id,
      sent_email_id: null,
      status: "sent",
    });

    expect(listPendingForwarding()).toEqual([]);
  });

  it("does not forward historical mail unless backfill is requested", () => {
    const rule = createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    });
    const inbound = storeInboundEmail({
      provider_id: null,
      message_id: "<old@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["user@example.com"],
      cc_addresses: [],
      subject: "old",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-01-01T00:00:00.000Z",
    });

    expect(listPendingForwarding()).toEqual([]);
    expect(listPendingForwarding(100, undefined, { backfill: true })).toEqual([{ rule, inbound_email_id: inbound.id }]);
  });

  it("retries failed forwarding deliveries but suppresses sent deliveries", () => {
    const rule = createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
    });
    getDatabase().run("UPDATE forwarding_rules SET created_at = ? WHERE id = ?", ["2025-01-01T00:00:00.000Z", rule.id]);
    const updatedRule = listForwardingRules()[0]!;
    const inbound = storeInboundEmail({
      provider_id: null,
      message_id: "<retry@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["user@example.com"],
      cc_addresses: [],
      subject: "retry",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-01-01T00:00:00.000Z",
    });

    recordForwardingDelivery({
      rule_id: updatedRule.id,
      inbound_email_id: inbound.id,
      sent_email_id: null,
      status: "failed",
      error: "temporary failure",
    });

    expect(listPendingForwarding()).toEqual([{ rule: updatedRule, inbound_email_id: inbound.id }]);

    recordForwardingDelivery({
      rule_id: updatedRule.id,
      inbound_email_id: inbound.id,
      sent_email_id: null,
      status: "sent",
    });

    expect(listPendingForwarding()).toEqual([]);
  });
});
