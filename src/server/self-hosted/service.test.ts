import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import {
  AttachmentRepairQuotaExceededError,
  EmailsSelfHostedStore,
  encodeMessagesCursor,
} from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** Minimal in-memory query client that answers only the SQL our tests exercise. */
function fakeClient(): { client: TypedQueryClient; calls: string[] } {
  const calls: string[] = [];
  const domains: Record<string, unknown>[] = [];
  const client: TypedQueryClient = {
    async query(sql, params) {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (/SELECT \* FROM domains\b/i.test(sql)) return domains as unknown as T[];
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("INSERT INTO domains")) {
        const rec = {
          id: String((params ?? [])[0] ?? "generated-id"),
          domain: String((params ?? [])[1] ?? ""),
          status: String((params ?? [])[2] ?? "pending"),
          provider: (params ?? [])[3] ?? null,
          verified: Boolean((params ?? [])[4]),
          notes: (params ?? [])[5] ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        domains.push(rec);
        return rec as unknown as T;
      }
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rec = {
        id: "generated-id",
        domain: String((params ?? [])[1] ?? ""),
        status: "pending",
        provider: null,
        verified: false,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      domains.push(rec);
      return rec as unknown as T;
    },
    async execute(sql: string) {
      calls.push(sql.trim().split("\n")[0]!.trim());
    },
  };
  return { client, calls };
}

function deps(): SelfHostedServiceDeps {
  const { client } = fakeClient();
  return {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
    env: { EMAILS_INGEST_S3_BUCKET: "canonical-test-ingest" },
  };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("Emails self-hosted service", () => {
  test("GET /health returns 200 with status/version/mode", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/health"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("9.9.9");
    expect(body.mode).toBe("self_hosted");
  });

  test("operational probes never expose database error details", async () => {
    const d = deps();
    d.client.get = async () => { throw new Error("postgres password=super-secret"); };
    d.client.many = async () => { throw new Error("postgres password=super-secret"); };

    const health = await handleSelfHostedRequest(d, req("GET", "/health"));
    const ready = await handleSelfHostedRequest(d, req("GET", "/ready"));
    expect(await health!.text()).not.toContain("super-secret");
    expect(await ready!.text()).not.toContain("super-secret");
  });

  test("GET /ready requires exact migration ids and checksums", async () => {
    const cases = [
      {
        name: "pending",
        rows: emailsSelfHostedMigrations().slice(0, -1).map(({ id, checksum }) => ({ id, checksum })),
        issue: "pendingMigrations",
      },
      {
        name: "checksum drift",
        rows: emailsSelfHostedMigrations().map(({ id, checksum }, index) => ({ id, checksum: index === 0 ? "sha256:drift" : checksum })),
        issue: "checksum mismatch",
      },
      {
        name: "unknown newer migration",
        rows: [...emailsSelfHostedMigrations().map(({ id, checksum }) => ({ id, checksum })), { id: "9999_future", checksum: "sha256:future" }],
        issue: "unknown migration",
      },
    ];
    for (const scenario of cases) {
      const d = deps();
      d.client.many = async (sql) => sql.includes("schema_migrations") ? scenario.rows as never[] : [];
      const res = await handleSelfHostedRequest(d, req("GET", "/ready"));
      expect(res?.status).toBe(503);
      const body = await res!.json();
      expect(JSON.stringify(body)).toContain(scenario.issue);
    }

    const d = deps();
    d.client.many = async (sql) => sql.includes("schema_migrations")
      ? emailsSelfHostedMigrations().map(({ id, checksum }) => ({ id, checksum })) as never[]
      : [];
    const res = await handleSelfHostedRequest(d, req("GET", "/ready"));
    expect(res?.status).toBe(200);
  });

  test("GET /ready accepts the published 0006b compatibility checksum", async () => {
    const d = deps();
    d.client.many = async (sql) => sql.includes("schema_migrations")
      ? emailsSelfHostedMigrations().map(({ id, checksum }) => ({
        id,
        checksum: id === "0006b_emails_legacy_messages_backfill_prep"
          ? "sha256:0418239e617335b948364101dfa9d55d401322c377c9999804429b6cc789de23"
          : checksum,
      })) as never[]
      : [];

    const res = await handleSelfHostedRequest(d, req("GET", "/ready"));

    expect(res?.status).toBe(200);
  });

  test("GET /version returns the version+mode shape", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/version"));
    const body = await res!.json();
    expect(body).toMatchObject({ status: "ok", version: "9.9.9", mode: "self_hosted", name: "emails" });
  });

  test("unknown non-v1 path falls through (null)", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/dashboard"));
    expect(res).toBeNull();
  });

  test("/v1 without a key is rejected 401", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains"));
    expect(res?.status).toBe(401);
    expect((await res!.json()).reason).toBe("missing_token");
  });

  test("/v1 with a bad-signature key is rejected 401", async () => {
    const forged = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: "a-different-signing-secret-16b+" }).token;
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains", { token: forged }));
    expect(res?.status).toBe(401);
  });

  test("read-scoped key can GET but not POST (403 insufficient scope)", async () => {
    const d = deps();
    const readToken = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const listRes = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token: readToken }));
    expect(listRes?.status).toBe(200);
    const writeRes = await handleSelfHostedRequest(d, req("POST", "/v1/domains", { token: readToken, body: { domain: "x.com" } }));
    expect(writeRes?.status).toBe(403);
  });

  test("wrong-app key is rejected", async () => {
    const otherApp = mintApiKey({ app: "todos", scopes: ["todos:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains", { token: otherApp }));
    expect(res?.status).toBe(401);
  });

  test("write-scoped key creates a domain (201) and it appears in the list", async () => {
    const d = deps();
    const writeToken = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/domains", { token: writeToken, body: { domain: "Example.COM" } }));
    expect(create?.status).toBe(201);
    const created = (await create!.json()).domain;
    expect(created.domain).toBe("example.com");
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token: writeToken }));
    expect((await list!.json()).domains.length).toBe(1);
  });

  test("message counts are exposed through the authenticated self-hosted API", async () => {
    const d = deps();
    d.store.messageCounts = async () => ({
      inbox: 4,
      sent: 2,
      unread: 3,
      starred: 1,
      archived: 0,
      spam: 0,
      trash: 0,
      total: 6,
      latest_received_at: "2026-07-10T10:00:00.000Z",
    });
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/messages/counts", { token }));

    expect(res?.status).toBe(200);
    expect((await res!.json()).counts).toMatchObject({ inbox: 4, sent: 2, unread: 3, total: 6 });
  });

  test("attachment repair is authenticated, dry-run by default, bounded, and resumable by tenant-scoped run id", async () => {
    const d = deps();
    const scoped = d.store as any;
    const calls: unknown[] = [];
    const repairRunId = "11111111-1111-4111-8111-111111111111";
    const summary = {
      id: repairRunId,
      tenant_id: "00000000-0000-0000-0000-000000000001",
      apply: false,
      status: "pending",
      entry_total: 2,
      inventory_total: 3,
      repaired: 0,
      would_repair: 0,
      unavailable: 0,
      pending: 3,
      retrying: 0,
      entry_repaired: 0,
      entry_would_repair: 0,
      entry_unavailable: 0,
      entry_pending: 2,
      entry_retrying: 0,
      attempts: 0,
      checkpoint: 0,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z",
      completed_at: null,
    };
    scoped.createOrGetAttachmentRepairRun = async (input: unknown) => {
      calls.push(["create", input]);
      return summary;
    };
    scoped.getAttachmentRepairRun = async (id: string) => id === repairRunId ? summary : null;
    d.attachmentRepair = {
      processPage: async (store: unknown, runId: string, limit: number) => {
        calls.push(["process", store === scoped, runId, limit]);
        return { ...summary, checkpoint: 1 };
      },
    };
    const token = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/attachments/repairs", {
      token,
      body: {
        idempotency_key: "repair-run-1",
        entries: [
          {
            object_key: "source/one",
            recipients: ["one@example.test"],
            canary_message_ids: ["message-1"],
          },
          {
            object_key: "source/two",
            recipients: ["two@example.test"],
            canary_message_ids: ["message-2"],
          },
        ],
        limit: 1,
      },
    }));
    expect(create?.status).toBe(201);
    expect(calls).toEqual([
      ["create", {
        idempotencyKey: "repair-run-1",
        canonicalBucket: "canonical-test-ingest",
        apply: false,
        entries: [
          {
            object_key: "source/one",
            recipients: ["one@example.test"],
            canary_message_ids: ["message-1"],
          },
          {
            object_key: "source/two",
            recipients: ["two@example.test"],
            canary_message_ids: ["message-2"],
          },
        ],
      }],
      ["process", true, repairRunId, 1],
    ]);
    const createdBody = await create!.json();
    expect(createdBody.repair).toMatchObject({
      id: repairRunId,
      apply: false,
      inventory_total: 3,
      pending: 3,
      checkpoint: 1,
    });
    expect(createdBody.repair).not.toHaveProperty("tenant_id");
    expect(JSON.stringify(createdBody)).not.toContain("source/");
    expect(JSON.stringify(createdBody)).not.toContain("content_base64");

    const readOnly = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const forbidden = await handleSelfHostedRequest(d, req("POST", `/v1/attachments/repairs/${repairRunId}/resume`, {
      token: readOnly,
      body: { limit: 1 },
    }));
    expect(forbidden?.status).toBe(403);

    const resume = await handleSelfHostedRequest(d, req("POST", `/v1/attachments/repairs/${repairRunId}/resume`, {
      token,
      body: { limit: 1 },
    }));
    expect(resume?.status).toBe(200);
    expect(calls.at(-1)).toEqual(["process", true, repairRunId, 1]);
  });

  test("attachment repair is operator-only while owner/admin sessions and wildcard automation remain authorized", async () => {
    const repairRunId = "11111111-1111-4111-8111-111111111111";
    const summary = {
      id: repairRunId,
      tenant_id: "00000000-0000-0000-0000-000000000001",
      apply: false,
      status: "completed",
      entry_total: 1,
      inventory_total: 1,
      repaired: 0,
      would_repair: 1,
      unavailable: 0,
      operator_action: 0,
      pending: 0,
      retrying: 0,
      entry_repaired: 0,
      entry_would_repair: 1,
      entry_unavailable: 0,
      entry_operator_action: 0,
      entry_pending: 0,
      entry_retrying: 0,
      attempts: 1,
      checkpoint: 1,
      byte_budget: 1024,
      bytes_consumed: 5,
      time_budget_ms: 60_000,
      deadline_at: "2026-07-24T00:01:00.000Z",
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:01.000Z",
      completed_at: "2026-07-24T00:00:01.000Z",
    } as const;
    const manifest = {
      idempotency_key: "operator-auth-contract",
      entries: [{
        object_key: "source/one",
        recipients: ["one@example.test"],
        canary_message_ids: ["message-1"],
      }],
    };

    const callAs = async (
      credential: { kind: "api"; scopes: string[] } | { kind: "session"; role: "owner" | "admin" | "member" },
    ) => {
      const d = deps();
      let ledgerCalls = 0;
      (d.store as any).createOrGetAttachmentRepairRun = async () => {
        ledgerCalls++;
        return summary;
      };
      d.attachmentRepair = { processPage: async () => summary };
      let token: string;
      if (credential.kind === "api") {
        token = mintApiKey({
          app: "emails",
          scopes: credential.scopes,
          signingSecret: SIGNING_SECRET,
        }).token;
      } else {
        token = `emss_${credential.role}_session`;
        d.authStore.resolveSession = async () => ({
          sessionId: `${credential.role}-session`,
          userId: `${credential.role}-user`,
          tenantId: "00000000-0000-0000-0000-000000000001",
          role: credential.role,
          globalRole: "user",
        });
      }
      const response = await handleSelfHostedRequest(
        d,
        req("POST", "/v1/attachments/repairs", { token, body: manifest }),
      );
      return { response: response!, ledgerCalls };
    };

    for (const credential of [
      { kind: "api", scopes: ["emails:write"] },
      { kind: "session", role: "member" },
    ] as const) {
      const { response, ledgerCalls } = await callAs(credential);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "attachment repair requires a tenant owner, admin, or operator API key",
        reason: "operator_required",
      });
      expect(ledgerCalls).toBe(0);
    }

    for (const credential of [
      { kind: "api", scopes: ["emails:*"] },
      { kind: "session", role: "owner" },
      { kind: "session", role: "admin" },
    ] as const) {
      const { response, ledgerCalls } = await callAs(credential);
      expect(response.status).toBe(201);
      expect(ledgerCalls).toBe(1);
    }
  });

  test("attachment repair quota rejection is typed and does not start source processing", async () => {
    const d = deps();
    (d.store as any).createOrGetAttachmentRepairRun = async () => {
      throw new AttachmentRepairQuotaExceededError("active_runs", true);
    };
    let processCalls = 0;
    d.attachmentRepair = {
      processPage: async () => {
        processCalls++;
        throw new Error("source processing should not start after quota rejection");
      },
    };
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const response = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/attachments/repairs", {
        token,
        body: {
          idempotency_key: "quota-contract",
          entries: [{
            object_key: "source/one",
            recipients: ["one@example.test"],
            canary_message_ids: ["message-1"],
          }],
        },
      }),
    );

    expect(response?.status).toBe(429);
    expect(await response!.json()).toEqual({
      error: "attachment repair active runs quota exceeded",
      code: "attachment_repair_quota_exceeded",
      quota: "active_runs",
      retryable: true,
    });
    expect(processCalls).toBe(0);
  });

  test("attachment repair create preflight prefers MAILERY_INGEST_S3_BUCKET and supports the legacy fallback", async () => {
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;
    const repairRunId = "11111111-1111-4111-8111-111111111111";
    const summary = {
      id: repairRunId,
      tenant_id: "00000000-0000-0000-0000-000000000001",
      apply: false,
      status: "completed",
      entry_total: 1,
      inventory_total: 1,
      repaired: 0,
      would_repair: 1,
      unavailable: 0,
      operator_action: 0,
      pending: 0,
      retrying: 0,
      entry_repaired: 0,
      entry_would_repair: 1,
      entry_unavailable: 0,
      entry_operator_action: 0,
      entry_pending: 0,
      entry_retrying: 0,
      attempts: 1,
      checkpoint: 1,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:01.000Z",
      completed_at: "2026-07-24T00:00:01.000Z",
    } as const;

    for (const scenario of [
      {
        env: {
          MAILERY_INGEST_S3_BUCKET: "mailery-canonical",
          EMAILS_INGEST_S3_BUCKET: "legacy-canonical",
        },
        expected: "mailery-canonical",
      },
      {
        env: { MAILERY_INGEST_S3_BUCKET: "mailery-canonical" },
        expected: "mailery-canonical",
      },
      {
        env: { EMAILS_INGEST_S3_BUCKET: "legacy-canonical" },
        expected: "legacy-canonical",
      },
    ] as const) {
      const d = deps();
      d.env = scenario.env as NodeJS.ProcessEnv;
      let canonicalBucket: string | undefined;
      (d.store as any).createOrGetAttachmentRepairRun = async (
        input: { canonicalBucket: string },
      ) => {
        canonicalBucket = input.canonicalBucket;
        return summary;
      };
      d.attachmentRepair = {
        processPage: async () => summary,
      };

      const response = await handleSelfHostedRequest(
        d,
        req("POST", "/v1/attachments/repairs", {
          token,
          body: {
            idempotency_key: `bucket-precedence-${scenario.expected}`,
            entries: [{
              object_key: "source/one",
              recipients: ["one@example.test"],
              canary_message_ids: ["message-1"],
            }],
          },
        }),
      );

      expect(response?.status).toBe(201);
      expect(canonicalBucket).toBe(scenario.expected);
    }
  });

  test("attachment repair resume returns the typed not-configured response before processing", async () => {
    const d = deps();
    d.env = {};
    const repairRunId = "11111111-1111-4111-8111-111111111111";
    (d.store as any).getAttachmentRepairRun = async () => ({
      id: repairRunId,
      tenant_id: "00000000-0000-0000-0000-000000000001",
      apply: false,
      status: "pending",
      entry_total: 1,
      inventory_total: 1,
      repaired: 0,
      would_repair: 0,
      unavailable: 0,
      operator_action: 0,
      pending: 1,
      retrying: 0,
      entry_repaired: 0,
      entry_would_repair: 0,
      entry_unavailable: 0,
      entry_operator_action: 0,
      entry_pending: 1,
      entry_retrying: 0,
      attempts: 0,
      checkpoint: 0,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z",
      completed_at: null,
    });
    let processCalls = 0;
    d.attachmentRepair = {
      processPage: async () => {
        processCalls++;
        throw new Error("repair processing should not start");
      },
    };
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const response = await handleSelfHostedRequest(
      d,
      req("POST", `/v1/attachments/repairs/${repairRunId}/resume`, {
        token,
        body: { limit: 1 },
      }),
    );

    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({
      error: "attachment repair canonical source is not configured",
      code: "attachment_repair_not_configured",
    });
    expect(processCalls).toBe(0);
  });

  test("attachment repair create and resume reject every unknown top-level key before ledger access", async () => {
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;
    const repairRunId = "11111111-1111-4111-8111-111111111111";
    const forbiddenKeys = ["bucket", "raw_payload", "content_base64", "unexpected"] as const;

    for (const forbiddenKey of forbiddenKeys) {
      const createDeps = deps();
      let createCalls = 0;
      let processCalls = 0;
      (createDeps.store as any).createOrGetAttachmentRepairRun = async () => {
        createCalls++;
        throw new Error("repair ledger mutated");
      };
      createDeps.attachmentRepair = {
        processPage: async () => {
          processCalls++;
          throw new Error("repair page processed");
        },
      };
      const create = await handleSelfHostedRequest(
        createDeps,
        req("POST", "/v1/attachments/repairs", {
          token,
          body: {
            idempotency_key: "strict-create-body",
            entries: [{
              object_key: "source/one",
              recipients: ["one@example.test"],
              canary_message_ids: ["message-1"],
            }],
            [forbiddenKey]: forbiddenKey === "bucket" ? "caller-controlled" : "payload",
          },
        }),
      );
      expect(create?.status).toBe(400);
      expect(await create!.json()).toEqual({
        error: `attachment repair request contains unsupported fields: ${forbiddenKey}`,
        code: "invalid_repair_body",
      });
      expect(createCalls).toBe(0);
      expect(processCalls).toBe(0);

      const resumeDeps = deps();
      let resumeReads = 0;
      let resumeProcesses = 0;
      (resumeDeps.store as any).getAttachmentRepairRun = async () => {
        resumeReads++;
        throw new Error("repair ledger read");
      };
      resumeDeps.attachmentRepair = {
        processPage: async () => {
          resumeProcesses++;
          throw new Error("repair page processed");
        },
      };
      const resume = await handleSelfHostedRequest(
        resumeDeps,
        req("POST", `/v1/attachments/repairs/${repairRunId}/resume`, {
          token,
          body: { [forbiddenKey]: "payload" },
        }),
      );
      expect(resume?.status).toBe(400);
      expect(await resume!.json()).toEqual({
        error: `attachment repair resume request contains unsupported fields: ${forbiddenKey}`,
        code: "invalid_repair_body",
      });
      expect(resumeReads).toBe(0);
      expect(resumeProcesses).toBe(0);
    }
  });

  test("attachment repair status does not expose a run from another tenant", async () => {
    const d = deps();
    (d.store as any).getAttachmentRepairRun = async () => null;
    const token = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
    const response = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/attachments/repairs/11111111-1111-4111-8111-111111111111", { token }),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({
      error: "attachment repair not found",
      code: "attachment_repair_not_found",
    });
  });

  test("attachment repair routes reject malformed ids before the store UUID boundary", async () => {
    const d = deps();
    let storeReads = 0;
    (d.store as any).getAttachmentRepairRun = async () => {
      storeReads++;
      throw new Error("malformed repair id reached PostgreSQL");
    };
    const readToken = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;
    const writeToken = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const read = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/attachments/repairs/not-a-uuid", { token: readToken }),
    );
    const resume = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/attachments/repairs/not-a-uuid/resume", {
        token: writeToken,
        body: { limit: 1 },
      }),
    );

    for (const response of [read, resume]) {
      expect(response?.status).toBe(400);
      expect(await response!.json()).toEqual({
        error: "attachment repair id must be a UUID",
        code: "invalid_attachment_repair_id",
      });
    }
    expect(storeReads).toBe(0);
  });

  test("attachment repair manifest inventory validation failures are consistent 400 responses", async () => {
    const d = deps();
    (d.store as any).createOrGetAttachmentRepairRun = async () => {
      throw new RangeError(
        "attachment repair canaries must exactly match tenant-scoped canonical object bindings",
      );
    };
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:*"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const response = await handleSelfHostedRequest(
      d,
      req("POST", "/v1/attachments/repairs", {
        token,
        body: {
          idempotency_key: "invalid-inventory",
          entries: [{
            object_key: "source/missing",
            recipients: ["one@example.test"],
            canary_message_ids: ["missing-message"],
          }],
        },
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "attachment repair canaries must exactly match tenant-scoped canonical object bindings",
      code: "invalid_repair_manifest",
    });
  });

  test("message list forwards direction, recipient, search, and since filters to the store", async () => {
    const d = deps();
    let filters: unknown;
    d.store.listMessages = async (opts) => {
      filters = opts;
      return { items: [], next_cursor: null };
    };
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/messages?direction=outbound&to=person%40example.com&from=sender&subject=invoice&search=needle&since=2026-07-12T00%3A00%3A00%2B03%3A00&limit=7&offset=2", { token }),
    );

    expect(res?.status).toBe(200);
    expect(filters).toEqual({
      direction: "outbound",
      to: "person@example.com",
      from: "sender",
      subject: "invoice",
      search: "needle",
      since: "2026-07-11T21:00:00.000Z",
      limit: 7,
      offset: 2,
    });
  });

  test("attachment inventory rejects an invalid direction before calling the store", async () => {
    const d = deps();
    let storeCalls = 0;
    d.store.listAttachments = async () => {
      storeCalls++;
      return { items: [], next_cursor: null };
    };
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const response = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/attachments?direction=sideways", { token }),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "direction must be inbound or outbound",
      code: "invalid_direction",
    });
    expect(storeCalls).toBe(0);
  });

  test("attachment inventory returns the documented code for an invalid since filter", async () => {
    const d = deps();
    let storeCalls = 0;
    d.store.listAttachments = async () => {
      storeCalls++;
      return { items: [], next_cursor: null };
    };
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
    }).token;

    const response = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/attachments?since=not-a-date", { token }),
    );

    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "since must be a valid ISO date",
      code: "invalid_since",
    });
    expect(storeCalls).toBe(0);
  });

  test("attachment inventory accepts only canonical integer limits from 1 through 500", async () => {
    const token = mintApiKey({
      app: "emails",
      scopes: ["emails:read"],
      signingSecret: SIGNING_SECRET,
    }).token;
    const invalid = [
      "",
      "0",
      "501",
      "1.5",
      "+1",
      "-1",
      "01",
      "1e2",
      "Infinity",
      "NaN",
      "bogus",
      " 1",
      "1 ",
    ];
    for (const raw of invalid) {
      const d = deps();
      let storeCalls = 0;
      d.store.listAttachments = async () => {
        storeCalls++;
        return { items: [], next_cursor: null };
      };
      const response = await handleSelfHostedRequest(
        d,
        req("GET", `/v1/attachments?limit=${encodeURIComponent(raw)}`, { token }),
      );
      expect(response?.status, raw).toBe(400);
      expect(await response!.json(), raw).toEqual({
        error: "limit must be a canonical integer between 1 and 500",
        code: "invalid_limit",
      });
      expect(storeCalls, raw).toBe(0);
    }

    for (const raw of ["1", "500"]) {
      const d = deps();
      let receivedLimit: number | undefined;
      d.store.listAttachments = async (opts) => {
        receivedLimit = opts.limit;
        return { items: [], next_cursor: null };
      };
      const response = await handleSelfHostedRequest(
        d,
        req("GET", `/v1/attachments?limit=${raw}`, { token }),
      );
      expect(response?.status).toBe(200);
      expect(receivedLimit).toBe(Number(raw));
    }
  });

  test("message list forwards cursor, folder, q, and repeatable domain filters to the store", async () => {
    const d = deps();
    let filters: Record<string, unknown> | undefined;
    d.store.listMessages = async (opts) => {
      filters = opts as Record<string, unknown>;
      return { items: [], next_cursor: null };
    };
    const cursor = encodeMessagesCursor("2026-07-20T10:00:00.000000Z", "some-id");
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(
      d,
      req(
        "GET",
        `/v1/messages?folder=inbox&q=needle&domain=hasna.com&domain=@Beepmedia.com,%20extra.org&cursor=${encodeURIComponent(cursor)}&limit=50`,
        { token },
      ),
    );

    expect(res?.status).toBe(200);
    expect((await res!.json()).next_cursor).toBeNull();
    expect(filters).toMatchObject({
      folder: "inbox",
      search: "needle",
      cursor,
      domains: ["hasna.com", "beepmedia.com", "extra.org"],
      limit: 50,
    });
  });

  test("message list rejects malformed cursors and unknown folders", async () => {
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const badCursor = await handleSelfHostedRequest(
      deps(),
      req("GET", "/v1/messages?cursor=not-a-cursor", { token }),
    );
    expect(badCursor?.status).toBe(400);
    const badFolder = await handleSelfHostedRequest(
      deps(),
      req("GET", "/v1/messages?folder=junk", { token }),
    );
    expect(badFolder?.status).toBe(400);
  });

  test("message groups and counts forward the domain scope to the store", async () => {
    const d = deps();
    const seen: unknown[] = [];
    d.store.messageCounts = async (opts?: { domains?: string[] }) => {
      seen.push(opts?.domains);
      return {
        inbox: 1, unread: 1, starred: 0, sent: 0, archived: 0, spam: 0, trash: 0, total: 1,
        latest_received_at: null,
      };
    };
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const groups = await handleSelfHostedRequest(d, req("GET", "/v1/messages/groups?domain=hasna.com", { token }));
    expect(groups?.status).toBe(200);
    expect((await groups!.json()).inbox).toBe(1);
    const counts = await handleSelfHostedRequest(d, req("GET", "/v1/messages/counts", { token }));
    expect(counts?.status).toBe(200);
    expect(seen).toEqual([["hasna.com"], undefined]);
  });

  test("message list rejects invalid since filters", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      req("GET", "/v1/messages?since=not-a-date", {
        token: mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token,
      }),
    );

    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "since must be a valid ISO date" });
  });

  test("redacts internal failures from 500 responses", async () => {
    const d = deps();
    d.store.listDomains = async () => { throw new Error("database host and provider secret"); };
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token }));
      expect(res?.status).toBe(500);
      expect(await res!.json()).toEqual({ error: "internal error" });
    } finally {
      console.error = originalError;
    }
  });

  test("rejects oversized JSON bodies before parsing", async () => {
    const token = mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
    const body = JSON.stringify({ domain: `example-${"x".repeat(1024 * 1024)}.com` });
    const request = new Request("http://svc/v1/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token, "content-length": String(body.length) },
      body,
    });
    const res = await handleSelfHostedRequest(deps(), request);
    expect(res?.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
  });

  test("POST with missing required field returns 400", async () => {
    const writeToken = mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(deps(), req("POST", "/v1/domains", { token: writeToken, body: {} }));
    expect(res?.status).toBe(400);
  });
});
