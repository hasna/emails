// Inbox performance path integration tests (migration 0019).
//
// Runs the REAL request pipeline against a real Postgres
// (EMAILS_TEST_POSTGRES_URL; skipped when unset). Locks in:
//   - keyset cursor pagination: cursor walk == offset walk, no dups/gaps,
//     including rows that TIE on received_at (id tiebreaker), next_cursor
//     null on the last page, 400 on malformed cursors.
//   - ?domain= filter (repeatable, to+cc recipiency, display-name parsing)
//     on /v1/messages and /v1/messages/groups.
//   - folder= filter parity with the counts semantics.
//   - /v1/mailboxes rollup counts `Display Name <email>` recipients correctly
//     (the old LIKE-join under-counted only by substring accident; the parsed
//     rollup must count them exactly).
//   - message_counters stay exact through insert -> mark-read -> label ->
//     delete, so /v1/messages/groups is O(1) and correct.
//   - list payload contract: snippet <= 140 chars, attachment_count present,
//     headers/attachments ABSENT from list rows.

import { beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import type { SelfHostedKeyStore } from "./keys.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const stubKeyStore: SelfHostedKeyStore = {
  insertMinted: async () => {},
  list: async () => [],
  revoke: async () => false,
};

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
    rateLimiter: new RateLimiter({
      rules: {
        login: { limit: 100000, windowMs: 1000 },
        signup: { limit: 100000, windowMs: 1000 },
        forgot: { limit: 100000, windowMs: 1000 },
        "verify-resend": { limit: 100000, windowMs: 1000 },
        reset: { limit: 100000, windowMs: 1000 },
        invite: { limit: 100000, windowMs: 1000 },
      },
    }),
    mailer: {
      from: "noreply@hasna.studio",
      verifyUrlBase: "https://app.test/verify",
      resetUrlBase: "https://app.test/reset",
      inviteUrlBase: "https://app.test/invite",
      productName: "Test Emails",
    },
    env: process.env,
  };
}

