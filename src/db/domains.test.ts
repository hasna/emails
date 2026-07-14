// Self-hosted-ONLY: the domains repo routes every read/write to the /v1
// `domains` API. This exercises the REAL synchronous curl transport against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. The /v1 domain entity is
// intentionally minimal (id, domain, provider, verified, timestamps); the rich
// local Domain shape is reconstructed with defaults by apiToDomain(). As a result
// several behaviors changed and the assertions reflect the new model:
//   - source_of_truth is now "postgres" (was "local").
//   - Verification is a single boolean over /v1: updateDomain only flips it when
//     ALL DNS statuses pass (or verified_at is supplied); partial DNS statuses do
//     not persist as individual columns.
//   - updateDomainReadiness is a no-op over /v1 (the schema carries no lifecycle
//     fields) — it just returns the current domain.
// Ordering-sensitive tests seed explicit created_at (create sets created_at≈now).

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  countUsableDomains,
  createDomain,
  findDomainsByName,
  getDomain,
  getDomainByName,
  listDomains,
  listDomainsByProviderIds,
  listUsableDomains,
  moveDomainProvider,
  updateDomain,
  updateDomainReadiness,
  deleteDomain,
  updateDnsStatus,
} from "./domains.js";
import { DomainNotFoundError } from "../types/index.js";

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

const PROVIDER = "prov-1";

/** A snake_case /v1 domain row with the fields apiToDomain reads. */
function dom(row: { id: string; domain: string; provider?: string; verified?: boolean; created_at?: string }): Record<string, unknown> {
  const ts = row.created_at ?? "2026-01-01T00:00:00.000Z";
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider ?? PROVIDER,
    verified: row.verified ?? false,
    created_at: ts,
    updated_at: ts,
  };
}

describe("createDomain", () => {
  it("creates a domain with pending statuses", () => {
    const d = createDomain(PROVIDER, "example.com");
    expect(d.id).toHaveLength(36);
    expect(d.domain).toBe("example.com");
    expect(d.provider_id).toBe(PROVIDER);
    expect(d.dkim_status).toBe("pending");
    expect(d.spf_status).toBe("pending");
    expect(d.dmarc_status).toBe("pending");
    expect(d.domain_type).toBe("self_hosted");
    expect(d.source_of_truth).toBe("postgres");
    expect(d.ownership_status).toBe("pending");
    expect(d.inbound_status).toBe("pending");
    expect(d.outbound_status).toBe("pending");
    expect(d.monitoring_status).toBe("none");
    expect(d.dns_records).toEqual({});
    expect(d.provider_metadata).toEqual({});
    expect(d.verified_at).toBeNull();
  });
});

describe("getDomain", () => {
  it("retrieves domain by id", () => {
    const d = createDomain(PROVIDER, "example.com");
    const found = getDomain(d.id);
    expect(found?.id).toBe(d.id);
    expect(found?.domain).toBe("example.com");
  });

  it("returns null for unknown id", () => {
    expect(getDomain("nonexistent")).toBeNull();
  });
});

describe("getDomainByName", () => {
  it("finds domain by name", () => {
    const d = createDomain(PROVIDER, "example.com");
    const found = getDomainByName(PROVIDER, "example.com");
    expect(found?.id).toBe(d.id);
  });

  it("finds domain by name case-insensitively", () => {
    const d = createDomain(PROVIDER, "Example.com");
    const found = getDomainByName(PROVIDER, "EXAMPLE.COM");
    expect(found?.id).toBe(d.id);
  });

  it("returns null for unknown domain", () => {
    expect(getDomainByName(PROVIDER, "unknown.com")).toBeNull();
  });
});

