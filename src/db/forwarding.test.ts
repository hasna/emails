// Self-hosted-ONLY: forwarding RULES route to /v1/forwarding. The pending-forward
// scan and the delivery ledger were LOCAL SQL joins over inbound_emails /
// inbound_recipients / forwarding_deliveries — data the client does not own — so
// those functions now fail loud (the server runs the forwarding pipeline).
//
// Migrated from the deleted local-SQLite pattern: the former tests drove
// storeInboundEmail + listPendingForwarding + recordForwardingDelivery and mutated
// created_at via `db.run(...)`. Those covered server-owned behavior and are deleted
// (see DELETED notes below); the rule CRUD/dedup/filter path is exercised here
// against the out-of-process /v1 stub (see src/test-support/v1-stub.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createForwardingRule,
  listForwardingRules,
  listPendingForwarding,
  recordForwardingDelivery,
  removeForwardingRule,
  setForwardingRuleEnabled,
} from "./forwarding.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("forwarding rules", () => {
  it("creates and updates app-copy rules by source/target/mode", async () => {
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

    // Same source/target/mode → update in place (dedup), not a second row.
    expect(second.id).toBe(first.id);
    expect(second.source_address).toBe("user@example.com");
    expect(second.target_address).toBe("archive@example.net");
    expect(second.enabled).toBe(false);
    expect(listForwardingRules()).toHaveLength(1);
    expect(await stub.list("forwarding")).toHaveLength(1);
  });

  it("filters by source/enabled and orders by source then target", () => {
    createForwardingRule({ source_address: "b@x.com", target_address: "t@x.com" });
    createForwardingRule({ source_address: "a@x.com", target_address: "t@x.com" });
    createForwardingRule({ source_address: "a@x.com", target_address: "z@x.com", enabled: false });

    expect(listForwardingRules().map((r) => [r.source_address, r.target_address])).toEqual([
      ["a@x.com", "t@x.com"],
      ["a@x.com", "z@x.com"],
      ["b@x.com", "t@x.com"],
    ]);
    expect(listForwardingRules({ source_address: "A@X.com" }).map((r) => r.target_address)).toEqual([
      "t@x.com",
      "z@x.com",
    ]);
    expect(listForwardingRules({ enabled: false }).map((r) => r.source_address)).toEqual(["a@x.com"]);
  });

  it("toggles and removes a rule", async () => {
    const rule = createForwardingRule({ source_address: "user@example.com", target_address: "archive@example.net" });
    expect(rule.enabled).toBe(true);

    expect(setForwardingRuleEnabled(rule.id, false).enabled).toBe(false);
    expect(listForwardingRules()[0]!.enabled).toBe(false);

    expect(removeForwardingRule(rule.id)).toBe(true);
    expect(listForwardingRules()).toEqual([]);
    expect(await stub.list("forwarding")).toEqual([]);
  });

  it("fails loud for server-owned pending-forward and delivery-ledger reads", () => {
    // DELETED (server-owned): the former "lists pending inbound messages once",
    // "does not forward historical mail unless backfill", and "retries failed
    // forwarding deliveries" tests exercised listPendingForwarding +
    // recordForwardingDelivery, which were LOCAL SQL joins over inbound_emails and
    // the forwarding_deliveries ledger. That pipeline now runs on the server; the
    // client must fail loud rather than silently return nothing.
    expect(() => listPendingForwarding()).toThrow(/not available in the self-hosted client/i);
    expect(() =>
      recordForwardingDelivery({
        rule_id: "r1",
        inbound_email_id: "i1",
        sent_email_id: null,
        status: "sent",
      }),
    ).toThrow(/not available in the self-hosted client/i);
  });
});
