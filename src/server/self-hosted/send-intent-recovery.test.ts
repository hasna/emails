import { describe, expect, it } from "bun:test";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import {
  EmailsSelfHostedStore,
  SendIntentAtomicityUnavailableError,
} from "./store.js";

describe("send-intent recovery store boundary", () => {
  it("fails closed when the backing client cannot provide real transactions", async () => {
    let calls = 0;
    const client: TypedQueryClient = {
      async query() { calls++; return { rows: [], rowCount: 0 }; },
      async many() { calls++; return []; },
      async get() { calls++; return null; },
      async one() { calls++; throw new Error("unexpected query"); },
      async execute() { calls++; },
    };
    const store = new EmailsSelfHostedStore(client)
      .forTenant("00000000-0000-0000-0000-000000000001");
    const key = "transaction-boundary-key";

    await expect(store.lookupSendIntent(key)).rejects.toBeInstanceOf(SendIntentAtomicityUnavailableError);
    await expect(store.cancelSendIntent(key)).rejects.toBeInstanceOf(SendIntentAtomicityUnavailableError);
    await expect(store.reserveSendIntent({
      from_addr: "sender@example.test",
      to_addrs: ["recipient@example.test"],
      idempotency_key: key,
      send_payload_hash: "payload-hash",
    })).rejects.toBeInstanceOf(SendIntentAtomicityUnavailableError);
    await expect(store.claimSendIntent("message-id")).rejects.toBeInstanceOf(SendIntentAtomicityUnavailableError);
    expect(calls).toBe(0);
  });

  it("rejects unbounded or unsafe keys before touching even a test store", async () => {
    let calls = 0;
    const client: TypedQueryClient = {
      async query() { calls++; return { rows: [], rowCount: 0 }; },
      async many() { calls++; return []; },
      async get() { calls++; return null; },
      async one() { calls++; throw new Error("unexpected query"); },
      async execute() { calls++; },
    };
    const store = new EmailsSelfHostedStore(client, { allowUnsafeTestTransactions: true })
      .forTenant("00000000-0000-0000-0000-000000000001");

    for (const key of ["", " leading-space", "x".repeat(201), "unsafe\nkey", "\uD800"]) {
      await expect(store.lookupSendIntent(key)).rejects.toThrow("idempotency key must be 1-200 safe characters");
      await expect(store.cancelSendIntent(key)).rejects.toThrow("idempotency key must be 1-200 safe characters");
    }
    expect(calls).toBe(0);
  });

  it("requires reconciliation consistently for keyed legacy none rows", async () => {
    const key = "legacy-none-key";
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      direction: "outbound",
      from_addr: "sender@example.test",
      to_addrs: ["recipient@example.test"],
      cc_addrs: [],
      subject: "legacy send intent",
      body_text: null,
      body_html: null,
      status: "queued",
      provider_message_id: null,
      message_id: null,
      in_reply_to: null,
      received_at: null,
      is_read: false,
      is_starred: false,
      labels: [],
      headers: {},
      attachments: [],
      source_id: null,
      idempotency_key: key,
      send_payload_hash: null,
      send_state: "none",
      send_started_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const client: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async many() { return []; },
      async get<T>(sql: string) {
        if (sql.includes("FROM messages")) return record as T;
        return null;
      },
      async one() { throw new Error("unexpected query"); },
      async execute() {},
    };
    const store = new EmailsSelfHostedStore(client, { allowUnsafeTestTransactions: true })
      .forTenant("00000000-0000-0000-0000-000000000001");

    const lookup = await store.lookupSendIntent(key);
    const cancellation = await store.cancelSendIntent(key);

    expect(lookup).toMatchObject({
      found: true,
      tombstoned: false,
      reconciliation_required: true,
      message: { id: record.id, send_state: "none" },
    });
    expect(cancellation).toMatchObject({
      outcome: "reconciliation_required",
      tombstoned: true,
      reconciliation_required: true,
      message: { id: record.id, send_state: "none" },
    });
    expect(lookup.reconciliation_required).toBe(cancellation.reconciliation_required);
  });
});
