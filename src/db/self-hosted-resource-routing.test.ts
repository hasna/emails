// End-to-end proof that the resource repositories route reads to the selfHosted /v1
// API in selfHosted mode (not the local SQLite island), and FAIL CLOSED when the
// endpoint is absent — the split-brain fix. A stub /v1 server runs OUT OF
// PROCESS (the repo layer's selfHosted client is synchronous curl, which cannot reach
// an in-process Bun.serve), and the local DB is left empty so any local read
// would return [] and could not masquerade as the selfHosted rows asserted below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { SelfHostedHttpError, resetSelfHostedConfigCache } from "./self-hosted-store.js";
import { DATABASE_PATH_SETTINGS, StoreConfigurationError } from "../store-resolution.js";
import { listContacts } from "./contacts.js";
import { listGroups } from "./groups.js";
import { listOwners } from "./owners.js";
import { listTemplates } from "./templates.js";
import { listProviderSummaries } from "./providers.js";
import { listScheduledEmails } from "./scheduled.js";
import { listEmails, searchEmails } from "./emails.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const SERVER_CODE = `
const server = Bun.serve({ port: 0, fetch(req) {
  const p = new URL(req.url).pathname;
  const ok = (b) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
  const tenantId = "12345678-1234-4234-8234-123456789abc";
  if (p === "/v1/contacts") return ok({ items: [{ id: "c1", tenant_id: tenantId, email: "selfHosted@example.com", name: "SelfHosted", send_count: 3, bounce_count: 0, complaint_count: 0, last_sent_at: null, suppressed: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" }] });
  if (p === "/v1/groups") return ok({ items: [{ id: "g1", tenant_id: tenantId, name: "selfHosted-group", description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/owners") return ok({ items: [{ id: "o1", tenant_id: tenantId, type: "agent", name: "SelfHosted Agent", contact_email: null, external_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/providers") return ok({ items: [{ id: "p1", tenant_id: tenantId, name: "selfHosted-ses", type: "ses", region: "us-east-1", active: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/scheduled") return ok({ items: [{ id: "s1", tenant_id: tenantId, provider_id: "p1", from_address: "a@x.com", to_addresses: ["b@x.com"], cc_addresses: [], bcc_addresses: [], reply_to: null, subject: "hi", html: null, text_body: null, attachments_json: [], template_name: null, template_vars: {}, scheduled_at: "2026-02-01T00:00:00Z", status: "pending", error: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
  if (p === "/v1/messages") return ok({ messages: [
    { id: "m1", direction: "outbound", from_addr: "sender@x.com", to_addrs: ["rcpt@x.com"], cc_addrs: [], subject: "Sent one", snippet: null, status: "sent", provider_message_id: null, message_id: null, in_reply_to: null, received_at: null, is_read: true, is_starred: false, labels: [], attachment_count: 0, source_id: null, send_state: "sent", policy_denial: null, send_started_at: null, created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
    { id: "m2", direction: "inbound", from_addr: "them@x.com", to_addrs: ["me@x.com"], cc_addrs: [], subject: "Received", snippet: null, status: "received", provider_message_id: null, message_id: null, in_reply_to: null, received_at: "2026-01-04T00:00:00Z", is_read: false, is_starred: false, labels: [], attachment_count: 0, source_id: null, send_state: "none", policy_denial: null, send_started_at: null, created_at: "2026-01-04T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
  ], next_cursor: null });
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
  captureInheritedProcessEnv();
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
  restoreInheritedProcessEnv();
});

describe("resource repos route reads to selfHosted in selfHosted mode", () => {
  // The contacts family no longer participates in the routing this file measures, and it
  // stopped the way the schedule and the sent ledger did: it has collapsed to one
  // implementation over the store seam, so it reaches this same `/v1` service because
  // STORAGE CONFIGURATION named an Emails API — not because a mode word chose an arm.
  // The database path is unset for the duration of this case, leaving exactly one
  // configured store, because the pair is a CONTRADICTION that `planEmailStore` refuses
  // outright. What it still guards: the rows come from the service, mapped (JSON number
  // and boolean columns included), and not from a local read — this file leaves the
  // local database empty precisely so a local read could not masquerade as these rows.
  test("listContacts reads the configured API store", async () => {
    const restore = DATABASE_PATH_SETTINGS.map((key) => [key, process.env[key]] as const);
    for (const [key] of restore) delete process.env[key];
    try {
      const rows = await listContacts();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email).toBe("selfHosted@example.com");
      expect(rows[0]!.send_count).toBe(3);
      expect(rows[0]!.suppressed).toBe(false);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  // The schedule no longer participates in the routing this file measures, and the way it
  // stopped is worth stating precisely. Its family has collapsed to one implementation over
  // the store seam, so it reaches this same `/v1` service because STORAGE CONFIGURATION
  // named an Emails API — not because a mode word chose an arm.
  //
  // THE OLD PREMISE IS NO LONGER EXPRESSIBLE, which is the axis deletion working rather
  // than a gap: every other case here runs with a local database configured AND an API
  // configured, and reads the API because the mode word said so. `planEmailStore` treats
  // that pair as a CONTRADICTION and refuses outright — deliberately no precedence, because
  // a winner picked for you sends mail to the store you did not mean. So the database path
  // is unset for the duration of this one case, leaving exactly one configured store.
  //
  // What it still guards is worth guarding: the rows must come from the service, mapped, and
  // not from a local read (which is why this file leaves the local database empty at all).
  test("listScheduledEmails reads the configured API store", async () => {
    const restore = DATABASE_PATH_SETTINGS.map((key) => [key, process.env[key]] as const);
    for (const [key] of restore) delete process.env[key];
    try {
      const rows = await listScheduledEmails();
      expect(rows.map((s) => s.id)).toEqual(["s1"]);
      expect(rows[0]!.to_addresses).toEqual(["b@x.com"]);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("a local database AND an API both configured is refused, never silently resolved", async () => {
    // The other half of the same finding, asserted rather than left implicit: with both
    // configured the read must REFUSE. A precedence rule here would have made every case
    // above pass while reading the wrong store.
    //
    // The contradiction is CONSTRUCTED here rather than inherited from the harness. The
    // hermetic runner sets a database path and a bare `bun test` does not, so a case that
    // read whatever the environment happened to hold would assert one thing under
    // `bun run test` and something else run directly — and the version of this that did
    // exactly that is how it was caught.
    const key = DATABASE_PATH_SETTINGS[1];
    const previous = process.env[key];
    process.env[key] = ":memory:";
    try {
      expect(process.env.EMAILS_SELF_HOSTED_URL).toBeTruthy();
      // AWAITED. `expect(promise).rejects` without it is a floating assertion that passes
      // whatever the promise does.
      await expect(listScheduledEmails()).rejects.toThrow(StoreConfigurationError);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  // The sent ledger no longer participates in the routing this file measures either, and it
  // stopped the same way the schedule did: its family has collapsed to one implementation over
  // the store seam, so it reaches this `/v1` service because STORAGE CONFIGURATION named an
  // Emails API — not because a mode word chose an arm. The database path is therefore unset for
  // the duration of this case, leaving exactly one configured store, because the pair is a
  // CONTRADICTION that `planEmailStore` refuses outright.
  //
  // WHAT IT STILL GUARDS IS STRONGER THAN WHAT IT USED TO. The stand-in service below ignores
  // `direction` entirely and serves BOTH rows for every request — which is exactly the shape of
  // fixture that let the deleted arm look correct — so the outbound scoping asserted here is
  // being done by the client, over rows a widened server handed it, and not by the query.
  test("the sent ledger reads the configured API store and surfaces only outbound rows", async () => {
    const restore = DATABASE_PATH_SETTINGS.map((key) => [key, process.env[key]] as const);
    for (const [key] of restore) delete process.env[key];
    try {
      const listed = await listEmails();
      expect(listed.map((e) => e.id)).toEqual(["m1"]);
      expect(listed[0]!.subject).toBe("Sent one");
      const found = await searchEmails("Sent");
      expect(found.map((e) => e.id)).toEqual(["m1"]);
      // "Received" is the inbound row's subject. It is served by the endpoint and must not
      // reach the sent ledger.
      expect(await searchEmails("Received")).toEqual([]);
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("missing endpoint FAILS CLOSED (no silent local read)", () => {
    expect(() => listTemplates()).toThrow(SelfHostedHttpError);
  });
});
