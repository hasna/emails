// Provider webhook receivers against a REAL Postgres (EMAILS_TEST_POSTGRES_URL).
//
// The unit suite (webhooks.test.ts) proves the routing, the security order and
// the tenant scoping against an in-memory double. This suite closes the only gap
// that double cannot: that the rows the receivers write are really there, in the
// operator's Postgres, under the real migrated schema and its real constraints —
// including the (tenant_id, provider, event_id) receipt uniqueness and the
// (tenant_id, source_id) message uniqueness the idempotency claims rest on.
//
// Every acceptance assertion is a READ back out of Postgres through the same
// tenant-scoped store `/v1` serves. A 200 from the handler proves nothing here.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { testAuthEnv } from "./auth/test-support.js";
import type { AuthMailerConfig } from "./auth/mailer.js";
import type { SelfHostedKeyStore } from "./keys.js";
import { resourceSpecForPath } from "./resources.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:emails-inbound";
const BUCKET = "acme-operator-inbound";
const PREFIX = "inbound/";
const RESEND_SECRET = `whsec_${Buffer.from("resend-integration-secret").toString("base64")}`;

const EVENTS_SPEC = resourceSpecForPath("events")!;
const RECEIPTS_SPEC = resourceSpecForPath("webhook-receipts")!;

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

