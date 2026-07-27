import type { DnsPublishingSupport, DnsRecord } from "../types/index.js";

export function generateSpfRecord(domain: string): DnsRecord {
  return {
    type: "TXT",
    name: domain,
    value: "v=spf1 include:amazonses.com ~all",
    purpose: "SPF",
  };
}

export function generateDmarcRecord(domain: string): DnsRecord {
  return {
    type: "TXT",
    name: `_dmarc.${domain}`,
    value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; ruf=mailto:dmarc@${domain}; sp=none; fo=1`,
    purpose: "DMARC",
  };
}

/**
 * Render the DNS records a domain must publish.
 *
 * `support` is the answer to "does this provider type publish DNS records at
 * all", from `providerDnsPublishing()`. It only changes the EMPTY case, and it
 * changes it for a reason: the old single sentence, "No DNS records found",
 * described a `sandbox` domain — which structurally has none and never will —
 * with the same words as a `resend` domain that is simply not in the account
 * yet. One is complete, the other is an unfinished setup, and an operator could
 * not tell which they were looking at, nor rule out a failed lookup.
 *
 * Passing nothing keeps the original text byte-for-byte, so callers that have no
 * provider in hand (the public library export, the dashboard) are unaffected and
 * are never made to claim something they do not know.
 *
 * `support` is deliberately not used when records are present: a provider that
 * returned records has records, whatever it declares, and the table is the
 * answer.
 */
export function formatDnsTable(records: DnsRecord[], support?: DnsPublishingSupport): string {
  if (records.length === 0) {
    if (support && !support.publishes) {
      return `No DNS records to publish, and none are expected: ${support.reason}.`
        + `${support.instead ? ` ${support.instead}` : ""}\n`;
    }
    if (support?.publishes) {
      return "No DNS records found for this domain. This provider type does publish DNS records, "
        + "so an empty list is a result and not a provider with none to give — the domain has "
        + "most likely not been added to the provider yet.\n";
    }
    return "No DNS records found.\n";
  }

  const cols = {
    purpose: Math.max(7, ...records.map((r) => r.purpose.length)),
    type: Math.max(4, ...records.map((r) => r.type.length)),
    name: Math.max(4, ...records.map((r) => r.name.length)),
    value: Math.max(5, ...records.map((r) => r.value.length)),
  };

  const sep = `+${"-".repeat(cols.purpose + 2)}+${"-".repeat(cols.type + 2)}+${"-".repeat(cols.name + 2)}+${"-".repeat(cols.value + 2)}+`;
  const header = `| ${"Purpose".padEnd(cols.purpose)} | ${"Type".padEnd(cols.type)} | ${"Name".padEnd(cols.name)} | ${"Value".padEnd(cols.value)} |`;

  const lines = [sep, header, sep];
  for (const r of records) {
    lines.push(
      `| ${r.purpose.padEnd(cols.purpose)} | ${r.type.padEnd(cols.type)} | ${r.name.padEnd(cols.name)} | ${r.value.padEnd(cols.value)} |`,
    );
  }
  lines.push(sep);

  return lines.join("\n") + "\n";
}
