// End-to-end proof that the resource repositories route WRITES to the cloud /v1
// API in cloud mode (not the local SQLite island) — the write half of the
// split-brain fix. Reads were already routed (see cloud-resource-routing.test.ts);
// this covers createOwner, createGroup, and contact suppress/unsuppress, plus the
// deliberate fail-loud for send-key creation (the cloud store holds no secret
// hash, so a locally-minted key would be unverifiable / split-brain).
//
// A stateful stub /v1 server runs OUT OF PROCESS (the repo layer's cloud client
// is synchronous curl, which cannot reach an in-process Bun.serve). The local DB
// is left empty so a local write could not masquerade as the cloud state asserted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { resetCloudConfigCache } from "./cloud-store.js";
import { createOwner, listOwners } from "./owners.js";
import { createGroup, listGroups } from "./groups.js";
import { suppressContact, unsuppressContact, listContacts } from "./contacts.js";
import { createSendKey } from "./send-keys.js";
import { createTemplate, listTemplates, getTemplate, deleteTemplate } from "./templates.js";
import { createSequence, listSequences } from "./sequences.js";

const SERVER_CODE = `
const owners = [];
const groups = [];
const contacts = [];
const templates = [];
const sequences = [];
let seq = 0;
const nid = (p) => p + (++seq);
const now = "2026-01-01T00:00:00Z";
const server = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const ok = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const body = (m === "POST" || m === "PATCH") ? await req.json().catch(() => ({})) : {};

  if (p === "/v1/owners" && m === "GET") return ok({ items: owners });
  if (p === "/v1/owners" && m === "POST") {
    const o = { id: nid("o"), type: body.type, name: body.name, contact_email: body.contact_email ?? null, external_id: body.external_id ?? null, created_at: now, updated_at: now };
    owners.push(o);
    return ok(o, 201);
  }

  if (p === "/v1/groups" && m === "GET") return ok({ items: groups });
  if (p === "/v1/groups" && m === "POST") {
    const g = { id: nid("g"), name: body.name, description: body.description ?? null, created_at: now, updated_at: now };
    groups.push(g);
    return ok(g, 201);
  }

  if (p === "/v1/contacts" && m === "GET") {
    const email = url.searchParams.get("email");
    const items = email ? contacts.filter((c) => c.email === email) : contacts;
    return ok({ items });
  }
  if (p === "/v1/contacts" && m === "POST") {
    const c = { id: nid("c"), email: body.email, name: body.name ?? null, send_count: 0, bounce_count: 0, complaint_count: 0, last_sent_at: null, suppressed: !!body.suppressed, created_at: now, updated_at: now };
    contacts.push(c);
    return ok(c, 201);
  }
  if (p === "/v1/templates" && m === "GET") return ok({ items: templates });
  if (p === "/v1/templates" && m === "POST") {
    const t = { id: nid("t"), name: body.name, subject_template: body.subject_template, html_template: body.html_template ?? null, text_template: body.text_template ?? null, metadata: body.metadata ?? {}, created_at: now, updated_at: now };
    templates.push(t);
    return ok(t, 201);
  }
  const tm = p.match(/^\\/v1\\/templates\\/([^/]+)$/);
  if (tm && m === "GET") {
    const t = templates.find((x) => x.id === tm[1]);
    return t ? ok(t, 200) : ok({ error: "not found" }, 404);
  }
  if (tm && m === "DELETE") {
    const i = templates.findIndex((x) => x.id === tm[1]);
    if (i < 0) return ok({ error: "not found" }, 404);
    templates.splice(i, 1);
    return ok({ deleted: true, id: tm[1] }, 200);
  }

  if (p === "/v1/sequences" && m === "GET") return ok({ items: sequences });
  if (p === "/v1/sequences" && m === "POST") {
    const s = { id: nid("s"), name: body.name, description: body.description ?? null, status: body.status ?? "active", created_at: now, updated_at: now };
    sequences.push(s);
    return ok(s, 201);
  }

  const cm = p.match(/^\\/v1\\/contacts\\/([^/]+)$/);
  if (cm && m === "PATCH") {
    const c = contacts.find((x) => x.id === cm[1]);
    if (!c) return ok({ error: "not found" }, 404);
    if ("suppressed" in body) c.suppressed = !!body.suppressed;
    return ok(c, 200);
  }

  return ok({ error: "not found" }, 404);
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
  process.env.HASNA_MAILERY_STORAGE_MODE = "cloud";
  process.env.HASNA_MAILERY_API_URL = baseUrl;
  process.env.HASNA_MAILERY_API_KEY = "test_key";
  resetCloudConfigCache();
});

afterEach(() => {
  delete process.env.HASNA_MAILERY_STORAGE_MODE;
  delete process.env.HASNA_MAILERY_API_URL;
  delete process.env.HASNA_MAILERY_API_KEY;
  resetCloudConfigCache();
});

describe("resource repos route writes to cloud in cloud mode", () => {
  test("createOwner POSTs to /v1/owners and appears in cloud listOwners", () => {
    const o = createOwner({ type: "agent", name: "Writer Agent" });
    expect(o.id).toStartWith("o");
    expect(o.name).toBe("Writer Agent");
    // The registered owner is now visible via the cloud read path (not just a
    // local id that never reaches the cloud — the split-brain symptom).
    expect(listOwners().some((x) => x.id === o.id)).toBe(true);
  });

  test("createGroup POSTs to /v1/groups and appears in cloud listGroups", () => {
    const g = createGroup("writer-group", "desc");
    expect(g.id).toStartWith("g");
    expect(listGroups().some((x) => x.name === "writer-group")).toBe(true);
  });

  test("suppressContact creates-then-suppresses on the cloud and shows in cloud list", () => {
    suppressContact("blocked@example.com");
    const suppressed = listContacts({ suppressed: true });
    expect(suppressed.map((c) => c.email)).toContain("blocked@example.com");
    // Idempotent unsuppress flips the same cloud record (no duplicate contact).
    unsuppressContact("blocked@example.com");
    expect(listContacts({ suppressed: true }).map((c) => c.email)).not.toContain("blocked@example.com");
    expect(listContacts().filter((c) => c.email === "blocked@example.com")).toHaveLength(1);
  });

  test("createTemplate POSTs to /v1/templates and appears in cloud listTemplates", () => {
    const t = createTemplate({ name: "welcome", subject_template: "Hi {{name}}", html_template: "<p>hi</p>" });
    expect(t.id).toStartWith("t");
    expect(t.subject_template).toBe("Hi {{name}}");
    expect(listTemplates().some((x) => x.name === "welcome")).toBe(true);
  });

  test("getTemplate/deleteTemplate route show+remove to cloud (by name and id)", () => {
    const t = createTemplate({ name: "farewell", subject_template: "Bye {{name}}" });
    // show by id AND by name both resolve against the cloud, not the empty local DB.
    expect(getTemplate(t.id)?.name).toBe("farewell");
    expect(getTemplate("farewell")?.id).toBe(t.id);
    // remove deletes the cloud record (resolving name -> id first).
    expect(deleteTemplate("farewell")).toBe(true);
    expect(getTemplate("farewell")).toBeNull();
    expect(listTemplates().some((x) => x.name === "farewell")).toBe(false);
  });

  test("createSequence POSTs to /v1/sequences and appears in cloud listSequences", () => {
    const s = createSequence({ name: "onboarding", description: "drip" });
    expect(s.id).toStartWith("s");
    expect(s.status).toBe("active");
    expect(listSequences().some((x) => x.name === "onboarding")).toBe(true);
  });

  test("createSendKey FAILS LOUD in cloud mode instead of a silent local mint", () => {
    expect(() => createSendKey("o1", "ci")).toThrow(/not supported yet|server-side mint/);
  });
});
