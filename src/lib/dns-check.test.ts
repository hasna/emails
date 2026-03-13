import { describe, it, expect, mock, beforeEach } from "bun:test";
import { checkDnsRecords, formatDnsCheck } from "./dns-check.js";
import type { DnsRecord } from "../types/index.js";

// Mock dns/promises
const mockResolve = mock(() => Promise.resolve([]));

mock.module("dns/promises", () => ({
  resolve: mockResolve,
}));

beforeEach(() => {
  mockResolve.mockReset();
});

describe("checkDnsRecords", () => {
  it("returns match=true when DNS record contains expected value", async () => {
    const records: DnsRecord[] = [
      { type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com", purpose: "SPF" },
    ];
    mockResolve.mockResolvedValueOnce([["v=spf1 include:amazonses.com include:sendgrid.net ~all"]]);

    const results = await checkDnsRecords("example.com", records);
    expect(results).toHaveLength(1);
    expect(results[0]!.match).toBe(true);
    expect(results[0]!.found).toContain("v=spf1 include:amazonses.com include:sendgrid.net ~all");
  });

  it("returns match=false when DNS record does not contain expected value", async () => {
    const records: DnsRecord[] = [
      { type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com", purpose: "SPF" },
    ];
    mockResolve.mockResolvedValueOnce([["v=spf1 include:other.com ~all"]]);

    const results = await checkDnsRecords("example.com", records);
    expect(results).toHaveLength(1);
    expect(results[0]!.match).toBe(false);
  });

  it("returns match=false and empty found when DNS lookup fails", async () => {
    const records: DnsRecord[] = [
      { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1", purpose: "DMARC" },
    ];
    mockResolve.mockRejectedValueOnce(new Error("NXDOMAIN"));

    const results = await checkDnsRecords("example.com", records);
    expect(results).toHaveLength(1);
    expect(results[0]!.match).toBe(false);
    expect(results[0]!.found).toEqual([]);
  });

  it("handles multiple records", async () => {
    const records: DnsRecord[] = [
      { type: "TXT", name: "example.com", value: "v=spf1", purpose: "SPF" },
      { type: "CNAME", name: "dkim._domainkey.example.com", value: "dkim.resend.com", purpose: "DKIM" },
    ];
    mockResolve.mockResolvedValueOnce([["v=spf1 include:test ~all"]]);
    mockResolve.mockResolvedValueOnce(["dkim.resend.com"]);

    const results = await checkDnsRecords("example.com", records);
    expect(results).toHaveLength(2);
    expect(results[0]!.match).toBe(true);
    expect(results[1]!.match).toBe(true);
  });

  it("uses CNAME resolver for CNAME records", async () => {
    const records: DnsRecord[] = [
      { type: "CNAME", name: "dkim._domainkey.example.com", value: "dkim.resend.com", purpose: "DKIM" },
    ];
    mockResolve.mockResolvedValueOnce(["dkim.resend.com"]);

    const results = await checkDnsRecords("example.com", records);
    expect(results[0]!.match).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith("dkim._domainkey.example.com", "CNAME");
  });
});

describe("formatDnsCheck", () => {
  it("returns empty message for no results", () => {
    expect(formatDnsCheck([])).toBe("No DNS records to check.\n");
  });

  it("formats results into a table", () => {
    const results = [
      {
        record: { type: "TXT" as const, name: "example.com", value: "v=spf1", purpose: "SPF" as const },
        expected: "v=spf1",
        found: ["v=spf1 include:test"],
        match: true,
      },
      {
        record: { type: "TXT" as const, name: "_dmarc.example.com", value: "v=DMARC1", purpose: "DMARC" as const },
        expected: "v=DMARC1",
        found: [],
        match: false,
      },
    ];
    const output = formatDnsCheck(results);
    expect(output).toContain("Type");
    expect(output).toContain("Name");
    expect(output).toContain("Expected");
    expect(output).toContain("Found");
    expect(output).toContain("Status");
  });
});
