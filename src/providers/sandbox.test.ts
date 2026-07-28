// `SandboxAdapter` — the provider that captures instead of sending.
//
// `sendEmail` and `getStats` reach `src/db/sandbox.ts`, which has collapsed onto the store
// seam; the remaining methods are pure no-ops. So this file drives the adapter against the
// REAL `HttpEmailStore`, pointed at `src/test-support/v1-store-api.ts` — a `/v1` service that
// stores nothing and translates every request into the same seam, backed by an in-memory
// SQLite database this file can read directly.
//
// IT IS NOT THE OUT-OF-PROCESS STUB ANY MORE, for the reason that fixture's own header gives:
// the collapsed module reads `GET /v1/openapi.json` before any filtered list, the stub serves
// that document only on request, and when it does its generic list handler still IGNORES
// equality filters and answers with the unfiltered list — which this module correctly treats
// as a fault rather than as an answer.
//
// THE MIDDLE DESCRIBE IS THE ONE TO READ. `getSandboxCount` can now answer `null`, meaning
// "the capture table could not be counted to its end". `Stats` has no field that can carry
// that, so the adapter must fail loudly rather than write a lower bound or a zero into `sent`.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { listSandboxEmails } from "../db/sandbox.js";
import { SandboxAdapter } from "./sandbox.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import type { EmailStore } from "../store/email-store.js";
import type { ListOptions } from "../store/records.js";
import type { Provider } from "../types/index.js";
import { startV1StoreApi, type V1StoreApi } from "../test-support/v1-store-api.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";

const PROVIDER_ID = "sandbox-provider-1";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let db: ReturnType<typeof getDatabase>;
let api: V1StoreApi | null = null;

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

/**
 * Open the database while its path is the ONLY configured store.
 *
 * A database path AND an API together are a hard boot error with deliberately no precedence
 * rule, so the two cannot be configured at once; the handle stays open inside the service
 * below, so the adapter sees exactly one configured store and still reads one dataset. The
 * settings are named through the resolution's OWN exported constants rather than copied as
 * literals, so this file cannot go stale against the list that decides which store a caller
 * with no injected store gets.
 */
function openDatabase(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
  resetDatabase();
  db = getDatabase();
  // `sandbox_emails.provider_id` is a real foreign key into `providers`.
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, 'Sandbox Test', 'sandbox', 1)", [PROVIDER_ID]);
}

/** Hand the environment over to a `/v1` service backed by `store`. */
function pointTheEnvironmentAt(store: EmailStore): V1StoreApi {
  const service = startV1StoreApi({ store });
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env[API_BASE_URL_SETTING] = service.baseUrl;
  process.env[API_CREDENTIAL_SETTINGS[1] as string] = service.apiKey;
  return service;
}

function sandboxAdapter(): SandboxAdapter {
  return new SandboxAdapter({ id: PROVIDER_ID, name: "Sandbox Test", type: "sandbox" } as Provider);
}

/** Rows as the TABLE holds them, read without going through the adapter or the module. */
function tableRows(): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM sandbox_emails").all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  api?.stop();
  api = null;
  closeDatabase();
  restoreInheritedProcessEnv();
});