describe("findDomainsByName", () => {
  it("finds domains case-insensitively across providers", () => {
    const first = createDomain("p1", "Example.com");
    const second = createDomain("p2", "example.com");

    const matches = findDomainsByName("EXAMPLE.COM");
    expect(matches.map((domain) => domain.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe("listDomains", () => {
  it("lists all domains", () => {
    createDomain(PROVIDER, "a.com");
    createDomain(PROVIDER, "b.com");
    expect(listDomains().length).toBe(2);
  });

  it("filters by provider_id", () => {
    createDomain("p1", "a.com");
    createDomain("p2", "b.com");
    expect(listDomains("p1").length).toBe(1);
    expect(listDomains("p2").length).toBe(1);
  });

  it("paginates domains", () => {
    for (let i = 0; i < 5; i++) {
      createDomain("p1", `page-${i}.com`);
    }

    expect(listDomains("p1", { limit: 2 })).toHaveLength(2);
    expect(listDomains("p1", { limit: 2, offset: 2 })).toHaveLength(2);
  });

  it("lists domains for multiple providers in one query", () => {
    const first = createDomain("p1", "first.example.com");
    const second = createDomain("p2", "second.example.com");
    createDomain("p3", "unrelated.example.com");

    const domains = listDomainsByProviderIds(["p1", "p2", "p1"]);

    expect(domains.map((domain) => domain.id).sort()).toEqual([first.id, second.id].sort());
    expect(listDomainsByProviderIds([])).toEqual([]);
  });
});

describe("listUsableDomains / countUsableDomains", () => {
  it("filters, counts, and paginates verified domains over /v1", async () => {
    // "Usable" over /v1 = verified (ownership/dkim derive from the single verified
    // flag); send/receive options are accepted but do not further differentiate.
    await stub.seed({
      domains: [
        dom({ id: "d1", domain: "v1.com", provider: "p1", verified: true, created_at: "2026-01-04T00:00:00.000Z" }),
        dom({ id: "d2", domain: "v2.com", provider: "p1", verified: true, created_at: "2026-01-03T00:00:00.000Z" }),
        dom({ id: "d3", domain: "pending.com", provider: "p1", verified: false, created_at: "2026-01-02T00:00:00.000Z" }),
        dom({ id: "d4", domain: "other.com", provider: "p2", verified: true, created_at: "2026-01-05T00:00:00.000Z" }),
      ],
    });

    expect(countUsableDomains({ provider_id: "p1" })).toBe(2);
    expect(countUsableDomains()).toBe(3);
    // send/receive options do not change the usable set in the self-hosted model.
    expect(countUsableDomains({ provider_id: "p1", send: true })).toBe(2);
    expect(countUsableDomains({ provider_id: "p1", receive: true })).toBe(2);

    expect(listUsableDomains({ provider_id: "p1" }).map((d) => d.domain)).toEqual(["v1.com", "v2.com"]);
    expect(listUsableDomains({ provider_id: "p1", limit: 1, offset: 1 }).map((d) => d.domain)).toEqual(["v2.com"]);
    expect(listUsableDomains({ provider_id: "p2" }).map((d) => d.domain)).toEqual(["other.com"]);
  });
});

describe("updateDomain", () => {
  it("verifies a domain when all DNS statuses pass", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDomain(d.id, { dkim_status: "verified", spf_status: "verified", dmarc_status: "verified" });
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("verified");
    expect(updated.verified_at).not.toBeNull();
  });

  it("verifies a domain when verified_at is supplied", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDomain(d.id, { verified_at: "2026-07-02T00:00:00.000Z" });
    expect(updated.dkim_status).toBe("verified");
  });

  it("does not verify on a partial DNS status (single verified flag over /v1)", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDomain(d.id, { dkim_status: "verified", spf_status: "verified" });
    expect(updated.dkim_status).toBe("pending");
    expect(updated.verified_at).toBeNull();
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDomain("nonexistent", { dkim_status: "verified" })).toThrow(DomainNotFoundError);
  });
});

describe("updateDomainReadiness", () => {
  it("is a no-op over /v1 but returns the current domain", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDomainReadiness(d.id, {
      inbound_status: "ready",
      outbound_status: "ready",
      ownership_status: "verified",
    });
    // The /v1 domain schema does not carry lifecycle/readiness fields; input ignored.
    expect(updated.id).toBe(d.id);
    expect(updated.inbound_status).toBe("pending");
    expect(updated.outbound_status).toBe("pending");
    expect(updated.ownership_status).toBe("pending");
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDomainReadiness("nonexistent", { inbound_status: "ready" })).toThrow(DomainNotFoundError);
  });
});

describe("moveDomainProvider", () => {
  it("moves a domain to a new provider", () => {
    const d = createDomain("p1", "example.com");
    const result = moveDomainProvider(d.id, "p2");
    expect(result.from_provider_id).toBe("p1");
    expect(result.to_provider_id).toBe("p2");
    expect(result.domain.provider_id).toBe("p2");
    expect(result.moved_addresses).toBe(0);
    expect(getDomainByName("p2", "example.com")?.provider_id).toBe("p2");
  });

  it("is a no-op when the target provider matches", () => {
    const d = createDomain("p1", "example.com");
    const result = moveDomainProvider(d.id, "p1");
    expect(result.from_provider_id).toBe("p1");
    expect(result.to_provider_id).toBe("p1");
    expect(result.moved_addresses).toBe(0);
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => moveDomainProvider("nonexistent", "p2")).toThrow(DomainNotFoundError);
  });
});

describe("deleteDomain", () => {
  it("deletes a domain", () => {
    const d = createDomain(PROVIDER, "example.com");
    expect(deleteDomain(d.id)).toBe(true);
    expect(getDomain(d.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteDomain("nonexistent")).toBe(false);
  });
});

describe("updateDnsStatus", () => {
  it("updates all statuses and sets verified_at when all verified", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "verified", "verified");
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("verified");
    expect(updated.verified_at).not.toBeNull();
  });

  it("does not set verified_at if not all verified", () => {
    const d = createDomain(PROVIDER, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "pending", "pending");
    expect(updated.verified_at).toBeNull();
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDnsStatus("nonexistent", "verified", "verified", "verified")).toThrow(DomainNotFoundError);
  });
});
