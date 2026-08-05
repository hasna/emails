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

const NO_RECORDS_UNKNOWN_PROVIDER = "No DNS records found.\n";

/**
 * Render the DNS records a domain must publish.
 *
 * `support` disambiguates the EMPTY case only — see `DnsPublishingSupport`,
 * which is where the ambiguity is documented. Passing nothing keeps the original
 * text byte-for-byte, so a caller with no provider in hand is never made to
 * claim something it does not know.
 *
 * `support` is ignored when records are present: a provider that returned
 * records has records, whatever it declares.
 *
 * This is an `exports` entry of the package, so it is reachable from untyped JS
 * where `support` can be anything — `[[], []].map(formatDnsTable)` hands it an
 * array index. Everything below is validated at runtime rather than trusted from
 * the type, because printing "…none are expected: undefined." would be a worse
 * message than the one this replaced.
 */
export function formatDnsTable(records: DnsRecord[], support?: DnsPublishingSupport): string {
  if (records.length === 0) {
    if (typeof support !== "object" || support === null) return NO_RECORDS_UNKNOWN_PROVIDER;
    if (support.publishes === false) {
      // The reason is the entire message. An empty or non-string one degrades to
      // the plain sentence instead of rendering "…none are expected: ." — the
      // type forbids it, the type is not enforced at a package boundary.
      const reason = typeof support.reason === "string" ? support.reason.trim().replace(/\.+$/, "") : "";
      if (!reason) return NO_RECORDS_UNKNOWN_PROVIDER;
      const instead = typeof support.instead === "string" ? support.instead.trim() : "";
      return `No DNS records to publish, and none are expected: ${reason}.${instead ? ` ${instead}` : ""}\n`;
    }
    if (support.publishes === true) {
      // Both readings, because both are real: `ResendAdapter.getDnsRecords`
      // returns [] for a domain that is not in the account AND for a
      // `domains.list()` / `domains.get()` call whose `error` it discards. A
      // message that named only the first would send an operator with a bad API
      // key to add a domain that is already there.
      return "No DNS records came back for this domain. This provider type does publish "
        + "DKIM/SPF/DMARC records, so this is an answer about the domain and not about the "
        + "provider: most often the domain has not been added to the provider yet — "
        + "'emails domain add <domain> --provider <id>' — though a provider lookup that failed "
        + "or was throttled looks the same from here.\n";
    }
    return NO_RECORDS_UNKNOWN_PROVIDER;
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
