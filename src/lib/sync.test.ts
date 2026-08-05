// Provider delivery-event sync, driven for real against a local SQLite database.
//
// WHAT THIS FILE USED TO BE. Two cases against the DELETED HTTP-client arm, asserting that
// it threw. That arm is gone, so those assertions are replaced by the thing they stood in
// for: THE REFUSAL IS STILL A REFUSAL on an installation that reads its mail through an
// Emails API, and it is now derived from STORAGE CONFIGURATION rather than from the
// deployment word. The comfortable wrong answer it must never become is `0` events synced —
// the shape of a healthy sync over a provider with nothing new to report.
//
// EVERY STORAGE SETTING IS NAMED THROUGH THE RESOLUTION'S OWN EXPORTED CONSTANTS
// (`src/store-resolution.ts`), never as a literal, so this suite configures storage without
// naming the deployment word. As in the forwarding suite, two absences are deliberate and
// are NOT gaps: no case sets the deployment word to prove it no longer decides, and no
// assertion scans the module text for the dispatch helper or the mode read — naming either
// here would raise a ratchet counter (`src/mode-axis-ratchet.test.ts`) that may only fall.
// The ratchet enforces both absences tree-wide, this file included.
//
// `HOME` IS REDIRECTED IN EVERY CASE. When no database path is configured the database
// layer resolves — and CREATES — `~/.hasna/emails/emails.db`, and a case about a refusal
// must not be able to touch a developer's real mailbox on the way to failing.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import type { ProviderAdapter, RemoteEvent } from "../providers/interface.js";
import { syncAll, syncProvider } from "./sync.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let home: string;
let db: Database;

/**
 * Every storage setting cleared BY NAME FROM THE RESOLVER, plus the pointer that stands in
 * for a whole credential set. The hazard: a value inherited from the developer's shell
 * decides the gate below, and a case then passes or fails for a reason that is not in this
 * file.
 */
function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

/** Storage configured as a local in-memory database, which is what the ingestion needs. */
function configureLocalStore(): void {
  clearStoreSettings();
  process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";
}