describe("SandboxAdapter over a healthy store", () => {
  beforeEach(() => {
    openDatabase();
    api = pointTheEnvironmentAt(createSqliteEmailStore({ database: db, detail: "sandbox adapter fixture" }));
  });

  it("captures the email over /v1 and returns the id the store minted", async () => {
    const id = await sandboxAdapter().sendEmail({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Test subject",
      text: "Hello world",
    });

    expect(id).toHaveLength(36);

    // Read off the TABLE, not back through the adapter: a round trip through one code path
    // would also pass for a store that never persisted anything.
    const rows = tableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["id"]).toBe(id);
    expect(rows[0]!["subject"]).toBe("Test subject");

    const stored = await listSandboxEmails(PROVIDER_ID, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(id);
    expect(stored[0]!.from_address).toBe("from@example.com");
    expect(stored[0]!.to_addresses).toEqual(["to@example.com"]);
    expect(stored[0]!.text_body).toBe("Hello world");
    expect(stored[0]!.html).toBeNull();
  });

  it("captures array to/cc/bcc", async () => {
    await sandboxAdapter().sendEmail({
      from: "from@example.com",
      to: ["a@example.com", "b@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Multi recipients",
      html: "<p>Hello</p>",
    });

    const [stored] = await listSandboxEmails(PROVIDER_ID, 10);
    expect(stored!.to_addresses).toEqual(["a@example.com", "b@example.com"]);
    expect(stored!.cc_addresses).toEqual(["cc@example.com"]);
    expect(stored!.bcc_addresses).toEqual(["bcc@example.com"]);
    expect(stored!.html).toBe("<p>Hello</p>");
  });

  it("captures reply_to", async () => {
    await sandboxAdapter().sendEmail({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Reply test",
      text: "hello",
      reply_to: "reply@example.com",
    });

    expect((await listSandboxEmails(PROVIDER_ID, 10))[0]!.reply_to).toBe("reply@example.com");
  });

  it("reports the capture count as the sent and delivered figures", async () => {
    const adapter = sandboxAdapter();
    await adapter.sendEmail({ from: "a@a.com", to: "b@b.com", subject: "S1", text: "t" });
    await adapter.sendEmail({ from: "a@a.com", to: "b@b.com", subject: "S2", text: "t" });

    const stats = await adapter.getStats();
    expect(stats.provider_id).toBe(PROVIDER_ID);
    expect(stats.sent).toBe(2);
    expect(stats.delivered).toBe(2);
    expect(stats.bounced).toBe(0);
    expect(stats.complained).toBe(0);
    expect(stats.delivery_rate).toBe(100);
    expect(stats.bounce_rate).toBe(0);
    expect(stats.period).toBe("all");
  });

  it("reports zero when nothing has been captured", async () => {
    const stats = await sandboxAdapter().getStats();
    expect(stats.sent).toBe(0);
    expect(stats.delivered).toBe(0);
  });
});

describe("SandboxAdapter when the capture table cannot be counted to its end", () => {
  /**
   * A store whose list IGNORES the offset, so the enumeration behind the count can never reach
   * an empty page and exhausts its budget.
   *
   * The environment is pointed at a `/v1` service backed by THIS store, so the adapter — which
   * takes no store argument and resolves the configured one — really does meet a store it
   * cannot count. Nothing here reaches inside the adapter or stubs the module under test.
   */
  function truncatingStore(): EmailStore {
    const base = createSqliteEmailStore({ database: db, detail: "truncating fixture" });
    return {
      ...base,
      sandbox: {
        ...base.sandbox,
        list: async (opts?: ListOptions & { filters?: Record<string, string> }) =>
          base.sandbox.list({ ...opts, limit: 2, offset: 0 }),
      },
    };
  }

  beforeEach(() => {
    openDatabase();
    for (let index = 0; index < 6; index += 1) {
      db.run(
        `INSERT INTO sandbox_emails (id, provider_id, from_address, subject, created_at)
         VALUES (?, ?, 'a@a.com', 'seeded', ?)`,
        [`sbx-${index}`, PROVIDER_ID, new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()],
      );
    }
    api = pointTheEnvironmentAt(truncatingStore());
  });

  it("REFUSES to report a figure rather than publishing a lower bound or a zero", async () => {
    let thrown: Error | null = null;
    try {
      await sandboxAdapter().getStats();
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).not.toBeNull();
    // The REASON reaches the caller, not only the fact. `Stats` is a bag of plain numbers with
    // nowhere to mark a bound, so a formatter handed one would print it as a total.
    expect(thrown!.message).toContain(PROVIDER_ID);
    expect(thrown!.message).toContain("could not be counted to the end");
    expect(thrown!.message).toContain("lower bound");
  });

  it("POSITIVE CONTROL: the same adapter over a store it CAN count answers with a figure", async () => {
    // Without this, the case above would pass for an adapter that always threw.
    api?.stop();
    api = pointTheEnvironmentAt(createSqliteEmailStore({ database: db, detail: "countable fixture" }));

    expect((await sandboxAdapter().getStats()).sent).toBe(6);
  });
});

describe("SandboxAdapter no-op methods", () => {
  beforeEach(() => {
    openDatabase();
    api = pointTheEnvironmentAt(createSqliteEmailStore({ database: db, detail: "sandbox adapter fixture" }));
  });

  it("listDomains returns empty array", async () => {
    expect(await sandboxAdapter().listDomains()).toEqual([]);
  });

  it("getDnsRecords returns empty array", async () => {
    expect(await sandboxAdapter().getDnsRecords("example.com")).toEqual([]);
  });

  it("verifyDomain returns pending statuses", async () => {
    const result = await sandboxAdapter().verifyDomain("example.com");
    expect(result.dkim).toBe("pending");
    expect(result.spf).toBe("pending");
    expect(result.dmarc).toBe("pending");
  });

  it("addDomain is a no-op", async () => {
    await expect(sandboxAdapter().addDomain("example.com")).resolves.toBeUndefined();
  });

  it("listAddresses returns empty array", async () => {
    expect(await sandboxAdapter().listAddresses()).toEqual([]);
  });

  it("addAddress is a no-op", async () => {
    await expect(sandboxAdapter().addAddress("test@example.com")).resolves.toBeUndefined();
  });

  it("verifyAddress always returns true", async () => {
    expect(await sandboxAdapter().verifyAddress("test@example.com")).toBe(true);
  });

  it("pullEvents returns empty array", async () => {
    expect(await sandboxAdapter().pullEvents()).toEqual([]);
  });
});
