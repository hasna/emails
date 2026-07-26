// Regression proof that `offset > 0` returns the right page through the
// `.local` self-hosted resource helpers.
//
// `selfHostedListQuery` used to send `offset` to the server AND `selfHostedPage`
// sliced the same window again locally. The real `/v1` list route pages
// server-side (`LIMIT $n OFFSET $n+1` in store.listResource), so the two windows
// compose: for `{ limit: 2, offset: 2 }` the server returned rows 3-4 and the
// local slice then took `rows.slice(2, 4)` of that 2-row array — an EMPTY page.
// The canonical `self-hosted-resource.ts` twin documents the same fix; the
// `.local` twin that the ten `*.local.ts` repositories import still carried it.
//
// The stub below deliberately honours `limit`/`offset` exactly the way the real
// server does, so this test reproduces the double-window rather than hiding it
// behind a stub that ignores paging. Ordering matches the repo layer's own
// `created_at DESC` sort so the expected page is unambiguous.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { resetSelfHostedConfigCache } from "./self-hosted-store.js";
import { selfHostedListQuery, selfHostedPage } from "./self-hosted-resource.local.js";
// Imported from the `.local` module directly: the `providers.js` dispatcher sends
// a no-Database call in self-hosted mode to `providers.remote.ts`, so the `.local`
// self-hosted branch — the one the ten `*.local.ts` repositories still run behind
// their mode gate — is only reachable from here.
import { listProviders } from "./providers.local.js";

// Five providers, newest first once the repo layer sorts by created_at DESC:
// p5, p4, p3, p2, p1.
const SERVER_CODE = `
const rows = [5, 4, 3, 2, 1].map((n) => ({
  id: "p" + n,
  tenant_id: "00000000-0000-0000-0000-000000000001",
  name: "provider-" + n,
  type: "ses",
  region: "us-east-1",
  active: true,
  created_at: "2026-01-0" + n + "T00:00:00Z",
  updated_at: "2026-01-0" + n + "T00:00:00Z",
}));
const server = Bun.serve({ port: 0, fetch(req) {
  const url = new URL(req.url);
  if (url.pathname !== "/v1/providers") {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  // Same contract as the real route: clamped LIMIT/OFFSET applied server-side.
  const limitRaw = Number(url.searchParams.get("limit"));
  const offsetRaw = Number(url.searchParams.get("offset"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  return new Response(JSON.stringify({ items: rows.slice(offset, offset + limit) }), {
    headers: { "Content-Type": "application/json" },
  });
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

describe("selfHostedListQuery windows the page exactly once", () => {
  test("never sends a server-side offset", () => {
    expect(selfHostedListQuery({ limit: 2, offset: 2 }).query).not.toHaveProperty("offset");
    expect(selfHostedListQuery({ offset: 40 }).query).not.toHaveProperty("offset");
  });

  test("fetches a superset that covers the requested window", () => {
    // limit + offset must be reachable, otherwise the local slice under-fills.
    const deep = selfHostedListQuery({ limit: 50, offset: 4000 });
    expect(Number(deep.query["limit"])).toBeGreaterThanOrEqual(4050);
    const shallow = selfHostedListQuery({ limit: 2, offset: 2 });
    expect(Number(shallow.query["limit"])).toBeGreaterThanOrEqual(4);
  });

  test("a null limit fetches everything and windows to identity", () => {
    const all = selfHostedListQuery({ offset: 3 });
    expect(all.query).not.toHaveProperty("limit");
    expect(selfHostedPage(["a", "b", "c"], all.limit, all.offset)).toEqual(["a", "b", "c"]);
  });
});

describe("offset > 0 returns the correct page against a paging /v1 server", () => {
  test("listProviders pages without double-windowing", () => {
    expect(listProviders(undefined, { limit: 2, offset: 0 }).map((p) => p.id)).toEqual(["p5", "p4"]);
    // The double-window bug returned [] here.
    expect(listProviders(undefined, { limit: 2, offset: 2 }).map((p) => p.id)).toEqual(["p3", "p2"]);
    expect(listProviders(undefined, { limit: 2, offset: 4 }).map((p) => p.id)).toEqual(["p1"]);
    expect(listProviders(undefined, { limit: 2, offset: 6 })).toEqual([]);
  });

  test("the last partial page is not truncated away", () => {
    expect(listProviders(undefined, { limit: 4, offset: 3 }).map((p) => p.id)).toEqual(["p2", "p1"]);
  });
});