/** Storage configured as an Emails API, and NO database path. */
function configureApiStore(): void {
  clearStoreSettings();
  process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
  process.env[API_CREDENTIAL_SETTINGS[0]] = "not-a-real-credential";
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "sync-home-"));
  process.env["HOME"] = home;
  configureLocalStore();
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
  rmSync(home, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────────────────
//
// TIMESTAMPS ARE STAMPED EXPLICITLY wherever more than one row of a kind is written: rows
// seeded in a tight loop share a timestamp to the millisecond, and an ordering assertion
// that holds by uuid luck steals an unrelated mutant's kill.

function seedProvider(
  id: string,
  options: { type?: string; apiKey?: string | null; active?: number } = {},
): string {
  db.run(
    "INSERT INTO providers (id, name, type, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      id,
      id,
      options.type ?? "sandbox",
      options.active ?? 1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  );
  return id;
}

function seedEmail(
  id: string,
  providerId: string,
  options: { providerMessageId?: string | null; status?: string; sentAt?: string } = {},
): string {
  db.run(
    `INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, subject, status, sent_at)
     VALUES (?, ?, ?, 'from@example.test', '["to@example.test"]', 's', ?, ?)`,
    [
      id,
      providerId,
      options.providerMessageId ?? null,
      options.status ?? "sent",
      options.sentAt ?? "2026-06-01T00:00:00.000Z",
    ],
  );
  return id;
}

function seedEvent(
  id: string,
  providerId: string,
  options: { providerEventId?: string | null; type?: string; occurredAt?: string } = {},
): string {
  db.run(
    "INSERT INTO events (id, provider_id, provider_event_id, type, occurred_at) VALUES (?, ?, ?, ?, ?)",
    [id, providerId, options.providerEventId ?? null, options.type ?? "delivered", options.occurredAt ?? "2026-06-01T00:00:00.000Z"],
  );
  return id;
}

/**
 * A pull seam that records the cursor it was handed and answers canned events. Every other
 * operation throws: a sync that touches more of the adapter than `pullEvents` is a
 * behaviour change this suite must fail on, not absorb.
 */
function stubAdapter(events: RemoteEvent[], sinceCalls?: Array<string | undefined>): ProviderAdapter {
  const refuse = (operation: string) => async (): Promise<never> => {
    throw new Error(`the sync pipeline must not call ${operation}`);
  };
  return {
    listDomains: refuse("listDomains"),
    getDnsRecords: refuse("getDnsRecords"),
    verifyDomain: refuse("verifyDomain"),
    addDomain: refuse("addDomain"),
    listAddresses: refuse("listAddresses"),
    addAddress: refuse("addAddress"),
    verifyAddress: refuse("verifyAddress"),
    sendEmail: refuse("sendEmail"),
    getStats: refuse("getStats"),
    pullEvents: async (since?: string) => {
      sinceCalls?.push(since);
      return events;
    },
  };
}

function remoteEvent(overrides: Partial<RemoteEvent> & { provider_event_id: string }): RemoteEvent {
  return {
    type: "delivered",
    occurred_at: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function eventCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

function emailStatus(id: string): string {
  return (db.query("SELECT status FROM emails WHERE id = ?").get(id) as { status: string }).status;
}

// ── storage-configuration refusals ───────────────────────────────────────────────────────

describe("syncProvider storage refusals", () => {
  it("REFUSES on an API-configured installation instead of reporting zero events", async () => {
    // THE DETECTOR. On the two-arm tree this configuration reached a deployment-word
    // dispatcher; the collapsed pipeline derives the same refusal from storage
    // configuration, in its own words, naming the setting to change.
    closeDatabase();
    configureApiStore();

    await expect(syncProvider("p-any")).rejects.toThrow(/ingestion belongs to that service/);
    await expect(syncProvider("p-any")).rejects.toThrow(new RegExp(`Unset ${API_BASE_URL_SETTING}`));
    await expect(syncAll()).rejects.toThrow(/ingestion belongs to that service/);
  });

  it("REFUSES a contradictory storage configuration instead of silently picking one", async () => {
    closeDatabase();
    clearStoreSettings();
    process.env[API_BASE_URL_SETTING] = "https://mail.example.test";
    process.env[API_CREDENTIAL_SETTINGS[0]] = "not-a-real-credential";
    process.env[DATABASE_PATH_SETTINGS[1]] = ":memory:";

    await expect(syncProvider("p-any")).rejects.toThrow(/did not resolve to one store/);
    await expect(syncProvider("p-any")).rejects.toThrow(new RegExp(API_BASE_URL_SETTING));
    await expect(syncProvider("p-any")).rejects.toThrow(new RegExp(DATABASE_PATH_SETTINGS[1]));
    await expect(syncAll()).rejects.toThrow(/did not resolve to one store/);
  });

  it("lets an explicit Database bypass storage resolution entirely", async () => {
    // A caller that hands in a handle legitimately holds one — the server's pull route and
    // the ingestion tests below — and must not be re-gated on the ambient environment.
    const providerId = seedProvider("p-explicit");
    configureApiStore();

    // A BOUNCED event with a recipient, deliberately: the contact-counter write is the
    // one call in the batch whose repository consults process-wide routing when there
    // is work to do, so this case only proves the explicit-handle scope if it makes
    // that repository do work.
    const inserted = await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", type: "bounced", recipient: "b@example.test" }),
    ]));
    expect(inserted).toBe(1);
    expect(eventCount()).toBe(1);
    expect(
      db.query("SELECT bounce_count FROM contacts WHERE email = ?").get("b@example.test"),
    ).toEqual({ bounce_count: 1 });

    // And the same for syncAll: its provider enumeration must run inside the same
    // explicit-handle scope, not re-consult the ambient environment.
    await expect(syncAll(db)).resolves.toEqual({ "p-explicit": 0 });
  });
});

// ── ingestion against a real local database ──────────────────────────────────────────────

