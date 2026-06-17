import { Resolver, resolveMx } from "node:dns/promises";

export type MxOwner =
  | "aws-ses"
  | "google-workspace"
  | "cloudflare-routing"
  | "microsoft-365"
  | "zoho"
  | "proton"
  | "none"
  | "mixed"
  | "unknown";

export interface MxRecordLike {
  exchange?: string;
  content?: string;
  priority?: number;
}

export interface NormalizedMxRecord {
  exchange: string;
  priority: number | null;
  owner: MxOwner;
}

export interface MxAssessment {
  domain?: string;
  owner: MxOwner;
  records: NormalizedMxRecord[];
  summary: string;
  protects_existing_inbound: boolean;
}

export function normalizeMxExchange(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function ownerForMxExchange(exchange: string): MxOwner {
  const host = normalizeMxExchange(exchange);
  if (!host) return "unknown";
  if (/^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return "aws-ses";
  if (host === "aspmx.l.google.com" || /^alt\d+\.aspmx\.l\.google\.com$/.test(host) || host.endsWith(".googlemail.com")) {
    return "google-workspace";
  }
  if (/^route\d+\.mx\.cloudflare\.net$/.test(host)) return "cloudflare-routing";
  if (host.endsWith(".mail.protection.outlook.com")) return "microsoft-365";
  if (host === "mx.zoho.com" || /^mx\d+\.zoho\.com$/.test(host)) return "zoho";
  if (host.endsWith(".protonmail.ch") || host.endsWith(".protonmail.com")) return "proton";
  return "unknown";
}

export function classifyMxRecords(records: MxRecordLike[], domain?: string): MxAssessment {
  const normalized = records
    .map((record) => {
      const exchange = normalizeMxExchange(record.exchange ?? record.content ?? "");
      if (!exchange) return null;
      return {
        exchange,
        priority: typeof record.priority === "number" ? record.priority : null,
        owner: ownerForMxExchange(exchange),
      };
    })
    .filter((record): record is NormalizedMxRecord => record !== null)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.exchange.localeCompare(b.exchange));

  if (normalized.length === 0) {
    return {
      domain,
      owner: "none",
      records: [],
      summary: "No root MX records found.",
      protects_existing_inbound: false,
    };
  }

  const owners = [...new Set(normalized.map((record) => record.owner))];
  const owner: MxOwner = owners.length === 1 ? owners[0]! : "mixed";
  return {
    domain,
    owner,
    records: normalized,
    summary: formatMxSummary(owner, normalized),
    protects_existing_inbound: owner !== "none" && owner !== "aws-ses",
  };
}

const PUBLIC_MX_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

export async function inspectPublicMx(domain: string, opts: { servers?: string[] } = {}): Promise<MxAssessment> {
  const errors: string[] = [];
  for (const server of opts.servers ?? PUBLIC_MX_RESOLVERS) {
    try {
      const resolver = new Resolver();
      resolver.setServers([server]);
      const records = await resolver.resolveMx(domain);
      return classifyMxRecords(records, domain);
    } catch (error) {
      const empty = emptyDnsCode(error);
      if (empty) return classifyMxRecords([], domain);
      errors.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const records = await resolveMx(domain);
    return classifyMxRecords(records, domain);
  } catch (error) {
    if (emptyDnsCode(error)) {
      return classifyMxRecords([], domain);
    }
    if (errors.length > 0) errors.push(`system: ${error instanceof Error ? error.message : String(error)}`);
    return {
      domain,
      owner: "unknown",
      records: [],
      summary: `Could not resolve root MX records: ${errors.length > 0 ? errors.join("; ") : error instanceof Error ? error.message : String(error)}`,
      protects_existing_inbound: true,
    };
  }
}

function emptyDnsCode(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENOTIMP";
}

export async function guardSesInboundMx(domain: string, force = false): Promise<MxAssessment> {
  const assessment = await inspectPublicMx(domain);
  if (requiresMxSwitchConfirmation(assessment) && !force) {
    throw new Error(formatMxSwitchWarning(assessment));
  }
  return assessment;
}

export function requiresMxSwitchConfirmation(assessment: MxAssessment, targetOwner: MxOwner = "aws-ses"): boolean {
  if (assessment.records.length === 0) return assessment.protects_existing_inbound;
  if (assessment.owner === targetOwner) return false;
  return true;
}

export function formatMxRecords(records: NormalizedMxRecord[]): string {
  if (records.length === 0) return "(none)";
  return records
    .map((record) => `${record.priority ?? "-"} ${record.exchange}`)
    .join(", ");
}

export function formatMxSwitchWarning(assessment: MxAssessment, target = "AWS SES inbound"): string {
  return [
    `Refusing to add ${target} MX because ${assessment.domain ?? "this domain"} already has root MX owned by ${ownerLabel(assessment.owner)}.`,
    `Current MX: ${formatMxRecords(assessment.records)}.`,
    "Use send-only setup to preserve existing inbound, or re-run with --force-mx-switch only after confirming mailbox ownership can move.",
  ].join(" ");
}

export function ownerLabel(owner: MxOwner): string {
  switch (owner) {
    case "aws-ses": return "AWS SES";
    case "google-workspace": return "Google Workspace";
    case "cloudflare-routing": return "Cloudflare Email Routing";
    case "microsoft-365": return "Microsoft 365";
    case "zoho": return "Zoho Mail";
    case "proton": return "Proton Mail";
    case "none": return "no provider";
    case "mixed": return "multiple providers";
    case "unknown": return "an unknown provider";
  }
}

function formatMxSummary(owner: MxOwner, records: NormalizedMxRecord[]): string {
  const provider = ownerLabel(owner);
  const count = records.length;
  return `${count} root MX record(s), owner: ${provider}`;
}
