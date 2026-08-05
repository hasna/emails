import { ansi } from "./ansi.js";
import type { DnsPublishingSupport, DnsRecord } from "../types/index.js";

export interface DnsCheckResult {
  record: DnsRecord;
  expected: string;
  found: string[];
  match: boolean;
}

const NOTHING_TO_CHECK = "No DNS records to check.\n";

/**
 * Render a live DNS check.
 *
 * `support` disambiguates the EMPTY case only, for exactly the reason
 * `formatDnsTable` takes it: nothing to check is three different situations —
 * a provider type that publishes no records at all, a domain not yet added to a
 * provider that does, and a lookup that failed — and "No DNS records to check."
 * reads as the last one in all three.
 *
 * This existed as an unconditioned sentence while its sibling renderer had
 * already been fixed, so `emails domain dns` said "Nothing is missing" and the
 * `emails domain check` it recommends in its own next-step line answered "not
 * ready" for the same domain. Same ambiguity, one command apart.
 *
 * Validated at runtime rather than trusted from the type, because this module is
 * reachable from untyped JS through the package's `exports`, and printing
 * "…none are expected: undefined." would be worse than the plain sentence.
 */
export function formatDnsCheck(results: DnsCheckResult[], support?: DnsPublishingSupport): string {
  if (results.length === 0) {
    if (typeof support !== "object" || support === null) return NOTHING_TO_CHECK;
    if (support.publishes === false) {
      const reason = typeof support.reason === "string" ? support.reason.trim().replace(/\.+$/, "") : "";
      if (!reason) return NOTHING_TO_CHECK;
      const instead = typeof support.instead === "string" ? support.instead.trim() : "";
      return `Nothing to check, and nothing is expected to be published: ${reason}.${instead ? ` ${instead}` : ""}\n`;
    }
    if (support.publishes === true) {
      return "No records were expected for this domain, so nothing could be checked. This provider "
        + "type does publish DKIM/SPF/DMARC records, so this is an answer about the domain and not "
        + "about the provider: most often the domain has not been added to the provider yet — "
        + "'emails domain add <domain> --provider <id>' — though a provider lookup that failed or "
        + "was throttled looks the same from here.\n";
    }
    return NOTHING_TO_CHECK;
  }

  const cols = {
    type: Math.max(4, ...results.map((r) => r.record.type.length)),
    name: Math.max(4, ...results.map((r) => r.record.name.length)),
    expected: Math.max(8, ...results.map((r) => Math.min(r.expected.length, 50))),
    found: Math.max(5, ...results.map((r) => Math.min((r.found[0] || "—").length, 50))),
    status: 6,
  };

  const sep = `+${"-".repeat(cols.type + 2)}+${"-".repeat(cols.name + 2)}+${"-".repeat(cols.expected + 2)}+${"-".repeat(cols.found + 2)}+${"-".repeat(cols.status + 2)}+`;
  const header = `| ${"Type".padEnd(cols.type)} | ${"Name".padEnd(cols.name)} | ${"Expected".padEnd(cols.expected)} | ${"Found".padEnd(cols.found)} | ${"Status".padEnd(cols.status)} |`;

  const lines = [sep, header, sep];
  for (const r of results) {
    const expectedTrunc =
      r.expected.length > 50 ? r.expected.slice(0, 47) + "..." : r.expected;
    const foundStr = r.found.length > 0 ? r.found[0]! : "—";
    const foundTrunc =
      foundStr.length > 50 ? foundStr.slice(0, 47) + "..." : foundStr;
    const statusPadded = r.match
      ? "OK".padEnd(cols.status)
      : "MISS".padEnd(cols.status);
    const statusColored = r.match
      ? ansi.green(statusPadded)
      : ansi.red(statusPadded);

    lines.push(
      `| ${r.record.type.padEnd(cols.type)} | ${r.record.name.padEnd(cols.name)} | ${expectedTrunc.padEnd(cols.expected)} | ${foundTrunc.padEnd(cols.found)} | ${statusColored} |`,
    );
  }
  lines.push(sep);

  return lines.join("\n") + "\n";
}