describe("syncProvider ingestion", () => {
  it("ingests pulled events, returns the inserted count, and stores every column", async () => {
    const providerId = seedProvider("p-1");
    const inserted = await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", recipient: "r@example.test", metadata: { a: 1 } }),
      remoteEvent({ provider_event_id: "ev-2", type: "opened", occurred_at: "2026-06-02T01:00:00.000Z" }),
    ]));

    expect(inserted).toBe(2);
    const rows = db
      .query("SELECT provider_id, provider_event_id, type, recipient, metadata, occurred_at FROM events ORDER BY provider_event_id")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        provider_id: providerId,
        provider_event_id: "ev-1",
        type: "delivered",
        recipient: "r@example.test",
        metadata: '{"a":1}',
        occurred_at: "2026-06-02T00:00:00.000Z",
      },
      {
        provider_id: providerId,
        provider_event_id: "ev-2",
        type: "opened",
        recipient: null,
        metadata: "{}",
        occurred_at: "2026-06-02T01:00:00.000Z",
      },
    ]);
  });

  it("throws for an unknown provider rather than syncing nothing", async () => {
    await expect(syncProvider("missing", db, stubAdapter([]))).rejects.toThrow("Provider not found: missing");
  });

  it("hands the pull the most recent event time FOR THAT PROVIDER as the cursor", async () => {
    const providerId = seedProvider("p-1");
    const other = seedProvider("p-2");
    seedEvent("e-old", providerId, { occurredAt: "2026-06-01T00:00:00.000Z" });
    seedEvent("e-new", providerId, { occurredAt: "2026-06-03T00:00:00.000Z" });
    // A LATER event under ANOTHER provider must not advance this provider's cursor: a
    // cursor moved past mail that was never pulled is silently skipped mail.
    seedEvent("e-other", other, { occurredAt: "2026-06-09T00:00:00.000Z" });

    const sinceCalls: Array<string | undefined> = [];
    await syncProvider(providerId, db, stubAdapter([], sinceCalls));
    expect(sinceCalls).toEqual(["2026-06-03T00:00:00.000Z"]);
  });

  it("pulls WITHOUT a cursor on the first sync", async () => {
    const providerId = seedProvider("p-1");
    const sinceCalls: Array<string | undefined> = [];
    await syncProvider(providerId, db, stubAdapter([], sinceCalls));
    expect(sinceCalls).toEqual([undefined]);
  });

  it("skips events whose provider_event_id is already stored, and counts only new rows", async () => {
    const providerId = seedProvider("p-1");
    seedEvent("e-seen", providerId, { providerEventId: "ev-seen" });

    const inserted = await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-seen" }),
      remoteEvent({ provider_event_id: "ev-new" }),
    ]));

    expect(inserted).toBe(1);
    expect(eventCount()).toBe(2);
  });

  it("inserts ONE row when the same provider_event_id arrives twice in one pull", async () => {
    const providerId = seedProvider("p-1");
    const inserted = await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-dup" }),
      remoteEvent({ provider_event_id: "ev-dup", occurred_at: "2026-06-02T01:00:00.000Z" }),
    ]));

    expect(inserted).toBe(1);
    expect(eventCount()).toBe(1);
  });

  it("moves a linked email from sent to delivered/bounced/complained, scoped to the provider", async () => {
    const providerId = seedProvider("p-1");
    const other = seedProvider("p-2");
    seedEmail("m-delivered", providerId, { providerMessageId: "pm-1" });
    seedEmail("m-bounced", providerId, { providerMessageId: "pm-2" });
    // The SAME provider message id under a DIFFERENT provider. An unscoped link would
    // mark another provider's mail delivered off this provider's event stream.
    seedEmail("m-foreign", other, { providerMessageId: "pm-1" });

    await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", provider_message_id: "pm-1" }),
      remoteEvent({ provider_event_id: "ev-2", provider_message_id: "pm-2", type: "bounced", recipient: "b@example.test" }),
    ]));

    expect(emailStatus("m-delivered")).toBe("delivered");
    expect(emailStatus("m-bounced")).toBe("bounced");
    expect(emailStatus("m-foreign")).toBe("sent");
  });

  it("does NOT overwrite a status that has already left sent, and opened moves nothing", async () => {
    const providerId = seedProvider("p-1");
    seedEmail("m-final", providerId, { providerMessageId: "pm-1", status: "bounced" });
    seedEmail("m-opened", providerId, { providerMessageId: "pm-2" });

    await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", provider_message_id: "pm-1", type: "delivered" }),
      remoteEvent({ provider_event_id: "ev-2", provider_message_id: "pm-2", type: "opened" }),
    ]));

    expect(emailStatus("m-final")).toBe("bounced");
    expect(emailStatus("m-opened")).toBe("sent");
  });

  it("increments contact bounce and complaint counters for event recipients", async () => {
    const providerId = seedProvider("p-1");
    await syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", type: "bounced", recipient: "b@example.test" }),
      remoteEvent({ provider_event_id: "ev-2", type: "complained", recipient: "c@example.test" }),
      remoteEvent({ provider_event_id: "ev-3", type: "delivered", recipient: "d@example.test" }),
    ]));

    const contacts = db
      .query("SELECT email, bounce_count, complaint_count FROM contacts ORDER BY email")
      .all() as Array<Record<string, unknown>>;
    expect(contacts).toEqual([
      { email: "b@example.test", bounce_count: 1, complaint_count: 0 },
      { email: "c@example.test", bounce_count: 0, complaint_count: 1 },
    ]);
  });

  it("rolls the WHOLE batch back when one write fails mid-ingestion", async () => {
    // The atomicity contract, asserted as behaviour: the event inserts, the status
    // updates and the contact counters land together or not at all. A partial batch is
    // exactly the silent corruption a transaction exists to prevent — and the second
    // event's type violates the events table's CHECK constraint, which throws inside
    // the write path after the first event has already been inserted.
    const providerId = seedProvider("p-1");
    seedEmail("m-1", providerId, { providerMessageId: "pm-1" });

    await expect(syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-ok", provider_message_id: "pm-1", type: "bounced", recipient: "b@example.test" }),
      remoteEvent({ provider_event_id: "ev-bad", type: "not-a-real-event-type" as RemoteEvent["type"] }),
    ]))).rejects.toThrow();

    expect(eventCount()).toBe(0);
    expect(emailStatus("m-1")).toBe("sent");
    expect((db.query("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n).toBe(0);
  });
});

