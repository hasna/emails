// `POST /v1/messages/record` — the route that persists a message row and transmits
// nothing, and the guard it must NOT have loosened.
//
// WHY THIS FILE EXISTS SEPARATELY from the Postgres integration run. The integration
// suite proves the route works end to end, but it only runs when a database is
// reachable, so it cannot be the only place the two properties below are asserted.
// Both are properties of the HANDLER and of the SQL it emits, so a fake query client
// records them without a server:
//
//  1. THE SEND PATH IS STILL THE ONLY WAY TO TRANSMIT. `POST /v1/messages` keeps its
//     409 for a non-inbound write, this route never touches `deps.sender`, and it
//     REFUSES all four send-ledger columns — so a row recorded here can never carry
//     the fence a real send produces and can never be mistaken for one.
//  2. AN UPSERT REPLAY WRITES ONLY WHAT THE BODY CARRIES. The conflict clause used to
//     assign the whole insert set from `EXCLUDED`, which reset `is_read`, `is_starred`,
//     `labels` and `received_at` from `messageInsertParams`' defaults on every replay —
//     on the one operation whose contract is that a replay changes nothing it was not
//     told about. That regression is invisible to a route test that only checks status
//     codes, so the emitted SQL is asserted directly.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { selfScopedStore, testAuthDeps } from "./auth/test-support.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** A row shaped like `messages`, so `mapMessageRow` has something real to map. */
function messageRow(params: readonly unknown[]): Record<string, unknown> {
  return {
    id: String(params[0] ?? "row-id"),
    direction: String(params[1] ?? "outbound"),
    from_addr: String(params[2] ?? ""),
    to_addrs: params[3] ?? "[]",
    cc_addrs: params[4] ?? "[]",
    subject: params[5] ?? null,
    body_text: params[6] ?? null,
    body_html: params[7] ?? null,
    status: params[8] ?? "queued",
    provider_message_id: params[9] ?? null,
    message_id: params[10] ?? null,
    in_reply_to: params[11] ?? null,
    received_at: params[12] ?? null,
    is_read: Boolean(params[13]),
    is_starred: Boolean(params[14]),
    labels: params[15] ?? "[]",
    headers: params[16] ?? "{}",
    attachments: params[17] ?? "[]",
    source_id: params[18] ?? null,
    idempotency_key: params[19] ?? null,
    send_payload_hash: params[20] ?? null,
    send_state: params[21] ?? "none",
    send_started_at: params[22] ?? null,
    tenant_id: String(params[23] ?? ""),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    inserted: true,
  };
}

interface Recorder {
  client: TypedQueryClient;
  /** Every statement, whole, so an assertion can read the SET list. */
  statements: string[];
  params: readonly unknown[][];
}

