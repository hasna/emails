// Regression: in selfHosted (self_hosted) mode `getEmail`, `resolveEmailId`, and
// `getEmailContent` MUST route to the app's /v1/messages API — never the local
// (empty) SQLite `emails` table. Previously `getEmail`/`getEmailContent` read
// SQLite unconditionally and `show`'s id resolution used the local
// `resolvePartialId`, so `emails show <id>` returned "Email not found" for a
// message that plainly existed over /v1 (search/list found it) — the split-brain
// bug this test locks closed.
//
// Mirrors domain.selfHosted.test.ts: the self-hosted-store's transport is a SYNCHRONOUS
// curl (spawnSync) that blocks Bun's loop, so the /v1 stand-in runs in a
// SEPARATE process. No module mocks — the real transport path is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEmail, resolveEmailId } from "./emails.js";
import { getEmailContent } from "./email-content.js";
import { resetSelfHostedConfigCache } from "./self-hosted-store.js";

const API_KEY = "hasna_emails_test_key_emails_1234567890";
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
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__seed") {
      const body = await req.json();
      rows.clear();
      for (const r of body.messages ?? []) rows.set(r.id, r);
      return json({ ok: true });
    }
    if (req.headers.get("authorization") !== "Bearer " + KEY) return json({ error: "unauthorized" }, 401);
    if (parts[0] !== "v1" || parts[1] !== "messages") return json({ error: "not found" }, 404);
    const id = parts[2];
    if (req.method === "GET" && !id) return json({ messages: [...rows.values()] });
    if (id && req.method === "GET") { const e = rows.get(id); return e ? json({ message: e }) : json({ error: "message not found" }, 404); }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

const MESSAGE = {
  id: "dad074f1-1111-2222-3333-444455556666",
  direction: "outbound",
  from_addr: "sender@hasna.xyz",
  to_addrs: ["dest@example.com"],
  subject: "SelfHosted show works",
  body_text: "hello from the selfHosted store",
  body_html: "<p>hello from the selfHosted store</p>",
  headers: { "X-Test": "1" },
  status: "sent",
  received_at: "2026-07-08T12:00:00.000Z",
  created_at: "2026-07-08T12:00:00.000Z",
};

async function seed(messages: Record<string, unknown>[]): Promise<void> {
  await fetch(`${baseOrigin}/v1/__seed`, { method: "POST", body: JSON.stringify({ messages }) });
}

beforeAll(async () => {
  serverDir = mkdtempSync(join(tmpdir(), "emails-emails-selfHosted-test-"));
  const scriptPath = join(serverDir, "server.mjs");
  writeFileSync(scriptPath, SERVER_SRC);
  serverProc = Bun.spawn(["bun", scriptPath], {
    env: { ...process.env, TEST_API_KEY: API_KEY },
    stdout: "pipe",
    stderr: "inherit",
  });
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
  if (!baseOrigin) throw new Error("mock selfHosted server did not report a port");
});

afterAll(() => {
  serverProc?.kill();
  if (serverDir) rmSync(serverDir, { recursive: true, force: true });
});

describe("emails repo — selfHosted (self_hosted) routing", () => {
  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
    resetSelfHostedConfigCache();
  });
  afterEach(() => {
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_SELF_HOSTED_URL"];
    delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
    resetSelfHostedConfigCache();
  });

  it("getEmail reads a message from the selfHosted API by full id", async () => {
    await seed([MESSAGE]);
    const email = getEmail(MESSAGE.id);
    expect(email).not.toBeNull();
    expect(email!.id).toBe(MESSAGE.id);
    expect(email!.subject).toBe("SelfHosted show works");
    expect(email!.to_addresses).toEqual(["dest@example.com"]);
  });

  it("getEmail returns null for an id absent in the selfHosted store (no local fallback)", async () => {
    await seed([MESSAGE]);
    expect(getEmail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("resolveEmailId confirms a full id and matches a unique prefix via the selfHosted store", async () => {
    await seed([MESSAGE]);
    expect(resolveEmailId(MESSAGE.id)).toBe(MESSAGE.id);
    expect(resolveEmailId("dad074f1")).toBe(MESSAGE.id);
    expect(resolveEmailId("nope")).toBeNull();
  });

  it("getEmailContent returns the message body from the selfHosted API", async () => {
    await seed([MESSAGE]);
    const content = getEmailContent(MESSAGE.id);
    expect(content).not.toBeNull();
    expect(content!.text_body).toBe("hello from the selfHosted store");
    expect(content!.html).toBe("<p>hello from the selfHosted store</p>");
    expect(content!.headers).toEqual({ "X-Test": "1" });
  });
});
