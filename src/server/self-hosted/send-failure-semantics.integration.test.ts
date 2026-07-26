// Send-failure semantics against the REAL request pipeline + real Postgres.
//
// Locks in the fix for the 2026-07-25 production incident: a synchronous
// provider reject (SES sandbox `MessageRejected` for any unverified/external
// recipient) was swallowed by a bare `catch {}`, marked `uncertain`, and
// surfaced as a generic 502 "send outcome is uncertain" — which reads as an
// infrastructure failure AND as "the message may have been sent". Operators
// retried, producing duplicate ledger rows for mail that never left at all.
//
// Contract proven here:
//   1. A definitive provider reject (4xx-class SDK error) -> 422 with the REAL
//      provider error, `sent: false`, ledger row `send_state = 'failed'` —
//      never a 502, never `uncertain`.
//   2. Retrying the SAME idempotency key after a definitive reject re-attempts
//      on the SAME ledger row (no duplicate) and can succeed.
//   3. A provider success followed by a ledger-finalization failure returns a
//      SUCCESS (202) carrying `sent: true` + the provider message id + an
//      explicit warning — a successful send must never look like a failure.
//   4. An indeterminate provider failure (network / 5xx) stays a 502 and says
//      so explicitly (`sent: null`, reconcile-before-retry).
//   5. Replaying a completed intent returns the existing message (200,
//      idempotent_replay) — never a second send.
//   6. Every provider-accepted response — fresh success, idempotent replay,
//      or finalization failure — carries top-level `sent: true` and the
//      provider message id; a failed re-arm answers 503 `sent: false`.
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
import { testAuthEnv } from "./auth/test-support.js";
import type { AuthMailerConfig } from "./auth/mailer.js";
import type { SelfHostedKeyStore } from "./keys.js";
import type { SelfHostedSender } from "./sender.js";

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
  from: "noreply@auth.example",
  verifyUrlBase: "https://app.test/verify",
  resetUrlBase: "https://app.test/reset",
  inviteUrlBase: "https://app.test/invite",
  productName: "Test Emails",
};

/** An AWS-SDK-v3-shaped error, as `@aws-sdk/client-sesv2` actually throws it. */
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
    env: testAuthEnv(),
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

/** Register a ready sender address so outbound policy allows the send. */
async function registerSender(deps: SelfHostedServiceDeps, token: string, domain: string, email: string): Promise<void> {
  const dom = await call(deps, "POST", "/v1/domains", {
    token,
    body: { domain, status: "active", verified: true, provisioning_status: "ready" },
  });
  expect(dom.status).toBe(201);
  const addr = await call(deps, "POST", "/v1/addresses", {
    token,
    body: {
      email,
      status: "active",
      verified: true,
      domain_id: dom.body.domain.id,
      provisioning_status: "ready",
    },
  });
  expect(addr.status).toBe(201);
}

async function rowByKey(key: string): Promise<{ id: string; send_state: string; status: string; provider_message_id: string | null } | null> {
  return pgClient!.get(
    `SELECT id, send_state, status, provider_message_id FROM messages WHERE idempotency_key = $1`,
    [key],
  );
}

