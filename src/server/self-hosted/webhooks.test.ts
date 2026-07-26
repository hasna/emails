// End-to-end coverage for the provider webhook receivers mounted on the
// self-hosted service.
//
// The bar here is deliberately NOT "the handler returned 200". Every acceptance
// test reads the row back out through the operator's store (the same
// `EmailsSelfHostedStore.forTenant(...)` API `/v1` serves), and every rejection
// test asserts the store is still empty. That is the only way to catch the
// failure this suite exists for: a route that is reachable but whose writes land
// somewhere other than the operator's Postgres — accepted mail the operator
// cannot read, which is worse than a 404 because the provider stops retrying.
//
// The query client below is an in-memory Postgres double. It answers ONLY the
// statement shapes this path issues and THROWS on anything else, so an
// unimplemented query fails the test loudly instead of quietly returning no
// rows.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { verifyApiKey } from "@hasna/contracts/auth";
import type { PoolQueryClient, TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { resourceSpecForPath } from "./resources.js";
import {
  RESEND_INBOUND_V1_WEBHOOK_PATH,
  SES_INBOUND_V1_WEBHOOK_PATH,
} from "../webhooks/receivers.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:emails-inbound";
const BUCKET = "acme-operator-inbound";
const PREFIX = "inbound/";
const OBJECT_KEY = "inbound/acme.com/msgkey123";
const RESEND_SECRET = `whsec_${Buffer.from("resend-selfhosted-test-secret").toString("base64")}`;

const EVENTS_SPEC = resourceSpecForPath("events")!;
const RECEIPTS_SPEC = resourceSpecForPath("webhook-receipts")!;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// In-memory Postgres double
// ---------------------------------------------------------------------------

interface FakeDb {
  client: PoolQueryClient;
  tables: Map<string, Row[]>;
  seenSql: string[];
}

function rowsOf(tables: Map<string, Row[]>, table: string): Row[] {
  const existing = tables.get(table);
  if (existing) return existing;
  const created: Row[] = [];
  tables.set(table, created);
  return created;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Build an inserted row from `INSERT INTO t (cols) VALUES (placeholders)`. */
function insertRow(sql: string, params: readonly unknown[]): { table: string; row: Row } {
  const table = /INSERT INTO ([a-z_]+)/i.exec(sql)?.[1] ?? "";
  const cols = (/INSERT INTO [a-z_]+ \(([^)]*)\)/i.exec(sql)?.[1] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const tokens = (/VALUES \(([^)]*)\)/i.exec(sql)?.[1] ?? "")
    .split(",").map((value) => value.trim());
  if (cols.length === 0 || cols.length !== tokens.length) {
    throw new Error(`fake pg: cannot parse INSERT column/value shape: ${normalize(sql).slice(0, 160)}`);
  }
  const row: Row = {};
  cols.forEach((col, index) => {
    const token = tokens[index] ?? "";
    const position = Number(/\$(\d+)/.exec(token)?.[1] ?? "0");
    if (position === 0) throw new Error(`fake pg: non-placeholder INSERT value "${token}"`);
    let value = params[position - 1];
    if (/::jsonb/i.test(token) && typeof value === "string") {
      try { value = JSON.parse(value); } catch { /* keep the raw string */ }
    }
    row[col] = value;
  });
  const stamp = new Date().toISOString();
  row["created_at"] ??= stamp;
  row["updated_at"] ??= stamp;
  row["completed_at"] ??= stamp;
  row["occurred_at"] ??= stamp;
  return { table, row };
}

function conflictKeys(sql: string, table: string): string[] {
  const explicit = /ON CONFLICT \(([a-z_,\s]+)\)/i.exec(sql)?.[1];
  if (explicit) return explicit.split(",").map((value) => value.trim()).filter(Boolean);
  if (table === "inbound_message_sources") return ["tenant_id", "message_id"];
  throw new Error(`fake pg: ON CONFLICT with no target on ${table}`);
}

function fakeDb(): FakeDb {
  const tables = new Map<string, Row[]>();
  const seenSql: string[] = [];

  function unsupported(sql: string): never {
    throw new Error(`fake pg: unsupported statement: ${normalize(sql).slice(0, 220)}`);
  }

  /** Every statement resolves to a row list; callers pick get/one/many from it. */
  function run(sql: string, params: readonly unknown[] = []): Row[] {
    seenSql.push(normalize(sql));
    const flat = normalize(sql);

    // Layer-2 tenant GUC + readiness probes: no-ops for the double.
    if (/set_config\('app\.current_tenant'/i.test(flat)) return [];
    if (/^SELECT 1\b/i.test(flat)) return [{ ok: 1 }];
    if (/^SELECT id, checksum FROM schema_migrations/i.test(flat)) return [];

    if (/^INSERT INTO/i.test(flat)) {
      const { table, row } = insertRow(sql, params);
      const rows = rowsOf(tables, table);
      if (/ON CONFLICT/i.test(flat)) {
        const keys = conflictKeys(sql, table);
        const clash = rows.find((existing) => keys.every((key) => existing[key] === row[key]));
        if (clash) {
          if (/DO UPDATE SET/i.test(flat)) {
            for (const [key, value] of Object.entries(row)) {
              if (key === "id" || key === "created_at") continue;
              clash[key] = value;
            }
            clash["updated_at"] = new Date().toISOString();
            return [{ ...clash, inserted: false }];
          }
          return []; // DO NOTHING
        }
      }
      rows.push(row);
      return [{ ...row, inserted: true }];
    }

    // resolveInboundRecipients: the ONE global address -> tenant map.
    if (/FROM inbound_domain_routes r JOIN tenants t/i.test(flat)) {
      const wanted = new Set((params[0] as string[]).map((value) => value.toLowerCase()));
      const activeTenants = new Set(
        rowsOf(tables, "tenants").filter((row) => row["status"] === "active").map((row) => row["id"]),
      );
      return rowsOf(tables, "inbound_domain_routes")
        .filter((row) => wanted.has(String(row["domain"]).toLowerCase()))
        .filter((row) => activeTenants.has(row["tenant_id"]))
        .map((row) => ({ domain: row["domain"], tenant_id: row["tenant_id"] }));
    }

    // findMessageIdByKey
    if (/FROM messages WHERE \(source_id = \$1 OR message_id = \$1\) AND tenant_id = \$2/i.test(flat)) {
      const [key, tenantId] = params as [string, string];
      const hit = rowsOf(tables, "messages")
        .find((row) => row["tenant_id"] === tenantId && (row["source_id"] === key || row["message_id"] === key));
      return hit ? [{ id: hit["id"] }] : [];
    }

    // createInboundMessageWithProvenance conflict re-read
    if (/FROM messages WHERE tenant_id = \$1::uuid AND source_id = \$2/i.test(flat)) {
      const [tenantId, sourceId] = params as [string, string];
      return rowsOf(tables, "messages")
        .filter((row) => row["tenant_id"] === tenantId && row["source_id"] === sourceId);
    }

    // getMessage
    if (/FROM messages WHERE id = \$1 AND tenant_id = \$2/i.test(flat)) {
      const [id, tenantId] = params as [string, string];
      return rowsOf(tables, "messages").filter((row) => row["id"] === id && row["tenant_id"] === tenantId);
    }

    if (/FROM inbound_message_sources WHERE tenant_id = \$1(?:::uuid)? AND message_id = \$2/i.test(flat)) {
      const [tenantId, messageId] = params as [string, string];
      return rowsOf(tables, "inbound_message_sources")
        .filter((row) => row["tenant_id"] === tenantId && row["message_id"] === messageId);
    }

    // Generic resource list: SELECT * FROM <t> WHERE tenant_id = $1 [AND col = $n] ...
    const resourceList = /^SELECT \* FROM ([a-z_]+) WHERE (.+?) ORDER BY/i.exec(flat);
    if (resourceList) {
      const table = resourceList[1]!;
      const predicates = resourceList[2]!.split(/\s+AND\s+/i).map((clause) => {
        const match = /^([a-z_]+) = \$(\d+)$/.exec(clause.trim());
        if (!match) throw new Error(`fake pg: unsupported list predicate "${clause}"`);
        return { column: match[1]!, value: params[Number(match[2]) - 1] };
      });
      return rowsOf(tables, table)
        .filter((row) => predicates.every(({ column, value }) => row[column] === value));
    }

    // assertNotOtherTenant (only reached when a body carries an FK id)
    const fkProbe = /^SELECT tenant_id FROM ([a-z_]+) WHERE id = \$1$/i.exec(flat);
    if (fkProbe) {
      return rowsOf(tables, fkProbe[1]!).filter((row) => row["id"] === params[0]);
    }

    return unsupported(sql);
  }

  const client: PoolQueryClient = {
    async query<T extends Row>(sql: string, params?: readonly unknown[]) {
      const rows = run(sql, params) as T[];
      return { rows, rowCount: rows.length };
    },
    async many<T extends Row>(sql: string, params?: readonly unknown[]) {
      return run(sql, params) as T[];
    },
    async get<T extends Row>(sql: string, params?: readonly unknown[]) {
      return (run(sql, params)[0] as T | undefined) ?? null;
    },
    async one<T extends Row>(sql: string, params?: readonly unknown[]) {
      const rows = run(sql, params);
      if (rows.length === 0) throw new Error(`fake pg: one() returned no row for ${normalize(sql).slice(0, 120)}`);
      return rows[0] as T;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      run(sql, params);
    },
    async transaction<T>(fn: (tx: TypedQueryClient) => Promise<T>) {
      return fn(client);
    },
  } as PoolQueryClient;

  return { client, tables, seenSql };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RAW_EMAIL = [
  "From: Alice <alice@external.com>",
  "To: ops@acme.com",
  "Subject: Hello from S3",
  "Message-ID: <real-rfc-id@external.com>",
  "Date: Thu, 02 Jul 2026 09:59:00 +0000",
  "",
  "body text",
  "",
].join("\r\n");

interface Harness {
  deps: SelfHostedServiceDeps;
  store: EmailsSelfHostedStore;
  db: FakeDb;
  fetched: string[];
}

function harness(options: {
  verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
  resendSecret?: string | undefined;
  routedDomains?: Array<{ domain: string; tenantId: string }>;
  tenants?: Array<{ id: string; status: string }>;
} = {}): Harness {
  const db = fakeDb();
  const store = new EmailsSelfHostedStore(db.client);
  const fetched: string[] = [];

  for (const tenant of options.tenants ?? [{ id: TENANT_A, status: "active" }, { id: TENANT_B, status: "active" }]) {
    rowsOf(db.tables, "tenants").push({ id: tenant.id, status: tenant.status });
  }
  const routes = options.routedDomains ?? [{ domain: "acme.com", tenantId: TENANT_A }];
  for (const route of routes) {
    rowsOf(db.tables, "inbound_domain_routes").push({ domain: route.domain, tenant_id: route.tenantId });
  }

  const env: NodeJS.ProcessEnv = {
    EMAILS_SNS_TOPIC_ARNS: TOPIC_ARN,
    EMAILS_AWS_ACCOUNT_IDS: "123456789012",
    EMAILS_INGEST_S3_BUCKET: BUCKET,
    EMAILS_INGEST_S3_PREFIX: PREFIX,
    AWS_REGION: "us-east-1",
  };
  if (options.resendSecret !== undefined) env["RESEND_WEBHOOK_SECRET"] = options.resendSecret;

  const deps: SelfHostedServiceDeps = {
    client: db.client,
    store,
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(db.client, SIGNING_SECRET),
    env,
    webhooks: {
      ...(options.verifySns ? { verifySns: options.verifySns } : {}),
      fetchObject: async (bucket, key) => {
        if (bucket !== BUCKET) throw new Error(`unexpected bucket ${bucket}`);
        if (key !== OBJECT_KEY) throw new Error(`unexpected key ${key}`);
        return Buffer.from(RAW_EMAIL, "utf8");
      },
      fetchUrl: async (url: string) => { fetched.push(url); },
      now: () => "2026-07-02T10:00:00.000Z",
    },
  };
  return { deps, store, db, fetched };
}

let snsSequence = 0;

function snsEnvelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    MessageId: `sns-selfhosted-${++snsSequence}`,
    TopicArn: TOPIC_ARN,
    Signature: "test-signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem",
    Timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function sesReceived(): string {
  return JSON.stringify({
    notificationType: "Received",
    mail: { messageId: "msgkey123", source: "alice@external.com", timestamp: "2026-07-02T10:00:00.000Z" },
    receipt: {
      recipients: ["ops@acme.com"],
      action: { type: "S3", bucketName: "attacker-controlled-bucket", objectKey: OBJECT_KEY },
    },
  });
}

function sesDelivery(kind: "Bounce" | "Complaint", providerMessageId = "ses-outbound-1"): string {
  return JSON.stringify({
    notificationType: kind,
    mail: {
      messageId: providerMessageId,
      source: "noreply@acme.com",
      destination: ["dead@external.com"],
      timestamp: "2026-07-02T11:00:00.000Z",
    },
    ...(kind === "Bounce"
      ? { bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "dead@external.com" }] } }
      : { complaint: { complainedRecipients: [{ emailAddress: "dead@external.com" }] } }),
  });
}

