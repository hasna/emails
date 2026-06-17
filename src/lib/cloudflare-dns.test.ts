import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { CloudflareDnsClient } from "./cloudflare-dns.js";

// ─── Mock Cloudflare connector client ────────────────────────────────────────

type MockRecord = { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean; priority?: number };
let mockZones: { id: string; name: string; name_servers?: string[] }[] = [];
let mockRecords: MockRecord[] = [];
let createCalled: { type: string; name: string; content: string }[] = [];

const mockCf = {
  listZones: mock(async (params?: { name?: string }) => (
    params?.name
      ? mockZones.filter((z) => z.name === params.name)
      : mockZones
  )),
  listDnsRecords: mock(async (_zoneId: string, params?: { type?: string; name?: string }) => (
    mockRecords.filter((r) => {
      if (params?.type && r.type !== params.type) return false;
      if (params?.name && r.name !== params.name) return false;
      return true;
    })
  )),
  createDnsRecord: mock(async (_zoneId: string, params: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) => {
    createCalled.push({ type: params.type, name: params.name, content: params.content });
    const record: MockRecord = { id: `rec-${Math.random().toString(36).slice(2,8)}`, type: params.type, name: params.name, content: params.content, ttl: params.ttl ?? 300, proxied: params.proxied ?? false };
    mockRecords.push(record);
    return record;
  }),
};

const { findZone, upsertEmailDnsRecords, addMxRecord } = await import("./cloudflare-dns.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCf() { return mockCf as unknown as CloudflareDnsClient; }

beforeEach(() => {
  mockZones = [];
  mockRecords = [];
  createCalled = [];
  mockCf.listZones.mockReset();
  mockCf.listDnsRecords.mockReset();
  mockCf.createDnsRecord.mockReset();
  mockCf.listZones.mockImplementation(async (params?: { name?: string }) => (
    params?.name ? mockZones.filter((z) => z.name === params.name) : mockZones
  ));
  mockCf.listDnsRecords.mockImplementation(async (_zoneId: string, params?: { type?: string; name?: string }) => (
    mockRecords.filter((r) => {
        if (params?.type && r.type !== params.type) return false;
        if (params?.name && r.name !== params.name) return false;
        return true;
      })
  ));
  mockCf.createDnsRecord.mockImplementation(async (_zoneId: string, params: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number }) => {
    createCalled.push({ type: params.type, name: params.name, content: params.content });
    const record: MockRecord = { id: `rec-${Math.random().toString(36).slice(2,8)}`, type: params.type, name: params.name, content: params.content, ttl: 300, proxied: false, priority: params.priority };
    mockRecords.push(record);
    return record;
  });
});

// ─── findZone ─────────────────────────────────────────────────────────────────

describe("findZone", () => {
  it("returns zone when exact match found", async () => {
    mockZones = [{ id: "z1", name: "example.com", name_servers: ["ns1.cf.com"] }];
    const zone = await findZone(makeCf(), "example.com");
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe("z1");
    expect(zone!.name).toBe("example.com");
  });

  it("finds apex zone for subdomain (mail.example.com → example.com)", async () => {
    mockZones = [{ id: "z2", name: "example.com" }];
    // First call returns nothing (exact), second returns the apex
    let callCount = 0;
    mockCf.listZones.mockImplementation(async (params?: { name?: string }) => {
      callCount++;
      if (callCount === 1) return [];
      return mockZones.filter((z) => z.name === params?.name);
    });
    const zone = await findZone(makeCf(), "mail.example.com");
    expect(zone).not.toBeNull();
    expect(zone!.id).toBe("z2");
  });

  it("returns null when no zone found", async () => {
    mockZones = [];
    const zone = await findZone(makeCf(), "notfound.com");
    expect(zone).toBeNull();
  });
});

// ─── upsertEmailDnsRecords ────────────────────────────────────────────────────

describe("upsertEmailDnsRecords", () => {
  it("creates records that don't exist", async () => {
    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
      { type: "CNAME" as const, name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", purpose: "DKIM" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(2);
  });

  it("skips records that already exist", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "example.com", content: '"v=spf1 include:amazonses.com ~all"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results[0]!.status).toBe("skipped");
    expect(mockCf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("skips compatible SPF records with extra existing providers", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "example.com", content: '"v=spf1 include:amazonses.com include:_spf.google.com ~all"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results[0]!.status).toBe("skipped");
    expect(mockCf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("skips stricter compatible DMARC records", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "_dmarc.example.com", content: '"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "_dmarc.example.com", value: "v=DMARC1; p=none; rua=mailto:dmarc@example.com", purpose: "DMARC" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results[0]!.status).toBe("skipped");
    expect(mockCf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("creates some and skips others", async () => {
    mockRecords = [
      { id: "r1", type: "TXT", name: "example.com", content: '"v=spf1 include:amazonses.com ~all"', ttl: 300, proxied: false },
    ];

    const records = [
      { type: "TXT" as const, name: "example.com", value: "v=spf1 include:amazonses.com ~all", purpose: "SPF" as const },
      { type: "CNAME" as const, name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", purpose: "DKIM" as const },
    ];

    const results = await upsertEmailDnsRecords(makeCf(), "z1", records);

    expect(results.find((r) => r.type === "TXT")!.status).toBe("skipped");
    expect(results.find((r) => r.type === "CNAME")!.status).toBe("created");
  });
});

// ─── addMxRecord ──────────────────────────────────────────────────────────────

describe("addMxRecord", () => {
  it("creates MX record with correct type and priority", async () => {
    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com", 10);

    expect(result.status).toBe("created");
    expect(result.type).toBe("MX");
    const call = createCalled[0]!;
    expect(call.type).toBe("MX");
    expect(call.content).toBe("inbound-smtp.us-east-1.amazonaws.com");
  });

  it("skips MX if already exists", async () => {
    mockRecords = [
      { id: "mx1", type: "MX", name: "example.com", content: "inbound-smtp.us-east-1.amazonaws.com", ttl: 300, proxied: false },
    ];

    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com");
    expect(result.status).toBe("skipped");
    expect(mockCf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("blocks SES inbound MX beside Google Workspace unless forced", async () => {
    mockRecords = [
      { id: "mx1", type: "MX", name: "example.com", content: "aspmx.l.google.com", ttl: 300, proxied: false, priority: 1 },
      { id: "mx2", type: "MX", name: "example.com", content: "alt1.aspmx.l.google.com", ttl: 300, proxied: false, priority: 5 },
    ];

    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Google Workspace");
    expect(mockCf.createDnsRecord).not.toHaveBeenCalled();
  });

  it("allows forced SES inbound MX beside an existing provider", async () => {
    mockRecords = [
      { id: "mx1", type: "MX", name: "example.com", content: "aspmx.l.google.com", ttl: 300, proxied: false, priority: 1 },
    ];

    const result = await addMxRecord(makeCf(), "z1", "example.com", "inbound-smtp.us-east-1.amazonaws.com", 10, { forceMxSwitch: true });

    expect(result.status).toBe("created");
    expect(mockCf.createDnsRecord).toHaveBeenCalledTimes(1);
  });
});
