// Attachment-metadata inventory + bulk-search-underreport fix (MP-00034).
//
// Runs the REAL request pipeline (handleSelfHostedRequest) against a real
// Postgres (EMAILS_TEST_POSTGRES_URL). Proves:
//   - Step 2 regression: GET /v1/messages?search=<filename> now matches
//     attachment filename/content_type (previously body/subject only -> 0 hits).
//   - GET /v1/attachments streams full per-attachment metadata that matches the
//     per-ID truth, never leaks content_base64, and paginates exact-once
//     (no dup/skip, ordered, robust to a concurrent insert).
//   - POST /v1/attachments/batch returns metadata keyed by message_id, reports
//     unknown ids, and rejects empty / oversized / malformed batches (400).
//   - Tenant isolation: another tenant's attachments never surface.
//   - Malformed cursor -> 400.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import {
  AttachmentRepairIdempotencyConflictError,
  EmailsSelfHostedStore,
  MAX_ATTACHMENT_BATCH_IDS,
} from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import {
  processAttachmentRepairPage,
  type AttachmentRepairLedgerEntry,
  type AttachmentRepairResult,
} from "./attachment-repair.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import type { SelfHostedKeyStore } from "./keys.js";
import type { AuthMailerConfig } from "./auth/mailer.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const stubKeyStore: SelfHostedKeyStore = { insertMinted: async () => {}, list: async () => [], revoke: async () => false };
const MAILER: AuthMailerConfig = { from: "n@hasna.studio", verifyUrlBase: "x", resetUrlBase: "x", inviteUrlBase: "x", productName: "t" };

function makeDeps(): SelfHostedServiceDeps {
  return {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => `mock-${crypto.randomUUID()}` },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    authStore: new AuthStore(pgClient!),
    keyStore: stubKeyStore,
    signingSecret: SIGNING_SECRET,
    rateLimiter: new RateLimiter({ rules: {} }),
    mailer: MAILER,
    env: process.env,
  };
}

function reqOf(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
async function call(deps: SelfHostedServiceDeps, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await handleSelfHostedRequest(deps, reqOf(method, path, opts));
  return { status: res!.status, body: (await res!.json().catch(() => ({}))) as any };
}
async function makeTenant(slug: string) {
  const t = await pgClient!.one<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slug, slug]);
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, t.id]);
  return { tenantId: t.id, token: minted.token };
}

interface AttSpec { filename: string; content_type: string; size: number; sha256: string; content_base64: string }
function att(filename: string, contentType: string, payload: string, sha = ""): AttSpec {
  return { filename, content_type: contentType, size: payload.length, sha256: sha || filename.padEnd(64, "0").slice(0, 64), content_base64: Buffer.from(payload).toString("base64") };
}
async function importMsg(
  deps: SelfHostedServiceDeps,
  token: string,
  opts: { receivedAt: string; subject?: string; text?: string; attachments?: AttSpec[]; messageId?: string },
): Promise<string> {
  const res = await call(deps, "POST", "/v1/messages", {
    token,
    body: {
      from: "sender@ext.example",
      to: ["me@iso.example"],
      subject: opts.subject ?? "subject",
      text: opts.text ?? "body",
      received_at: opts.receivedAt,
      message_id: opts.messageId ?? `<${crypto.randomUUID()}@ext>`,
      attachments: opts.attachments ?? [],
    },
  });
  expect(res.status).toBe(201);
  return res.body.message.id as string;
}

async function makeRepairableInboundMessage(
  deps: SelfHostedServiceDeps,
  tenant: { tenantId: string; token: string },
  canonicalBucket: string,
  suffix: string,
): Promise<{ messageId: string; objectKey: string }> {
  const safeDay = 1 + [...suffix].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 28, 0);
  const receivedAt = `2026-11-${String(safeDay).padStart(2, "0")}T10:00:00.000Z`;
  const messageId = await importMsg(deps, tenant.token, {
    receivedAt,
    attachments: [{ ...att(`repair-${suffix}.txt`, "text/plain", `body-${suffix}`), content_base64: undefined } as never],
  });
  const objectKey = `repair-${suffix}`;
  await pgClient!.execute(
    `UPDATE messages
     SET source_id = $3,
         message_id = $3,
         attachments = (
           SELECT jsonb_agg(item.value - 'content_base64' ORDER BY item.ordinality)
           FROM jsonb_array_elements(attachments) WITH ORDINALITY AS item(value, ordinality)
         )
     WHERE tenant_id = $1::uuid AND id = $2`,
    [tenant.tenantId, messageId, objectKey],
  );
  expect(await deps.store.forTenant(tenant.tenantId)
    .recordInboundSourceProvenance({
      messageId,
      bucket: canonicalBucket,
      objectKey,
      rawSha256: "d".repeat(64),
      establishedVia: "canonical_replay",
    })).toBe("recorded");
  return { messageId, objectKey };
}

function attachmentRepairIdempotencyDigest(tenantId: string, key: string): string {
  return createHash("sha256")
    .update("emails:attachment-repair:idempotency:v1\0", "utf8")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(key, "utf8")
    .digest("hex");
}

/** Drain the full inventory with a small page size; return every item in order. */
async function drainInventory(deps: SelfHostedServiceDeps, token: string, limit: number): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const q = `/v1/attachments?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call(deps, "GET", q, { token });
    expect(page.status).toBe(200);
    items.push(...page.body.items);
    if (!page.body.next_cursor) return items;
    cursor = page.body.next_cursor;
  }
  throw new Error("inventory pagination did not terminate");
}
const keyOf = (i: any) => `${i.message_id}#${i.attachment_index}`;

beforeAll(async () => {
  if (!pgClient) return;
  await pgClient.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pgClient.execute("CREATE SCHEMA public");
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});
afterAll(async () => { await pgClient?.close(); });

describe.skipIf(!pgClient)("MP-00034 bulk search underreport fix", () => {
  it("GET /v1/messages?search=<filename> matches attachment-only signals (regression)", async () => {
    const deps = makeDeps();
    const t = await makeTenant("srch");
    // Term appears ONLY in an attachment filename — never in subject/body.
    await importMsg(deps, t.token, {
      receivedAt: "2026-01-01T00:00:00.000Z",
      subject: "quarterly numbers",
      text: "see the file",
      attachments: [att("invoice-Q3.pdf", "application/pdf", "PDF")],
    });
    // Decoy message with the same subject/body but NO matching attachment.
    await importMsg(deps, t.token, { receivedAt: "2026-01-02T00:00:00.000Z", subject: "quarterly numbers", text: "see the file" });

    const byFilename = await call(deps, "GET", `/v1/messages?search=invoice-Q3.pdf`, { token: t.token });
    expect(byFilename.status).toBe(200);
    expect(byFilename.body.messages.length).toBe(1);
    expect(byFilename.body.messages[0].attachment_count).toBe(1);

    // content_type is also part of the match surface.
    const byType = await call(deps, "GET", `/v1/messages?q=application/pdf`, { token: t.token });
    expect(byType.body.messages.length).toBe(1);

    // A term in no field still matches nothing (no false positives).
    const none = await call(deps, "GET", `/v1/messages?search=zzz-nonexistent-token`, { token: t.token });
    expect(none.body.messages.length).toBe(0);
  });
});

