// Covers the client-flip (self_hosted) branch of the domain CLI end to end
// against the REAL cloud-store (curl over HTTP): with HASNA_MAILERY_API_URL +
// HASNA_MAILERY_API_KEY set and mode=self_hosted, `domain add`, `domain list`,
// and `domain remove` must route reads AND writes to the cloud HTTP API — never
// to a local provider row/adapter (the cloud API exposes no /v1/providers).
//
// The cloud-store performs its HTTP call with a SYNCHRONOUS `curl` (spawnSync),
// which blocks Bun's event loop — so the stand-in for <app>.hasna.xyz/v1 runs in
// a SEPARATE process (an in-process server would deadlock). No module mocks are
// used, so the real transport path is exercised and nothing leaks across files.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDomainCommands } from "./domain.js";
import { resetCloudConfigCache } from "../../db/cloud-store.js";

const API_KEY = "hasna_mailery_test_key_1234567890";
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let serverDir = "";
let baseOrigin = "";

const SERVER_SRC = `
const KEY = process.env.TEST_API_KEY;
const rows = new Map();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\\/+|\\/+$/g, "").split("/");
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__reset") { rows.clear(); return json({ ok: true }); }
    if (req.headers.get("authorization") !== "Bearer " + KEY) return json({ error: "unauthorized" }, 401);
    if (parts[0] !== "v1" || parts[1] !== "domains") return json({ error: "not found" }, 404);
    const id = parts[2];
    if (req.method === "GET" && !id) return json({ domains: [...rows.values()] });
    if (req.method === "POST" && !id) {
      const body = await req.json();
      const now = new Date().toISOString();
      const entity = { id: crypto.randomUUID(), domain: body.domain, provider: body.provider ?? null, verified: false, created_at: now, updated_at: now };
      rows.set(entity.id, entity);
      return json({ domain: entity }, 201);
    }
    if (id && req.method === "GET") { const e = rows.get(id); return e ? json({ domain: e }) : json({ error: "not found" }, 404); }
    if (id && (req.method === "PATCH" || req.method === "PUT")) {
      const e = rows.get(id); if (!e) return json({ error: "not found" }, 404);
      const patch = await req.json(); const u = { ...e, ...patch, updated_at: new Date().toISOString() }; rows.set(id, u); return json({ domain: u });
    }
    if (id && req.method === "DELETE") return rows.delete(id) ? json({ ok: true }) : json({ error: "not found" }, 404);
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

async function serverDomains(): Promise<Array<{ domain: string }>> {
  const res = await fetch(`${baseOrigin}/v1/domains`, { headers: { authorization: `Bearer ${API_KEY}` } });
  const body = (await res.json()) as { domains: Array<{ domain: string }> };
  return body.domains;
}

beforeAll(async () => {
  serverDir = mkdtempSync(join(tmpdir(), "mailery-cloud-test-"));
  const scriptPath = join(serverDir, "server.mjs");
  writeFileSync(scriptPath, SERVER_SRC);
  serverProc = Bun.spawn(["bun", scriptPath], {
    env: { ...process.env, TEST_API_KEY: API_KEY },
    stdout: "pipe",
    stderr: "inherit",
  });
  // Read the announced port from stdout.
  const reader = serverProc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = buf.match(/PORT=(\d+)/);
    if (m) {
      baseOrigin = `http://127.0.0.1:${m[1]}`;
      break;
    }
  }
  reader.releaseLock();
  if (!baseOrigin) throw new Error("mock cloud server did not report a port");
});

afterAll(() => {
  serverProc?.kill();
  if (serverDir) rmSync(serverDir, { recursive: true, force: true });
});

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "mailery", ...args]);
  return { data, out: out.join("\n") };
}

describe("domain CLI — cloud (self_hosted) routing", () => {
  beforeEach(async () => {
    await fetch(`${baseOrigin}/v1/__reset`, { method: "POST" });
    process.env["EMAILS_DB_PATH"] = ":memory:";
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_MAILERY_API_URL"] = baseOrigin;
    process.env["HASNA_MAILERY_API_KEY"] = API_KEY;
    resetCloudConfigCache();
  });
  afterEach(() => {
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    resetCloudConfigCache();
  });

  it("add writes to the cloud API (not a local provider)", async () => {
    const { data } = await runDomainCommand(["domain", "add", "cloudy.example.com", "--provider", "cloud"]);
    const entity = data as { id: string; domain: string };
    expect(entity.domain).toBe("cloudy.example.com");
    const remote = await serverDomains();
    expect(remote.map((d) => d.domain)).toEqual(["cloudy.example.com"]);
  });

  it("list reads from the cloud API", async () => {
    await runDomainCommand(["domain", "add", "one.example.com", "--provider", "cloud"]);
    await runDomainCommand(["domain", "add", "two.example.com", "--provider", "cloud"]);
    const { data } = await runDomainCommand(["domain", "list"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain).sort()).toEqual(["one.example.com", "two.example.com"]);
  });

  it("add is idempotent by name against the cloud API", async () => {
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "cloud"]);
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "cloud"]);
    expect((await serverDomains()).length).toBe(1);
  });

  it("remove deletes from the cloud API", async () => {
    await runDomainCommand(["domain", "add", "gone.example.com", "--provider", "cloud"]);
    const remote = await serverDomains();
    expect(remote.length).toBe(1);
    const id = (remote[0] as { id: string }).id;
    await runDomainCommand(["domain", "remove", id, "--yes"]);
    expect((await serverDomains()).length).toBe(0);
  });
});