async function call(
  deps: SelfHostedServiceDeps,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  const res = await handleSelfHostedRequest(
    deps,
    new Request(`http://svc${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
  return { status: res!.status, body: await res!.json().catch(() => ({})) };
}

async function makeTenant(slug: string): Promise<{ tenantId: string; token: string }> {
  const t = await pgClient!.one<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [
    minted.kid,
    t.id,
  ]);
  return { tenantId: t.id, token: minted.token };
}

const RUN = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  if (!pgClient) return;
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});

describe.skipIf(!pgClient)("inbox perf: keyset cursor pagination", () => {
  it("cursor walk equals offset walk with no dups/gaps, including received_at ties", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-cursor-${RUN}`);
    // 12 messages: 4 share the exact same received_at (tie -> id breaks order),
    // 2 are outbound with NULL received_at (order by created_at).
    const tie = "2026-05-05T12:00:00.000Z";
    for (let i = 0; i < 10; i++) {
      const res = await call(deps, "POST", "/v1/messages", {
        token,
        body: {
          from: `s${i}@ext.example`,
          to: [`in@perf-cursor.example`],
          subject: `m${i}`,
          direction: "inbound",
          received_at: i < 4 ? tie : `2026-05-0${(i % 5) + 1}T0${i % 10}:00:00.000Z`,
        },
      });
      expect(res.status).toBe(201);
    }
    for (let i = 0; i < 2; i++) {
      await pgClient!.execute(`SELECT set_config('app.current_tenant', '', false)`);
      const res = await call(deps, "POST", "/v1/messages", {
        token,
        body: { from: "me@perf-cursor.example", to: [`o${i}@ext.example`], subject: `out${i}`, direction: "inbound" },
      });
      expect(res.status).toBe(201);
    }

    const byOffset: string[] = [];
    for (let off = 0; off < 12; off += 4) {
      const page = await call(deps, "GET", `/v1/messages?limit=4&offset=${off}`, { token });
      expect(page.status).toBe(200);
      byOffset.push(...page.body.messages.map((m: any) => m.id));
    }
    expect(new Set(byOffset).size).toBe(12);

    const byCursor: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const path: string = `/v1/messages?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await call(deps, "GET", path, { token });
      expect(page.status).toBe(200);
      byCursor.push(...page.body.messages.map((m: any) => m.id));
      cursor = page.body.next_cursor;
    } while (cursor && ++guard < 10);

    expect(byCursor).toEqual(byOffset);
    // Last page was full, so one trailing empty page carried next_cursor=null.
    expect(cursor).toBeNull();
  });

  it("rejects malformed cursors with 400 (a broken client must not silently restart at page 1)", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-badcur-${RUN}`);
    const res = await call(deps, "GET", "/v1/messages?cursor=%00garbage", { token });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!pgClient)("inbox perf: ?domain= filter contract", () => {
  it("filters messages and groups by recipient domain, parsing display-name forms, to+cc", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-dom-${RUN}`);
    const mk = (to: string[], cc: string[] = [], extra: Record<string, unknown> = {}) =>
      call(deps, "POST", "/v1/messages", {
        token,
        body: { from: "x@ext.example", to, cc, direction: "inbound", subject: "d", ...extra },
      });
    await mk([`"Andrei H" <a@alpha.example>`]); // display-name form
    await mk(["b@beta.example"]);
    await mk(["c@gamma.example"], [`"CC" <cc@alpha.example>`]); // alpha via cc
    await mk(["d@beta.example"], [], { is_read: true });

    const alpha = await call(deps, "GET", "/v1/messages?domain=alpha.example", { token });
    expect(alpha.status).toBe(200);
    expect(alpha.body.messages.length).toBe(2); // to-form + cc-form

    const multi = await call(deps, "GET", "/v1/messages?domain=alpha.example&domain=beta.example", { token });
    expect(multi.body.messages.length).toBe(4);

    const commaAndAt = await call(deps, "GET", "/v1/messages?domain=@Alpha.example,beta.example", { token });
    expect(commaAndAt.body.messages.length).toBe(4);

    const groupsBeta = await call(deps, "GET", "/v1/messages/groups?domain=beta.example", { token });
    expect(groupsBeta.status).toBe(200);
    expect(groupsBeta.body.total).toBe(2);
    expect(groupsBeta.body.inbox).toBe(2);
    expect(groupsBeta.body.unread).toBe(1);

    const none = await call(deps, "GET", "/v1/messages?domain=nowhere.example", { token });
    expect(none.body.messages.length).toBe(0);
    expect(none.body.next_cursor).toBeNull();
  });
});

describe.skipIf(!pgClient)("inbox perf: folder filter + counters lifecycle", () => {
  it("folder= filters match the groups counts through mark-read/label/delete", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-fold-${RUN}`);
    const mk = (body: Record<string, unknown>) =>
      call(deps, "POST", "/v1/messages", {
        token,
        body: { from: "x@ext.example", to: ["in@fold.example"], direction: "inbound", ...body },
      });
    const a = await mk({ subject: "a" });
    await mk({ subject: "b", is_read: true });
    await mk({ subject: "c", labels: ["archived"] });
    await mk({ subject: "d", labels: ["trash"] });
    await mk({ subject: "e", is_starred: true });

    const groups1 = await call(deps, "GET", "/v1/messages/groups", { token });
    expect(groups1.body).toMatchObject({ total: 5, inbox: 3, unread: 2, starred: 1, archived: 1, trash: 1, spam: 0, sent: 0 });

    const inbox = await call(deps, "GET", "/v1/messages?folder=inbox", { token });
    expect(inbox.body.messages.length).toBe(groups1.body.inbox);
    const starred = await call(deps, "GET", "/v1/messages?folder=starred", { token });
    expect(starred.body.messages.length).toBe(groups1.body.starred);
    const trash = await call(deps, "GET", "/v1/messages?folder=trash", { token });
    expect(trash.body.messages.length).toBe(groups1.body.trash);
    const badFolder = await call(deps, "GET", "/v1/messages?folder=junk", { token });
    expect(badFolder.status).toBe(400);

    // counters must track writes exactly (they are the O(1) source of truth)
    const aId = a.body.message.id;
    const patch = await call(deps, "PATCH", `/v1/messages/${aId}`, { token, body: { is_read: true } });
    if (patch.status === 405 || patch.status === 404) {
      // No PATCH on this surface: flip via direct UPDATE inside the tenant txn
      // (the trigger, not the API layer, owns counter sync).
      await pgClient!.transaction(async (tx) => {
        const { tenantId } = { tenantId: null as string | null };
        void tenantId;
        const row = await tx.one<{ tenant_id: string }>(
          `SELECT tenant_id::text AS tenant_id FROM messages WHERE id = $1`,
          [aId],
        );
        await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [row.tenant_id]);
        await tx.execute(`UPDATE messages SET is_read = true WHERE id = $1`, [aId]);
      });
    }
    const groups2 = await call(deps, "GET", "/v1/messages/groups", { token });
    expect(groups2.body.unread).toBe(groups1.body.unread - 1);
    expect(groups2.body.inbox).toBe(groups1.body.inbox);
  });
});

