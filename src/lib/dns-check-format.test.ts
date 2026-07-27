// `formatDnsCheck` is the sibling of `formatDnsTable` and had the SAME empty-case
// ambiguity, left behind when #103 fixed only the table renderer.
//
// Nothing to check is three different situations — a provider type that publishes no
// records at all, a domain not yet added to a provider that does, and a lookup that
// failed — and the unconditioned "No DNS records to check." reads as the last one in
// all three. `emails domain check` is the only shipped caller, and `emails domain dns`
// names it as the next step, so the two commands disagreed about the same domain.
//
// This file is the unit-level half; src/cli/commands/domain.test.ts asserts the two
// commands agree through the real CLI.
import { describe, it, expect } from "bun:test";
import { formatDnsCheck, type DnsCheckResult } from "./dns-check-format.js";
import type { DnsPublishingSupport, DnsRecord } from "../types/index.js";

const PLAIN = "No DNS records to check.\n";

const nonPublishing: DnsPublishingSupport = {
  publishes: false,
  reason: "a sandbox provider captures mail in the local store instead of handing it to a "
    + "DNS-authenticated sender, so a sandbox domain has no DKIM, SPF or DMARC of its own",
  instead: "Nothing is missing. To get real records, move the domain to an SES or Resend provider: "
    + "'emails domain move-provider <domain> --to-provider <id>'.",
};

describe("formatDnsCheck empty-case disambiguation", () => {
  it("says a non-publishing provider type has nothing to check, and does not imply a failure", () => {
    const output = formatDnsCheck([], nonPublishing);
    expect(output).toContain("nothing is expected to be published");
    expect(output).toContain("has no DKIM, SPF or DMARC of its own");
    expect(output).toContain("emails domain move-provider <domain> --to-provider <id>");
    // "to check" alone was the ambiguity carrier: it reads as a failed lookup.
    expect(output).not.toBe(PLAIN);
  });

  it("gives a publishing provider's empty result both of its real causes", () => {
    const output = formatDnsCheck([], { publishes: true });
    expect(output).toContain("has not been added to the provider yet");
    expect(output).toContain("emails domain add <domain> --provider <id>");
    expect(output).toContain("throttled");
  });

  it("keeps the original sentence when the caller knows nothing about the provider", () => {
    // Back-compat positive control, matching `formatDnsTable`: a caller with no
    // provider in hand must not be made to claim either answer above.
    expect(formatDnsCheck([])).toBe(PLAIN);
  });

  it("falls back to the plain sentence rather than rendering a malformed one", () => {
    // The type forbids all of these. The type is not enforced at a package boundary,
    // and "…nothing is expected to be published: undefined." would be worse than the
    // sentence being replaced.
    const malformed: unknown[] = [
      { publishes: false, reason: "" },
      { publishes: false, reason: "   " },
      { publishes: false },
      { publishes: "no" },
      {},
      null,
      42,
      "sandbox",
    ];
    for (const support of malformed) {
      expect(formatDnsCheck([], support as DnsPublishingSupport)).toBe(PLAIN);
    }
    // The `Array.map` hazard specifically: the second argument is the index, and 1 is
    // truthy, so an unguarded implementation renders "…: undefined." for the second.
    expect([[], []].map(formatDnsCheck)).toEqual([PLAIN, PLAIN]);
  });

  it("punctuates the composed sentence exactly once", () => {
    const output = formatDnsCheck([], { ...nonPublishing, reason: "it publishes nothing." });
    expect(output).toContain("it publishes nothing.");
    expect(output).not.toContain("nothing..");
  });

  it("renders the table, not any empty-case message, whenever results exist", () => {
    // A provider that declares it publishes nothing but produced results has results.
    const record: DnsRecord = { type: "TXT", name: "example.com", value: "v=spf1 ~all", purpose: "SPF" };
    const results: DnsCheckResult[] = [
      { record, expected: "v=spf1 ~all", found: ["v=spf1 ~all"], match: true },
    ];
    const output = formatDnsCheck(results, nonPublishing);
    expect(output).toContain("v=spf1 ~all");
    expect(output).not.toContain("nothing is expected");
    expect(output).not.toContain("No DNS records to check");
  });

  it("produces three mutually distinguishable messages", () => {
    const messages = [
      formatDnsCheck([], nonPublishing),
      formatDnsCheck([], { publishes: true }),
      formatDnsCheck([]),
    ];
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) expect(message.trim().length).toBeGreaterThan(0);
  });
});