function rawEmail(subject: string): string {
  return [
    "From: Alice <alice@external.com>",
    "To: ops@acme-inbound.test",
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@external.com>`,
    "Date: Thu, 02 Jul 2026 09:59:00 +0000",
    "",
    "integration body",
    "",
  ].join("\r\n");
}

function makeDeps(options: {
  objects?: Map<string, string>;
  verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
  resendSecret?: string | undefined;
} = {}): { deps: SelfHostedServiceDeps; fetched: string[] } {
  const fetched: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...testAuthEnv(),
    EMAILS_SNS_TOPIC_ARNS: TOPIC_ARN,
    EMAILS_AWS_ACCOUNT_IDS: "123456789012",
    EMAILS_INGEST_S3_BUCKET: BUCKET,
    EMAILS_INGEST_S3_PREFIX: PREFIX,
    AWS_REGION: "us-east-1",
  };
  if (options.resendSecret !== undefined) env["RESEND_WEBHOOK_SECRET"] = options.resendSecret;
  const deps: SelfHostedServiceDeps = {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => `mock-${randomUUID()}` },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    authStore: new AuthStore(pgClient!),
    keyStore: stubKeyStore,
    signingSecret: SIGNING_SECRET,
    rateLimiter: new RateLimiter(),
    mailer: MAILER,
    env,
    webhooks: {
      ...(options.verifySns ? { verifySns: options.verifySns } : {}),
      fetchObject: async (bucket, key) => {
        if (bucket !== BUCKET) throw new Error(`unexpected bucket ${bucket}`);
        const body = options.objects?.get(key);
        if (body === undefined) throw new Error(`no test object at ${key}`);
        return Buffer.from(body, "utf8");
      },
      fetchUrl: async (url: string) => { fetched.push(url); },
    },
  };
  return { deps, fetched };
}

let snsSequence = 0;

function snsEnvelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    MessageId: `sns-int-${randomUUID()}-${++snsSequence}`,
    TopicArn: TOPIC_ARN,
    Signature: "test-signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    Timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function snsPost(body: unknown, path = "/v1/webhooks/ses-inbound"): Request {
  return new Request(`http://svc${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resendPost(body: unknown, options: { id?: string; secret?: string; signature?: string } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const id = options.id ?? randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signature = options.signature;
  if (!signature) {
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from((options.secret ?? RESEND_SECRET).replace(/^whsec_/, ""), "base64"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
    signature = `v1,${Buffer.from(signed).toString("base64")}`;
  }
  return new Request("http://svc/v1/webhooks/resend-inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body: raw,
  });
}

/** A tenant that owns an inbound domain claim (the only address→tenant map). */
async function makeRoutedTenant(slug: string, domain: string): Promise<string> {
  const tenant = await pgClient!.one<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id`,
    [slug],
  );
  await pgClient!.execute(
    `INSERT INTO inbound_domain_routes (domain, tenant_id) VALUES ($1, $2)`,
    [domain, tenant.id],
  );
  return tenant.id;
}

async function count(table: string, tenantId: string): Promise<number> {
  const row = await pgClient!.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(row.n);
}

async function json(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return await response!.json() as Record<string, unknown>;
}

const alwaysVerified = async () => true;

beforeAll(async () => {
  if (!pgClient) return;
  await pgClient.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pgClient.execute("CREATE SCHEMA public");
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});

afterAll(async () => {
  await pgClient?.close();
});

describe.skipIf(!pgClient)("SES inbound webhook lands in the operator's Postgres", () => {
  it("stores a signed Received notification and reads it back through the tenant store", async () => {
    const domain = "ses-inbound-1.test";
    const tenantId = await makeRoutedTenant("wh-ses-1", domain);
    const key = `${PREFIX}${domain}/msg-1`;
    const objects = new Map([[key, rawEmail("SES integration inbound")]]);
    const { deps } = makeDeps({ objects, verifySns: alwaysVerified });

    const body = await json(await handleSelfHostedRequest(deps, snsPost(snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Received",
        mail: { messageId: "msg-1", source: "alice@external.com", timestamp: "2026-07-02T10:00:00.000Z" },
        receipt: {
          recipients: [`ops@${domain}`],
          // A forged bucket in the payload must never be used.
          action: { type: "S3", bucketName: "attacker-bucket", objectKey: key },
        },
      }),
    }))));
    expect(body).toMatchObject({ ok: true, synced: 1, object_key: key });

    const scoped = deps.store.forTenant(tenantId);
    const messageId = await scoped.findMessageIdByKey(key);
    expect(messageId).not.toBeNull();
    const message = await scoped.getMessage(messageId!);
    expect(message!.subject).toBe("SES integration inbound");
    expect(message!.direction).toBe("inbound");
    expect(message!.to_addrs).toEqual([`ops@${domain}`]);
    // Provenance is bound to the OPERATOR-configured bucket, not the payload's.
    expect(await scoped.getInboundSourceProvenance(messageId!)).toMatchObject({
      bucket: BUCKET,
      object_key: key,
    });
    // The idempotency receipt is a real, tenant-scoped Postgres row.
    const receipts = await scoped.listResource(RECEIPTS_SPEC, { filters: { provider: "sns" } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!["resource_id"]).toBe(messageId);
    expect(await count("messages", tenantId)).toBe(1);
  });

  it("replaying the same SNS MessageId leaves exactly one message and one receipt", async () => {
    const domain = "ses-inbound-2.test";
    const tenantId = await makeRoutedTenant("wh-ses-2", domain);
    const key = `${PREFIX}${domain}/msg-2`;
    const objects = new Map([[key, rawEmail("SES replay")]]);
    const { deps } = makeDeps({ objects, verifySns: alwaysVerified });
    const envelope = snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Received",
        mail: { messageId: "msg-2" },
        receipt: { recipients: [`ops@${domain}`], action: { objectKey: key } },
      }),
    });

    const first = await json(await handleSelfHostedRequest(deps, snsPost(envelope)));
    const second = await json(await handleSelfHostedRequest(deps, snsPost(envelope)));
    expect(first["synced"]).toBe(1);
    expect(second["duplicate"]).toBe(true);
    expect(await count("messages", tenantId)).toBe(1);
    expect(await count("webhook_receipts", tenantId)).toBe(1);
  });

  it("an invalid SNS signature writes nothing at all", async () => {
    const domain = "ses-inbound-3.test";
    const tenantId = await makeRoutedTenant("wh-ses-3", domain);
    const key = `${PREFIX}${domain}/msg-3`;
    const { deps } = makeDeps({
      objects: new Map([[key, rawEmail("never stored")]]),
      verifySns: async () => false,
    });

    const response = await handleSelfHostedRequest(deps, snsPost(snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Received",
        mail: { messageId: "msg-3" },
        receipt: { recipients: [`ops@${domain}`], action: { objectKey: key } },
      }),
    })));
    expect(response!.status).toBe(401);
    expect(await count("messages", tenantId)).toBe(0);
    expect(await count("webhook_receipts", tenantId)).toBe(0);
    expect(await count("events", tenantId)).toBe(0);
  });

  it("mail for an unclaimed domain is quarantined and never acknowledged", async () => {
    const key = `${PREFIX}unclaimed.test/msg-4`;
    const { deps } = makeDeps({
      objects: new Map([[key, rawEmail("unroutable")]]),
      verifySns: alwaysVerified,
    });
    const body = await json(await handleSelfHostedRequest(deps, snsPost(snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Received",
        mail: { messageId: "msg-4" },
        receipt: { recipients: ["ops@unclaimed.test"], action: { objectKey: key } },
      }),
    }))));
    expect(body["ignored"]).toBe("no_tenant_route");
    const quarantined = await pgClient!.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM inbound_quarantine WHERE source_id = $1`,
      [key],
    );
    expect(Number(quarantined.n)).toBe(1);
  });
});

