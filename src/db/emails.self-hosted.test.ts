// Regression: in selfHosted (self_hosted) mode `getEmail` and `resolveEmailId` MUST
// route to the app's /v1/messages API — never the local (empty) SQLite `emails`
// table. Previously `getEmail` read SQLite unconditionally and `show`'s id
// resolution used the local `resolvePartialId`, so `emails show <id>` returned
// "Email not found" for a message that plainly existed over /v1 (search/list found
// it) — the split-brain bug this test locks closed.
//
// `getEmailContent` was covered here too and no longer is; the note at the end of the
// describe block says where it went and why it could not stay.
//
// Mirrors domain.selfHosted.test.ts: the self-hosted-store's transport is a SYNCHRONOUS
// curl (spawnSync) that blocks Bun's loop, so the /v1 stand-in runs in a
// SEPARATE process. No module mocks — the real transport path is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEmail, resolveEmailId } from "./emails.js";
import { resetSelfHostedConfigCache } from "./self-hosted-store.js";

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
    if (req.method === "GET" && !id) return json({ messages: [...rows.values()], next_cursor: null });
    if (id && req.method === "GET") { const e = rows.get(id); return e ? json({ message: e }) : json({ error: "message not found" }, 404); }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

const MESSAGE = {
  id: "dad074f1-1111-2222-3333-444455556666",
  direction: "outbound",
  from_addr: "sender@example.org",
  to_addrs: ["dest@example.com"],
  cc_addrs: [],
  bcc_addrs: [],
  subject: "SelfHosted show works",
  snippet: "hello from the selfHosted store",
  body_text: "hello from the selfHosted store",
  body_html: "<p>hello from the selfHosted store</p>",
  headers: { "X-Test": "1" },
  attachments: [],
  attachment_count: 0,
  status: "sent",
  provider_message_id: null,
  message_id: null,
  in_reply_to: null,
  received_at: "2026-07-08T12:00:00.000Z",
  is_read: true,
  is_starred: false,
  labels: [],
  source_id: null,
  send_state: "sent",
  // Required on a /v1 list item: null means "no outbound policy gate refused this".
  policy_denial: null,
  send_started_at: null,
  created_at: "2026-07-08T12:00:00.000Z",
  updated_at: "2026-07-08T12:00:00.000Z",
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
    captureInheritedProcessEnv();
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
    restoreInheritedProcessEnv();
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

  // THE `getEmailContent` CASE MOVED, and this note is the whole reason it is not simply
  // gone. It asserted that the reader routes to `/v1` rather than to the local SQLite island
  // when the deployment word is set. That regression is now structurally impossible: the
  // email-content family has no arms and no routing — it reads whichever store the
  // installation configured — so there is nothing left here for a mode word to get wrong.
  //
  // It also could no longer run in this file's fixture. These cases set a database path AND
  // an API origin at once (lines above), which `planEmailStore` treats as a hard boot error
  // rather than a precedence rule, on the grounds that an installation with two places to
  // keep its mail has not said which one it meant.
  //
  // The successor is `src/db/email-content.test.ts`, which asserts the same three fields
  // against a REAL HTTP store in front of the seam — and against a real SQLite store with
  // identical assertions, which this file could not do.
});
