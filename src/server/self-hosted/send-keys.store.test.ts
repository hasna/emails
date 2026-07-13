// Store-level coverage for scoped send keys: minting persists only a hash (in the
// dedicated send_key_secrets table, never on the generic send_keys resource),
// verification resolves a token and stamps last_used_at, revoked keys fail, and
// from-address authorization keys off address ownership.
//
// Uses a small purpose-built in-memory client that emulates ONLY the specific
// queries the send-key store methods issue, so the real hashing/branching logic
// is exercised without a live Postgres.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";

interface SendKeyRow {
  id: string;
  owner_id: string | null;
  prefix: string | null;
  label: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
interface SecretRow { id: string; send_key_id: string; key_hash: string }
interface AddressRow { id: string; email: string; owner_id: string | null; administrator_id: string | null }

function sendKeyClient() {
  const sendKeys: SendKeyRow[] = [];
  const secrets: SecretRow[] = [];
  const addresses: AddressRow[] = [];

  const client: TypedQueryClient = {
    async query() { throw new Error("query() not emulated"); },
    async many<T>() { return [] as unknown as T[]; },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      const p = params ?? [];
      if (/INSERT INTO send_keys/i.test(sql)) {
        const now = new Date().toISOString();
        const row: SendKeyRow = {
          id: String(p[0]), owner_id: (p[1] as string) ?? null, prefix: (p[2] as string) ?? null,
          label: (p[3] as string) ?? null, last_used_at: null, revoked_at: null, created_at: now, updated_at: now,
        };
        sendKeys.push(row);
        return row as unknown as T;
      }
      throw new Error(`one() not emulated: ${sql}`);
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      const p = params ?? [];
      // M4 assertNotOtherTenant: owner ids in these tests are not real owner rows,
      // so the referenced-row lookup returns null (reference allowed).
      if (/FROM owners WHERE id = \$1/i.test(sql)) return null as unknown as T | null;
      if (/FROM send_key_secrets WHERE key_hash = \$1/i.test(sql)) {
        const s = secrets.find((x) => x.key_hash === p[0]);
        return (s ? { send_key_id: s.send_key_id } : null) as unknown as T | null;
      }
      if (/^\s*SELECT[\s\S]*FROM send_keys WHERE id = \$1/i.test(sql)) {
        return (sendKeys.find((k) => k.id === p[0]) ?? null) as unknown as T | null;
      }
      if (/^\s*UPDATE send_keys SET last_used_at/i.test(sql)) {
        const k = sendKeys.find((x) => x.id === p[0]);
        if (!k) return null;
        const now = new Date().toISOString();
        k.last_used_at = now;
        k.updated_at = now;
        return { ...k } as unknown as T;
      }
      if (/FROM addresses[\s\S]*WHERE lower\(email\) = \$1/i.test(sql)) {
        const email = String(p[0]);
        const ownerId = p[1];
        const a = addresses.find((x) => x.email.toLowerCase() === email && (x.owner_id === ownerId || x.administrator_id === ownerId));
        return (a ? { one: 1 } : null) as unknown as T | null;
      }
      throw new Error(`get() not emulated: ${sql}`);
    },
    async execute(sql: string, params?: readonly unknown[]): Promise<void> {
      const p = params ?? [];
      if (/INSERT INTO send_key_secrets/i.test(sql)) {
        secrets.push({ id: String(p[0]), send_key_id: String(p[1]), key_hash: String(p[2]) });
        return;
      }
      // send_key_tenants resolution map (design §6 H2) — no-op in this shim.
      if (/INSERT INTO send_key_tenants/i.test(sql)) return;
      throw new Error(`execute() not emulated: ${sql}`);
    },
  };

  return { client, sendKeys, secrets, addresses };
}

describe("send keys: mint", () => {
  test("mint returns an esk_ token, persists only its hash, and never the token", async () => {
    const { client, sendKeys, secrets } = sendKeyClient();
    const store = new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
    const { token, key } = await store.mintSendKey({ owner_id: "o1", label: "ci" });

    expect(token.startsWith("esk_")).toBe(true);
    expect(key.owner_id).toBe("o1");
    expect(key.label).toBe("ci");
    expect(key).not.toHaveProperty("key_hash");

    // The summary row carries no secret; the hash lives only in send_key_secrets.
    expect(sendKeys[0]).not.toHaveProperty("key_hash");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.key_hash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    // The plaintext token is never stored anywhere.
    expect(secrets[0]!.key_hash).not.toContain(token);
  });
});

describe("send keys: verify", () => {
  test("a valid token resolves to its key and stamps last_used_at", async () => {
    const { client } = sendKeyClient();
    const store = new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
    const { token, key } = await store.mintSendKey({ owner_id: "o1" });

    const verified = await store.verifySendKey(token);
    expect(verified?.id).toBe(key.id);
    expect(verified?.owner_id).toBe("o1");
    expect(verified?.last_used_at).toBeTruthy();
  });

  test("an unknown or empty token returns null", async () => {
    const { client } = sendKeyClient();
    const store = new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
    await store.mintSendKey({ owner_id: "o1" });
    expect(await store.verifySendKey("esk_bogus")).toBeNull();
    expect(await store.verifySendKey("")).toBeNull();
  });

  test("a revoked key does not verify", async () => {
    const { client, sendKeys } = sendKeyClient();
    const store = new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
    const { token } = await store.mintSendKey({ owner_id: "o1" });
    sendKeys[0]!.revoked_at = new Date().toISOString();
    expect(await store.verifySendKey(token)).toBeNull();
  });
});

describe("send keys: from-address authorization", () => {
  test("owner or administrator of the address is authorized; others are not", async () => {
    const { client, addresses } = sendKeyClient();
    const store = new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
    addresses.push({ id: "a1", email: "mine@x.com", owner_id: "o1", administrator_id: "agent1" });

    expect(await store.isOwnerAuthorizedFrom("o1", "mine@x.com")).toBe(true);
    // Display-name From values are canonicalized to the bare address.
    expect(await store.isOwnerAuthorizedFrom("agent1", "Ops <mine@x.com>")).toBe(true);
    expect(await store.isOwnerAuthorizedFrom("o2", "mine@x.com")).toBe(false);
    expect(await store.isOwnerAuthorizedFrom("o1", "victim@x.com")).toBe(false);
    expect(await store.isOwnerAuthorizedFrom("", "mine@x.com")).toBe(false);
    expect(await store.isOwnerAuthorizedFrom("o1", "not-an-email")).toBe(false);
  });
});