describe.skipIf(!pgClient)("Resend inbound webhook lands in the operator's Postgres", () => {
  it("stores a signed inbound payload and reads it back through the tenant store", async () => {
    const domain = "resend-inbound-1.test";
    const tenantId = await makeRoutedTenant("wh-resend-1", domain);
    const { deps } = makeDeps({ resendSecret: RESEND_SECRET });

    const body = await json(await handleSelfHostedRequest(deps, await resendPost({
      type: "inbound.email.received",
      created_at: "2026-06-03T10:00:00.000Z",
      data: {
        email_id: "re_int_1",
        from: "alice@ext.test",
        to: [`ops@${domain}`],
        subject: "Resend integration inbound",
        text: "hi there",
        html: "<p>hi there</p>",
        headers: {},
      },
    })));
    expect(body["ok"]).toBe(true);

    const scoped = deps.store.forTenant(tenantId);
    const message = await scoped.getMessage(String(body["id"]));
    expect(message).not.toBeNull();
    expect(message!.subject).toBe("Resend integration inbound");
    expect(message!.from_addr).toBe("alice@ext.test");
    expect(message!.direction).toBe("inbound");
    expect(message!.source_id).toBe("resend:re_int_1");
    expect(await count("messages", tenantId)).toBe(1);
    expect(await count("webhook_receipts", tenantId)).toBe(1);
  });

  it("replaying the same svix-id leaves exactly one message", async () => {
    const domain = "resend-inbound-2.test";
    const tenantId = await makeRoutedTenant("wh-resend-2", domain);
    const { deps } = makeDeps({ resendSecret: RESEND_SECRET });
    const payload = {
      type: "inbound.email.received",
      created_at: "2026-06-03T10:00:00.000Z",
      data: { email_id: "re_int_2", from: "alice@ext.test", to: [`ops@${domain}`], subject: "replay", text: "x", headers: {} },
    };

    const first = await json(await handleSelfHostedRequest(deps, await resendPost(payload, { id: "svix-replay" })));
    const second = await json(await handleSelfHostedRequest(deps, await resendPost(payload, { id: "svix-replay" })));
    expect(first["id"]).toBeTruthy();
    expect(second["duplicate"]).toBe(true);
    expect(second["id"]).toBe(first["id"]);
    expect(await count("messages", tenantId)).toBe(1);
    expect(await count("webhook_receipts", tenantId)).toBe(1);
  });

  it("a wrongly-signed payload writes nothing", async () => {
    const domain = "resend-inbound-3.test";
    const tenantId = await makeRoutedTenant("wh-resend-3", domain);
    const { deps } = makeDeps({ resendSecret: RESEND_SECRET });
    const response = await handleSelfHostedRequest(deps, await resendPost({
      type: "inbound.email.received",
      data: { email_id: "re_int_3", from: "a@ext.test", to: [`ops@${domain}`], subject: "nope", text: "x", headers: {} },
    }, { secret: `whsec_${Buffer.from("wrong-secret").toString("base64")}` }));
    expect(response!.status).toBe(401);
    expect(await count("messages", tenantId)).toBe(0);
  });

  it("an unconfigured Resend secret fails CLOSED with 503 and writes nothing", async () => {
    const domain = "resend-inbound-4.test";
    const tenantId = await makeRoutedTenant("wh-resend-4", domain);
    const { deps } = makeDeps({ resendSecret: undefined });
    const response = await handleSelfHostedRequest(deps, await resendPost({
      type: "inbound.email.received",
      data: { email_id: "re_int_4", from: "a@ext.test", to: [`ops@${domain}`], subject: "nope", text: "x", headers: {} },
    }));
    expect(response!.status).toBe(503);
    expect(await count("messages", tenantId)).toBe(0);
  });
});

