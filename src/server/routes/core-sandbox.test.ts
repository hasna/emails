// The local dashboard's `/api/sandbox` routes read LOCAL SQLITE, whatever the environment says.
//
// WHY THIS FILE EXISTS. `src/db/sandbox` collapsed onto the store seam, so its exports stopped
// naming a `Database` and started taking an `EmailStore`. These three routes used to import the
// deleted SQLite arm DIRECTLY and hand it the process-wide connection; passing nothing now would
// have silently repointed the local dashboard at an operator's API on any installation
// configured for one — a behaviour change dressed up as a collapse. They therefore name a SQLite
// store bound to that same connection, and this file is what keeps that decision from being
// undone by a later edit that "simplifies" the argument away.
//
// The environment here is pointed at a `/v1` service that answers with a row NO local table
// holds, so a route that followed the configuration would be visible immediately. Every other
// import in `core.ts` is still a local-SQLite module, so this is consistency rather than a new
// rule; when those families collapse they each face the same question.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { handle } from "./core.js";
import { createHttpEmailStore } from "../../store-http/index.js";
import { createSqliteEmailStore } from "../../store-sqlite/index.js";
import type { EmailStore } from "../../store/email-store.js";
import type { ResourceRow } from "../../store/records.js";
import { startV1StoreApi, type V1StoreApi } from "../../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../../store-resolution.js";

const PROVIDER_ID = "dashboard-provider";
/** A capture that exists ONLY in the API's answers, never in the local table. */
const PHANTOM_ID = "sbx-only-on-the-api";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi | null = null;

/**
 * The running `/v1` fixture, or a clear failure.
 *
 * The handle is nullable so a `beforeEach` that dies before it is assigned reports its own
 * error rather than a `TypeError` from the teardown; this is the accessor every case uses, so
 * "not started" can never read as "started and empty".
 */
function service(): V1StoreApi {
  if (api === null) throw new Error("the /v1 fixture was not started");
  return api;
}

function phantomRow(): ResourceRow {
  return {
    id: PHANTOM_ID,
    provider_id: PROVIDER_ID,
    from_address: "api@example.com",
    to_addresses: JSON.stringify(["api@example.com"]),
    cc_addresses: "[]",
    bcc_addresses: "[]",
    reply_to: null,
    subject: "served by the API",
    html: null,
    text_body: null,
    attachments_json: "[]",
    headers_json: "{}",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

/** A store that answers every sandbox read with the phantom row and nothing else. */
function apiOnlyStore(): EmailStore {
  const base = createSqliteEmailStore({ database: db, detail: "api-only fixture" });
  return {
    ...base,
    sandbox: {
      ...base.sandbox,
      list: async (opts?: { limit?: number; offset?: number }) =>
        ({ ok: true as const, value: (opts?.offset ?? 0) > 0 ? [] : [phantomRow()] }),
      get: async (id: string) => ({ ok: true as const, value: id === PHANTOM_ID ? phantomRow() : null }),
      remove: async () => ({ ok: true as const, value: true }),
    },
  };
}

function seedLocalCapture(id: string, subject: string, createdAt: string): void {
  db.run(
    `INSERT INTO sandbox_emails (id, provider_id, from_address, subject, created_at)
     VALUES (?, ?, 'local@example.com', ?, ?)`,
    [id, PROVIDER_ID, subject, createdAt],
  );
}

async function call(path: string, method: string): Promise<Response> {
  const url = new URL(`http://dashboard.invalid${path}`);
  const response = await handle(new Request(url, { method }), url, url.pathname, method);
  if (response === null) throw new Error(`no route handled ${method} ${path}`);
  return response;
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
  resetDatabase();
  db = getDatabase();
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, 'Dashboard', 'sandbox', 1)", [PROVIDER_ID]);
  seedLocalCapture("sbx-local-1", "held locally", "2026-01-01T00:00:00.000Z");
  seedLocalCapture("sbx-local-2", "also held locally", "2026-01-02T00:00:00.000Z");

  api = startV1StoreApi({ store: apiOnlyStore() });
  // The handle above stays open, so the dashboard still has its connection while the
  // ENVIRONMENT now describes an API and nothing else. A path and an API together are a hard
  // boot error, so the two cannot both be configured.
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[API_BASE_URL_SETTING] = service().baseUrl;
  process.env[API_CREDENTIAL_SETTINGS[2] as string] = service().apiKey;
});

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

describe("the fixture itself", () => {
  it("POSITIVE CONTROL: the configured API is reachable and really does serve a different row", async () => {
    // WITHOUT THIS EVERY ASSERTION BELOW IS UNFALSIFIABLE. `expect(...).not.toContain(PHANTOM_ID)`
    // also passes when the `/v1` service is unreachable, mis-credentialled, or serving nothing —
    // in which case the routes would look right for entirely the wrong reason, and a real
    // regression would still look green. So the counterfactual is exercised for real: the store
    // the ENVIRONMENT names is built the same way the collapsed module would build it, and it
    // answers with the capture no local table holds. Adversarial review asked for this.
    const before = service().requestCount();
    const configured = createHttpEmailStore({ baseUrl: service().baseUrl, credential: service().apiKey });
    const listed = await configured.sandbox.list({ limit: 50 });

    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.map((row) => row["id"])).toEqual([PHANTOM_ID]);
    expect(service().requestCount()).toBeGreaterThan(before);
  });
});

describe("GET /api/sandbox", () => {
  it("lists the LOCAL captures, not the ones the configured API would serve", async () => {
    const before = service().requestCount();
    const body = await (await call("/api/sandbox", "GET")).json() as Array<Record<string, unknown>>;

    expect(body.map((row) => row["id"])).toEqual(["sbx-local-2", "sbx-local-1"]);
    expect(body.map((row) => row["subject"])).toContain("held locally");
    // The route did not go to the wire at all — a stronger statement than "the phantom row is
    // absent", which would also hold for a route that asked the API and got nothing.
    expect(service().requestCount()).toBe(before);
  });
});

describe("GET /api/sandbox/:id", () => {
  it("reads a LOCAL capture by id", async () => {
    const body = await (await call("/api/sandbox/sbx-local-1", "GET")).json() as Record<string, unknown>;
    expect(body["subject"]).toBe("held locally");
  });

  it("refuses the capture only the configured API holds, WITHOUT going to the wire", async () => {
    // The status is pinned EXACTLY rather than as `>= 400`, and the reason is worth stating:
    // `resolveIdStrict` looks the id up in the LOCAL table and throws `RouteInputError` (400)
    // before any store is consulted, so this never reaches a 404. A `.not.toContain` on the
    // body would be unfalsifiable here — the phantom row could not appear under ANY routing —
    // so what is asserted instead is that the request count did not move. Adversarial review
    // found the earlier version of this case could not fail.
    const before = service().requestCount();
    const response = await call(`/api/sandbox/${PHANTOM_ID}`, "GET");

    expect(response.status).toBe(400);
    expect(service().requestCount()).toBe(before);
  });
});

describe("DELETE /api/sandbox", () => {
  it("deletes the LOCAL captures and reports the number it really removed", async () => {
    const before = service().requestCount();
    const body = await (await call("/api/sandbox", "DELETE")).json() as { deleted: number };

    expect(body.deleted).toBe(2);
    expect(db.query("SELECT id FROM sandbox_emails").all()).toEqual([]);
    // A delete that followed the environment would have removed nothing local and reported 1,
    // because the API fixture answers every removal with success.
    expect(service().requestCount()).toBe(before);
  });
});
