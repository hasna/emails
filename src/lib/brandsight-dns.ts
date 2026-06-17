import type { DnsRecord, Provider } from "../types/index.js";
import { getAdapter } from "../providers/index.js";
import { getBrandsightAuth, type BrandsightAuth } from "./config.js";
import { dnsRecordMatches } from "./dns-check.js";

const BRANDSIGHT_BASE = "https://api.godaddy.com/v2";
export const BRANDSIGHT_DEFAULT_NAMESERVERS = ["ns05.gcd-dns.com", "ns06.gcd-dns.com"] as const;

export interface BrandsightDnsRecord {
  type: "A" | "AAAA" | "CNAME" | "MX" | "NS" | "SRV" | "TXT" | "SOA";
  name: string;
  data: string;
  ttl?: number;
  priority?: number;
  port?: number;
  protocol?: string;
  service?: string;
  weight?: number;
}

export interface BrandsightDomainDetails {
  status?: string;
  nameServers?: string[];
  dnssecRecords?: BrandsightDnssecRecord[];
}

export interface BrandsightDnssecRecord {
  algorithm: string;
  digest?: string;
  digestType?: string;
  flags?: string;
  keyTag: number;
  publicKey?: string | null;
}

export interface BrandsightSetupRecord {
  type: string;
  name: string;
  data: string;
  status: "created" | "replaced" | "skipped" | "failed";
  error?: string;
}

export interface BrandsightSetupResult {
  domain: string;
  records: BrandsightSetupRecord[];
  created: number;
  replaced: number;
  skipped: number;
  failed: number;
  nameservers: {
    desired: string[];
    current: string[];
    status: "skipped" | "requested" | "failed";
    error?: string;
  };
  dnssec: {
    removed: number;
    status: "skipped" | "requested" | "failed";
    error?: string;
  };
}

export type BrandsightFetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class BrandsightClient {
  private auth: BrandsightAuth;
  private fetchImpl: BrandsightFetchImpl;

  constructor(opts: { auth?: BrandsightAuth; fetchImpl?: BrandsightFetchImpl } = {}) {
    const auth = opts.auth ?? getBrandsightAuth();
    if (!auth) {
      throw new Error("BrandSight credentials not configured (set brandsight_api_key, brandsight_api_secret, brandsight_customer_id or BRANDSIGHT_* env vars)");
    }
    this.auth = auth;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<BrandsightFetchImpl>);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BRANDSIGHT_BASE}/customers/${this.auth.customerId}${path}`, {
      method,
      headers: {
        Authorization: `sso-key ${this.auth.apiKey}:${this.auth.apiSecret}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    if (!res.ok) {
      const msg = json?.message ?? json?.code ?? `BrandSight ${method} ${path} failed (${res.status})`;
      const details = json?.fields ? `: ${JSON.stringify(json.fields)}` : "";
      throw new Error(`${msg}${details}`);
    }
    return json as T;
  }

  getDomain(domain: string): Promise<BrandsightDomainDetails> {
    return this.call<BrandsightDomainDetails>("GET", `/domains/${domain}?includes=dnssecRecords`);
  }

  listRecords(domain: string): Promise<BrandsightDnsRecord[]> {
    return this.call<BrandsightDnsRecord[]>("GET", `/domains/${domain}/records`);
  }

  addRecords(domain: string, records: BrandsightDnsRecord[]): Promise<unknown> {
    return this.call("PATCH", `/domains/${domain}/records`, records);
  }

  replaceRecordsByTypeName(domain: string, type: string, name: string, records: Array<Omit<BrandsightDnsRecord, "type" | "name">>): Promise<unknown> {
    return this.call("PUT", `/domains/${domain}/records/${type}/${encodeURIComponent(name)}`, records);
  }

  replaceNameServers(domain: string, nameServers: string[]): Promise<unknown> {
    return this.call("PUT", `/domains/${domain}/nameServers`, { nameServers });
  }

  deleteDnssecRecords(domain: string, records: BrandsightDnssecRecord[]): Promise<unknown> {
    return this.call("DELETE", `/domains/${domain}/dnssecRecords`, records.map((record) => ({
      algorithm: record.algorithm,
      ...(record.digest ? { digest: record.digest } : {}),
      ...(record.digestType ? { digestType: record.digestType } : {}),
      ...(record.flags ? { flags: record.flags } : {}),
      keyTag: record.keyTag,
      ...(record.publicKey ? { publicKey: record.publicKey } : {}),
    })));
  }
}