function recordingClient(): Recorder {
  const statements: string[] = [];
  const params: readonly unknown[][] = [];
  const capture = (sql: string, bound?: readonly unknown[]): void => {
    statements.push(sql);
    (params as unknown[][]).push([...(bound ?? [])]);
  };
  const client: TypedQueryClient = {
    async query(sql: string, bound?: readonly unknown[]) {
      capture(sql, bound);
      return { rows: [], rowCount: 0 };
    },
    async many<T>(sql: string, bound?: readonly unknown[]): Promise<T[]> {
      capture(sql, bound);
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      return [];
    },
    async get<T>(sql: string, bound?: readonly unknown[]): Promise<T | null> {
      capture(sql, bound);
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(sql: string, bound?: readonly unknown[]): Promise<T> {
      capture(sql, bound);
      return messageRow(bound ?? []) as unknown as T;
    },
    async execute(sql: string, bound?: readonly unknown[]) {
      capture(sql, bound);
    },
  };
  return { client, statements, params };
}

function depsFor(recorder: Recorder): SelfHostedServiceDeps {
  return {
    client: recorder.client,
    store: selfScopedStore(recorder.client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    // A sender that FAILS THE TEST if it is ever called. The record route's central
    // claim is that it transmits nothing, and a stub that quietly succeeded would let a
    // future edit start sending from here with every assertion still green.
    sender: {
      provider: "ses",
      send: async () => {
        throw new Error("the record route must never invoke a provider");
      },
    },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    ...testAuthDeps(recorder.client, SIGNING_SECRET),
  } as SelfHostedServiceDeps;
}

function keyWith(scopes: string[]): string {
  return mintApiKey({ app: "emails", scopes, signingSecret: SIGNING_SECRET }).token;
}

async function call(
  recorder: Recorder,
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers["x-api-key"] = init.token;
  const response = await handleSelfHostedRequest(
    depsFor(recorder),
    new Request(`http://svc${path}`, {
      method: init.method ?? "POST",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  expect(response, `${path} was not claimed by the service`).not.toBeNull();
  return { status: response!.status, body: (await response!.json().catch(() => ({}))) as Record<string, unknown> };
}

const OUTBOUND = { from: "sender@example.com", to: ["recipient@example.com"], subject: "recorded", direction: "outbound" };

describe("POST /v1/messages/record", () => {
  test("records an outbound message without invoking a provider", async () => {
    const recorder = recordingClient();
    const answer = await call(recorder, "/v1/messages/record", { token: keyWith(["emails:write"]), body: OUTBOUND });
    expect(answer.status).toBe(201);
    expect((answer.body["message"] as Record<string, unknown>)["direction"]).toBe("outbound");
    // The write is a plain INSERT with no conflict clause, and the tenant is the LAST
    // bound parameter — taken from the scoped store, never from the body.
    const insert = recorder.statements.find((sql) => sql.includes("INSERT INTO messages"));
    expect(insert, "no message insert was emitted").toBeDefined();
    expect(insert).not.toContain("ON CONFLICT");
    const bound = recorder.params[recorder.statements.indexOf(insert as string)] as unknown[];
    expect(bound.length).toBe(24);
    expect(bound[23]).toBe("00000000-0000-0000-0000-000000000001");
    // The ledger columns are recorded as ABSENT, not as invented values.
    expect(bound[19], "idempotency_key").toBeNull();
    expect(bound[20], "send_payload_hash").toBeNull();
    expect(bound[21], "send_state").toBe("none");
    expect(bound[22], "send_started_at").toBeNull();
    // The projection the service publishes: the fence columns never leave the service.
    expect(Object.keys(answer.body["message"] as object)).not.toContain("idempotency_key");
    expect(Object.keys(answer.body["message"] as object)).not.toContain("send_payload_hash");
  });

  test("records an inbound message too, so one route serves both directions", async () => {
    const recorder = recordingClient();
    const answer = await call(recorder, "/v1/messages/record", {
      token: keyWith(["emails:write"]),
      body: { from: "s@example.com", to: ["r@example.com"], received_at: new Date().toISOString() },
    });
    expect(answer.status).toBe(201);
    // Direction is INFERRED from the inbound signal, exactly as POST /v1/messages infers
    // it — one parser, so the two routes cannot drift.
    expect((answer.body["message"] as Record<string, unknown>)["direction"]).toBe("inbound");
  });

  test("refuses every send-ledger field rather than dropping it", async () => {
    for (const field of ["idempotency_key", "send_payload_hash", "send_state", "send_started_at"]) {
      const recorder = recordingClient();
      const answer = await call(recorder, "/v1/messages/record", {
        token: keyWith(["emails:write"]),
        body: { ...OUTBOUND, [field]: "x" },
      });
      expect(answer.status, `${field} must be refused`).toBe(400);
      expect(answer.body["reason"]).toBe("send_ledger_field");
      expect(String(answer.body["error"])).toContain(field);
      // REFUSED BEFORE ANY WRITE. A 400 issued after the insert would have recorded the
      // row it claims to have rejected.
      expect(recorder.statements.some((sql) => sql.includes("INSERT INTO messages"))).toBe(false);
    }
  });

  test("requires the write scope and a credential", async () => {
    const unauthenticated = await call(recordingClient(), "/v1/messages/record", { token: null, body: OUTBOUND });
    expect(unauthenticated.status).toBe(401);
    const readOnly = await call(recordingClient(), "/v1/messages/record", {
      token: keyWith(["emails:read"]),
      body: OUTBOUND,
    });
    expect(readOnly.status).toBe(403);
    // ...and the same credential that is refused above is accepted for a read, so the
    // 403 is about the scope and not about a broken key.
    const reads = await call(recordingClient(), "/v1/messages/counts", {
      method: "GET",
      token: keyWith(["emails:read"]),
    });
    expect(reads.status).toBe(200);
  });

  test("names the missing field, and answers 405 for anything but POST", async () => {
    const noFrom = await call(recordingClient(), "/v1/messages/record", {
      token: keyWith(["emails:write"]),
      body: { to: ["r@example.com"] },
    });
    expect(noFrom.status).toBe(400);
    expect(String(noFrom.body["error"])).toContain("from is required");
    const noTo = await call(recordingClient(), "/v1/messages/record", {
      token: keyWith(["emails:write"]),
      body: { from: "s@example.com" },
    });
    expect(noTo.status).toBe(400);
    expect(String(noTo.body["error"])).toContain("to is required");
    const wrongMethod = await call(recordingClient(), "/v1/messages/record", {
      method: "GET",
      token: keyWith(["emails:write"]),
    });
    expect(wrongMethod.status).toBe(405);
  });

  test("stores an empty source_id as NULL rather than as a fence", async () => {
    // ADVERSARIAL REVIEW'S BLOCKER. Left as `""` the value lands in the column, and the
    // partial unique index `(tenant_id, source_id) WHERE source_id IS NOT NULL` then makes
    // the SECOND such write a unique violation — a 500 for a caller who asked for a plain
    // create, where the SQLite store answers a typed conflict. The client permits `""`
    // explicitly, so this was reachable from the shipped package.
    const recorder = recordingClient();
    const answer = await call(recorder, "/v1/messages/record", {
      token: keyWith(["emails:write"]),
      body: { ...OUTBOUND, source_id: "" },
    });
    expect(answer.status).toBe(201);
    const insert = recorder.statements.find((sql) => sql.includes("INSERT INTO messages"));
    // A plain create, NOT an upsert: an empty fence is no fence.
    expect(insert).not.toContain("ON CONFLICT");
    const bound = recorder.params[recorder.statements.indexOf(insert as string)] as unknown[];
    expect(bound[18], "source_id must be NULL, not the empty string").toBeNull();
  });

  test("refuses a direction that is neither inbound nor outbound", async () => {
    // Newly reachable, and newly worth guarding: until this route existed every write path
    // PINNED the direction, so a caller could not store a typo. A stored "outbund" is read
    // as inbound by every folder predicate (`lower(coalesce(direction,'')) <> 'outbound'`)
    // AND excluded from the sender's outbound quota (`direction = 'outbound'`) — one row,
    // two classifications — and an upsert would write it over a good row.
    for (const direction of ["banana", "INBOUND", "Outbound", " inbound", 42]) {
      const recorder = recordingClient();
      const answer = await call(recorder, "/v1/messages/record", {
        token: keyWith(["emails:write"]),
        body: { from: "s@example.com", to: ["r@example.com"], direction },
      });
      expect(answer.status, `direction ${JSON.stringify(direction)} must be refused`).toBe(400);
      expect(String(answer.body["error"])).toContain("direction must be one of");
      expect(recorder.statements.some((sql) => sql.includes("INSERT INTO messages"))).toBe(false);
    }
    // POSITIVE CONTROL: both legal values still write, so this is not "reject everything".
    for (const direction of ["inbound", "outbound"]) {
      const answer = await call(recordingClient(), "/v1/messages/record", {
        token: keyWith(["emails:write"]),
        body: { from: "s@example.com", to: ["r@example.com"], direction },
      });
      expect(answer.status, direction).toBe(201);
      expect((answer.body["message"] as Record<string, unknown>)["direction"]).toBe(direction);
    }
  });

  test("is not swallowed by the /v1/messages/{id} matcher", async () => {
    // `record` is a legal message-id PREFIX as far as that regex is concerned, so the
    // ordering in the router is load-bearing. A 404 "message not found" here would mean
    // the route had been registered after it.
    const answer = await call(recordingClient(), "/v1/messages/record", {
      token: keyWith(["emails:write"]),
      body: OUTBOUND,
    });
    expect(answer.status).toBe(201);
  });
});

describe("POST /v1/messages keeps refusing an outbound write", () => {
  test("answers 409 and points at the send path", async () => {
    // THE GUARD THIS CHANGE MUST NOT HAVE LOOSENED. Adding the record route would have
    // been much easier by lifting this condition, and that would have made an outbound
    // row creatable with no provider invocation behind it — while every conformance case
    // went green. So the 409 is asserted here, beside the route that replaced the need
    // for lifting it.
    const recorder = recordingClient();
    const answer = await call(recorder, "/v1/messages", { token: keyWith(["emails:write"]), body: OUTBOUND });
    expect(answer.status).toBe(409);
    expect(String(answer.body["error"])).toContain("POST /v1/messages/send");
    expect(recorder.statements.some((sql) => sql.includes("INSERT INTO messages"))).toBe(false);
  });

  test("still imports an inbound message", async () => {
    // The other direction, without which the assertion above would also pass for a route
    // that had stopped working entirely.
    const answer = await call(recordingClient(), "/v1/messages", {
      token: keyWith(["emails:write"]),
      body: { from: "s@example.com", to: ["r@example.com"], direction: "inbound" },
    });
    expect(answer.status).toBe(201);
  });
});

describe("the upsert conflict clause writes only what the body carries", () => {
  /** The `SET` list the conflict path emits for one body. */
  async function assignments(body: Record<string, unknown>): Promise<string[]> {
    const recorder = recordingClient();
    const answer = await call(recorder, "/v1/messages/record", { token: keyWith(["emails:write"]), body });
    expect(answer.status).toBe(201);
    const sql = recorder.statements.find((statement) => statement.includes("ON CONFLICT"));
    expect(sql, "no upsert was emitted").toBeDefined();
    const set = (sql as string).split("DO UPDATE SET")[1]?.split("RETURNING")[0] ?? "";
    return set
      .split(",")
      .map((entry) => entry.trim().split(/\s*=\s*/)[0] as string)
      .filter((column) => column.length > 0)
      .sort();
  }

  test("a minimal replay touches neither the flags, the labels, nor received_at", async () => {
    const columns = await assignments({ ...OUTBOUND, source_id: "upstream-1" });
    // The body named from/to/subject/direction, so exactly those plus `updated_at`.
    expect(columns).toEqual(["direction", "from_addr", "subject", "to_addrs", "updated_at"]);
    // THE REGRESSION THIS PINS. Every one of these was assigned unconditionally from
    // `EXCLUDED`, i.e. from the insert defaults `false`/`false`/`[]`/`null`, so a replay
    // marked the mailbox unread, dropped every label and re-sorted the message to the
    // import instant.
    for (const untouched of ["is_read", "is_starred", "labels", "received_at"]) {
      expect(columns, `${untouched} must not be written by a replay that did not name it`).not.toContain(untouched);
    }
    // `source_id` is the conflict key and `created_at` is the row's identity; neither is
    // ever in the set.
    expect(columns).not.toContain("source_id");
    expect(columns).not.toContain("created_at");
  });

  test("a body that DOES name a field still writes it", async () => {
    // The other direction of the same rule. Without this, "writes only what the body
    // carries" would also be satisfied by a clause that wrote nothing at all.
    const columns = await assignments({
      ...OUTBOUND,
      source_id: "upstream-2",
      is_read: true,
      is_starred: false,
      labels: ["kept"],
      received_at: new Date().toISOString(),
      cc: ["cc@example.com"],
      text: "body",
      html: "<p>body</p>",
      status: "sent",
      provider_message_id: "provider-1",
      message_id: "<m@example.com>",
      in_reply_to: "<parent@example.com>",
      headers: { "X-Test": "1" },
      attachments: [],
    });
    for (const written of [
      "cc_addrs",
      "body_text",
      "body_html",
      "status",
      "provider_message_id",
      "message_id",
      "in_reply_to",
      "received_at",
      "is_read",
      "is_starred",
      "labels",
      "headers",
      "attachments",
    ]) {
      expect(columns, `${written} was named in the body and must be written`).toContain(written);
    }
    // `is_starred: false` is a VALUE, not an absence — a clause built with `??` instead
    // of an `undefined` check would silently skip it.
    expect(columns).toContain("is_starred");
  });
});