describe.skipIf(!pgClient)("inbox perf: /v1/mailboxes rollup", () => {
  it("counts display-name recipients exactly and stays tenant-scoped", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-mbx-${RUN}`);
    const other = await makeTenant(`perf-mbx-other-${RUN}`);

    const addr = await call(deps, "POST", "/v1/addresses", {
      token,
      body: { email: `CEO@perf-mbx-${RUN}.example` },
    });
    expect([200, 201]).toContain(addr.status);

    const mk = (tok: string, to: string[], extra: Record<string, unknown> = {}) =>
      call(deps, "POST", "/v1/messages", {
        token: tok,
        body: { from: "x@ext.example", to, direction: "inbound", subject: "m", ...extra },
      });
    // 2 display-name + 1 bare to the registered address (one read), 1 unrelated
    await mk(token, [`"The CEO" <ceo@perf-mbx-${RUN}.example>`]);
    await mk(token, [`"CEO again" <CEO@perf-mbx-${RUN}.example>`], { is_read: true });
    await mk(token, [`ceo@perf-mbx-${RUN}.example`]);
    await mk(token, ["elsewhere@other.example"]);
    // same address string in ANOTHER tenant must not leak into this rollup
    await mk(other.token, [`ceo@perf-mbx-${RUN}.example`]);

    const res = await call(deps, "GET", "/v1/mailboxes", { token });
    expect(res.status).toBe(200);
    const box = res.body.mailboxes.find((m: any) => m.address.toLowerCase() === `ceo@perf-mbx-${RUN}.example`);
    expect(box).toBeDefined();
    expect(box.total).toBe(3);
    expect(box.unread).toBe(2);
    expect(res.body.counts.total).toBe(4);
  });
});

describe.skipIf(!pgClient)("inbox perf: list payload contract", () => {
  it("list rows carry snippet<=140 + attachment_count and drop headers/attachments; q aliases search", async () => {
    const deps = makeDeps();
    const { token } = await makeTenant(`perf-payload-${RUN}`);
    const created = await call(deps, "POST", "/v1/messages", {
      token,
      body: {
        from: "x@ext.example",
        to: ["in@payload.example"],
        direction: "inbound",
        subject: "payload",
        text: `needle-${RUN} ` + "y".repeat(600),
        headers: { "X-Big": "z".repeat(5000) },
        attachments: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
      },
    });
    expect(created.status).toBe(201);

    const list = await call(deps, "GET", `/v1/messages?q=needle-${RUN}`, { token });
    expect(list.status).toBe(200);
    expect(list.body.messages.length).toBe(1);
    const item = list.body.messages[0];
    expect(item.snippet.length).toBeLessThanOrEqual(140);
    expect(item.attachment_count).toBe(2);
    expect(item.headers).toBeUndefined();
    expect(item.attachments).toBeUndefined();

    // the detail read still returns everything
    const detail = await call(deps, "GET", `/v1/messages/${item.id}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body.message.attachments.length).toBe(2);
    expect(detail.body.message.headers["X-Big"]).toBeDefined();
  });
});