async function rowCountByKey(key: string): Promise<number> {
  const row = await pgClient!.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE idempotency_key = $1`,
    [key],
  );
  return Number(row.n);
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

describe.skipIf(!pgClient)("send-failure semantics (2026-07-25 incident contract)", () => {
  it("a definitive provider reject returns 422 with the real provider error and sent:false — NEVER a generic 502/uncertain", async () => {
    let providerCalls = 0;
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        providerCalls += 1;
        throw sesError(
          "MessageRejected",
          // Shape-faithful copy of the real SES error, with a reserved example
          // address: this repo is public and must not publish a third party's
          // mailbox.
          "Email address is not verified. The following identities failed the check in region US-EAST-1: accountant@external.example",
          400,
          "client",
        );
      },
    });
    const { token } = await makeTenant("reject-422");
    await registerSender(deps, token, "reject422.example", "sender@reject422.example");

    const key = `reject-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: {
        from: "sender@reject422.example",
        to: ["accountant@external.example"],
        subject: "external send",
        text: "body",
        idempotency_key: key,
      },
    });

    expect(providerCalls).toBe(1);
    // The defect: this used to be 502 "send outcome is uncertain".
    expect(res.status).toBe(422);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe("provider_rejected");
    expect(res.body.provider_error).toBe("MessageRejected");
    // The REAL provider message reaches the operator (it names the cause).
    expect(String(res.body.error)).toContain("Email address is not verified");
    expect(String(res.body.error)).not.toContain("uncertain");
    expect(res.body.retry_safe).toBe(true);

    // Ledger: exactly one row, definitively failed — not uncertain.
    expect(await rowCountByKey(key)).toBe(1);
    const row = await rowByKey(key);
    expect(row?.send_state).toBe("failed");
    expect(row?.status).toBe("failed");
  });

  it("retrying the SAME idempotency key after a definitive reject re-attempts on the SAME row and can succeed", async () => {
    let fail = true;
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        if (fail) throw sesError("MessageRejected", "Email address is not verified.", 400, "client");
        return "provider-msg-after-retry";
      },
    });
    const { token } = await makeTenant("reject-retry");
    await registerSender(deps, token, "rejectretry.example", "sender@rejectretry.example");

    const key = `retry-${crypto.randomUUID()}`;
    const body = {
      from: "sender@rejectretry.example",
      to: ["someone@external.example"],
      subject: "retry me",
      text: "body",
      idempotency_key: key,
    };

    const first = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(first.status).toBe(422);
    const failedRow = await rowByKey(key);
    expect(failedRow?.send_state).toBe("failed");

    fail = false;
    const second = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(second.status).toBe(202);
    expect(second.body.message.provider_message_id).toBe("provider-msg-after-retry");

    // No duplicate ledger row was created by the retry.
    expect(await rowCountByKey(key)).toBe(1);
    const row = await rowByKey(key);
    expect(row?.id).toBe(failedRow!.id);
    expect(row?.send_state).toBe("sent");
  });

  it("a post-send ledger failure returns SUCCESS with sent:true + provider message id + warning — a sent message must never look failed", async () => {
    const deps = makeDeps({ provider: "ses", send: async () => "provider-accepted-id" });
    const { token } = await makeTenant("finalize-warn");
    await registerSender(deps, token, "finalizewarn.example", "sender@finalizewarn.example");

    // Make ONLY completeSendIntent fail, exactly once, on the tenant-scoped store.
    const realStore = deps.store;
    let finalizationFailures = 0;
    deps.store = new Proxy(realStore, {
      get(target, prop, receiver) {
        if (prop === "forTenant") {
          return (tenantId: string) => {
            const scoped: TenantScopedStore = target.forTenant(tenantId);
            return new Proxy(scoped, {
              get(sTarget, sProp, sReceiver) {
                if (sProp === "completeSendIntent") {
                  return async () => {
                    finalizationFailures += 1;
                    throw new Error("simulated ledger finalization outage");
                  };
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

    const key = `finalize-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: {
        from: "sender@finalizewarn.example",
        to: ["target@external.example"],
        subject: "finalization failure",
        text: "body",
        idempotency_key: key,
      },
    });

    expect(finalizationFailures).toBe(1);
    // The defect: this used to be a 502, which operators read as "not sent".
    expect(res.status).toBe(202);
    expect(res.body.sent).toBe(true);
    expect(res.body.provider_message_id).toBe("provider-accepted-id");
    expect(String(res.body.warning)).toMatch(/sent|accepted/i);
    expect(res.body.retry_safe).toBe(false);

    // The HTTP response is not where an operator looks a day later — the ROW is.
    // A parked row that lost the provider id can only be reconciled as
    // `not_sent`, which would file a delivered message as failed.
    const row = await rowByKey(key);
    expect(row?.send_state).toBe("uncertain");
    expect(row?.provider_message_id).toBe("provider-accepted-id");

    // And that evidence must be enough to close it out honestly as `sent`.
    const reconciled = await call(deps, "POST", "/v1/messages/send-intents/reconcile", {
      token,
      body: {
        message_id: row!.id,
        outcome: "sent",
        provider_message_id: row!.provider_message_id,
        evidence: "provider returned this id before the ledger write failed",
      },
    });
    expect(reconciled.status).toBe(200);
    expect((await rowByKey(key))?.send_state).toBe("sent");
  });

  it("an indeterminate provider failure stays 502 and says the outcome is unknown (sent: null)", async () => {
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        // A network-level failure: no HTTP status, so nothing is known.
        throw new TypeError("fetch failed");
      },
    });
    const { token } = await makeTenant("uncertain-502");
    await registerSender(deps, token, "uncertain502.example", "sender@uncertain502.example");

    const key = `uncertain-${crypto.randomUUID()}`;
    const res = await call(deps, "POST", "/v1/messages/send", {
      token,
      body: {
        from: "sender@uncertain502.example",
        to: ["target@external.example"],
        subject: "network failure",
        text: "body",
        idempotency_key: key,
      },
    });

    expect(res.status).toBe(502);
    expect(res.body.sent).toBeNull();
    expect(res.body.retry_safe).toBe(false);
    expect(res.body.reconciliation_required).toBe(true);
    expect(String(res.body.error)).toMatch(/may or may not have been sent/i);
    const row = await rowByKey(key);
    expect(row?.send_state).toBe("uncertain");
  });

  it("replaying a completed intent returns the existing message (200 idempotent_replay), not a second send", async () => {
    let providerCalls = 0;
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        providerCalls += 1;
        return "provider-once";
      },
    });
    const { token } = await makeTenant("replay-once");
    await registerSender(deps, token, "replayonce.example", "sender@replayonce.example");

    const key = `replay-${crypto.randomUUID()}`;
    const body = {
      from: "sender@replayonce.example",
      to: ["target@external.example"],
      subject: "send once",
      text: "body",
      idempotency_key: key,
    };
    const first = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(first.status).toBe(202);
    // `sent` + the provider's id sit at the TOP level of every provider-accepted
    // response, so a client checks one place regardless of which path answered.
    expect(first.body.sent).toBe(true);
    expect(first.body.provider_message_id).toBe("provider-once");

    const replay = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent_replay).toBe(true);
    expect(replay.body.message.id).toBe(first.body.message.id);
    expect(replay.body.sent).toBe(true);
    expect(replay.body.provider_message_id).toBe("provider-once");
    expect(providerCalls).toBe(1);
    expect(await rowCountByKey(key)).toBe(1);
  });

  it("never reports a sent replay when the ledger lacks provider proof", async () => {
    let providerCalls = 0;
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        providerCalls += 1;
        return "provider-proof";
      },
    });
    const { token } = await makeTenant("replay-missing-proof");
    await registerSender(
      deps,
      token,
      "replaymissingproof.example",
      "sender@replaymissingproof.example",
    );

    const key = `replay-missing-proof-${crypto.randomUUID()}`;
    const body = {
      from: "sender@replaymissingproof.example",
      to: ["target@external.example"],
      subject: "send once",
      text: "body",
      idempotency_key: key,
    };
    const first = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(first.status).toBe(202);
    await pgClient!.execute(
      `UPDATE messages SET provider_message_id = NULL WHERE idempotency_key = $1`,
      [key],
    );

    const replay = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      reason: "provider_proof_missing",
      sent: null,
      retry_safe: false,
      reconciliation_required: true,
    });
    expect(replay.body.idempotent_replay).toBeUndefined();
    expect(providerCalls).toBe(1);
  });

  it("a failed re-arm answers 503 sent:false (nothing was sent) instead of a generic 500 that hides the outcome", async () => {
    let fail = true;
    let providerCalls = 0;
    const deps = makeDeps({
      provider: "ses",
      send: async () => {
        providerCalls += 1;
        if (fail) throw sesError("MessageRejected", "Email address is not verified.", 400, "client");
        return "provider-after-rearm";
      },
    });
    const { token } = await makeTenant("rearm-503");
    await registerSender(deps, token, "rearm503.example", "sender@rearm503.example");

    const key = `rearm-${crypto.randomUUID()}`;
    const body = {
      from: "sender@rearm503.example",
      to: ["someone@external.example"],
      subject: "rearm outage",
      text: "body",
      idempotency_key: key,
    };
    const first = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(first.status).toBe(422);

    // Simulate a DB outage hitting ONLY the re-arm step of the retry.
    const original = TenantScopedStore.prototype.rearmFailedSendIntent;
    TenantScopedStore.prototype.rearmFailedSendIntent = async () => {
      throw new Error("simulated rearm outage");
    };
    let outage: { status: number; body: any };
    try {
      outage = await call(deps, "POST", "/v1/messages/send", { token, body });
    } finally {
      TenantScopedStore.prototype.rearmFailedSendIntent = original;
    }
    expect(outage.status).toBe(503);
    expect(outage.body.sent).toBe(false);
    expect(outage.body.reason).toBe("rearm_failed");
    expect(outage.body.retry_safe).toBe(true);
    expect(String(outage.body.error)).toMatch(/NOTHING was sent/);
    // The provider was never invoked during the outage retry.
    expect(providerCalls).toBe(1);

    // With the store healthy again, the same key retries on the SAME row.
    fail = false;
    const second = await call(deps, "POST", "/v1/messages/send", { token, body });
    expect(second.status).toBe(202);
    expect(second.body.sent).toBe(true);
    expect(second.body.provider_message_id).toBe("provider-after-rearm");
    expect(await rowCountByKey(key)).toBe(1);
  });
});
