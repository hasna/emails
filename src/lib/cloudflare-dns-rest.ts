/**
 * Direct Cloudflare DNS REST client — implements CloudflareDnsClient using a
 * plain fetch against api.cloudflare.com/client/v4, with our own auth headers
 * (scoped token OR global key + email). NO dependency on @hasna/connectors, so
 * provisioning never shells out to `bun run <connector>/src/cli/index.ts` and
 * never depends on the connectors package being installed/connected.
 *
 * `fetchImpl` is injectable so request construction is fully unit-testable.
 */

import {
  resolveCloudflareAuth,
  cloudflareAuthEnv,
  type CloudflareAuth,
} from "./cloudflare-auth.js";
import type { CloudflareDnsClient, CloudflareZone, CloudflareDnsRecord } from "./cloudflare-dns.js";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export type DnsFetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

function authHeaders(auth?: CloudflareAuth): Record<string, string> {
  const a = auth ?? resolveCloudflareAuth();
  if (!a) throw new Error("Cloudflare credentials not configured (set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL)");
  const env = cloudflareAuthEnv(a);
  if (env["CLOUDFLARE_API_TOKEN"]) return { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}` };
  return { "X-Auth-Key": env["CLOUDFLARE_API_KEY"]!, "X-Auth-Email": env["CLOUDFLARE_EMAIL"]! };
}

export class DirectCloudflareClient implements CloudflareDnsClient {
  private auth?: CloudflareAuth;
  private fetchImpl: DnsFetchImpl;

  constructor(opts: { auth?: CloudflareAuth | string; fetchImpl?: DnsFetchImpl } = {}) {
    if (typeof opts.auth === "string") this.auth = { kind: "token", token: opts.auth };
    else this.auth = opts.auth;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<DnsFetchImpl>);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${CF_BASE}${path}`, {
      method,
      headers: { ...authHeaders(this.auth), "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok || (json && json.success === false)) {
      const msg = json?.errors?.[0]?.message ?? `Cloudflare ${method} ${path} failed (${res.status})`;
      throw new Error(msg);
    }
    return (json?.result ?? json) as T;
  }

  async listZones(params?: { name?: string; page?: number; perPage?: number }): Promise<CloudflareZone[]> {
    const q = new URLSearchParams();
    if (params?.name) q.set("name", params.name);
    if (params?.page) q.set("page", String(params.page));
    if (params?.perPage) q.set("per_page", String(params.perPage));
    const qs = q.toString();
    const result = await this.call<Array<{ id: string; name: string; name_servers?: string[] }>>(
      "GET",
      `/zones${qs ? `?${qs}` : ""}`,
    );
    return (result ?? []).map((z) => ({ id: z.id, name: z.name, name_servers: z.name_servers, nameservers: z.name_servers }));
  }

  async listDnsRecords(
    zoneId: string,
    params?: { type?: string; name?: string; page?: number; perPage?: number },
  ): Promise<CloudflareDnsRecord[]> {
    const q = new URLSearchParams();
    if (params?.type) q.set("type", params.type);
    if (params?.name) q.set("name", params.name);
    if (params?.page) q.set("page", String(params.page));
    if (params?.perPage) q.set("per_page", String(params.perPage));
    const qs = q.toString();
    const result = await this.call<CloudflareDnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records${qs ? `?${qs}` : ""}`,
    );
    return result ?? [];
  }

  async createDnsRecord(
    zoneId: string,
    params: { type: "TXT" | "CNAME" | "MX"; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number },
  ): Promise<CloudflareDnsRecord> {
    const body: Record<string, unknown> = {
      type: params.type,
      name: params.name,
      content: params.content,
      ttl: params.ttl ?? 1,
    };
    if (params.type !== "MX" && params.proxied !== undefined) body["proxied"] = params.proxied;
    if (params.type === "MX") body["priority"] = params.priority ?? 10;
    return this.call<CloudflareDnsRecord>("POST", `/zones/${zoneId}/dns_records`, body);
  }
}
