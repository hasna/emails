import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  createDomain,
  getDomain,
  getDomainByName,
  listDomains,
  updateDomain,
  deleteDomain,
  updateDnsStatus,
} from "./domains.js";
import { DomainNotFoundError } from "../types/index.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createDomain", () => {
  it("creates a domain with pending statuses", () => {
    const d = createDomain(providerId, "example.com");
    expect(d.id).toHaveLength(36);
    expect(d.domain).toBe("example.com");
    expect(d.provider_id).toBe(providerId);
    expect(d.dkim_status).toBe("pending");
    expect(d.spf_status).toBe("pending");
    expect(d.dmarc_status).toBe("pending");
    expect(d.verified_at).toBeNull();
  });
});

describe("getDomain", () => {
  it("retrieves domain by id", () => {
    const d = createDomain(providerId, "example.com");
    const found = getDomain(d.id);
    expect(found?.id).toBe(d.id);
    expect(found?.domain).toBe("example.com");
  });

  it("returns null for unknown id", () => {
    expect(getDomain("nonexistent")).toBeNull();
  });
});

describe("getDomainByName", () => {
  it("finds domain by provider and name", () => {
    const d = createDomain(providerId, "example.com");
    const found = getDomainByName(providerId, "example.com");
    expect(found?.id).toBe(d.id);
  });

  it("returns null for unknown domain", () => {
    expect(getDomainByName(providerId, "unknown.com")).toBeNull();
  });
});

describe("listDomains", () => {
  it("lists all domains", () => {
    createDomain(providerId, "a.com");
    createDomain(providerId, "b.com");
    const list = listDomains();
    expect(list.length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createDomain(providerId, "a.com");
    createDomain(p2.id, "b.com");
    expect(listDomains(providerId).length).toBe(1);
    expect(listDomains(p2.id).length).toBe(1);
  });
});

describe("updateDomain", () => {
  it("updates dns statuses", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDomain(d.id, { dkim_status: "verified", spf_status: "verified" });
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("pending");
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDomain("nonexistent", { dkim_status: "verified" })).toThrow(DomainNotFoundError);
  });
});

describe("deleteDomain", () => {
  it("deletes a domain", () => {
    const d = createDomain(providerId, "example.com");
    expect(deleteDomain(d.id)).toBe(true);
    expect(getDomain(d.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteDomain("nonexistent")).toBe(false);
  });
});

describe("updateDnsStatus", () => {
  it("updates all statuses and sets verified_at when all verified", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "verified", "verified");
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("verified");
    expect(updated.verified_at).not.toBeNull();
  });

  it("does not set verified_at if not all verified", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "pending", "pending");
    expect(updated.verified_at).toBeNull();
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDnsStatus("nonexistent", "verified", "verified", "verified")).toThrow(DomainNotFoundError);
  });
});
