import { resolve } from "dns/promises";
import type { DnsRecord } from "../types/index.js";
import type { DnsCheckResult } from "./dns-check-format.js";
import { normalizeMxExchange } from "./mx-ownership.js";

export { formatDnsCheck } from "./dns-check-format.js";
export type { DnsCheckResult } from "./dns-check-format.js";

export async function checkDnsRecords(
  _domain: string,
  expectedRecords: DnsRecord[],
): Promise<DnsCheckResult[]> {
  const results: DnsCheckResult[] = [];
  for (const record of expectedRecords) {
    try {
      const found = await resolve(record.name, record.type);
      const foundFlat = flattenDnsResult(record.type, found);
      const match = dnsRecordMatches(record, foundFlat);
      results.push({ record, expected: record.value, found: foundFlat, match });
    } catch {
      results.push({ record, expected: record.value, found: [], match: false });
    }
  }
  return results;
}

function flattenDnsResult(type: DnsRecord["type"], found: unknown): string[] {
  if (!Array.isArray(found)) return [String(found)];
  if (type === "MX") {
    return found.map((item) => {
      const mx = item as { priority?: unknown; exchange?: unknown };
      return `${String(mx.priority ?? "-")} ${normalizeMxExchange(String(mx.exchange ?? ""))}`.trim();
    });
  }
  return found.flatMap((item: unknown) =>
    Array.isArray(item) ? [item.map(String).join("")] : [String(item)]
  );
}

export function dnsRecordMatches(record: DnsRecord, found: string[]): boolean {
  if (record.type === "TXT" && record.purpose === "SPF") return spfMatches(record.value, found);
  if (record.type === "TXT" && record.purpose === "DMARC") return dmarcMatches(record.value, found);
  if (record.type === "CNAME") {
    const expected = normalizeMxExchange(record.value);
    return found.some((value) => normalizeMxExchange(value) === expected);
  }
  if (record.type === "MX") {
    const expected = normalizeMxExchange(stripMxPriority(record.value));
    return found.some((value) => normalizeMxExchange(stripMxPriority(value)) === expected);
  }

  const expected = normalizeTxt(record.value);
  return found.some((value) => {
    const normalized = normalizeTxt(value);
    return normalized.includes(expected) || expected.includes(normalized);
  });
}

function stripMxPriority(value: string): string {
  return value.replace(/^(?:\d+|-)\s+/, "");
}

function normalizeTxt(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\s+/g, " ").trim();
}

function spfMatches(expected: string, found: string[]): boolean {
  const expectedTerms = spfTerms(expected);
  if (expectedTerms.length === 0) return found.some((value) => normalizeTxt(value).toLowerCase().startsWith("v=spf1"));
  return found
    .map((value) => normalizeTxt(value).toLowerCase())
    .filter((value) => value.startsWith("v=spf1"))
    .some((value) => {
      const terms = new Set(spfTerms(value));
      return expectedTerms.every((term) => terms.has(term));
    });
}

function spfTerms(value: string): string[] {
  return normalizeTxt(value)
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^\+/, ""))
    .filter((term) => term && term !== "v=spf1" && !/^[~?+-]?all$/.test(term));
}

function dmarcMatches(expected: string, found: string[]): boolean {
  const expectedTags = dmarcTags(expected);
  const expectedPolicy = policyRank(expectedTags.get("p") ?? "none");
  return found
    .map(dmarcTags)
    .filter((tags) => tags.get("v")?.toLowerCase() === "dmarc1")
    .some((tags) => policyRank(tags.get("p") ?? "none") >= expectedPolicy);
}

function dmarcTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of normalizeTxt(value).split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key || rest.length === 0) continue;
    tags.set(key.trim().toLowerCase(), rest.join("=").trim());
  }
  return tags;
}

function policyRank(policy: string): number {
  switch (policy.toLowerCase()) {
    case "reject": return 2;
    case "quarantine": return 1;
    default: return 0;
  }
}