function snsRequest(body: unknown, path = "/v1/webhooks/ses-inbound"): Request {
  return new Request(`http://selfhosted.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resendRequest(
  body: unknown,
  options: { id?: string; secret?: string; signature?: string } = {},
): Promise<Request> {
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
  return new Request("http://selfhosted.test/v1/webhooks/resend-inbound", {
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

const resendInboundEvent = {
  type: "inbound.email.received",
  created_at: "2026-06-03T10:00:00.000Z",
  data: {
    email_id: "re_selfhosted_1",
    from: "alice@ext.com",
    to: ["ops@acme.com"],
    subject: "Hello via Resend",
    text: "hi there",
    html: "<p>hi there</p>",
    headers: {},
    // A payload MUST NOT be able to nominate its own destination tenant.
    tenant_id: TENANT_B,
  },
};

async function json(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return await response!.json() as Record<string, unknown>;
}

function storedRowCount(db: FakeDb, table: string): number {
  return (db.tables.get(table) ?? []).length;
}

const alwaysVerified = async () => true;
const neverVerified = async () => false;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

describe("self-hosted webhook mount", () => {
  test("every documented webhook route is actually mounted, and vice versa", async () => {
    const documented = Object.keys(emailsSelfHostedOpenApi.paths as Record<string, unknown>)
      .filter((path) => path.startsWith("/v1/webhooks/"))
      .sort();
    expect(documented).toEqual([SES_INBOUND_V1_WEBHOOK_PATH, RESEND_INBOUND_V1_WEBHOOK_PATH].sort());
    for (const path of documented) {
      const { deps } = harness({ verifySns: alwaysVerified, resendSecret: RESEND_SECRET });
      // Claimed by the service (not a 404 fall-through) with an empty POST body.
      const response = await handleSelfHostedRequest(
        deps,
        new Request(`http://selfhosted.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response, path).not.toBeNull();
      expect(response!.status, path).not.toBe(404);
    }
  });

  test("the hosted service owns both provider webhook routes", async () => {
    for (const path of ["/v1/webhooks/ses-inbound", "/v1/webhooks/resend-inbound"]) {
      const { deps } = harness({ verifySns: alwaysVerified, resendSecret: RESEND_SECRET });
      // Not a 404: before this mount every /v1 path outside the documented set
      // fell through to "not found", so no provider could reach the service.
      const response = await handleSelfHostedRequest(
        deps,
        new Request(`http://selfhosted.test${path}`, { method: "GET" }),
      );
      expect(response, path).not.toBeNull();
      expect(response!.status, path).toBe(405);
    }
  });

  test("a provider reaches the routes with no Hasna API key", async () => {
    const { deps, store } = harness({ verifySns: alwaysVerified });
    const response = await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    );
    // No x-api-key and no bearer token were sent; the SNS signature and the
    // topic/account allowlist are the authentication.
    expect(response!.status).toBe(200);
    expect(await store.forTenant(TENANT_A).findMessageIdByKey(OBJECT_KEY)).not.toBeNull();
  });

  test("an unknown /v1 path is still not found (the mount did not widen the surface)", async () => {
    const { deps } = harness({ verifySns: alwaysVerified });
    const response = await handleSelfHostedRequest(
      deps,
      new Request("http://selfhosted.test/v1/webhooks/unknown-provider", { method: "POST" }),
    );
    expect(response!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: the mail is in the operator's store
// ---------------------------------------------------------------------------

describe("SES inbound reaches the operator's store", () => {
  test("a signed SNS Received notification is retrievable through the tenant store", async () => {
    const { deps, store, db } = harness({ verifySns: alwaysVerified });

    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    ));
    expect(body).toMatchObject({ ok: true, synced: 1, object_key: OBJECT_KEY });

    const scoped = store.forTenant(TENANT_A);
    const id = await scoped.findMessageIdByKey(OBJECT_KEY);
    expect(id).not.toBeNull();
    const message = await scoped.getMessage(id!);
    expect(message).not.toBeNull();
    expect(message!.subject).toBe("Hello from S3");
    expect(message!.from_addr).toBe(`"Alice" <alice@external.com>`);
    expect(message!.body_text).toContain("body text");
    expect(message!.direction).toBe("inbound");
    // Stored recipients come from the trusted SES envelope, not the MIME header.
    expect(message!.to_addrs).toEqual(["ops@acme.com"]);
    expect(message!.source_id).toBe(OBJECT_KEY);

    // Immutable provenance and the idempotency receipt both landed in Postgres.
    expect(await scoped.getInboundSourceProvenance(id!)).toMatchObject({
      bucket: BUCKET,
      object_key: OBJECT_KEY,
    });
    expect(await scoped.listResource(RECEIPTS_SPEC, { filters: { provider: "sns", event_id: undefined } }))
      .toHaveLength(1);
    expect(storedRowCount(db, "messages")).toBe(1);
  });

  test("the payload's own bucket is never used", async () => {
    // fetchObject throws on any bucket other than the configured one, so a
    // successful ingest is itself proof the attacker-controlled bucket in the
    // notification was discarded.
    const { deps, store } = harness({ verifySns: alwaysVerified });
    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    ));
    expect(body["ok"]).toBe(true);
    const provenance = await store
      .forTenant(TENANT_A)
      .getInboundSourceProvenance((await store.forTenant(TENANT_A).findMessageIdByKey(OBJECT_KEY))!);
    expect(provenance!.bucket).toBe(BUCKET);
  });

  test("an object key outside the configured prefix stores nothing", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    const outside = JSON.stringify({
      notificationType: "Received",
      mail: { messageId: "msgkey999" },
      receipt: { recipients: ["ops@acme.com"], action: { objectKey: "elsewhere/evil" } },
    });
    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: outside })),
    ));
    expect(body["ignored"]).toBe("notification object key outside configured prefix");
    expect(storedRowCount(db, "messages")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });

  test("mail for an unclaimed domain is quarantined, never acknowledged", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified, routedDomains: [] });
    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    ));
    expect(body["ignored"]).toBe("no_tenant_route");
    expect(storedRowCount(db, "messages")).toBe(0);
    // Not acknowledged: the provider retries, and a later domain claim lands it.
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
    // The unroutable event is still recorded, not dropped on the floor.
    expect(storedRowCount(db, "inbound_quarantine")).toBe(1);
  });
});