// ── threshold alerts ─────────────────────────────────────────────────────────────────────

describe("syncProvider threshold alerts", () => {
  /** Everything the sync writes to stderr, captured for one call. */
  async function captureAlerts(run: () => Promise<unknown>): Promise<string> {
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stderr.write = original;
    }
    return captured.join("");
  }

  it("alerts on a tripped complaint threshold and ANNOUNCES an unevaluable bounce rate", async () => {
    const { setConfigValue } = await import("./config.js");
    setConfigValue("complaint-alert-threshold", 1);
    setConfigValue("bounce-alert-threshold", 5);
    const providerId = seedProvider("p-1");

    // In-window timestamps: the alert read covers the last 30 days, and an event
    // stamped outside it is CORRECTLY not counted — a fixture hazard this suite hit.
    const output = await captureAlerts(() => syncProvider(providerId, db, stubAdapter([
      remoteEvent({ provider_event_id: "ev-1", type: "complained", recipient: "c1@example.test", occurred_at: new Date(Date.now() - 3_600_000).toISOString() }),
      remoteEvent({ provider_event_id: "ev-2", type: "complained", recipient: "c2@example.test", occurred_at: new Date(Date.now() - 1_800_000).toISOString() }),
    ])));

    // The count threshold trips on a LOWER BOUND, and the complaint share is reported
    // as unavailable rather than fabricated: the seam cannot scope sent mail to a
    // provider, and the alert must say so instead of inventing a denominator.
    expect(output).toContain("ALERT [p-1]: 2 complaints");
    expect(output).toContain("exceeds threshold 1");
    expect(output).toContain("rate unavailable");
    // The bounce-rate threshold CANNOT be evaluated for the same reason, and silence
    // there would read exactly like "your bounce rate is fine" — it is announced.
    expect(output).toContain("the bounce-rate alert (threshold 5%, last 30d) could not be evaluated");
  });

  it("stays SILENT when the pull inserted nothing", async () => {
    const { setConfigValue } = await import("./config.js");
    setConfigValue("complaint-alert-threshold", 1);
    setConfigValue("bounce-alert-threshold", 5);
    const providerId = seedProvider("p-1");

    const output = await captureAlerts(() => syncProvider(providerId, db, stubAdapter([])));
    expect(output).toBe("");
  });
});

// ── syncAll ──────────────────────────────────────────────────────────────────────────────

describe("syncAll", () => {
  it("syncs every ACTIVE provider and reports a count per provider", async () => {
    seedProvider("p-active");
    seedProvider("p-inactive", { active: 0 });

    // The sandbox adapter's pull answers an empty stream, which keeps this hermetic; the
    // per-provider ingestion itself is covered above through the recording seam.
    const results = await syncAll(db);
    expect(results).toEqual({ "p-active": 0 });
  });

  it("records 0 for a provider whose adapter cannot be built and still syncs the rest", async () => {
    seedProvider("p-good");
    // A provider whose credential is missing: building its adapter throws, the failure is
    // reported per provider, and one broken provider must not take down the others.
    seedProvider("p-broken", { type: "resend", apiKey: null });

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      const results = await syncAll(db);
      expect(results).toEqual({ "p-good": 0, "p-broken": 0 });
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => line.includes("p-broken"))).toBe(true);
  });
});
