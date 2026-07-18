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
});
