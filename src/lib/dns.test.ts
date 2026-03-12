import { describe, it, expect } from "bun:test";
import { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./dns.js";
import type { DnsRecord } from "../types/index.js";

describe("generateSpfRecord", () => {
  it("returns a TXT record with SPF purpose", () => {
    const record = generateSpfRecord("example.com");
    expect(record.type).toBe("TXT");
    expect(record.name).toBe("example.com");
    expect(record.purpose).toBe("SPF");
    expect(record.value).toContain("v=spf1");
  });

  it("uses the provided domain", () => {
    const record = generateSpfRecord("myapp.io");
    expect(record.name).toBe("myapp.io");
  });
});

describe("generateDmarcRecord", () => {
  it("returns a TXT record with DMARC purpose", () => {
    const record = generateDmarcRecord("example.com");
    expect(record.type).toBe("TXT");
    expect(record.name).toBe("_dmarc.example.com");
    expect(record.purpose).toBe("DMARC");
    expect(record.value).toContain("v=DMARC1");
  });

  it("uses _dmarc prefix on the domain", () => {
    const record = generateDmarcRecord("myapp.io");
    expect(record.name).toBe("_dmarc.myapp.io");
  });
});

describe("formatDnsTable", () => {
  it("returns a message for empty records", () => {
    const output = formatDnsTable([]);
    expect(output).toContain("No DNS records");
  });

  it("formats records into a table", () => {
    const records: DnsRecord[] = [
      { type: "TXT", name: "example.com", value: "v=spf1 ~all", purpose: "SPF" },
      { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none", purpose: "DMARC" },
    ];
    const output = formatDnsTable(records);
    expect(output).toContain("SPF");
    expect(output).toContain("DMARC");
    expect(output).toContain("example.com");
    expect(output).toContain("v=spf1");
    expect(output).toContain("TXT");
  });

  it("includes header row", () => {
    const records: DnsRecord[] = [
      { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", purpose: "DKIM" },
    ];
    const output = formatDnsTable(records);
    expect(output).toContain("Purpose");
    expect(output).toContain("Type");
    expect(output).toContain("Name");
    expect(output).toContain("Value");
  });
});
