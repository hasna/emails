// End-to-end proof that the resource repositories route reads to the selfHosted /v1
// API in selfHosted mode (not the local SQLite island), and FAIL CLOSED when the
// endpoint is absent — the split-brain fix. A stub /v1 server runs OUT OF
// PROCESS (the repo layer's selfHosted client is synchronous curl, which cannot reach
// an in-process Bun.serve), and the local DB is left empty so any local read
// would return [] and could not masquerade as the selfHosted rows asserted below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { SelfHostedHttpError, resetSelfHostedConfigCache } from "./self-hosted-store.js";
import { listContacts } from "./contacts.js";
import { listGroups } from "./groups.js";
import { listOwners } from "./owners.js";
import { listTemplates } from "./templates.js";
import { listProviderSummaries } from "./providers.js";
import { listScheduledEmails } from "./scheduled.js";
import { listEmails, searchEmails } from "./emails.js";

const SERVER_CODE = `
const server = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname;
  const ok = (b) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
  if (p === "/v1/contacts") return ok({ items: [{ id: "c1", email: "selfHosted@example.com", name: "SelfHosted", send_count: 3, suppressed: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }] });
  if (p === "/v1/groups") return ok({ items: [{ id: "g1", name: "selfHosted-group", description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/owners") return ok({ items: [{ id: "o1", type: "agent", name: "SelfHosted Agent", contact_email: null, external_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/providers") return ok({ items: [{ id: "p1", name: "selfHosted-ses", type: "ses", region: "us-east-1", active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/scheduled") return ok({ items: [{ id: "s1", provider_id: "p1", from_address: "a@x.com", to_addresses: ["b@x.com"], subject: "hi", scheduled_at: "2026-02-01T00:00:00Z", status: "pending", created_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/messages") return ok({ messages: [
    { id: "m1", direction: "outbound", from_addr: "sender@x.com", to_addrs: ["rcpt@x.com"], subject: "Sent one", status: "sent", created_at: "2026-01-03T00:00:00Z" },
    { id: "m2", direction: "inbound", from_addr: "them@x.com", to_addrs: ["me@x.com"], subject: "Received", status: "received", created_at: "2026-01-04T00:00:00Z", received_at: "2026-01-04T00:00:00Z" },
  ] });
  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
} });
console.log("PORT " + server.port);
`;

let proc: Subprocess;
let baseUrl: string;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "-e", SERVER_CODE], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
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
  if (!port) throw new Error(`stub server did not report a port: ${buf}`);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => proc?.kill());

beforeEach(() => {
  process.env.EMAILS_MODE = "self_hosted";
  process.env.EMAILS_SELF_HOSTED_URL = baseUrl;
  process.env.EMAILS_SELF_HOSTED_API_KEY = "test_key";
  resetSelfHostedConfigCache();
});

afterEach(() => {
  delete process.env.EMAILS_MODE;
  delete process.env.EMAILS_SELF_HOSTED_URL;
  delete process.env.EMAILS_SELF_HOSTED_API_KEY;
  resetSelfHostedConfigCache();
});

describe("resource repos route reads to selfHosted in selfHosted mode", () => {
  test("listContacts returns selfHosted rows", () => {
    const rows = listContacts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("selfHosted@example.com");
    expect(rows[0]!.send_count).toBe(3);
  });

  test("listGroups returns selfHosted rows", () => {
    expect(listGroups().map((g) => g.name)).toEqual(["selfHosted-group"]);
  });

  test("listOwners returns selfHosted rows and filters by type", () => {
    expect(listOwners().map((o) => o.id)).toEqual(["o1"]);
    expect(listOwners("agent").map((o) => o.id)).toEqual(["o1"]);
    expect(listOwners("human")).toEqual([]);
  });

  test("listProviderSummaries returns selfHosted rows without secrets", () => {
    const rows = listProviderSummaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("selfHosted-ses");
    expect(rows[0]).not.toHaveProperty("api_key");
  });

  test("listScheduledEmails returns selfHosted rows", () => {
    const rows = listScheduledEmails();
    expect(rows.map((s) => s.id)).toEqual(["s1"]);
    expect(rows[0]!.to_addresses).toEqual(["b@x.com"]);
  });

  test("email log/search route to /v1/messages and surface only outbound", () => {
    const listed = listEmails();
    expect(listed.map((e) => e.id)).toEqual(["m1"]);
    expect(listed[0]!.subject).toBe("Sent one");
    const found = searchEmails("Sent");
    expect(found.map((e) => e.id)).toEqual(["m1"]);
    expect(searchEmails("Received")).toEqual([]);
  });

  test("missing endpoint FAILS CLOSED (no silent local read)", () => {
    expect(() => listTemplates()).toThrow(SelfHostedHttpError);
  });
});
