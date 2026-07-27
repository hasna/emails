// Proves the reusable /v1 stub helper works against the REAL client transport:
//  - the synchronous curl-backed resource store (src/db/self-hosted-store.ts), and
//  - the async fetch-backed SelfHostedMailDataSource (src/lib/self-hosted-mail-data-source.ts).
// This doubles as the reference pattern for the fan-out migration.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "./v1-stub.js";
import { selfHostedStoreFor } from "../db/self-hosted-store.js";
import { resolveSelfHostedMailDataSource } from "../lib/self-hosted-mail-data-source.js";
import { SELF_HOSTED_RESOURCES } from "../server/self-hosted/resources.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub({
    seed: {
      domains: [
        { id: "11111111-1111-4111-8111-111111111111", domain: "seed.example.com", verified: true },
      ],
    },
  });
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("v1-stub — generic resource CRUD over the synchronous curl store", () => {
  it("exposes a loopback base URL and an api key", () => {
    expect(stub.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(stub.apiKey.length).toBeGreaterThan(0);
  });

  it("serves the initial seed and round-trips create/get/delete", () => {
    const store = selfHostedStoreFor("domains");

    // Seeded row is visible.
    expect(store.list().map((r) => r["domain"])).toEqual(["seed.example.com"]);

    // Create routes to the stub and echoes the entity with an id.
    const created = store.create({ domain: "new.example.com", provider: "selfHosted" });
    expect(created["domain"]).toBe("new.example.com");
    expect(String(created["id"]).length).toBeGreaterThan(0);

    // Read back by id.
    const fetched = store.get(String(created["id"]));
    expect(fetched?.["domain"]).toBe("new.example.com");

    // List now has both.
    expect(store.list().map((r) => r["domain"]).sort()).toEqual(["new.example.com", "seed.example.com"]);

    // Delete removes it (and reports 404 as false afterwards).
    expect(store.del(String(created["id"]))).toBe(true);
    expect(store.del(String(created["id"]))).toBe(false);
    expect(store.list().map((r) => r["domain"])).toEqual(["seed.example.com"]);
  });

  it("reset() restores the initial seed between tests (no cross-test leakage)", async () => {
    const store = selfHostedStoreFor("domains");
    // The previous test's create/delete left only the seed; a fresh create here...
    store.create({ domain: "leaky.example.com" });
    expect(store.list()).toHaveLength(2);
    // ...is wiped by an explicit reset back to the seed.
    await stub.reset();
    expect(store.list().map((r) => r["domain"])).toEqual(["seed.example.com"]);
  });

  it("seed() replaces the whole store for a resource the test cares about", async () => {
    await stub.seed({ contacts: [{ id: "c1", email: "a@x.com" }, { id: "c2", email: "b@x.com" }] });
    const store = selfHostedStoreFor("contacts");
    expect(store.list().map((r) => r["email"]).sort()).toEqual(["a@x.com", "b@x.com"]);
    // The domains resource is now empty (seed replaced everything).
    expect(selfHostedStoreFor("domains").list()).toEqual([]);
  });

  it("enforces bearer auth (list back via the control dump helper)", async () => {
    const unauth = await fetch(`${stub.baseUrl}/v1/domains`);
    expect(unauth.status).toBe(401);
    // The unauthenticated control dump still works for assertions.
    const dumped = await stub.list("domains");
    expect(dumped.map((r) => r["domain"])).toEqual(["seed.example.com"]);
  });

  const expectItemMiss = async (resource: string, method: "GET" | "PATCH" | "PUT" | "DELETE", error: string) => {
    const response = await fetch(`${stub.baseUrl}/v1/${resource}/missing-id`, {
      method,
      headers: {
        authorization: `Bearer ${stub.apiKey}`,
        ...(method === "PATCH" || method === "PUT" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "PATCH" || method === "PUT" ? { body: "{}" } : {}),
    });
    expect(response.status, `${method} ${resource}`).toBe(404);
    expect(await response.json(), `${method} ${resource}`).toEqual({ error });
  };

  it("mirrors generic resource item-miss errors for every CRUD method", async () => {
    for (const method of ["GET", "PATCH", "PUT", "DELETE"] as const) {
      await expectItemMiss("templates", method, "templates not found");
    }
  });

  it("mirrors bespoke domain, address, and message item-miss errors for every CRUD method", async () => {
    for (const [resource, error] of [
      ["domains", "domain not found"],
      ["addresses", "address not found"],
      ["messages", "message not found"],
    ] as const) {
      for (const method of ["GET", "PATCH", "PUT", "DELETE"] as const) {
        await expectItemMiss(resource, method, error);
      }
    }
  });

  it("normalizes every registered resource seed to a complete server row", async () => {
    await stub.seed(Object.fromEntries(
      SELF_HOSTED_RESOURCES.map((spec) => [
        spec.path,
        [{ ...(spec.idColumn ? { [spec.idColumn]: `fixture-${spec.path}` } : {}) }],
      ]),
    ));

    for (const spec of SELF_HOSTED_RESOURCES) {
      const response = await fetch(`${stub.baseUrl}/v1/${spec.path}`, {
        headers: { authorization: `Bearer ${stub.apiKey}` },
      });
      expect(response.status, spec.path).toBe(200);
      const body = await response.json() as { items?: Array<Record<string, unknown>> };
      expect(body.items, spec.path).toHaveLength(1);
      const row = body.items![0]!;
      const key = spec.idColumn ?? "id";
      for (const field of [
        key,
        "tenant_id",
        ...spec.columns.map((column) => column.name),
        "created_at",
        "updated_at",
      ]) {
        expect(Object.hasOwn(row, field), `${spec.path}.${field}`).toBe(true);
      }
      expect(row["tenant_id"], spec.path).toBe("00000000-0000-0000-0000-000000000001");
      expect(Number.isNaN(Date.parse(String(row["created_at"]))), spec.path).toBe(false);
      expect(Number.isNaN(Date.parse(String(row["updated_at"]))), spec.path).toBe(false);
    }

    const providers = await stub.list("providers");
    expect(providers[0]).toMatchObject({ active: true, region: null });
  });
});

describe("v1-stub — messages semantics over the async mail data source", () => {
  beforeEach(async () => {
    await stub.seed({
      messages: [
        { id: "m1", direction: "inbound", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "hello", body_text: "hi", status: "received", is_read: false, is_starred: false, labels: [], received_at: "2026-06-02T00:00:00.000Z" },
        { id: "m2", direction: "inbound", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "second", body_text: "yo", status: "received", is_read: true, is_starred: false, labels: [], received_at: "2026-06-03T00:00:00.000Z" },
        { id: "m3", direction: "outbound", from_addr: "me@x.com", to_addrs: ["c@x.com"], subject: "sent one", body_text: "out", status: "sent", labels: [], created_at: "2026-06-01T00:00:00.000Z" },
      ],
    });
  });

  it("lists the inbox newest-first and computes counts", async () => {
    const ds = resolveSelfHostedMailDataSource();
    expect(ds).not.toBeNull();
    const inbox = await ds!.listMailbox("inbox");
    expect(inbox.map((m) => m.id)).toEqual(["m2", "m1"]);

    const counts = await ds!.mailboxCounts();
    expect(counts.inbox).toBe(2);
    expect(counts.unread).toBe(1);
    expect(counts.sent).toBe(1);
  });

  it("paginates full message pages with an opaque cursor and preserves offset fallback", async () => {
    await stub.seed({
      messages: [
        { id: "m1", direction: "inbound", received_at: "2026-06-01T00:00:00.000Z" },
        { id: "m2", direction: "inbound", received_at: "2026-06-02T00:00:00.000Z" },
        { id: "m3", direction: "inbound", received_at: "2026-06-03T00:00:00.000Z" },
        { id: "m4", direction: "inbound", received_at: "2026-06-04T00:00:00.000Z" },
      ],
    });
    const get = async (query: string) => {
      const response = await fetch(`${stub.baseUrl}/v1/messages?${query}`, {
        headers: { authorization: `Bearer ${stub.apiKey}` },
      });
      return {
        response,
        body: await response.json() as {
          messages?: Array<Record<string, unknown>>;
          next_cursor?: string | null;
        },
      };
    };

    const first = await get("limit=2");
    expect(first.response.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(["messages", "next_cursor"]);
    expect(first.body.messages?.map((row) => row["id"])).toEqual(["m4", "m3"]);
    expect(typeof first.body.next_cursor).toBe("string");
    expect(first.body.next_cursor).not.toBe("2");
    const repeatedFirst = await get("limit=2");
    expect(repeatedFirst.body.next_cursor).toBe(first.body.next_cursor);

    const second = await get(`limit=2&offset=999&cursor=${encodeURIComponent(first.body.next_cursor!)}`);
    expect(second.response.status).toBe(200);
    expect(second.body.messages?.map((row) => row["id"])).toEqual(["m2", "m1"]);
    expect(typeof second.body.next_cursor).toBe("string");

    const terminal = await get(`limit=2&cursor=${encodeURIComponent(second.body.next_cursor!)}`);
    expect(terminal.response.status).toBe(200);
    expect(terminal.body).toEqual({ messages: [], next_cursor: null });

    const offset = await get("limit=1&offset=1");
    expect(offset.response.status).toBe(200);
    expect(offset.body.messages?.map((row) => row["id"])).toEqual(["m3"]);
    expect(typeof offset.body.next_cursor).toBe("string");

    const malformed = await get("limit=2&cursor=not-a-stub-cursor");
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toEqual({ error: "cursor is not a valid pagination cursor" });
  });

  it("sends via POST /v1/messages/send and persists the outbound row", async () => {
    const ds = resolveSelfHostedMailDataSource();
    const res = await ds!.send({ to: "d@x.com", from: "me@x.com", subject: "new", body: "body", markdown: false });
    expect(String(res.id).length).toBeGreaterThan(0);
    const stored = await stub.list("messages");
    expect(stored.some((m) => m["subject"] === "new" && m["direction"] === "outbound")).toBe(true);
  });
});