export function brandsightRecordName(name: string, domain: string): string {
  const clean = name.replace(/\.$/, "").toLowerCase();
  const cleanDomain = domain.toLowerCase();
  if (clean === cleanDomain) return "@";
  if (clean.endsWith(`.${cleanDomain}`)) return clean.slice(0, -(cleanDomain.length + 1)) || "@";
  return name.replace(/\.$/, "");
}

export function brandsightAbsoluteTarget(value: string): string {
  return `${value.replace(/^"|"$/g, "").replace(/\.$/, "")}.`;
}

export function brandsightTextValue(value: string): string {
  return value.replace(/^"|"$/g, "").trim();
}

export function brandSightEmailRecords(opts: {
  domain: string;
  providerRecords: DnsRecord[];
  region?: string;
  addMx?: boolean;
  mailFromDomain?: string | null;
}): BrandsightDnsRecord[] {
  const domain = opts.domain;
  const records: BrandsightDnsRecord[] = [];
  for (const record of opts.providerRecords) {
    if (!["TXT", "CNAME", "MX"].includes(record.type)) continue;
    const type = record.type as "TXT" | "CNAME" | "MX";
    records.push({
      type,
      name: brandsightRecordName(record.name, domain),
      data: type === "TXT" ? brandsightTextValue(record.value) : brandsightAbsoluteTarget(record.value),
      ttl: 600,
      ...(type === "MX" ? { priority: 10 } : {}),
    });
  }

  const region = opts.region ?? "us-east-1";
  if (opts.addMx) {
    records.push({
      type: "MX",
      name: "@",
      data: brandsightAbsoluteTarget(`inbound-smtp.${region}.amazonaws.com`),
      priority: 10,
      ttl: 600,
    });
  }
  if (opts.mailFromDomain) {
    records.push(
      {
        type: "MX",
        name: brandsightRecordName(opts.mailFromDomain, domain),
        data: brandsightAbsoluteTarget(`feedback-smtp.${region}.amazonses.com`),
        priority: 10,
        ttl: 600,
      },
      {
        type: "TXT",
        name: brandsightRecordName(opts.mailFromDomain, domain),
        data: "v=spf1 include:amazonses.com ~all",
        ttl: 600,
      },
    );
  }

  const seen = new Set<string>();
  return records.filter((record) => {
    const key = brandsightRecordKey(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function upsertBrandsightEmailRecords(
  client: BrandsightClient,
  domain: string,
  records: BrandsightDnsRecord[],
): Promise<BrandsightSetupRecord[]> {
  const existing = await client.listRecords(domain);
  const existingKeys = new Set(existing.filter((record) => record.type !== "SOA").map(brandsightRecordKey));
  const results: BrandsightSetupRecord[] = [];

  for (const record of records) {
    if (record.type === "CNAME" || record.type === "MX") {
      try {
        await client.replaceRecordsByTypeName(domain, record.type, record.name, [recordBody(record)]);
        results.push({ type: record.type, name: record.name, data: record.data, status: existingKeys.has(brandsightRecordKey(record)) ? "skipped" : "replaced" });
      } catch (error) {
        results.push({ type: record.type, name: record.name, data: record.data, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }

    if (existing.some((current) => brandsightRecordMatches(record, current))) {
      results.push({ type: record.type, name: record.name, data: record.data, status: "skipped" });
      continue;
    }

    try {
      await client.addRecords(domain, [record]);
      results.push({ type: record.type, name: record.name, data: record.data, status: "created" });
    } catch (error) {
      results.push({ type: record.type, name: record.name, data: record.data, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}

export async function setupBrandsightEmailDns(opts: {
  domain: string;
  provider: Provider;
  auth?: BrandsightAuth;
  addMx?: boolean;
  mailFromDomain?: string | null;
  setNameservers?: boolean;
  nameServers?: string[];
  removeDnssec?: boolean;
}): Promise<BrandsightSetupResult> {
  const client = new BrandsightClient({ auth: opts.auth });
  const details = await client.getDomain(opts.domain);
  const desiredNameservers = opts.nameServers ?? [...BRANDSIGHT_DEFAULT_NAMESERVERS];
  let nameservers: BrandsightSetupResult["nameservers"] = {
    desired: desiredNameservers,
    current: details.nameServers ?? [],
    status: "skipped",
  };
  let dnssec: BrandsightSetupResult["dnssec"] = { removed: 0, status: "skipped" };

  if (opts.setNameservers !== false) {
    const current = (details.nameServers ?? []).map((ns) => ns.replace(/\.$/, "").toLowerCase());
    const wanted = desiredNameservers.map((ns) => ns.replace(/\.$/, "").toLowerCase());
    if (!wanted.every((ns) => current.includes(ns))) {
      try {
        await client.replaceNameServers(opts.domain, desiredNameservers);
        nameservers = { desired: desiredNameservers, current: details.nameServers ?? [], status: "requested" };
      } catch (error) {
        nameservers = { desired: desiredNameservers, current: details.nameServers ?? [], status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  if (opts.removeDnssec && (details.dnssecRecords?.length ?? 0) > 0) {
    try {
      await client.deleteDnssecRecords(opts.domain, details.dnssecRecords!);
      dnssec = { removed: details.dnssecRecords!.length, status: "requested" };
    } catch (error) {
      dnssec = { removed: 0, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  const adapter = getAdapter(opts.provider);
  const providerRecords = await adapter.getDnsRecords(opts.domain);
  const records = brandSightEmailRecords({
    domain: opts.domain,
    providerRecords,
    region: opts.provider.region ?? "us-east-1",
    addMx: !!opts.addMx,
    mailFromDomain: opts.mailFromDomain,
  });
  const published = await upsertBrandsightEmailRecords(client, opts.domain, records);
  return {
    domain: opts.domain,
    records: published,
    created: published.filter((record) => record.status === "created").length,
    replaced: published.filter((record) => record.status === "replaced").length,
    skipped: published.filter((record) => record.status === "skipped").length,
    failed: published.filter((record) => record.status === "failed").length,
    nameservers,
    dnssec,
  };
}

function recordBody(record: BrandsightDnsRecord): Omit<BrandsightDnsRecord, "type" | "name"> {
  return {
    data: record.data,
    ttl: record.ttl ?? 600,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.port !== undefined ? { port: record.port } : {}),
    ...(record.protocol !== undefined ? { protocol: record.protocol } : {}),
    ...(record.service !== undefined ? { service: record.service } : {}),
    ...(record.weight !== undefined ? { weight: record.weight } : {}),
  };
}

function brandsightRecordKey(record: BrandsightDnsRecord): string {
  return [
    record.type,
    record.name.toLowerCase(),
    normalizeRecordData(record.type, record.data),
    record.type === "MX" ? String(record.priority ?? 10) : "",
  ].join("\t");
}

function normalizeRecordData(type: string, value: string): string {
  const data = value.replace(/^"|"$/g, "").trim();
  if (type === "CNAME" || type === "MX") return data.replace(/\.$/, "").toLowerCase();
  return data;
}

function brandsightRecordMatches(expected: BrandsightDnsRecord, actual: BrandsightDnsRecord): boolean {
  if (expected.type !== actual.type || expected.name.toLowerCase() !== actual.name.toLowerCase()) return false;
  if (expected.type === "TXT") {
    return dnsRecordMatches(
      {
        type: "TXT",
        name: expected.name,
        value: expected.data,
        purpose: expected.name === "_dmarc" ? "DMARC" : expected.data.toLowerCase().startsWith("v=spf1") ? "SPF" : "SES_IDENTITY",
      },
      [actual.data],
    );
  }
  return brandsightRecordKey(expected) === brandsightRecordKey(actual);
}