describe("Resend inbound reaches the operator's store", () => {
  test("a signed Resend inbound payload is retrievable through the tenant store", async () => {
    const { deps, store, db } = harness({ resendSecret: RESEND_SECRET });

    const body = await json(await handleSelfHostedRequest(
      deps,
      await resendRequest(resendInboundEvent),
    ));
    expect(body["ok"]).toBe(true);
    expect(body["id"]).toBeTruthy();

    const scoped = store.forTenant(TENANT_A);
    const message = await scoped.getMessage(String(body["id"]));
    expect(message).not.toBeNull();
    expect(message!.subject).toBe("Hello via Resend");
    expect(message!.from_addr).toBe("alice@ext.com");
    expect(message!.body_text).toBe("hi there");
    expect(message!.direction).toBe("inbound");
    expect(message!.to_addrs).toEqual(["ops@acme.com"]);
    expect(storedRowCount(db, "messages")).toBe(1);
  });

  test("a payload field cannot choose the tenant", async () => {
    const { deps, store } = harness({ resendSecret: RESEND_SECRET });
    const body = await json(await handleSelfHostedRequest(deps, await resendRequest(resendInboundEvent)));
    // `data.tenant_id` names TENANT_B; routing came from the envelope recipient.
    expect(await store.forTenant(TENANT_A).getMessage(String(body["id"]))).not.toBeNull();
    expect(await store.forTenant(TENANT_B).getMessage(String(body["id"]))).toBeNull();
  });

  test("inbound for an unclaimed recipient domain stores nothing", async () => {
    const { deps, db } = harness({ resendSecret: RESEND_SECRET, routedDomains: [] });
    const body = await json(await handleSelfHostedRequest(deps, await resendRequest(resendInboundEvent)));
    expect(body["ignored"]).toBe("no destination scope for inbound recipients");
    expect(storedRowCount(db, "messages")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Delivery outcomes: the upstream half of suppression
// ---------------------------------------------------------------------------

describe("delivery outcomes reach the operator's store", () => {
  for (const [kind, expected] of [["Bounce", "bounced"], ["Complaint", "complained"]] as const) {
    test(`a signed SES ${kind} notification is persisted in the sending tenant's scope`, async () => {
      const { deps, store, db } = harness({ verifySns: alwaysVerified });
      // The outbound message the bounce refers to, so the stored event can be
      // joined to the send a suppression pass would act on.
      const sent = await store.forTenant(TENANT_A).createMessage({
        from_addr: "noreply@acme.com",
        to_addrs: ["dead@external.com"],
        direction: "outbound",
        status: "sent",
        message_id: "ses-outbound-1",
        subject: "campaign",
      });

      const body = await json(await handleSelfHostedRequest(
        deps,
        snsRequest(snsEnvelope({ Type: "Notification", Message: sesDelivery(kind) })),
      ));
      expect(body).toMatchObject({ ok: true, type: expected, message_id: "ses-outbound-1" });

      const events = await store.forTenant(TENANT_A).listResource(EVENTS_SPEC, { filters: { type: expected } });
      expect(events).toHaveLength(1);
      expect(events[0]!["recipient"]).toBe("dead@external.com");
      // Tenant-scoped and joined to the outbound row.
      expect(events[0]!["tenant_id"]).toBe(TENANT_A);
      expect(events[0]!["email_id"]).toBe(sent.id);
      // The other tenant sees nothing.
      expect(await store.forTenant(TENANT_B).listResource(EVENTS_SPEC, { filters: { type: expected } }))
        .toHaveLength(0);
      expect(storedRowCount(db, "events")).toBe(1);
    });
  }

  test("a Resend delivery event is persisted in the sending tenant's scope", async () => {
    const { deps, store } = harness({ resendSecret: RESEND_SECRET });
    const body = await json(await handleSelfHostedRequest(deps, await resendRequest({
      type: "email.bounced",
      data: { email_id: "re_out_1", from: "noreply@acme.com", to: ["dead@external.com"], created_at: "2026-07-02T11:00:00.000Z" },
    })));
    expect(body).toMatchObject({ ok: true, type: "bounced" });
    const events = await store.forTenant(TENANT_A).listResource(EVENTS_SPEC, { filters: { type: "bounced" } });
    expect(events).toHaveLength(1);
    expect(events[0]!["recipient"]).toBe("dead@external.com");
  });

  test("a delivery outcome from an unclaimed sending domain stores nothing", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified, routedDomains: [] });
    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesDelivery("Bounce") })),
    ));
    expect(body["ignored"]).toBe("no destination scope for delivery notification");
    expect(storedRowCount(db, "events")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("replaying a provider event stores one record", () => {
  test("the same SNS MessageId twice ingests once", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    const envelope = snsEnvelope({ Type: "Notification", Message: sesReceived() });

    const first = await json(await handleSelfHostedRequest(deps, snsRequest(envelope)));
    const second = await json(await handleSelfHostedRequest(deps, snsRequest(envelope)));

    expect(first["synced"]).toBe(1);
    expect(second["duplicate"]).toBe(true);
    expect(storedRowCount(db, "messages")).toBe(1);
    expect(storedRowCount(db, "webhook_receipts")).toBe(1);
  });

  test("the same SNS bounce twice stores one event", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    const envelope = snsEnvelope({ Type: "Notification", Message: sesDelivery("Bounce") });

    const first = await json(await handleSelfHostedRequest(deps, snsRequest(envelope)));
    const second = await json(await handleSelfHostedRequest(deps, snsRequest(envelope)));

    expect(first["event_id"]).toBeTruthy();
    expect(second["duplicate"]).toBe(true);
    expect(storedRowCount(db, "events")).toBe(1);
  });

  test("the same svix-id twice stores one Resend message", async () => {
    const { deps, db } = harness({ resendSecret: RESEND_SECRET });
    const first = await json(await handleSelfHostedRequest(
      deps,
      await resendRequest(resendInboundEvent, { id: "evt-replay" }),
    ));
    const second = await json(await handleSelfHostedRequest(
      deps,
      await resendRequest(resendInboundEvent, { id: "evt-replay" }),
    ));

    expect(first["id"]).toBeTruthy();
    expect(second["duplicate"]).toBe(true);
    expect(second["id"]).toBe(first["id"]);
    expect(storedRowCount(db, "messages")).toBe(1);
    expect(storedRowCount(db, "webhook_receipts")).toBe(1);
  });

  test("a failed ingest is not acknowledged, so the provider can retry", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    deps.webhooks!.fetchObject = async () => { throw new Error("S3 unavailable"); };
    const envelope = snsEnvelope({ Type: "Notification", Message: sesReceived() });

    const failed = await handleSelfHostedRequest(deps, snsRequest(envelope));
    expect(failed!.status).toBe(500);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
    expect(storedRowCount(db, "messages")).toBe(0);

    // The retry succeeds and lands the mail.
    deps.webhooks!.fetchObject = async () => Buffer.from(RAW_EMAIL, "utf8");
    const retried = await json(await handleSelfHostedRequest(deps, snsRequest(envelope)));
    expect(retried["synced"]).toBe(1);
    expect(storedRowCount(db, "messages")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rejections store nothing
// ---------------------------------------------------------------------------

describe("unsigned and wrongly-signed payloads are rejected and store nothing", () => {
  test("an invalid SNS signature is rejected before any write", async () => {
    const { deps, db } = harness({ verifySns: neverVerified });
    const response = await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    );
    expect(response!.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: "Invalid SNS signature" });
    expect(storedRowCount(db, "messages")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
    expect(storedRowCount(db, "events")).toBe(0);
  });

  test("the mounted route uses the REAL AWS signature verifier by default", async () => {
    // No verifySns seam: an unsigned/forged envelope must be rejected by
    // verifyAwsSnsSignature itself. The non-AWS SigningCertURL is refused before
    // any network fetch, so this asserts the production wiring, not a stub.
    const { deps, db } = harness();
    const response = await handleSelfHostedRequest(deps, snsRequest(snsEnvelope({
      Type: "Notification",
      Message: sesReceived(),
      SigningCertURL: "https://evil.example.com/SimpleNotificationService-test.pem",
    })));
    expect(response!.status).toBe(401);
    expect(storedRowCount(db, "messages")).toBe(0);
  });

  test("a topic outside the exact allowlist is rejected", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    const response = await handleSelfHostedRequest(deps, snsRequest(snsEnvelope({
      Type: "Notification",
      TopicArn: "arn:aws:sns:us-east-1:999999999999:evil",
      Message: sesReceived(),
    })));
    expect(response!.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: "SNS topic or account is not allowed" });
    expect(storedRowCount(db, "messages")).toBe(0);
  });

  test("an unconfigured SNS allowlist fails closed with 503", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    delete deps.env!["EMAILS_SNS_TOPIC_ARNS"];
    const response = await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })),
    );
    expect(response!.status).toBe(503);
    expect(storedRowCount(db, "messages")).toBe(0);
  });

  test("a non-AWS SubscribeURL is refused and never fetched (anti-SSRF)", async () => {
    const { deps, fetched, db } = harness({ verifySns: alwaysVerified });
    const response = await handleSelfHostedRequest(deps, snsRequest(snsEnvelope({
      Type: "SubscriptionConfirmation",
      SubscribeURL: "http://169.254.169.254/latest/meta-data/",
    })));
    expect(response!.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "SubscribeURL is not a valid AWS SNS endpoint" });
    expect(fetched).toEqual([]);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });

  test("a genuine AWS SubscribeURL is confirmed", async () => {
    const { deps, fetched } = harness({ verifySns: alwaysVerified });
    const url = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";
    const body = await json(await handleSelfHostedRequest(
      deps,
      snsRequest(snsEnvelope({ Type: "SubscriptionConfirmation", SubscribeURL: url })),
    ));
    expect(body).toEqual({ ok: true, confirmed: true });
    expect(fetched).toEqual([url]);
  });

  test("an invalid Resend signature is rejected before any write", async () => {
    const { deps, db } = harness({ resendSecret: RESEND_SECRET });
    const response = await handleSelfHostedRequest(
      deps,
      await resendRequest(resendInboundEvent, { signature: "v1,not-the-real-mac" }),
    );
    expect(response!.status).toBe(401);
    expect(storedRowCount(db, "messages")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });

  test("a payload signed with the WRONG secret is rejected", async () => {
    const { deps, db } = harness({ resendSecret: RESEND_SECRET });
    const response = await handleSelfHostedRequest(
      deps,
      await resendRequest(resendInboundEvent, {
        secret: `whsec_${Buffer.from("some-other-secret").toString("base64")}`,
      }),
    );
    expect(response!.status).toBe(401);
    expect(storedRowCount(db, "messages")).toBe(0);
  });

  test("an unconfigured Resend secret fails CLOSED with 503, never accepting unsigned mail", async () => {
    const { deps, db } = harness({ resendSecret: undefined });
    const response = await handleSelfHostedRequest(deps, await resendRequest(resendInboundEvent));
    expect(response!.status).toBe(503);
    expect(await json(response)).toMatchObject({ error: "Resend webhook secret is not configured" });
    expect(storedRowCount(db, "messages")).toBe(0);
    expect(storedRowCount(db, "webhook_receipts")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The double itself must not be able to pass vacuously
// ---------------------------------------------------------------------------

describe("test-double integrity", () => {
  test("an unimplemented query throws instead of silently returning no rows", async () => {
    const { db } = harness();
    await expect(db.client.many("SELECT wat FROM nowhere WHERE 1 = 1")).rejects.toThrow(/unsupported statement/);
  });

  test("the acceptance path really executed tenant-scoped Postgres writes", async () => {
    const { deps, db } = harness({ verifySns: alwaysVerified });
    await handleSelfHostedRequest(deps, snsRequest(snsEnvelope({ Type: "Notification", Message: sesReceived() })));
    // Layer 2: every scoped operation set the RLS tenant GUC.
    expect(db.seenSql.some((sql) => sql.includes("set_config('app.current_tenant'"))).toBe(true);
    expect(db.seenSql.some((sql) => sql.startsWith("INSERT INTO messages"))).toBe(true);
    expect(db.seenSql.some((sql) => sql.startsWith("INSERT INTO webhook_receipts"))).toBe(true);
  });
});
