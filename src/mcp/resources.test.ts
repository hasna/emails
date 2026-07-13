import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  addressesResourcePayloadForRuntime,
  agentContextResourcePayload,
  domainsResourcePayloadForRuntime,
  mailboxesResourcePayloadForRuntime,
  recentErrorsResourcePayloadForRuntime,
  sourcesResourcePayloadForRuntime,
} from "./resources.js";

// Self-hosted-ONLY: every MCP resource payload routes through the /v1 API (via the
// resource repositories + mail data-source seam). There is no local SQLite island,
// so all fixtures are seeded on the /v1 stub.

const NOW = "2026-07-13T00:00:00.000Z";

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

describe("MCP resource payloads (self-hosted /v1)", () => {
  it("routes the domain resource through the self-hosted API", async () => {
    await stub.seed({
      domains: [
        { id: "domain-1", domain: "example.com", status: "ready", provider: "ses", verified: true, notes: null, created_at: NOW, updated_at: NOW },
        { id: "domain-2", domain: "pending.example.com", status: "pending", provider: "ses", verified: false, notes: null, created_at: NOW, updated_at: NOW },
      ],
    });

    const domains = domainsResourcePayloadForRuntime() as {
      domains: Array<{ id: string; domain: string; provisioning: unknown; readiness: unknown }>;
      mode: string;
      source: string;
      note?: string;
    };

    expect(domains.mode).toBe("self_hosted");
    expect(domains.source).toBe("self_hosted_api");
    expect(domains.note).toBeUndefined();
    expect(domains.domains.map((domain) => domain.domain)).toEqual(["example.com", "pending.example.com"]);
    expect(domains.domains[0]).toHaveProperty("readiness");
    expect(domains.domains[0]?.provisioning).toBeNull();
  });

  it("routes the address resource through the self-hosted API", async () => {
    await stub.seed({
      addresses: [
        { id: "addr-1", email: "ops@example.com", domain: "example.com", status: "active", verified: true, created_at: NOW, updated_at: NOW },
        { id: "addr-2", email: "pending@example.com", domain: "example.com", status: "active", verified: false, created_at: NOW, updated_at: NOW },
      ],
    });

    const addresses = await addressesResourcePayloadForRuntime() as {
      addresses: Array<{ id: string; email: string; provisioning: unknown }>;
      mode: string;
      source: string;
      note?: string;
    };

    expect(addresses.mode).toBe("self_hosted");
    expect(addresses.source).toBe("self_hosted_api");
    expect(addresses.note).toBeUndefined();
    expect(addresses.addresses.map((address) => address.email)).toEqual(["ops@example.com", "pending@example.com"]);
    expect(addresses.addresses[0]?.provisioning).toBeNull();
  });

  it("reports recent-error resource as API-only with no local state read", () => {
    const recentErrors = recentErrorsResourcePayloadForRuntime() as {
      errors: unknown[];
      mode: string;
      source: string;
      note: string;
    };

    expect(recentErrors).toMatchObject({
      errors: [],
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(recentErrors.note).toContain("no local database or config state was read");
  });

  it("routes runtime mailboxes and sources through the self-hosted API", async () => {
    await stub.seed({
      messages: [
        { id: "m1", direction: "inbound", from_addr: "a@x.com", to_addrs: ["me@x.com"], subject: "hello", body_text: "hi", status: "received", is_read: false, is_starred: false, labels: [], received_at: "2026-06-02T00:00:00.000Z" },
        { id: "m2", direction: "inbound", from_addr: "b@x.com", to_addrs: ["me@x.com"], subject: "second", body_text: "yo", status: "received", is_read: true, is_starred: false, labels: [], received_at: "2026-06-03T00:00:00.000Z" },
        { id: "m3", direction: "outbound", from_addr: "me@x.com", to_addrs: ["c@x.com"], subject: "sent one", body_text: "out", status: "sent", labels: [], created_at: "2026-06-01T00:00:00.000Z" },
      ],
    });

    const mailboxes = await mailboxesResourcePayloadForRuntime() as { counts: { inbox: number; unread: number; sent: number } };
    const sources = await sourcesResourcePayloadForRuntime() as { sources: Array<{ id: string; badges: string[]; total: number; unread: number }> };

    expect(mailboxes.counts).toMatchObject({ inbox: 2, unread: 1, sent: 1 });
    expect(sources.sources[0]).toMatchObject({
      id: "self_hosted",
      badges: ["self_hosted"],
      total: 2,
      unread: 1,
    });
  });

  it("keeps the agent context resource compact with samples and a full-context pointer", async () => {
    const payload = await agentContextResourcePayload() as {
      status: { domains: Record<string, unknown>; addresses: Record<string, unknown> };
      limits: { samples: number };
      truncated: { domains: boolean; addresses: boolean };
      full_context_resource: string;
      full_context_cli: string;
    };

    expect(payload.limits.samples).toBe(5);
    expect(payload.status).toHaveProperty("domains");
    expect(payload.status).toHaveProperty("addresses");
    expect(payload.truncated).toHaveProperty("domains");
    expect(payload.truncated).toHaveProperty("addresses");
    expect(payload.full_context_resource).toBe("emails://agent/context/full");
    expect(payload.full_context_cli).toBe("emails agent context --json");
  });
});
