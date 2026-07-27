import { describe, it, expect } from "bun:test";
import { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./dns.js";
import type { DnsPublishingSupport, DnsRecord } from "../types/index.js";

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

// An empty DnsRecord[] carries three different meanings, and before this the
// formatter printed one sentence for all of them: a provider type that never
// publishes DNS, a provider that does but returned nothing for this domain, and
// (indistinguishably) a lookup that failed. The three assertions below are about
// TELLING THEM APART, so each one checks both what its message says and that it
// is not one of the others.
describe("formatDnsTable empty-case disambiguation", () => {
  const nonPublishing: DnsPublishingSupport = {
    publishes: false,
    reason: "a sandbox provider captures mail in the local store",
    instead: "Move the domain to a real provider.",
  };

  it("says a non-publishing provider type has nothing to publish, and does not imply a lookup", () => {
    const output = formatDnsTable([], nonPublishing);
    expect(output).toContain("none are expected");
    expect(output).toContain("a sandbox provider captures mail in the local store");
    expect(output).toContain("Move the domain to a real provider.");
    // "found" is the word that made this read as a failed lookup.
    expect(output).not.toContain("found");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("carries the reason even when there is nothing useful to do instead", () => {
    // `instead` is optional, and dropping the trailing sentence must not drop the
    // reason with it — the reason is the whole point of the message.
    const output = formatDnsTable([], { publishes: false, reason: "this provider has no DNS at all" });
    expect(output).toContain("this provider has no DNS at all");
    expect(output).toContain("none are expected");
  });

  it("says an empty result from a publishing provider is a result, not an absence of records", () => {
    const output = formatDnsTable([], { publishes: true });
    expect(output).toContain("No DNS records found");
    expect(output).toContain("does publish DNS records");
    expect(output).toContain("not been added to the provider");
    // Must not borrow the structural wording: this domain WILL have records.
    expect(output).not.toContain("none are expected");
  });

  it("keeps the original sentence unchanged when the caller knows nothing about the provider", () => {
    // Back-compat positive control. The public library export and the dashboard
    // both call this with one argument, and a caller with no provider in hand must
    // not be made to claim either of the two answers above.
    expect(formatDnsTable([])).toBe("No DNS records found.\n");
  });

  it("renders the table, not any empty-case message, whenever records exist", () => {
    // A provider that declares it does not publish but returns records has
    // records. The table wins; the declaration is not allowed to hide data.
    const records: DnsRecord[] = [
      { type: "TXT", name: "example.com", value: "v=spf1 ~all", purpose: "SPF" },
    ];
    const output = formatDnsTable(records, nonPublishing);
    expect(output).toContain("v=spf1 ~all");
    expect(output).not.toContain("none are expected");
    expect(output).not.toContain("No DNS records");
  });

  it("produces three mutually distinguishable messages", () => {
    const messages = [
      formatDnsTable([], nonPublishing),
      formatDnsTable([], { publishes: true }),
      formatDnsTable([]),
    ];
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) expect(message.trim().length).toBeGreaterThan(0);
  });
});
