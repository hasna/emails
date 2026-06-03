import { describe, it, expect } from "bun:test";
import { DirectCloudflareClient, type DnsFetchImpl } from "./cloudflare-dns-rest.js";

function rec(result: any) {
  const calls: { url: string; method: string; headers: Record<string,string>; body?: any }[] = [];
  const fetchImpl: DnsFetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { calls, fetchImpl };
}
const token = { kind: "token", token: "T" } as const;

describe("DirectCloudflareClient (no @hasna/connectors)", () => {
  it("listZones GETs /zones?name= with Bearer and maps nameservers", async () => {
    const r = rec([{ id: "z1", name: "ex.com", name_servers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] }]);
    const zones = await new DirectCloudflareClient({ auth: token, fetchImpl: r.fetchImpl }).listZones({ name: "ex.com" });
    expect(r.calls[0].url).toContain("/zones?name=ex.com");
    expect(r.calls[0].headers.Authorization).toBe("Bearer T");
    expect(zones[0]!.nameservers).toEqual(["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
  });

  it("createDnsRecord POSTs CNAME with ttl default 1, no proxied for MX", async () => {
    const r = rec({ id: "r1", type: "CNAME", name: "x._domainkey.ex.com", content: "x.dkim.amazonses.com" });
    const out = await new DirectCloudflareClient({ auth: token, fetchImpl: r.fetchImpl }).createDnsRecord("z1", {
      type: "CNAME", name: "x._domainkey.ex.com", content: "x.dkim.amazonses.com",
    });
    expect(out.id).toBe("r1");
    expect(r.calls[0].method).toBe("POST");
    expect(r.calls[0].url).toContain("/zones/z1/dns_records");
    expect(r.calls[0].body).toMatchObject({ type: "CNAME", ttl: 1 });
  });

  it("createDnsRecord for MX sets priority default 10", async () => {
    const r = rec({ id: "m1" });
    await new DirectCloudflareClient({ auth: token, fetchImpl: r.fetchImpl }).createDnsRecord("z1", {
      type: "MX", name: "ex.com", content: "inbound-smtp.us-east-1.amazonaws.com",
    });
    expect(r.calls[0].body.priority).toBe(10);
  });

  it("uses X-Auth-Key/Email for a global key", async () => {
    const r = rec([]);
    await new DirectCloudflareClient({ auth: { kind: "global", apiKey: "K", email: "a@b.com" }, fetchImpl: r.fetchImpl }).listZones();
    expect(r.calls[0].headers["X-Auth-Key"]).toBe("K");
    expect(r.calls[0].headers["X-Auth-Email"]).toBe("a@b.com");
  });

  it("throws on API error", async () => {
    const fetchImpl: DnsFetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: "denied" }] }) });
    await expect(new DirectCloudflareClient({ auth: token, fetchImpl }).listZones()).rejects.toThrow("denied");
  });
});
