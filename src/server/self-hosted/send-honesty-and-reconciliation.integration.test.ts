// The two directions of send honesty, plus the reconciliation path for the
// messages that were left in limbo on 2026-07-25.
//
// The incident had TWO failure modes, and a fix for one can silently create the
// other. This suite asserts both invariants as invariants, over the WHOLE
// response — status class, `sent`, the presence of an `error` key, the ledger
// row, and what the CLI's own serializer renders — not just over one field:
//
//   A. PROVIDER ACCEPTED  =>  no part of the answer may imply failure.
//      (Operators retried a "502" for mail the provider had already taken, and
//      real client mail went out three times.)
//   B. PROVIDER REJECTED  =>  no part of the answer may imply success.
//      (Six emails to an external accountant were reported as delivered when
//      SES had refused every one of them.)
//
//   C. An UNCERTAIN outcome must be listable and closable against evidence,
//      one message at a time — the seven rows that had no path out.
//
// Gated on EMAILS_TEST_POSTGRES_URL like the other integration suites.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore, TenantScopedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import type { AuthMailerConfig } from "./auth/mailer.js";
import type { SelfHostedKeyStore } from "./keys.js";
import type { SelfHostedSender } from "./sender.js";
import { formatSelfHostedSummaries, toSelfHostedSummary } from "../../cli/commands/email-log.remote.js";
import type { TuiMessage } from "../../lib/mail-types.js";

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

const MAILER: AuthMailerConfig = {
  from: "noreply@hasna.studio",
  verifyUrlBase: "https://app.test/verify",
  resetUrlBase: "https://app.test/reset",
  inviteUrlBase: "https://app.test/invite",
  productName: "Test Emails",
};

function sesError(name: string, message: string, httpStatusCode: number, fault: "client" | "server"): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { $metadata: { httpStatusCode }, $fault: fault });
  return err;
}

function makeDeps(sender: SelfHostedSender): SelfHostedServiceDeps {
  return {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender,
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
    mailer: MAILER,
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
  const res = await handleSelfHostedRequest(deps, new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }));
  return { status: res!.status, body: await res!.json().catch(() => ({})) };
}

async function makeTenant(slug: string): Promise<{ tenantId: string; token: string }> {
  const t = await pgClient!.one<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, t.id]);
  return { tenantId: t.id, token: minted.token };
}

async function registerSender(deps: SelfHostedServiceDeps, token: string, domain: string, email: string): Promise<void> {
  const dom = await call(deps, "POST", "/v1/domains", {
    token,
    body: { domain, status: "active", verified: true, provisioning_status: "ready" },
  });
  expect(dom.status).toBe(201);
  const addr = await call(deps, "POST", "/v1/addresses", {
    token,
    body: { email, status: "active", verified: true, domain_id: dom.body.domain.id, provisioning_status: "ready" },
  });
  expect(addr.status).toBe(201);
}

