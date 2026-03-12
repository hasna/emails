import type { DnsRecord } from "../types/index.js";

export function generateSpfRecord(domain: string): DnsRecord {
  return {
    type: "TXT",
    name: domain,
    value: "v=spf1 include:amazonses.com include:sendgrid.net ~all",
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

export function formatDnsTable(records: DnsRecord[]): string {
  if (records.length === 0) return "No DNS records found.\n";

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