describe.skipIf(!pgClient)("MP-00034 attachment inventory route", () => {
  it("streams full metadata that matches the per-ID truth and never leaks content_base64", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-truth");
    const id = await importMsg(deps, t.token, {
      receivedAt: "2026-02-01T00:00:00.000Z",
      attachments: [
        att("a.pdf", "application/pdf", "AAAA", "a".repeat(64)),
        att("b.png", "image/png", "BB", "b".repeat(64)),
      ],
    });
    const inv = await call(deps, "GET", `/v1/attachments`, { token: t.token });
    expect(inv.status).toBe(200);
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    expect(mine.length).toBe(2);
    expect(mine.map((i: any) => i.attachment_index)).toEqual([0, 1]);
    expect(mine[0]).toMatchObject({ filename: "a.pdf", content_type: "application/pdf", size_bytes: 4, sha256: "a".repeat(64), direction: "inbound" });
    expect(mine[0].received_at).toBe("2026-02-01T00:00:00.000Z");
    for (const item of mine) expect("content_base64" in item).toBe(false);

    // The inventory count for this message equals the per-ID detail truth.
    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(mine.length).toBe(detail.body.message.attachments.length);
  });

  // #36: an inventory row proves METADATA exists, not bytes. On the live serve
  // the overwhelming majority of rows are legacy imports whose payloads were
  // never carried over, and GET /v1/messages/{id}/attachments/{n} answers 409
  // for them. A cataloging client that cannot tell the two apart either has to
  // attempt a download per row or silently records metadata-only rows as
  // complete. Inventory, batch and the per-ID detail must all agree, and must
  // agree with what the content route actually does.
  it("marks metadata-only rows unavailable across inventory, batch and detail — and the content route agrees", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-availability");
    const id = await importMsg(deps, t.token, {
      receivedAt: "2026-02-02T00:00:00.000Z",
      attachments: [
        // Metadata only — exactly the shape the legacy import produced.
        { filename: "legacy.pdf", content_type: "application/pdf", size: 2048, sha256: "c".repeat(64) } as never,
        att("stored.pdf", "application/pdf", "CCCC", "d".repeat(64)),
      ],
    });

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    expect(mine.map((i: any) => [i.filename, i.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);

    const batch = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [id] } });
    expect(batch.body.by_message_id[id].map((i: any) => [i.filename, i.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);

    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(detail.body.message.attachments.map((a: any) => [a.filename, a.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);
    for (const a of detail.body.message.attachments) expect("content_base64" in a).toBe(false);

    // The flag is a PREDICTION of the content route; prove it holds.
    const unavailable = await call(deps, "GET", `/v1/messages/${encodeURIComponent(id)}/attachments/0`, { token: t.token });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.code).toBe("attachment_content_unavailable");
    const available = await call(deps, "GET", `/v1/messages/${encodeURIComponent(id)}/attachments/1`, { token: t.token });
    expect(available.status).toBe(200);
    expect(available.body.attachment.content_base64).toBe(Buffer.from("CCCC").toString("base64"));
  });

  it("does not advertise byte-valid attachments with invalid download metadata as available", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-download-metadata");
    const payload = Buffer.from("hello").toString("base64");
    const id = await importMsg(deps, t.token, {
      receivedAt: "2026-02-03T00:00:00.000Z",
      attachments: [
        att("valid.txt", "text/plain", "hello"),
        { content_type: "text/plain", size: 5, content_base64: payload } as never,
        { filename: "", content_type: "text/plain", size: 5, content_base64: payload } as never,
        { filename: 42, content_type: "text/plain", size: 5, content_base64: payload } as never,
        { filename: "unsafe\u202Etxt.exe", content_type: "text/plain", size: 5, content_base64: payload } as never,
        { filename: "invalid-mime.txt", content_type: "text/plain; charset=utf-8", size: 5, content_base64: payload } as never,
        { filename: "missing-mime.txt", size: 5, content_base64: payload } as never,
      ],
    });

    const inventory = await call(deps, "GET", "/v1/attachments?limit=500", { token: t.token });
    expect(inventory.status).toBe(200);
    const items = inventory.body.items.filter((item: any) => item.message_id === id);
    expect(items.map((item: any) => item.content_available)).toEqual([true, false, false, false, false, false, false]);

    const batch = await call(deps, "POST", "/v1/attachments/batch", {
      token: t.token,
      body: { message_ids: [id] },
    });
    expect(batch.status).toBe(200);
    expect(batch.body.by_message_id[id].map((item: any) => item.content_available))
      .toEqual([true, false, false, false, false, false, false]);

    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(detail.status).toBe(200);
    expect(detail.body.message.attachments.map((item: any) => item.content_available))
      .toEqual([true, false, false, false, false, false, false]);

    const valid = await call(deps, "GET", `/v1/messages/${id}/attachments/0`, { token: t.token });
    expect(valid.status).toBe(200);
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const invalid = await call(deps, "GET", `/v1/messages/${id}/attachments/${index}`, { token: t.token });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe("invalid_attachment_payload");
    }
  });

  it("paginates exact-once across attachments — no dup/skip, correct order", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-keyset");
    // 5 messages, distinct received_at (fully determines cross-message order),
    // varied attachment counts incl. zero (a no-attachment message emits no rows).
    const specs = [
      { rx: "2026-03-05T00:00:00.000Z", n: 3 },
      { rx: "2026-03-04T00:00:00.000Z", n: 1 },
      { rx: "2026-03-03T00:00:00.000Z", n: 0 },
      { rx: "2026-03-02T00:00:00.000Z", n: 2 },
      { rx: "2026-03-01T00:00:00.000Z", n: 4 },
    ];
    const created: { id: string; rx: string; n: number }[] = [];
    for (const s of specs) {
      const attachments = Array.from({ length: s.n }, (_, k) => att(`f${k}.bin`, "application/octet-stream", `p${k}`));
      const id = await importMsg(deps, t.token, { receivedAt: s.rx, attachments });
      created.push({ id, rx: s.rx, n: s.n });
    }
    const totalAtt = specs.reduce((a, s) => a + s.n, 0); // 10

    // Expected order: received_at DESC, then attachment_index ASC.
    const expected: string[] = [];
    for (const c of [...created].sort((a, b) => (a.rx < b.rx ? 1 : -1))) {
      for (let k = 0; k < c.n; k++) expected.push(`${c.id}#${k}`);
    }

    for (const limit of [1, 2, 3, 10, 500]) {
      const items = await drainInventory(deps, t.token, limit);
      const keys = items.map(keyOf);
      expect(keys.length).toBe(totalAtt);
      expect(new Set(keys).size).toBe(totalAtt); // no duplicates
      expect(keys).toEqual(expected); // exact order, no skips
    }
  });

  it("paginates exact-once when messages share a sort_ts (id tie-break)", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-tiebreak");
    // Three messages with the SAME received_at -> same sort_ts, so cross-message
    // order falls entirely to the id DESC tie-break. Each has 2 attachments.
    const rx = "2026-08-08T08:08:08.000Z";
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await importMsg(deps, t.token, { receivedAt: rx, attachments: [att(`t${i}-0.bin`, "application/octet-stream", "a"), att(`t${i}-1.bin`, "application/octet-stream", "b")] }));
    }
    const expectedKeys = ids.flatMap((id) => [`${id}#0`, `${id}#1`]);
    for (const limit of [1, 2, 3, 5, 500]) {
      const items = await drainInventory(deps, t.token, limit);
      const keys = items.map(keyOf);
      expect(keys.length).toBe(6);
      expect(new Set(keys).size).toBe(6); // no dup
      expect(new Set(keys)).toEqual(new Set(expectedKeys)); // no skip
      // Each message's two attachments are adjacent and index-ascending (the
      // tie-break orders whole messages, then attachment_index within them).
      for (const id of ids) {
        const p0 = keys.indexOf(`${id}#0`);
        const p1 = keys.indexOf(`${id}#1`);
        expect(p1).toBe(p0 + 1);
      }
    }
  });

  it("a bigint-overflow attachment size does not 500 or wedge the scan; endpoints agree", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-bigsize");
    // size beyond bigint range is caller-supplied and stored unvalidated by the
    // import path — it must not crash the keyset scan (regression: it used to 500
    // and wedge every page from that row onward).
    const poison = await call(deps, "POST", "/v1/messages", {
      token: t.token,
      body: {
        from: "s@ext.example", to: ["me@iso.example"], subject: "s", text: "b",
        received_at: "2026-09-02T00:00:00.000Z", message_id: "<bigsize@ext>",
        attachments: [{ filename: "huge.bin", content_type: "application/octet-stream", size: 1e30, sha256: "e".repeat(64) }],
      },
    });
    expect(poison.status).toBe(201);
    const poisonId = poison.body.message.id;
    // An older message so the scan must page PAST the poison row.
    await importMsg(deps, t.token, { receivedAt: "2026-09-01T00:00:00.000Z", attachments: [att("after.bin", "application/octet-stream", "x")] });

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    expect(inv.status).toBe(200); // no 500
    const invPoison = inv.body.items.find((i: any) => i.message_id === poisonId);
    expect(invPoison).toBeDefined();
    expect(inv.body.items.some((i: any) => i.filename === "after.bin")).toBe(true); // not wedged

    const batch = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [poisonId] } });
    expect(batch.status).toBe(200);
    // The two endpoints normalize size identically (no null-vs-number skew).
    expect(invPoison.size_bytes).toBe(batch.body.by_message_id[poisonId][0].size_bytes);
  });

  it("last page yields next_cursor=null; an empty inventory returns [] and null", async () => {
    const deps = makeDeps();
    const empty = await makeTenant("inv-empty");
    const e = await call(deps, "GET", `/v1/attachments?limit=50`, { token: empty.token });
    expect(e.body.items).toEqual([]);
    expect(e.body.next_cursor).toBeNull();

    const t = await makeTenant("inv-exact");
    await importMsg(deps, t.token, { receivedAt: "2026-04-01T00:00:00.000Z", attachments: [att("x.txt", "text/plain", "x"), att("y.txt", "text/plain", "y")] });
    // limit exactly equals the row count: a full page still exposes a cursor,
    // and the follow-up page is empty with a null cursor (no over-read).
    const p1 = await call(deps, "GET", `/v1/attachments?limit=2`, { token: t.token });
    expect(p1.body.items.length).toBe(2);
    expect(p1.body.next_cursor).not.toBeNull();
    const p2 = await call(deps, "GET", `/v1/attachments?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`, { token: t.token });
    expect(p2.body.items).toEqual([]);
    expect(p2.body.next_cursor).toBeNull();
  });

  it("keeps index alignment and never errors on malformed attachment elements", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-malformed");
    // Element 1 is a bare string (not an object); element 2 has a fractional
    // size. Both must still occupy their array position so attachment_index
    // stays aligned with GET /v1/messages/{id}/attachments/{index}; the
    // fractional value is not a byte count and must remain unknown.
    const res = await call(deps, "POST", "/v1/messages", {
      token: t.token,
      body: {
        from: "s@ext.example", to: ["me@iso.example"], subject: "s", text: "b",
        received_at: "2026-05-20T00:00:00.000Z", message_id: "<malformed@ext>",
        attachments: [
          att("good.pdf", "application/pdf", "G"),
          "i-am-not-an-object",
          { filename: "frac.bin", content_type: "application/octet-stream", size: 1024.9, sha256: "d".repeat(64) },
        ],
      },
    });
    expect(res.status).toBe(201);
    const id = res.body.message.id;

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    expect(inv.status).toBe(200);
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    // All three positions surface; the malformed one is not silently dropped.
    expect(mine.map((i: any) => i.attachment_index)).toEqual([0, 1, 2]);
    expect(mine.map((i: any) => i.content_available)).toEqual([true, false, false]);
    expect(mine[0].filename).toBe("good.pdf");
    expect(mine[1]).toMatchObject({ filename: null, content_type: null, size_bytes: null, sha256: null });
    expect(mine[2].size_bytes).toBeNull();

    // Inventory row count matches the per-ID truth (jsonb_array_length).
    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(mine.length).toBe(detail.body.message.attachments.length);
    expect(detail.body.message.attachments.map((item: any) => item.content_available))
      .toEqual([true, false, false]);
    expect(detail.body.message.attachments[1]).toEqual({
      content_available: false,
    });
  });

  it("reports truthful content availability and keeps legacy human-readable sizes unknown", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-availability-strict");
    const res = await call(deps, "POST", "/v1/messages", {
      token: t.token,
      body: {
        from: "s@ext.example",
        to: ["me@iso.example"],
        subject: "legacy attachment metadata",
        text: "body",
        received_at: "2026-05-21T00:00:00.000Z",
        message_id: "<legacy-availability@ext>",
        attachments: [
          att("stored.txt", "text/plain", "hello", "a".repeat(64)),
          {
            filename: "stored-string-size.txt",
            content_type: "text/plain",
            size: "5",
            content_base64: Buffer.from("hello").toString("base64"),
          },
          {
            filename: "legacy.pdf",
            content_type: "application/pdf",
            size: "12.4 KB",
            sha256: null,
          },
          {
            filename: "unknown.bin",
            content_type: "application/octet-stream",
            size: " ",
          },
          {
            filename: "leading-zero.bin",
            content_type: "application/octet-stream",
            size: "05",
            content_base64: Buffer.from("hello").toString("base64"),
          },
          {
            filename: "fractional.bin",
            content_type: "application/octet-stream",
            size: 1.5,
            content_base64: Buffer.from("x").toString("base64"),
          },
          {
            filename: "malformed-base64.bin",
            content_type: "application/octet-stream",
            size: 3,
            content_base64: "not*base64",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const id = res.body.message.id;

    const inv = await call(deps, "GET", "/v1/attachments?limit=500", { token: t.token });
    expect(inv.status).toBe(200);
    const mine = inv.body.items.filter((item: any) => item.message_id === id);
    expect(mine).toEqual([
      expect.objectContaining({
        attachment_index: 0,
        filename: "stored.txt",
        size_bytes: 5,
        content_available: true,
      }),
      expect.objectContaining({
        attachment_index: 1,
        filename: "stored-string-size.txt",
        size_bytes: 5,
        content_available: true,
      }),
      expect.objectContaining({
        attachment_index: 2,
        filename: "legacy.pdf",
        size_bytes: null,
        content_available: false,
      }),
      expect.objectContaining({
        attachment_index: 3,
        filename: "unknown.bin",
        size_bytes: null,
        content_available: false,
      }),
      expect.objectContaining({
        attachment_index: 4,
        filename: "leading-zero.bin",
        size_bytes: null,
        content_available: false,
      }),
      expect.objectContaining({
        attachment_index: 5,
        filename: "fractional.bin",
        size_bytes: null,
        content_available: false,
      }),
      expect.objectContaining({
        attachment_index: 6,
        filename: "malformed-base64.bin",
        size_bytes: 3,
        content_available: false,
      }),
    ]);
    expect(JSON.stringify(inv.body)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(inv.body)).not.toContain("content_base64");

    const batch = await call(deps, "POST", "/v1/attachments/batch", {
      token: t.token,
      body: { message_ids: [id] },
    });
    expect(batch.body.by_message_id[id].map((item: any) => ({
      size_bytes: item.size_bytes,
      content_available: item.content_available,
    }))).toEqual([
      { size_bytes: 5, content_available: true },
      { size_bytes: 5, content_available: true },
      { size_bytes: null, content_available: false },
      { size_bytes: null, content_available: false },
      { size_bytes: null, content_available: false },
      { size_bytes: null, content_available: false },
      { size_bytes: 3, content_available: false },
    ]);
    expect(JSON.stringify(batch.body)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(batch.body)).not.toContain("content_base64");

    const canonicalStringSize = await call(
      deps,
      "GET",
      `/v1/messages/${id}/attachments/1`,
      { token: t.token },
    );
    expect(canonicalStringSize.status).toBe(200);
    expect(canonicalStringSize.body.attachment).toMatchObject({
      filename: "stored-string-size.txt",
      size: 5,
      content_base64: Buffer.from("hello").toString("base64"),
    });

    const unavailable = await call(deps, "GET", `/v1/messages/${id}/attachments/2`, { token: t.token });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body).toEqual({
      error: "attachment content is not stored",
      code: "attachment_content_unavailable",
      attachment: {
        filename: "legacy.pdf",
        content_type: "application/pdf",
        size: null,
      },
    });

    const malformed = await call(deps, "GET", `/v1/messages/${id}/attachments/6`, { token: t.token });
    expect(malformed.status).toBe(422);
    expect(malformed.body.code).toBe("invalid_attachment_payload");
  });

  it("a concurrent insert ahead of the cursor does not dup or skip the in-flight scan", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-concurrent");
    const base: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await importMsg(deps, t.token, { receivedAt: `2026-05-0${i + 1}T00:00:00.000Z`, attachments: [att(`b${i}.bin`, "application/octet-stream", `b${i}`)] });
      base.push(id);
    }
    // Page 1 (limit 2) then insert a NEWER message (sorts to the very front,
    // i.e. ahead of the cursor / already passed).
    const p1 = await call(deps, "GET", `/v1/attachments?limit=2`, { token: t.token });
    const seen = p1.body.items.map(keyOf);
    const intruderId = await importMsg(deps, t.token, { receivedAt: "2026-05-09T00:00:00.000Z", attachments: [att("intruder.bin", "application/octet-stream", "zzz")] });

    let cursor = p1.body.next_cursor;
    while (cursor) {
      const page = await call(deps, "GET", `/v1/attachments?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: t.token });
      seen.push(...page.body.items.map(keyOf));
      cursor = page.body.next_cursor;
    }
    // Every original attachment appears exactly once; the ahead-of-cursor
    // intruder does NOT corrupt the in-flight scan (it was already "passed").
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of base) expect(seen).toContain(`${id}#0`);
    expect(seen).not.toContain(`${intruderId}#0`);
    // A fresh scan started now DOES include the intruder (at the front).
    const fresh = await drainInventory(deps, t.token, 3);
    expect(fresh.map(keyOf)).toContain(`${intruderId}#0`);
    expect(fresh[0].message_id).toBe(intruderId);
  });
});

describe.skipIf(!pgClient)("MP-00034 attachment batch-by-ids route", () => {
  it("returns metadata keyed by message_id, reports unknown ids, excludes content_base64", async () => {
    const deps = makeDeps();
    const t = await makeTenant("batch-ok");
    const id1 = await importMsg(deps, t.token, { receivedAt: "2026-06-01T00:00:00.000Z", attachments: [att("r.pdf", "application/pdf", "R"), att("s.png", "image/png", "S")] });
    const id2 = await importMsg(deps, t.token, { receivedAt: "2026-06-02T00:00:00.000Z", attachments: [] });
    const bogus = crypto.randomUUID();

    const res = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [id1, id2, bogus] } });
    expect(res.status).toBe(200);
    expect(res.body.max_batch_size).toBe(MAX_ATTACHMENT_BATCH_IDS);
    expect(res.body.by_message_id[id1].length).toBe(2);
    expect(res.body.by_message_id[id1][0]).toEqual({ attachment_index: 0, filename: "r.pdf", content_type: "application/pdf", size_bytes: 1, sha256: "r.pdf".padEnd(64, "0").slice(0, 64), content_available: true });
    expect("content_base64" in res.body.by_message_id[id1][0]).toBe(false);
    expect(res.body.by_message_id[id2]).toEqual([]);
    expect(res.body.unknown_ids).toEqual([bogus]);
  });

  it("rejects empty, oversized, and malformed message_ids with 400", async () => {
    const deps = makeDeps();
    const t = await makeTenant("batch-bad");
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [] } })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: "nope" } })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: {} })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [123] } })).status).toBe(400);
    const oversized = Array.from({ length: MAX_ATTACHMENT_BATCH_IDS + 1 }, () => crypto.randomUUID());
    const big = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: oversized } });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe("batch_too_large");
    expect(big.body.max_batch_size).toBe(MAX_ATTACHMENT_BATCH_IDS);
  });
});

