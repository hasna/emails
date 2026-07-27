import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { runDomainTool } from "./tools/domains-impl.js";

const API_KEY = "mcp-domain-address-test-key";

const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_CLIENT_ENV_SECRET",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

let ORIGINAL_HOME: string | undefined;
let ORIGINAL_ENV = new Map<string, string | undefined>();

let tempHome: string | null = null;
let apiServer: ReturnType<typeof Bun.spawn> | null = null;

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const API_SERVER = `
const API_KEY = process.env.TEST_API_KEY;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer " + API_KEY) {
      return json({ error: "unauthorized" }, 401);
    }
    const now = "2026-07-13T00:00:00.000Z";
    if (req.method === "GET" && url.pathname === "/v1/domains") {
      return json({
          domains: [
            {
              id: "domain-ready-1",
              domain: "example.com",
              status: "ready",
              provider: "ses",
              verified: true,
              notes: null,
              created_at: now,
              updated_at: now,
            },
            {
              id: "domain-pending-1",
              domain: "pending.example.com",
              status: "pending",
              provider: "ses",
              verified: false,
              notes: null,
              created_at: now,
              updated_at: now,
            },
          ],
        });
    }
    if (req.method === "GET" && url.pathname === "/v1/addresses") {
      return json({
          addresses: [
            {
              id: "addr-ready-1",
              email: "ops@example.com",
              domain: "example.com",
              display_name: "Ops",
              status: "active",
              verified: true,
              daily_quota: null,
              created_at: now,
              updated_at: now,
            },
            {
              id: "addr-pending-1",
              email: "pending@example.com",
              domain: "example.com",
              display_name: null,
              status: "active",
              verified: false,
              daily_quota: null,
              created_at: now,
              updated_at: now,
            },
          ],
        });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log("PORT " + server.port);
`;

async function startApi(): Promise<string> {
  apiServer = Bun.spawn(["bun", "-e", API_SERVER], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, TEST_API_KEY: API_KEY },
  });
  const reader = apiServer.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  while (!buf.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.releaseLock();
  const port = buf.match(/PORT (\d+)/)?.[1];
  if (!port) throw new Error(`self-hosted domain/address API fixture did not report a port: ${buf}`);
  return `http://127.0.0.1:${port}`;
}

function parseResult<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