/** Force `completeSendIntent` to fail so the provider-accepted-then-ledger-broke path runs. */
function withBrokenFinalization(deps: SelfHostedServiceDeps): void {
  const realStore = deps.store;
  deps.store = new Proxy(realStore, {
    get(target, prop) {
      if (prop === "forTenant") {
        return (tenantId: string) => {
          const scoped: TenantScopedStore = target.forTenant(tenantId);
          return new Proxy(scoped, {
            get(sTarget, sProp) {
              if (sProp === "completeSendIntent") {
                return async () => { throw new Error("simulated ledger finalization outage"); };
              }
              const value = Reflect.get(sTarget, sProp, sTarget);
              return typeof value === "function" ? value.bind(sTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EmailsSelfHostedStore;
}

/**
 * Would a caller reading THIS response conclude the message failed?
 *
 * Deliberately generous about what counts as "looks like a failure": an error
 * status class, an `error` key, `sent` anything other than true, or a
 * `retry_safe: true` hint that invites the duplicate send.
 */
function readsAsFailure(status: number, body: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (status < 200 || status >= 300) reasons.push(`status ${status}`);
  if (typeof body["error"] === "string") reasons.push(`error: ${body["error"]}`);
  if (body["sent"] !== true) reasons.push(`sent=${JSON.stringify(body["sent"])}`);
  if (body["retry_safe"] === true) reasons.push("retry_safe=true invites a duplicate send");
  return reasons;
}

/** Would a caller reading THIS response conclude the message was sent? */
function readsAsSuccess(status: number, body: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (status >= 200 && status < 300) reasons.push(`2xx status ${status}`);
  if (body["sent"] === true) reasons.push("sent=true");
  if (typeof body["provider_message_id"] === "string") reasons.push("provider_message_id present");
  if (typeof body["error"] !== "string") reasons.push("no error explanation");
  return reasons;
}

/** What `emails log` / `emails log --json` would show for this ledger row. */
function ledgerRowAsCliRow(record: { id: string; from_addr: string; to_addrs: string[]; subject: string; status: string; send_state: string }) {
  const msg = {
    kind: "sent",
    id: record.id,
    from: record.from_addr,
    to: record.to_addrs.join(", "),
    subject: record.subject,
    date: "2026-07-25T12:00:00.000Z",
    is_read: true,
    is_starred: false,
    labels: [],
    snippet: "",
    thread_id: null,
    provider_thread_id: null,
    attachments: 0,
    status: record.status,
    send_state: record.send_state,
  } as unknown as TuiMessage;
  return toSelfHostedSummary(msg);
}

async function ledgerRow(key: string) {
  return pgClient!.get<{
    id: string;
    send_state: string;
    status: string;
    provider_message_id: string | null;
    from_addr: string;
    to_addrs: string[];
    subject: string;
    headers: Record<string, unknown> | null;
  }>(
    `SELECT id, send_state, status, provider_message_id, from_addr, to_addrs, subject, headers
     FROM messages WHERE idempotency_key = $1`,
    [key],
  );
}

beforeAll(async () => {
  if (!pgClient) return;
  await pgClient.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pgClient.execute("CREATE SCHEMA public");
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});

afterAll(async () => {
  await pgClient?.close();
});

// ── Direction A: accepted must never read as failed ─────────────────────────

describe.skipIf(!pgClient)("A: a message the provider ACCEPTED never reads as a failure", () => {
  it("fresh success", async () => {
    const deps = makeDeps({ provider: "ses", send: async () => "ses-accept-fresh" });
    const { token } = await makeTenant("honesty-a-fresh");
    await registerSender(deps, token, "afresh.example", "sender@afresh.example");

    const key = `a-fresh-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@afresh.example", to: ["target@external.example"], subject: "a", text: "b", idempotency_key: key },
    });

    expect(readsAsFailure(res.status, res.body)).toEqual([]);
    expect(res.body.provider_message_id).toBe("ses-accept-fresh");
    const row = await ledgerRow(key);
    expect(row?.send_state).toBe("sent");
  });

  it("provider accepted but the ledger write failed afterwards", async () => {
    const deps = makeDeps({ provider: "ses", send: async () => "ses-accept-broken-ledger" });
    withBrokenFinalization(deps);
    const { token } = await makeTenant("honesty-a-ledger");
    await registerSender(deps, token, "aledger.example", "sender@aledger.example");

    const key = `a-ledger-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@aledger.example", to: ["target@external.example"], subject: "a", text: "b", idempotency_key: key },
    });

    // This is the exact path that returned 502 and triplicated real client mail.
    expect(readsAsFailure(res.status, res.body)).toEqual([]);
    expect(res.body.provider_message_id).toBe("ses-accept-broken-ledger");
    expect(String(res.body.warning)).toMatch(/do NOT retry/i);
  });

  it("idempotent replay of a completed send", async () => {
    let calls = 0;
    const deps = makeDeps({ provider: "ses", send: async () => { calls += 1; return "ses-accept-replay"; } });
    const { token } = await makeTenant("honesty-a-replay");
    await registerSender(deps, token, "areplay.example", "sender@areplay.example");

    const key = `a-replay-${crypto.randomUUID()}`;
    const body = { from: "sender@areplay.example", to: ["target@external.example"], subject: "a", text: "b", idempotency_key: key };
    const first = await call(deps, "POST", "/v1/messages/send", { token, body });
    const second = await call(deps, "POST", "/v1/messages/send", { token, body });

    expect(calls).toBe(1);
    expect(readsAsFailure(first.status, first.body)).toEqual([]);
    expect(readsAsFailure(second.status, second.body)).toEqual([]);
    expect(second.body.idempotent_replay).toBe(true);
  });

  it("and the CLI log renders an accepted send as sent, not as an unknown blank", async () => {
    const deps = makeDeps({ provider: "ses", send: async () => "ses-accept-cli" });
    const { token } = await makeTenant("honesty-a-cli");
    await registerSender(deps, token, "acli.example", "sender@acli.example");
    const key = `a-cli-${crypto.randomUUID()}`;
    await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@acli.example", to: ["target@external.example"], subject: "quarterly", text: "b", idempotency_key: key },
    });

    const row = (await ledgerRow(key))!;
    const summary = ledgerRowAsCliRow(row);
    expect(summary.send_state).toBe("sent");
    expect(formatSelfHostedSummaries([summary], "log")).toContain("sent");
  });
});

// ── Direction B: rejected must never read as sent ───────────────────────────

describe.skipIf(!pgClient)("B: a message the provider REJECTED never reads as sent", () => {
  it("SES sandbox MessageRejected — the literal 2026-07-25 error", async () => {
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        throw sesError(
          "MessageRejected",
          "Email address is not verified. The following identities failed the check in region US-EAST-1: accountant@external.example",
          400,
          "client",
        );
      },
    });
    const { token } = await makeTenant("honesty-b-reject");
    await registerSender(deps, token, "breject.example", "sender@breject.example");

    const key = `b-reject-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@breject.example", to: ["accountant@external.example"], subject: "invoices", text: "b", idempotency_key: key },
    });

    // Nothing in this answer may read as a success.
    expect(readsAsSuccess(res.status, res.body)).toEqual([]);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe("provider_rejected");
    expect(String(res.body.error)).toContain("MessageRejected");

    const row = (await ledgerRow(key))!;
    expect(row.send_state).toBe("failed");
    expect(row.status).toBe("failed");
    expect(row.provider_message_id).toBeNull();
  });

  it("and the CLI log renders a rejected send as failed — never blank, never like delivered mail", async () => {
    const deps = makeDeps({
      provider: "ses",
      send: async () => { throw sesError("MessageRejected", "not verified", 400, "client"); },
    });
    const { token } = await makeTenant("honesty-b-cli");
    await registerSender(deps, token, "bcli.example", "sender@bcli.example");
    const key = `b-cli-${crypto.randomUUID()}`;
    await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@bcli.example", to: ["accountant@external.example"], subject: "invoices", text: "b", idempotency_key: key },
    });

    const row = (await ledgerRow(key))!;
    const summary = ledgerRowAsCliRow(row);
    // `emails log --json` must expose it…
    expect(summary.send_state).toBe("failed");
    expect(summary.status).toBe("failed");
    // …and the human table must too.
    const rendered = formatSelfHostedSummaries([summary], "log");
    expect(rendered).toContain("failed");
  });

  it("an indeterminate outcome claims neither: sent is null and the row stays uncertain", async () => {
    const deps = makeDeps({ provider: "ses", send: async () => { throw new TypeError("fetch failed"); } });
    const { token } = await makeTenant("honesty-b-unknown");
    await registerSender(deps, token, "bunknown.example", "sender@bunknown.example");

    const key = `b-unknown-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "sender@bunknown.example", to: ["target@external.example"], subject: "a", text: "b", idempotency_key: key },
    });

    expect(readsAsSuccess(res.status, res.body)).toEqual([]);
    expect(res.body.sent).toBeNull();
    expect((await ledgerRow(key))?.send_state).toBe("uncertain");
  });

  it("a policy block is not a send either", async () => {
    let providerCalls = 0;
    const deps = makeDeps({ provider: "ses", send: async () => { providerCalls += 1; return "never"; } });
    const { token } = await makeTenant("honesty-b-policy");
    // Deliberately NOT registering the sender address.
    const key = `b-policy-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: { from: "stranger@unregistered.example", to: ["target@external.example"], subject: "a", text: "b", idempotency_key: key },
    });

    expect(providerCalls).toBe(0);
    expect(readsAsSuccess(res.status, res.body)).toEqual([]);
  });
});

// ── Direction C: reconciling the messages left uncertain ────────────────────

describe.skipIf(!pgClient)("C: uncertain sends can be found and closed out on evidence", () => {
  async function seedUncertain(slug: string, count: number): Promise<{ deps: SelfHostedServiceDeps; token: string; keys: string[] }> {
    const deps = makeDeps({ provider: "ses", send: async () => { throw new TypeError("fetch failed"); } });
    const { token } = await makeTenant(slug);
    await registerSender(deps, token, `${slug}.example`, `sender@${slug}.example`);
    const keys: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const key = `${slug}-${i}-${crypto.randomUUID()}`;
      keys.push(key);
      const res = await call(deps, "POST", "/v1/messages/send", {
        token,
        body: {
          from: `sender@${slug}.example`,
          to: [`recipient-${i}@external.example`],
          subject: `stuck ${i}`,
          text: "body",
          idempotency_key: key,
        },
      });
      expect(res.status).toBe(502);
    }
    return { deps, token, keys };
  }

  it("lists exactly the messages whose outcome is unknown — nothing else", async () => {
    const { deps, token } = await seedUncertain("recon-list", 7);
    // A message that definitively failed must NOT show up: its outcome is known.
    const rejectDeps = makeDeps({
      provider: "ses",
      send: async () => { throw sesError("MessageRejected", "nope", 400, "client"); },
    });
    rejectDeps.store = deps.store;
    await call(rejectDeps, "POST", "/v1/messages/send", {
      token,
      body: {
        from: "sender@recon-list.example",
        to: ["known-failure@external.example"],
        subject: "known",
        text: "b",
        idempotency_key: `recon-list-known-${crypto.randomUUID()}`,
      },
    });

    const res = await call(deps, "GET", "/v1/messages/send-intents/uncertain", { token });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    for (const row of res.body.uncertain) expect(row.send_state).toBe("uncertain");
    // The endpoint never leaks the idempotency fence.
    expect(JSON.stringify(res.body)).not.toContain("idempotency_key");
  });

  it("closing one out as NOT SENT records the evidence and makes the row read as failed", async () => {
    const { deps, token, keys } = await seedUncertain("recon-notsent", 1);
    const before = (await ledgerRow(keys[0]!))!;

    const res = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: {
        message_id: before.id,
        outcome: "not_sent",
        evidence: "CloudWatch AWS/SES on 638389534677 shows zero Send in the window; no MessageId was ever returned",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.message.send_state).toBe("failed");

    const after = (await ledgerRow(keys[0]!))!;
    expect(after.send_state).toBe("failed");
    expect(after.status).toBe("failed");
    const reconciliation = (after.headers ?? {})["send_reconciliation"] as Record<string, unknown>;
    expect(reconciliation?.["outcome"]).toBe("not_sent");
    expect(String(reconciliation?.["evidence"])).toContain("zero Send");
    expect(String(reconciliation?.["resolved_by"])).toMatch(/^apikey:/);
    expect(typeof reconciliation?.["resolved_at"]).toBe("string");

    // It no longer appears as needing a decision.
    const list = await call(deps, "GET", "/v1/messages/send-intents/uncertain", { token });
    expect(list.body.count).toBe(0);

    // And `emails log` now says "failed" rather than an ambiguous "uncertain".
    expect(ledgerRowAsCliRow(after).send_state).toBe("failed");
  });

  it("closing one out as SENT requires the provider message id that proves it", async () => {
    const { deps, token, keys } = await seedUncertain("recon-sent", 1);
    const row = (await ledgerRow(keys[0]!))!;

    const missing = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id, outcome: "sent", evidence: "an operator says so" },
    });
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toContain("provider_message_id");
    // Unchanged: a refused reconciliation must not half-apply.
    expect((await ledgerRow(keys[0]!))?.send_state).toBe("uncertain");

    const ok = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: {
        message_id: row.id,
        outcome: "sent",
        provider_message_id: "0100019xxxxxxxxx-ses-message-id",
        evidence: "SES SNS Delivery event for this MessageId on account 638389534677",
      },
    });
    expect(ok.status).toBe(200);
    const after = (await ledgerRow(keys[0]!))!;
    expect(after.send_state).toBe("sent");
    expect(after.provider_message_id).toBe("0100019xxxxxxxxx-ses-message-id");
  });

  it("refuses empty evidence — an outcome asserted with no reason is what caused the incident", async () => {
    const { deps, token, keys } = await seedUncertain("recon-evidence", 1);
    const row = (await ledgerRow(keys[0]!))!;

    const res = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id, outcome: "not_sent", evidence: "   " },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("evidence is required");
    expect((await ledgerRow(keys[0]!))?.send_state).toBe("uncertain");
  });

  it("never overwrites a PROVEN outcome, and never applies twice", async () => {
    const { deps, token, keys } = await seedUncertain("recon-guard", 1);
    const row = (await ledgerRow(keys[0]!))!;

    const first = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id, outcome: "not_sent", evidence: "no SES Send metric in the window" },
    });
    expect(first.status).toBe(200);

    // Second attempt — including one that would flip the verdict — is refused.
    const second = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id, outcome: "sent", provider_message_id: "fabricated", evidence: "changed my mind" },
    });
    expect(second.status).toBe(409);
    expect(second.body.reconciled).toBe(false);
    const after = (await ledgerRow(keys[0]!))!;
    expect(after.send_state).toBe("failed");
    expect(after.provider_message_id).toBeNull();
  });

  it("refuses an unknown message and an invalid outcome", async () => {
    const { deps, token, keys } = await seedUncertain("recon-input", 1);
    const row = (await ledgerRow(keys[0]!))!;

    const unknown = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: crypto.randomUUID(), outcome: "not_sent", evidence: "x" },
    });
    expect(unknown.status).toBe(404);

    const bogus = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id, outcome: "probably", evidence: "x" },
    });
    expect(bogus.status).toBe(400);
    expect((await ledgerRow(keys[0]!))?.send_state).toBe("uncertain");
  });

  it("accepts a short id prefix and 404s a malformed id instead of blowing up on the uuid column", async () => {
    const { deps, token, keys } = await seedUncertain("recon-prefix", 1);
    const row = (await ledgerRow(keys[0]!))!;

    const garbage = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: "not-a-uuid-at-all", outcome: "not_sent", evidence: "x" },
    });
    expect(garbage.status).toBe(404);

    const byPrefix = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: { message_id: row.id.slice(0, 8), outcome: "not_sent", evidence: "prefix resolution" },
    });
    expect(byPrefix.status).toBe(200);
    expect((await ledgerRow(keys[0]!))?.send_state).toBe("failed");
  });

  it("is tenant-scoped: another tenant can neither see nor reconcile these rows", async () => {
    const { deps, keys } = await seedUncertain("recon-tenant-a", 1);
    const other = await makeTenant("recon-tenant-b");
    const row = (await ledgerRow(keys[0]!))!;

    const list = await call(deps, "GET", "/v1/messages/send-intents/uncertain", { token: other.token });
    expect(list.body.count).toBe(0);

    const attempt = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token: other.token,
      body: { message_id: row.id, outcome: "sent", provider_message_id: "x", evidence: "cross-tenant" },
    });
    expect(attempt.status).toBe(404);
    expect((await ledgerRow(keys[0]!))?.send_state).toBe("uncertain");
  });

  it("reconciles the seven stuck rows one by one, each with its own evidence", async () => {
    const { deps, token, keys } = await seedUncertain("recon-seven", 7);
    const listed = await call(deps, "GET", "/v1/messages/send-intents/uncertain", { token });
    expect(listed.body.count).toBe(7);

    for (const [index, entry] of (listed.body.uncertain as Array<{ id: string }>).entries()) {
      const res = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
        token,
        body: {
          message_id: entry.id,
          outcome: "not_sent",
          evidence: `per-message check ${index}: no SES MessageId, no Send/Delivery datapoint`,
        },
      });
      expect(res.status).toBe(200);
    }

    const remaining = await call(deps, "GET", "/v1/messages/send-intents/uncertain", { token });
    expect(remaining.body.count).toBe(0);
    for (const key of keys) expect((await ledgerRow(key))?.send_state).toBe("failed");
  });
});
