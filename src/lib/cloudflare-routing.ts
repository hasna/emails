/**
 * Cloudflare Email Routing API — enable routing on a zone, manage destination
 * addresses, create per-address routing rules (forward or Worker), and set the
 * catch-all. Endpoints (api.cloudflare.com/client/v4) from 2026 docs:
 *   POST /zones/{z}/email/routing/enable
 *   GET  /zones/{z}/email/routing/dns
 *   POST /accounts/{a}/email/routing/addresses          (destination, email-verified)
 *   POST /zones/{z}/email/routing/rules                 (matcher → forward/worker)
 *   PUT  /zones/{z}/email/routing/rules/catch_all
 *
 * Uses the shared cloudflare-auth headers (scoped token OR global key+email).
 * `fetchImpl` is injectable so request construction is fully unit-testable.
 */

import { resolveCloudflareAuth, cloudflareAuthEnv, type CloudflareAuth } from "./cloudflare-auth.js";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface RoutingClientOptions {
  auth?: CloudflareAuth;
  fetchImpl?: FetchImpl;
}

function authHeaders(auth?: CloudflareAuth): Record<string, string> {
  const a = auth ?? resolveCloudflareAuth();
  if (!a) throw new Error("Cloudflare credentials not configured");
  // cloudflareAuthEnv returns env var names; translate to HTTP headers.
  const env = cloudflareAuthEnv(a);
  if (env["CLOUDFLARE_API_TOKEN"]) return { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}` };
  return { "X-Auth-Key": env["CLOUDFLARE_API_KEY"]!, "X-Auth-Email": env["CLOUDFLARE_EMAIL"]! };
}

export class CloudflareRoutingClient {
  private fetchImpl: FetchImpl;
  private auth?: CloudflareAuth;

  constructor(opts: RoutingClientOptions = {}) {
    this.auth = opts.auth;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchImpl>);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${CF_BASE}${path}`, {
      method,
      headers: { ...authHeaders(this.auth), "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok || (json && json.success === false)) {
      const msg = json?.errors?.[0]?.message ?? `Cloudflare routing ${method} ${path} failed (${res.status})`;
      throw new Error(msg);
    }
    return (json?.result ?? json) as T;
  }

  /** Enable Email Routing on a zone (locks the required MX/SPF). */
  enableRouting(zoneId: string): Promise<unknown> {
    return this.call("POST", `/zones/${zoneId}/email/routing/enable`);
  }

  /** Read the MX/SPF records Email Routing requires. */
  getRoutingDns(zoneId: string): Promise<unknown> {
    return this.call("GET", `/zones/${zoneId}/email/routing/dns`);
  }

  /** Add an account-level destination address (must be email-verified by CF). */
  addDestination(accountId: string, email: string): Promise<unknown> {
    return this.call("POST", `/accounts/${accountId}/email/routing/addresses`, { email });
  }

  /** Create a routing rule that forwards a literal address to destination(s). */
  createForwardRule(zoneId: string, address: string, forwardTo: string[], name?: string): Promise<{ id?: string }> {
    return this.call("POST", `/zones/${zoneId}/email/routing/rules`, {
      name: name ?? address,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "forward", value: forwardTo }],
    });
  }

  /** Create a routing rule that sends a literal address to an Email Worker. */
  createWorkerRule(zoneId: string, address: string, workerName: string, name?: string): Promise<{ id?: string }> {
    return this.call("POST", `/zones/${zoneId}/email/routing/rules`, {
      name: name ?? address,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [workerName] }],
    });
  }

  /** Set the catch-all rule (forward unmatched mail to a destination). */
  setCatchAllForward(zoneId: string, forwardTo: string[]): Promise<unknown> {
    return this.call("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: forwardTo }],
    });
  }
}