describe.skipIf(!pgClient)("MP-00034 tenant isolation + malformed cursor", () => {
  it("another tenant's attachments never surface via inventory or batch", async () => {
    const deps = makeDeps();
    const a = await makeTenant("iso-att-a");
    const b = await makeTenant("iso-att-b");
    const aId = await importMsg(deps, a.token, { receivedAt: "2026-07-01T00:00:00.000Z", attachments: [att("a-secret.pdf", "application/pdf", "A")] });
    const bId = await importMsg(deps, b.token, { receivedAt: "2026-07-02T00:00:00.000Z", attachments: [att("b-secret.pdf", "application/pdf", "B")] });

    const aInv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: a.token });
    const aMsgIds = new Set(aInv.body.items.map((i: any) => i.message_id));
    expect(aMsgIds.has(aId)).toBe(true);
    expect(aMsgIds.has(bId)).toBe(false);
    expect(aInv.body.items.some((i: any) => i.filename === "b-secret.pdf")).toBe(false);

    // A asking for B's id gets it back only as unknown — never its metadata.
    const cross = await call(deps, "POST", `/v1/attachments/batch`, { token: a.token, body: { message_ids: [bId, aId] } });
    expect(cross.body.by_message_id[bId]).toBeUndefined();
    expect(cross.body.unknown_ids).toEqual([bId]);
    expect(cross.body.by_message_id[aId].length).toBe(1);
  });

  it("a malformed cursor is rejected with 400", async () => {
    const deps = makeDeps();
    const t = await makeTenant("bad-cursor");
    for (const bad of ["not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ ts: "nope", id: "x", idx: 0 })).toString("base64url")]) {
      const res = await call(deps, "GET", `/v1/attachments?cursor=${encodeURIComponent(bad)}`, { token: t.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_cursor");
    }
  });

  it("an invalid direction is rejected instead of silently disabling the filter", async () => {
    const deps = makeDeps();
    const t = await makeTenant("bad-direction");
    const response = await call(deps, "GET", "/v1/attachments?direction=sideways", {
      token: t.token,
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "direction must be inbound or outbound",
      code: "invalid_direction",
    });
  });
});

describe.skipIf(!pgClient)("checkpointed legacy attachment repair ledger", () => {
  it("returns the documented 400 for malformed repair ids before PostgreSQL UUID casts", async () => {
    const deps = makeDeps();
    const tenant = await makeTenant("repair-ledger-invalid-id");

    const read = await call(deps, "GET", "/v1/attachments/repairs/not-a-uuid", {
      token: tenant.token,
    });
    const resume = await call(
      deps,
      "POST",
      "/v1/attachments/repairs/not-a-uuid/resume",
      { token: tenant.token, body: { limit: 1 } },
    );

    for (const response of [read, resume]) {
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "attachment repair id must be a UUID",
        code: "invalid_attachment_repair_id",
      });
    }
  });

  it("creates attachment repair idempotency alias schema objects with tenant-scoped RLS", async () => {
    const table = await pgClient!.one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE oid = 'public.attachment_repair_idempotency_keys'::regclass`,
    );
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policy = await pgClient!.one<{ qual: string; with_check: string }>(
      `SELECT pg_get_expr(polqual, polrelid) AS qual,
              pg_get_expr(polwithcheck, polrelid) AS with_check
       FROM pg_policy
       WHERE polrelid = 'public.attachment_repair_idempotency_keys'::regclass
         AND polname = 'attachment_repair_idempotency_keys_tenant_isolation'`,
    );
    expect(policy.qual).toContain("app.current_tenant");
    expect(policy.with_check).toContain("app.current_tenant");

    const indexNames = await pgClient!.many<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'attachment_repair_idempotency_keys'`,
    );
    const names = indexNames.map((row) => row.indexname);
    expect(names).toContain("attachment_repair_idempotency_keys_request_hash_idx");
    expect(names).toContain("attachment_repair_idempotency_keys_run_id_idx");
  });

  it("matches an exact repair manifest without mutating runs or idempotency aliases", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-manifest-match";
    const tenantA = await makeTenant("repair-manifest-match-a");
    const tenantB = await makeTenant("repair-manifest-match-b");
    const storeA = deps.store.forTenant(tenantA.tenantId);
    const storeB = deps.store.forTenant(tenantB.tenantId);
    const message = await makeRepairableInboundMessage(
      deps,
      tenantA,
      canonicalBucket,
      "manifest-match",
    );
    const entries = [{
      object_key: message.objectKey,
      recipients: ["one@example.test"],
      canary_message_ids: [message.messageId],
    }];
    const run = await storeA.createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-manifest-match-key",
      canonicalBucket,
      apply: false,
      entries,
    });
    const counts = async (tenantId: string) => pgClient!.one<{
      run_count: number;
      alias_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int
          FROM attachment_repair_runs
          WHERE tenant_id = $1::uuid) AS run_count,
         (SELECT count(*)::int
          FROM attachment_repair_idempotency_keys
          WHERE tenant_id = $1::uuid) AS alias_count`,
      [tenantId],
    );
    const beforeA = await counts(tenantA.tenantId);
    const beforeB = await counts(tenantB.tenantId);

    expect(await storeA.attachmentRepairRunMatchesManifest(run.id, {
      canonicalBucket,
      apply: false,
      entries,
    })).toBe(true);
    expect(await storeA.attachmentRepairRunMatchesManifest(run.id, {
      canonicalBucket,
      apply: false,
      entries: [{
        ...entries[0]!,
        recipients: ["different@example.test"],
      }],
    })).toBe(false);
    expect(await storeA.attachmentRepairRunMatchesManifest(run.id, {
      canonicalBucket: `${canonicalBucket}-different`,
      apply: false,
      entries,
    })).toBe(false);
    expect(await storeA.attachmentRepairRunMatchesManifest(run.id, {
      canonicalBucket,
      apply: true,
      entries,
    })).toBe(false);
    expect(await storeB.attachmentRepairRunMatchesManifest(run.id, {
      canonicalBucket,
      apply: false,
      entries,
    })).toBe(false);

    expect(await counts(tenantA.tenantId)).toEqual(beforeA);
    expect(await counts(tenantB.tenantId)).toEqual(beforeB);
  });

  it("binds alternate idempotency keys to an existing request and rejects conflicting manifests", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-alias-binds";
    const tenant = await makeTenant("repair-alias-binds");
    const store = deps.store.forTenant(tenant.tenantId);
    const first = await makeRepairableInboundMessage(deps, tenant, canonicalBucket, "A");
    const second = await makeRepairableInboundMessage(deps, tenant, canonicalBucket, "B");

    const base = await store.createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-run-bound",
      canonicalBucket,
      entries: [{
        object_key: first.objectKey,
        recipients: ["one@example.test"],
        canary_message_ids: [first.messageId],
      }],
    });
    const aliased = await store.createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-key-b",
      canonicalBucket,
      entries: [{
        object_key: first.objectKey,
        recipients: ["one@example.test"],
        canary_message_ids: [first.messageId],
      }],
    });
    expect(aliased.id).toBe(base.id);

    const repeated = await store.createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-key-b",
      canonicalBucket,
      entries: [{
        object_key: first.objectKey,
        recipients: ["one@example.test"],
        canary_message_ids: [first.messageId],
      }],
    });
    expect(repeated.id).toBe(base.id);

    const aliasDigest = attachmentRepairIdempotencyDigest(tenant.tenantId, "repair-key-b");
    const aliasRow = await pgClient!.one<{ run_id: string; request_hash: string }>(
      `SELECT run_id::text AS run_id, request_hash
       FROM attachment_repair_idempotency_keys
       WHERE tenant_id = $1::uuid AND idempotency_key_hash = $2`,
      [tenant.tenantId, aliasDigest],
    );
    expect(aliasRow.run_id).toBe(base.id);
    expect(aliasRow.request_hash).toHaveLength(64);

    await expect(store.createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-key-b",
      canonicalBucket,
      entries: [{
        object_key: second.objectKey,
        recipients: ["two@example.test"],
        canary_message_ids: [second.messageId],
      }],
    })).rejects.toBeInstanceOf(AttachmentRepairIdempotencyConflictError);
  });

  it("isolates attachment-repair idempotency aliases by tenant", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-alias-cross-tenant";
    const tenantA = await makeTenant("repair-alias-tenant-a");
    const tenantB = await makeTenant("repair-alias-tenant-b");
    const storeA = deps.store.forTenant(tenantA.tenantId);
    const storeB = deps.store.forTenant(tenantB.tenantId);
    const messageA = await makeRepairableInboundMessage(deps, tenantA, canonicalBucket, "A");
    const messageB = await makeRepairableInboundMessage(deps, tenantB, canonicalBucket, "B");
    const sharedKey = "repair-key-cross-tenant";

    const aRun = await storeA.createOrGetAttachmentRepairRun({
      idempotencyKey: sharedKey,
      canonicalBucket,
      entries: [{
        object_key: messageA.objectKey,
        recipients: ["a@example.test"],
        canary_message_ids: [messageA.messageId],
      }],
    });
    const bRun = await storeB.createOrGetAttachmentRepairRun({
      idempotencyKey: sharedKey,
      canonicalBucket,
      entries: [{
        object_key: messageB.objectKey,
        recipients: ["b@example.test"],
        canary_message_ids: [messageB.messageId],
      }],
    });
    expect(aRun.id).not.toBe(bRun.id);

    const aDigest = attachmentRepairIdempotencyDigest(tenantA.tenantId, sharedKey);
    const bDigest = attachmentRepairIdempotencyDigest(tenantB.tenantId, sharedKey);
    const aliases = await pgClient!.many<{ tenant_id: string; run_id: string }>(
      `SELECT tenant_id::text AS tenant_id, run_id::text AS run_id
       FROM attachment_repair_idempotency_keys
       WHERE tenant_id IN ($1::uuid, $2::uuid)
         AND idempotency_key_hash IN ($3, $4)`,
      [tenantA.tenantId, tenantB.tenantId, aDigest, bDigest],
    );
    const byTenant = new Map(aliases.map((alias) => [alias.tenant_id, alias.run_id]));
    expect(byTenant.get(tenantA.tenantId)).toBe(aRun.id);
    expect(byTenant.get(tenantB.tenantId)).toBe(bRun.id);
  });

  it("keeps concurrent alternate-key races deterministic and persistent", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-alias-race";
    const tenant = await makeTenant("repair-alias-race");
    const store = deps.store.forTenant(tenant.tenantId);
    const first = await makeRepairableInboundMessage(deps, tenant, canonicalBucket, "one");
    const second = await makeRepairableInboundMessage(deps, tenant, canonicalBucket, "two");
    const key = "repair-key-race";

    const manifestOne = {
      idempotencyKey: key,
      canonicalBucket,
      entries: [{
        object_key: first.objectKey,
        recipients: ["one@example.test"],
        canary_message_ids: [first.messageId],
      }],
    };
    const manifestTwo = {
      idempotencyKey: key,
      canonicalBucket,
      entries: [{
        object_key: second.objectKey,
        recipients: ["two@example.test"],
        canary_message_ids: [second.messageId],
      }],
    };
    const settled = await Promise.allSettled([
      store.createOrGetAttachmentRepairRun(manifestOne),
      store.createOrGetAttachmentRepairRun(manifestTwo),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);

    const winnerIndex = settled.findIndex((result) => result.status === "fulfilled");
    const winnerManifest = winnerIndex === 0 ? manifestOne : manifestTwo;
    const loserManifest = winnerIndex === 0 ? manifestTwo : manifestOne;
    const winnerId = settled[winnerIndex]!.status === "fulfilled" ? settled[winnerIndex]!.value.id : "";
    const winner = await store.createOrGetAttachmentRepairRun(winnerManifest);
    expect(winner.id).toBe(winnerId);
    await expect(store.createOrGetAttachmentRepairRun(loserManifest))
      .rejects.toBeInstanceOf(AttachmentRepairIdempotencyConflictError);
  });

  it("rejects nonexistent, foreign-tenant, zero-attachment, and complete-only canaries at manifest creation", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-manifest-validation";
    deps.env = { ...process.env, EMAILS_INGEST_S3_BUCKET: canonicalBucket };
    const tenantA = await makeTenant("repair-manifest-a");
    const tenantB = await makeTenant("repair-manifest-b");
    const zeroId = await importMsg(deps, tenantA.token, {
      receivedAt: "2026-10-03T00:00:00.000Z",
      attachments: [],
    });
    const completeId = await importMsg(deps, tenantA.token, {
      receivedAt: "2026-10-04T00:00:00.000Z",
      attachments: [att("complete.txt", "text/plain", "done")],
    });
    const foreignId = await importMsg(deps, tenantB.token, {
      receivedAt: "2026-10-05T00:00:00.000Z",
      attachments: [{ ...att("foreign.txt", "text/plain", "old"), content_base64: undefined } as never],
    });
    const bindings = [
      { tenant: tenantA, messageId: zeroId, objectKey: "source/zero" },
      { tenant: tenantA, messageId: completeId, objectKey: "source/complete" },
      { tenant: tenantB, messageId: foreignId, objectKey: "source/foreign" },
    ] as const;
    for (const binding of bindings) {
      await pgClient!.execute(
        `UPDATE messages
         SET source_id = $3, message_id = $3
         WHERE tenant_id = $1::uuid AND id = $2`,
        [binding.tenant.tenantId, binding.messageId, binding.objectKey],
      );
      expect(await deps.store.forTenant(binding.tenant.tenantId)
        .recordInboundSourceProvenance({
          messageId: binding.messageId,
          bucket: canonicalBucket,
          objectKey: binding.objectKey,
          rawSha256: "b".repeat(64),
          establishedVia: "canonical_replay",
        })).toBe("recorded");
    }

    const cases = [
      {
        name: "missing",
        objectKey: "source/missing",
        messageId: crypto.randomUUID(),
        error: /exactly match tenant-scoped canonical object bindings/i,
      },
      {
        name: "foreign",
        objectKey: "source/foreign",
        messageId: foreignId,
        error: /exactly match tenant-scoped canonical object bindings/i,
      },
      {
        name: "zero",
        objectKey: "source/zero",
        messageId: zeroId,
        error: /repairable attachment inventory/i,
      },
      {
        name: "complete",
        objectKey: "source/complete",
        messageId: completeId,
        error: /repairable attachment inventory/i,
      },
    ];
    for (const scenario of cases) {
      const response = await call(deps, "POST", "/v1/attachments/repairs", {
        token: tenantA.token,
        body: {
          idempotency_key: `manifest-validation-${scenario.name}`,
          entries: [{
            object_key: scenario.objectKey,
            recipients: ["one@example.test"],
            canary_message_ids: [scenario.messageId],
          }],
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("invalid_repair_manifest");
      expect(response.body.error).toMatch(scenario.error);
      expect(JSON.stringify(response.body)).not.toContain(foreignId);
    }
  });

  it("is tenant isolated, idempotent, ordered, resumable, and reconciles terminal totals", async () => {
    const deps = makeDeps();
    const tenantA = await makeTenant("repair-ledger-a");
    const tenantB = await makeTenant("repair-ledger-b");
    const canonicalBucket = "repair-ledger-canonical";
    const firstId = await importMsg(deps, tenantA.token, {
      receivedAt: "2026-10-02T00:00:00.000Z",
      attachments: [
        att("one.txt", "text/plain", "one"),
        att("two.txt", "text/plain", "two"),
      ],
    });
    const secondId = await importMsg(deps, tenantA.token, {
      receivedAt: "2026-10-01T00:00:00.000Z",
      attachments: [att("three.txt", "text/plain", "three")],
    });
    const storeA = deps.store.forTenant(tenantA.tenantId);
    const storeB = deps.store.forTenant(tenantB.tenantId);
    for (const [messageId, objectKey] of [
      [firstId, "source/repair-one"],
      [secondId, "source/repair-two"],
    ] as const) {
      await pgClient!.execute(
        `UPDATE messages
         SET source_id = $3,
             message_id = $3,
             attachments = (
               SELECT jsonb_agg(
                 CASE
                   WHEN $3 = 'source/repair-one' AND item.ordinality = 1
                     THEN item.value
                   ELSE item.value - 'content_base64'
                 END
                 ORDER BY item.ordinality
               )
               FROM jsonb_array_elements(attachments) WITH ORDINALITY AS item(value, ordinality)
             )
         WHERE tenant_id = $1::uuid AND id = $2`,
        [tenantA.tenantId, messageId, objectKey],
      );
      expect(await storeA.recordInboundSourceProvenance({
        messageId,
        bucket: canonicalBucket,
        objectKey,
        rawSha256: "a".repeat(64),
        establishedVia: "canonical_replay",
      })).toBe("recorded");
    }
    const manifest = {
      idempotencyKey: "legacy-repair-integration-1",
      canonicalBucket,
      entries: [
        {
          object_key: "source/repair-one",
          recipients: ["one@example.test"],
          canary_message_ids: [firstId],
        },
        {
          object_key: "source/repair-two",
          recipients: ["two@example.test"],
          canary_message_ids: [secondId],
        },
      ],
    };

    const created = await storeA.createOrGetAttachmentRepairRun(manifest);
    expect(created).toMatchObject({
      apply: false,
      status: "pending",
      entry_total: 2,
      inventory_total: 2,
      repaired: 0,
      would_repair: 0,
      unavailable: 0,
      pending: 2,
      retrying: 0,
      entry_pending: 2,
      checkpoint: 0,
    });
    const replay = await storeA.createOrGetAttachmentRepairRun(manifest);
    expect(replay.id).toBe(created.id);
    const freshKeyReplay = await storeA.createOrGetAttachmentRepairRun({
      ...manifest,
      idempotencyKey: "legacy-repair-integration-fresh-key",
    });
    expect(freshKeyReplay.id).toBe(created.id);
    await expect(storeA.createOrGetAttachmentRepairRun({
      ...manifest,
      entries: [manifest.entries[0]!],
    })).rejects.toThrow(/idempotency.*different manifest/i);
    expect(await storeB.getAttachmentRepairRun(created.id)).toBeNull();

    const firstPage = await storeA.listPendingAttachmentRepairEntries(created.id, 1);
    expect(firstPage.map((entry) => entry.position)).toEqual([0]);
    expect(JSON.stringify(firstPage)).not.toContain("content_base64");
    const firstClaim = await storeA.claimAttachmentRepairEntry(created.id, 60_000);
    expect(firstClaim).toMatchObject({ position: 0, attempts: 1 });
    await storeA.recordAttachmentRepairEntryOutcome(
      created.id,
      0,
      firstClaim!.claim_token!,
      "pending",
      "retryable_repair_error",
    );
    const retryable = await storeA.listPendingAttachmentRepairEntries(created.id, 2);
    expect(retryable[0]?.position).toBe(1);
    expect(retryable.find((entry) => entry.position === 0)).toMatchObject({
      position: 0,
      status: "pending",
      attempts: 1,
      last_error_code: "retryable_repair_error",
    });
    expect(retryable.find((entry) => entry.position === 0)?.last_attempt_at).not.toBeNull();
    expect(await storeA.getAttachmentRepairRun(created.id)).toMatchObject({
      status: "pending",
      pending: 2,
      retrying: 1,
      entry_pending: 2,
      entry_retrying: 1,
      attempts: 1,
      checkpoint: 0,
    });
    await pgClient!.execute(
      `UPDATE attachment_repair_entries
       SET next_attempt_at = now() - interval '1 second'
       WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND position = 0`,
      [tenantA.tenantId, created.id],
    );
    const retryClaim = await storeA.claimAttachmentRepairEntry(created.id, 60_000);
    expect(retryClaim).toMatchObject({ position: 0, attempts: 2 });
    await storeA.recordAttachmentRepairEntryOutcome(
      created.id,
      0,
      retryClaim!.claim_token!,
      "repaired",
    );
    expect(await storeA.getAttachmentRepairRun(created.id)).toMatchObject({
      status: "pending",
      repaired: 1,
      would_repair: 0,
      unavailable: 0,
      pending: 1,
      entry_repaired: 1,
      entry_pending: 1,
      entry_retrying: 0,
      attempts: 2,
      checkpoint: 1,
    });

    const resumed = await storeA.listPendingAttachmentRepairEntries(created.id, 1);
    expect(resumed.map((entry) => entry.position)).toEqual([1]);
    const terminalClaim = await storeA.claimAttachmentRepairEntry(created.id, 60_000);
    expect(terminalClaim).toMatchObject({ position: 1, attempts: 1 });
    await storeA.recordAttachmentRepairEntryOutcome(
      created.id,
      1,
      terminalClaim!.claim_token!,
      "unavailable",
    );
    const terminal = await storeA.getAttachmentRepairRun(created.id);
    expect(terminal).toMatchObject({
      status: "completed",
      inventory_total: 2,
      repaired: 1,
      would_repair: 0,
      unavailable: 1,
      pending: 0,
      entry_repaired: 1,
      entry_unavailable: 1,
      entry_pending: 0,
      entry_retrying: 0,
      attempts: 3,
      checkpoint: 2,
    });
    expect(terminal!.repaired + terminal!.would_repair + terminal!.unavailable + terminal!.pending)
      .toBe(terminal!.inventory_total);
    expect(await storeA.listPendingAttachmentRepairEntries(created.id, 1)).toEqual([]);
  });

  it("enforces tenant-local active and durable quotas and recovers an active slot after completion", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-quota-canonical";
    const tenantA = await makeTenant("repair-quota-a");
    const tenantB = await makeTenant("repair-quota-b");
    const constrained = new EmailsSelfHostedStore(pgClient!, {
      attachmentRepairPolicy: {
        maxActiveRunsPerTenant: 1,
        maxLedgerRunsPerTenant: 2,
        maxLedgerEntriesPerTenant: 4,
        runByteBudget: 1024,
        runTimeBudgetMs: 60_000,
      },
    });
    const storeA = constrained.forTenant(tenantA.tenantId);
    const storeB = constrained.forTenant(tenantB.tenantId);

    const fixture = async (
      tenant: { tenantId: string; token: string },
      store: ReturnType<EmailsSelfHostedStore["forTenant"]>,
      suffix: string,
    ) => {
      const messageId = await importMsg(deps, tenant.token, {
        receivedAt: `2026-12-${suffix.padStart(2, "0")}T00:00:00.000Z`,
        attachments: [{ ...att(`${suffix}.txt`, "text/plain", suffix), content_base64: undefined } as never],
      });
      const objectKey = `source/quota-${tenant.tenantId}-${suffix}`;
      await pgClient!.execute(
        `UPDATE messages SET source_id = $3, message_id = $3
         WHERE tenant_id = $1::uuid AND id = $2`,
        [tenant.tenantId, messageId, objectKey],
      );
      expect(await store.recordInboundSourceProvenance({
        messageId,
        bucket: canonicalBucket,
        objectKey,
        rawSha256: "d".repeat(64),
        establishedVia: "canonical_replay",
      })).toBe("recorded");
      return {
        idempotencyKey: `quota-${tenant.tenantId}-${suffix}`,
        canonicalBucket,
        entries: [{
          object_key: objectKey,
          recipients: [`${suffix}@example.test`],
          canary_message_ids: [messageId],
        }],
      };
    };

    const a1Manifest = await fixture(tenantA, storeA, "1");
    const a2Manifest = await fixture(tenantA, storeA, "2");
    const a3Manifest = await fixture(tenantA, storeA, "3");
    const b1Manifest = await fixture(tenantB, storeB, "4");
    const a1 = await storeA.createOrGetAttachmentRepairRun(a1Manifest);

    await expect(storeA.createOrGetAttachmentRepairRun(a2Manifest))
      .rejects.toMatchObject({ code: "active_runs", retryable: true });
    await expect(storeB.createOrGetAttachmentRepairRun(b1Manifest)).resolves.toMatchObject({
      tenant_id: tenantB.tenantId,
    });

    const a1Claim = await storeA.claimAttachmentRepairEntry(a1.id, 60_000);
    await storeA.recordAttachmentRepairEntryOutcome(
      a1.id,
      a1Claim!.position,
      a1Claim!.claim_token!,
      "unavailable",
      "terminal_repair_error",
      0,
    );
    const a2 = await storeA.createOrGetAttachmentRepairRun(a2Manifest);
    const a2Claim = await storeA.claimAttachmentRepairEntry(a2.id, 60_000);
    await storeA.recordAttachmentRepairEntryOutcome(
      a2.id,
      a2Claim!.position,
      a2Claim!.claim_token!,
      "unavailable",
      "terminal_repair_error",
      0,
    );
    await expect(storeA.createOrGetAttachmentRepairRun(a3Manifest))
      .rejects.toMatchObject({ code: "ledger_runs", retryable: false });
  });

  it("charges byte reservations durably and terminalizes byte/time budget exhaustion for operator action", async () => {
    const deps = makeDeps();
    const canonicalBucket = "repair-budget-canonical";
    const tenant = await makeTenant("repair-budget");
    const constrained = new EmailsSelfHostedStore(pgClient!, {
      attachmentRepairPolicy: {
        maxActiveRunsPerTenant: 4,
        maxLedgerRunsPerTenant: 10,
        maxLedgerEntriesPerTenant: 20,
        runByteBudget: 5,
        runTimeBudgetMs: 60_000,
      },
    });
    const store = constrained.forTenant(tenant.tenantId);

    const createEntry = async (suffix: string) => {
      const messageId = await importMsg(deps, tenant.token, {
        receivedAt: `2027-01-0${suffix}T00:00:00.000Z`,
        attachments: [{ ...att(`${suffix}.txt`, "text/plain", suffix), content_base64: undefined } as never],
      });
      const objectKey = `source/budget-${suffix}`;
      await pgClient!.execute(
        `UPDATE messages SET source_id = $3, message_id = $3
         WHERE tenant_id = $1::uuid AND id = $2`,
        [tenant.tenantId, messageId, objectKey],
      );
      expect(await store.recordInboundSourceProvenance({
        messageId,
        bucket: canonicalBucket,
        objectKey,
        rawSha256: "e".repeat(64),
        establishedVia: "canonical_replay",
      })).toBe("recorded");
      return {
        object_key: objectKey,
        recipients: [`${suffix}@example.test`],
        canary_message_ids: [messageId],
      };
    };

    const byteRun = await store.createOrGetAttachmentRepairRun({
      idempotencyKey: "byte-budget",
      canonicalBucket,
      entries: [await createEntry("1"), await createEntry("2")],
    });
    expect(byteRun).toMatchObject({
      byte_budget: 5,
      bytes_consumed: 0,
      time_budget_ms: 60_000,
    });
    const first = await store.claimAttachmentRepairEntry(byteRun.id, 60_000);
    expect(first).toMatchObject({ source_byte_limit: 5 });
    expect(await store.getAttachmentRepairRun(byteRun.id)).toMatchObject({ bytes_consumed: 5 });
    await store.recordAttachmentRepairEntryOutcome(
      byteRun.id,
      first!.position,
      first!.claim_token!,
      "repaired",
      null,
      2,
    );
    expect(await store.getAttachmentRepairRun(byteRun.id)).toMatchObject({ bytes_consumed: 2 });
    const second = await store.claimAttachmentRepairEntry(byteRun.id, 60_000);
    expect(second).toMatchObject({ source_byte_limit: 3 });
    await store.recordAttachmentRepairEntryOutcome(
      byteRun.id,
      second!.position,
      second!.claim_token!,
      "unavailable",
      "run_byte_budget_exhausted",
      3,
    );
    expect(await store.getAttachmentRepairRun(byteRun.id)).toMatchObject({
      status: "completed",
      byte_budget: 5,
      bytes_consumed: 5,
      entry_operator_action: 1,
      operator_action: 1,
    });

    const timeRun = await store.createOrGetAttachmentRepairRun({
      idempotencyKey: "time-budget",
      canonicalBucket,
      entries: [await createEntry("3")],
    });
    const timeClaim = await store.claimAttachmentRepairEntry(timeRun.id, 60_000);
    expect(timeClaim).not.toBeNull();
    await pgClient!.execute(
      `UPDATE attachment_repair_runs
       SET deadline_at = now() - interval '1 millisecond'
       WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenant.tenantId, timeRun.id],
    );
    await store.recordAttachmentRepairEntryOutcome(
      timeRun.id,
      timeClaim!.position,
      timeClaim!.claim_token!,
      "repaired",
      null,
      0,
    );
    expect(await store.getAttachmentRepairRun(timeRun.id)).toMatchObject({
      status: "completed",
      entry_operator_action: 1,
      operator_action: 1,
      pending: 0,
    });
  });

  it("leases one external attempt across simultaneous resumes and recovers an expired crash claim", async () => {
    const deps = makeDeps();
    const tenantA = await makeTenant("repair-lease-a");
    const tenantB = await makeTenant("repair-lease-b");
    const canonicalBucket = "repair-lease-canonical";
    const storeA = deps.store.forTenant(tenantA.tenantId);
    const storeB = deps.store.forTenant(tenantB.tenantId);

    const createRepairableRun = async (suffix: string) => {
      const messageId = await importMsg(deps, tenantA.token, {
        receivedAt: `2026-11-0${suffix === "one" ? "1" : "2"}T00:00:00.000Z`,
        attachments: [att(`${suffix}.txt`, "text/plain", suffix)],
      });
      const objectKey = `source/lease-${suffix}`;
      await pgClient!.execute(
        `UPDATE messages
         SET source_id = $3,
             message_id = $3,
             attachments = (
               SELECT jsonb_agg(item.value - 'content_base64' ORDER BY item.ordinality)
               FROM jsonb_array_elements(attachments) WITH ORDINALITY AS item(value, ordinality)
             )
         WHERE tenant_id = $1::uuid AND id = $2`,
        [tenantA.tenantId, messageId, objectKey],
      );
      expect(await storeA.recordInboundSourceProvenance({
        messageId,
        bucket: canonicalBucket,
        objectKey,
        rawSha256: "c".repeat(64),
        establishedVia: "canonical_replay",
      })).toBe("recorded");
      return storeA.createOrGetAttachmentRepairRun({
        idempotencyKey: `repair-lease-${suffix}`,
        canonicalBucket,
        entries: [{
          object_key: objectKey,
          recipients: [`${suffix}@example.test`],
          canary_message_ids: [messageId],
        }],
      });
    };
    const resultFor = (
      entry: AttachmentRepairLedgerEntry,
      apply: boolean,
    ): AttachmentRepairResult => ({
      key: entry.object_key,
      apply,
      items: [{
        tenant_id: entry.tenant_id,
        message_id: entry.canary_message_ids[0],
        status: "would_repair",
        attachments: entry.attachment_count,
      }],
    });

    const concurrentRun = await createRepairableRun("one");
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let externalAttempts = 0;
    const repair = async (entry: AttachmentRepairLedgerEntry, apply: boolean) => {
      externalAttempts++;
      if (externalAttempts === 1) {
        signalStarted();
        await release;
      }
      return resultFor(entry, apply);
    };

    const firstResume = processAttachmentRepairPage(
      { store: storeA, repair },
      { runId: concurrentRun.id, limit: 1 },
    );
    await firstStarted;
    const secondResume = processAttachmentRepairPage(
      { store: storeA, repair },
      { runId: concurrentRun.id, limit: 1 },
    );
    await secondResume;
    releaseFirst();
    await firstResume;

    expect(externalAttempts).toBe(1);
    expect(await storeA.getAttachmentRepairRun(concurrentRun.id)).toMatchObject({
      status: "completed",
      entry_would_repair: 1,
    });

    const crashRun = await createRepairableRun("two");
    const claimed = await (storeA as any).claimAttachmentRepairEntry(crashRun.id, 60_000);
    expect(claimed).toMatchObject({ run_id: crashRun.id, attempts: 1 });
    expect(await (storeB as any).claimAttachmentRepairEntry(crashRun.id, 60_000)).toBeNull();
    await pgClient!.execute(
      `UPDATE attachment_repair_entries
       SET lease_expires_at = now() - interval '1 second'
       WHERE tenant_id = $1::uuid AND run_id = $2::uuid`,
      [tenantA.tenantId, crashRun.id],
    );

    let recoveredAttempts = 0;
    const recovered = await processAttachmentRepairPage({
      store: storeA,
      repair: async (entry, apply) => {
        recoveredAttempts++;
        return resultFor(entry, apply);
      },
    }, {
      runId: crashRun.id,
      limit: 1,
    });
    expect(recoveredAttempts).toBe(1);
    expect(recovered).toMatchObject({
      status: "completed",
      entry_would_repair: 1,
      attempts: 2,
    });
  });
});
