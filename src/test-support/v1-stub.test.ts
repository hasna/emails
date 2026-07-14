// Proves the reusable /v1 stub helper works against the REAL client transport:
//  - the synchronous curl-backed resource store (src/db/self-hosted-store.ts), and
//  - the async fetch-backed SelfHostedMailDataSource (src/lib/self-hosted-mail-data-source.ts).
// This doubles as the reference pattern for the fan-out migration.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "./v1-stub.js";
import { selfHostedStoreFor } from "../db/self-hosted-store.js";
import { resolveSelfHostedMailDataSource } from "../lib/self-hosted-mail-data-source.js";

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

  it("sends via POST /v1/messages/send and persists the outbound row", async () => {
    const ds = resolveSelfHostedMailDataSource();
    const res = await ds!.send({ to: "d@x.com", from: "me@x.com", subject: "new", body: "body", markdown: false });
    expect(String(res.id).length).toBeGreaterThan(0);
    const stored = await stub.list("messages");
    expect(stored.some((m) => m["subject"] === "new" && m["direction"] === "outbound")).toBe(true);
  });
});