beforeEach(async () => {
  ORIGINAL_HOME = process.env["HOME"];
  ORIGINAL_ENV = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  resetEnv();
  tempHome = mkdtempSync(join(tmpdir(), "emails-mcp-domain-address-self-hosted-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = await startApi();
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
  resetSelfHostedConfigCache();
});

afterEach(() => {
  apiServer?.kill();
  apiServer = null;
  resetSelfHostedConfigCache();
  restoreEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

describe("MCP domain/address self_hosted API-only guards", () => {
  it("routes domain and address listing tools through the API without creating local SQLite", async () => {
    const domainList = parseResult<{
      domains: Array<{ id: string; domain: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_domains", { provider_id: "ses" }));
    const domains = parseResult<{
      domains: Array<{ id: string; domain: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_usable_domains", { send: true }));
    const addresses = parseResult<{
      addresses: Array<{ id: string; email: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_addresses", {}));
    const usableFrom = parseResult<{
      addresses: Array<{ id: string; email: string; readiness: { send_ready: boolean } }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_usable_from_addresses", { send: true }));
    const verified = parseResult<{
      email: string;
      verified: boolean;
      mode: string;
      source: string;
    }>(await runDomainTool("verify_address", { address_id: "addr-ready" }));

    expect(domainList).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(domainList.domains.map((domain) => domain.domain)).toEqual(["example.com", "pending.example.com"]);
    expect(domains).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
      domains: [{ id: "domain-ready-1", domain: "example.com" }],
    });
    expect(addresses).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(addresses.addresses.map((address) => address.email)).toEqual(["ops@example.com", "pending@example.com"]);
    expect(usableFrom).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(usableFrom.addresses.map((address) => address.email)).toEqual(["ops@example.com", "pending@example.com"]);
    expect(usableFrom.addresses.every((address) => address.readiness.send_ready)).toBe(true);
    expect(verified).toMatchObject({
      email: "ops@example.com",
      verified: true,
      mode: "self_hosted",
      source: "self_hosted_api",
    });
  });

  it("fails the two provider-adapter tools that no mode can serve", async () => {
    // These are the ONLY domain/address tools left behind a mode guard, and the
    // guard is honest: they call `getAdapter(provider).getDnsRecords/.verifyDomain`,
    // the `/v1/providers` row carries no credential columns, and their CLI twins
    // (`emails domain dns`, `emails domain verify`) are `serverOnly(...)`. Removing
    // this refusal would replace it with a client-credentialed AWS/Cloudflare call.
    for (const [name, args] of [
      ["get_dns_records", { domain: "example.com" }],
      ["verify_domain", { domain: "example.com" }],
    ] as const) {
      const result = await runDomainTool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("self_hosted API-only mode");
    }
  });

  it("no longer refuses the repository-backed domain/address tools — they reach the wire", async () => {
    // Each of these has a `/v1` route, a complete client arm, and a working CLI twin;
    // the guard was the only thing refusing.
    //
    // A bare `not.toContain("self_hosted API-only mode")` would be near-vacuous here:
    // it stays green if a tool is replaced by `throw new Error("nope")`, and — worse —
    // if a guard is re-added using the OTHER refusal wording this codebase already
    // ships ("is API-backed in self_hosted mode and requires ..."). So each tool must
    // additionally prove it got as far as the HTTP transport: it either succeeds, or
    // fails with an error naming the wire (the `/v1` path or an HTTP status). This
    // fixture only serves GET /v1/domains and GET /v1/addresses, so most calls fail
    // there; src/mcp/self-hosted-unguarded-tools.test.ts drives them to completion
    // against a full stub.
    const REFUSAL_WORDINGS = ["self_hosted API-only mode", "is API-backed in self_hosted mode", "not available in the self-hosted client"];
    // The discriminating property is "reached the HTTP transport", NOT "succeeded".
    // Deliberately not asserting success for any of them: this suite shares a process
    // with others that mutate the self-hosted env, and under that pollution the
    // fixture's own key stops matching and every call fails 401 — which is still
    // proof the tool got to the wire. `self-hosted-unguarded-tools.test.ts` drives all
    // of these to completion against a clean stub; here the job is only to catch a
    // re-added mode refusal or a stubbed-out throw, and reaching the wire does that.
    const WIRE = /\/v1\/|\/(domains|addresses|aliases)\b|Self-hosted (GET|POST|PATCH|PUT|DELETE)|HTTP \d{3}/;

    for (const [name, args] of [
      ["remove_domain", { domain_id: "domain-ready-1" }],
      ["suggest_address", { domain: "example.com" }],
      ["remove_address", { address_id: "addr-ready-1" }],
      ["suspend_address", { address_id: "addr-ready-1" }],
      ["activate_address", { address_id: "addr-ready-1" }],
      ["set_address_quota", { address_id: "addr-ready-1", per_day: 5 }],
      ["add_alias", { alias: "hello@example.com", target: "ops@example.com" }],
      ["add_catch_all", { domain: "example.com", target: "ops@example.com" }],
      ["list_aliases", {}],
      ["remove_alias", { alias_id: "alias-1" }],
      ["resolve_alias", { recipient: "hello@example.com" }],
    ] as const) {
      const result = await runDomainTool(name, args);
      const body = result.content[0]?.text ?? "";
      expect(body, `${name} produced no output`).not.toBe("");
      for (const wording of REFUSAL_WORDINGS) {
        expect(body, `${name} still refuses by mode`).not.toContain(wording);
      }
      // Reached the transport: either it worked, or the failure names the wire.
      if (result.isError) {
        expect(body, `${name} failed before reaching the /v1 transport: ${body}`).toMatch(WIRE);
      }
    }
  });

  it("proves the wire-reaching assertion above can fail (guard wording is really absent)", async () => {
    // Negative control for the loop: the two tools that KEEP their guard must trip
    // the very check the loop applies, or the loop is asserting over nothing.
    for (const name of ["get_dns_records", "verify_domain"] as const) {
      const body = (await runDomainTool(name, { domain: "example.com" })).content[0]?.text ?? "";
      expect(body).toContain("self_hosted API-only mode");
    }
  });
});