describe.skipIf(!pgClient)("delivery outcomes land in the operator's Postgres", () => {
  it("a signed SES bounce is persisted in the sending tenant's scope and joined to the send", async () => {
    const domain = "bounce-1.test";
    const tenantId = await makeRoutedTenant("wh-bounce-1", domain);
    const sent = await new EmailsSelfHostedStore(pgClient!).forTenant(tenantId).createMessage({
      from_addr: `noreply@${domain}`,
      to_addrs: ["dead@external.test"],
      direction: "outbound",
      status: "sent",
      message_id: "ses-bounced-1",
      subject: "campaign",
    });

    const { deps } = makeDeps({ verifySns: alwaysVerified });
    const body = await json(await handleSelfHostedRequest(deps, snsPost(snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Bounce",
        mail: {
          messageId: "ses-bounced-1",
          source: `noreply@${domain}`,
          destination: ["dead@external.test"],
          timestamp: "2026-07-02T11:00:00.000Z",
        },
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "dead@external.test" }] },
      }),
    }))));
    expect(body).toMatchObject({ ok: true, type: "bounced", message_id: "ses-bounced-1" });

    const events = await deps.store.forTenant(tenantId).listResource(EVENTS_SPEC, { filters: { type: "bounced" } });
    expect(events).toHaveLength(1);
    expect(events[0]!["recipient"]).toBe("dead@external.test");
    // The bounce is joined to the outbound row a suppression pass would act on.
    expect(events[0]!["email_id"]).toBe(sent.id);
    expect(await count("events", tenantId)).toBe(1);
  });

  it("replaying the same bounce leaves exactly one event row", async () => {
    const domain = "bounce-2.test";
    const tenantId = await makeRoutedTenant("wh-bounce-2", domain);
    const { deps } = makeDeps({ verifySns: alwaysVerified });
    const envelope = snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Complaint",
        mail: {
          messageId: "ses-complained-1",
          source: `noreply@${domain}`,
          destination: ["angry@external.test"],
          timestamp: "2026-07-02T11:00:00.000Z",
        },
        complaint: { complainedRecipients: [{ emailAddress: "angry@external.test" }] },
      }),
    });

    const first = await json(await handleSelfHostedRequest(deps, snsPost(envelope)));
    const second = await json(await handleSelfHostedRequest(deps, snsPost(envelope)));
    expect(first["event_id"]).toBeTruthy();
    expect(second["duplicate"]).toBe(true);
    expect(await count("events", tenantId)).toBe(1);
  });

  it("a Resend delivery event is persisted in the sending tenant's scope", async () => {
    const domain = "bounce-3.test";
    const tenantId = await makeRoutedTenant("wh-bounce-3", domain);
    const { deps } = makeDeps({ resendSecret: RESEND_SECRET });
    const body = await json(await handleSelfHostedRequest(deps, await resendPost({
      type: "email.bounced",
      data: {
        email_id: "re_bounced_1",
        from: `noreply@${domain}`,
        to: ["dead@external.test"],
        created_at: "2026-07-02T11:00:00.000Z",
      },
    })));
    expect(body).toMatchObject({ ok: true, type: "bounced" });
    expect(await count("events", tenantId)).toBe(1);
  });

  it("a delivery outcome from an unclaimed sending domain writes nothing", async () => {
    const { deps } = makeDeps({ verifySns: alwaysVerified });
    const before = await pgClient!.one<{ n: string }>(`SELECT count(*)::text AS n FROM events`);
    const body = await json(await handleSelfHostedRequest(deps, snsPost(snsEnvelope({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Bounce",
        mail: { messageId: "orphan-1", source: "noreply@unclaimed-sender.test", destination: ["x@external.test"] },
        bounce: { bounceType: "Permanent" },
      }),
    }))));
    expect(body["ignored"]).toBe("no destination scope for delivery notification");
    const after = await pgClient!.one<{ n: string }>(`SELECT count(*)::text AS n FROM events`);
    expect(after.n).toBe(before.n);
  });
});

describe.skipIf(!pgClient)("cross-tenant isolation of the receivers", () => {
  it("one provider event never leaks into another tenant's scope", async () => {
    const domainA = "iso-a.test";
    const domainB = "iso-b.test";
    const tenantA = await makeRoutedTenant("wh-iso-a", domainA);
    const tenantB = await makeRoutedTenant("wh-iso-b", domainB);
    const { deps } = makeDeps({ resendSecret: RESEND_SECRET });

    const body = await json(await handleSelfHostedRequest(deps, await resendPost({
      type: "inbound.email.received",
      created_at: "2026-06-03T10:00:00.000Z",
      data: {
        email_id: "re_iso_1",
        from: "alice@ext.test",
        to: [`ops@${domainA}`],
        subject: "isolation",
        text: "x",
        headers: {},
        // A payload field must never select the tenant.
        tenant_id: tenantB,
      },
    })));

    expect(await deps.store.forTenant(tenantA).getMessage(String(body["id"]))).not.toBeNull();
    expect(await deps.store.forTenant(tenantB).getMessage(String(body["id"]))).toBeNull();
    expect(await count("messages", tenantB)).toBe(0);
    expect(await count("webhook_receipts", tenantB)).toBe(0);
  });
});
