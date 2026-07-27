// The standalone provider webhook receiver, driven for real over HTTP against a local SQLite
// database, plus the pure parsers and verifiers it re-exports.
//
// WHAT THIS FILE USED TO BE. One case against the DELETED second arm, asserting that it threw,
// plus the parser/verifier cases at the bottom. That arm is gone, so the assertion is replaced by
// the thing it was standing in for: THE REFUSAL IS STILL A REFUSAL on an installation that reads
// its mail through an Emails API, and it is now derived from STORAGE CONFIGURATION rather than
// from the deployment word. The comfortable wrong answer it must never become is A RUNNING
// LISTENER: a server that binds a port the provider does not post to and writes delivery events
// into a database nothing else reads, while answering 200 to anything that does reach it.
//
// EVERY STORAGE SETTING IS NAMED THROUGH THE RESOLUTION'S OWN EXPORTED CONSTANTS
// (`src/store-resolution.ts`), never as a literal, so this suite configures storage without
// naming the deployment word. Two absences are deliberate and are NOT gaps:
//
//   * there is no case that SETS the deployment word to prove it no longer decides. Writing it
//     here — in any form, including through an exported constant, because the ratchet's env
//     metric is a substring match — would RAISE a counter that may only fall. The absence of that
//     read is enforced by `src/mode-axis-ratchet.test.ts` with zero slack, which is the guard
//     designed for it.
//   * for the same reason there is no assertion that the module text no longer contains the
//     dispatch helper or the mode read: naming either identifier here would raise its own
//     counter. The ratchet counts them tree-wide, this file included.
//
// `HOME` IS REDIRECTED IN EVERY CASE, and that is a safety property rather than tidiness. When no
// database path is configured the database layer resolves `~/.hasna/emails/emails.db` and CREATES
// it, so a case that asserts a refusal must not be able to touch a developer's real mailbox on the
// way to failing — and one case below deliberately exercises that default path.
//
// EVERY LISTENER IS TRACKED AND STOPPED. `Bun.serve` holds the process open, so an untracked
// server turns a failing assertion into a hung suite, which is a worse failure than a red one.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import {
  createWebhookServer,
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook.js";

const SNS_TOPIC_SETTING = "EMAILS_SNS_TOPIC_ARNS";
const SNS_ACCOUNT_SETTING = "EMAILS_AWS_ACCOUNT_IDS";
const ACCOUNT_ID = "123456789012";
const TOPIC_ARN = `arn:aws:sns:us-east-1:${ACCOUNT_ID}:emails-delivery-events`;
/** Base64 of "testsecret" — the shape `verifyResendSignature` decodes, not a real credential. */
const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldA==";
const PROVIDER_ID = "provider-webhook-1";

type Listener = ReturnType<typeof createWebhookServer>;

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
let home: string;
let db: Database;
let running: Listener[];

/**
 * Every storage setting cleared, BY NAME FROM THE RESOLVER, plus the pointer that stands in for a
 * whole credential set. The hazard this covers: a value inherited from the developer's shell
 * decides the gate below, and the case then passes or fails for a reason that is not in this file.
 */
function clearStoreSettings(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
}

/** Storage configured as a local in-memory database, which is what the receiver needs. */
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

/** The SNS allowlist the SES route requires before it will look at a payload. */
function configureSnsAllowlist(): void {
  process.env[SNS_TOPIC_SETTING] = TOPIC_ARN;
  process.env[SNS_ACCOUNT_SETTING] = ACCOUNT_ID;
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "webhook-home-"));
  process.env["HOME"] = home;
  running = [];
  configureLocalStore();
  configureSnsAllowlist();
  resetDatabase();
  db = getDatabase();
  db.run(
    "INSERT INTO providers (id, name, type, api_key, active, created_at, updated_at) VALUES (?, ?, 'resend', 'k', 1, ?, ?)",
    [PROVIDER_ID, PROVIDER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  );
});

afterEach(() => {
  for (const server of running) {
    try { server.stop(true); } catch { /* a case may have stopped it already */ }
  }
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
  rmSync(home, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a receiver on an ephemeral port and register it for teardown.
 *
 * AN OPTIONS OBJECT WITH `in` CHECKS, not defaulted positional parameters. A JS default fires on
 * an explicitly passed `undefined`, so `startReceiver(id, undefined)` silently supplied the real
 * secret and two cases that meant to omit it passed against a configured receiver instead. Caught
 * by those cases failing; recorded here so the shape is not "simplified" back.
 */
function startReceiver(
  options: {
    providerId?: string;
    webhookSecret?: string;
    verifySns?: (body: Record<string, unknown>) => Promise<boolean>;
  } = {},
): { url: string } {
  const server = createWebhookServer(
    0,
    "providerId" in options ? options.providerId : PROVIDER_ID,
    "webhookSecret" in options ? options.webhookSecret : WEBHOOK_SECRET,
    { verifySns: options.verifySns ?? (async () => true) },
  );
  running.push(server);
  return { url: `http://127.0.0.1:${server.port}` };
}

/** A genuine svix signature over `{id}.{timestamp}.{body}`, computed the way Resend signs. */
async function svixHeaders(id: string, body: string, secret = WEBHOOK_SECRET): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${Buffer.from(signature).toString("base64")}`,
  };
}

function resendBody(emailId: string, type = "email.delivered", to = "user@example.com"): string {
  return JSON.stringify({ type, data: { email_id: emailId, to: [to], created_at: "2026-05-01T10:00:00.000Z" } });
}

/** A well-formed SNS `Notification` envelope carrying an SES delivery notification. */
function snsBody(messageId: string, notificationType = "Delivery", to = "ses@example.com"): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: messageId,
    TopicArn: TOPIC_ARN,
    Timestamp: "2026-05-01T10:00:00.000Z",
    Message: JSON.stringify({
      notificationType,
      mail: { messageId: `ses-${messageId}`, destination: [to], timestamp: "2026-05-01T10:00:00.000Z" },
    }),
  });
}

async function postResend(url: string, body: string, id: string, secret = WEBHOOK_SECRET): Promise<Response> {
  return fetch(`${url}/webhook/resend`, { method: "POST", body, headers: await svixHeaders(id, body, secret) });
}

async function postSes(url: string, body: string): Promise<Response> {
  return fetch(`${url}/webhook/ses`, { method: "POST", body, headers: { "content-type": "application/json" } });
}

interface EventRow {
  provider_id: string;
  provider_event_id: string | null;
  type: string;
  recipient: string | null;
  occurred_at: string;
}

function eventRows(): EventRow[] {
  return db
    .query("SELECT provider_id, provider_event_id, type, recipient, occurred_at FROM events ORDER BY rowid")
    .all() as EventRow[];
}

/** The refusal message for a configuration, or `""` when the receiver started instead. */
function refusalMessage(): string {
  try {
    const server = createWebhookServer(0, PROVIDER_ID, WEBHOOK_SECRET);
    running.push(server);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ── the storage-configuration gate ──────────────────────────────────────────────────────

describe("createWebhookServer storage gate", () => {
  it("REFUSES on an API-configured installation instead of standing up a listener", () => {
    configureApiStore();
    expect(() => createWebhookServer(0, PROVIDER_ID, WEBHOOK_SECRET)).toThrow(
      /durable provider webhook receiver runs where the mail is stored/,
    );
  });

  it("names the setting to unset, from the resolver's own constant", () => {
    configureApiStore();
    const message = refusalMessage();
    // Non-vacuous: a remedy that names nothing is not a remedy, so the constant must be
    // non-empty before its presence in the message means anything.
    expect(API_BASE_URL_SETTING.length).toBeGreaterThan(0);
    expect(message).toContain(API_BASE_URL_SETTING);
    expect(message).toContain("Unset");
  });

  it("creates NO local data directory on the way to refusing, at the path the code actually uses", () => {
    const dataDirectory = join(home, ".hasna", "emails");

    // POSITIVE CONTROL FIRST. With no storage setting at all the resolution defaults to a local
    // database under the redirected HOME, the receiver starts, and the directory appears. Without
    // this, the absence asserted below would also pass for a path that is simply wrong.
    clearStoreSettings();
    const started = createWebhookServer(0, PROVIDER_ID, WEBHOOK_SECRET);
    running.push(started);
    expect(existsSync(dataDirectory), "the positive control did not create the data directory").toBe(true);
    started.stop(true);
    rmSync(join(home, ".hasna"), { recursive: true, force: true });
    expect(existsSync(dataDirectory)).toBe(false);

    // Now the refusal, against the very same path.
    configureApiStore();
    expect(() => createWebhookServer(0, PROVIDER_ID, WEBHOOK_SECRET)).toThrow();
    expect(existsSync(dataDirectory), "refusing created a local data directory anyway").toBe(false);
  });

  it("REFUSES a configuration that names two different local databases, naming both settings", () => {
    clearStoreSettings();
    process.env[DATABASE_PATH_SETTINGS[0]] = join(home, "one.db");
    process.env[DATABASE_PATH_SETTINGS[1]] = join(home, "two.db");
    const message = refusalMessage();
    expect(message).toContain("cannot tell where this installation's delivery events would be stored");
    for (const setting of DATABASE_PATH_SETTINGS) expect(message).toContain(setting);
  });

  it("STARTS when both database settings name the SAME file, because that is not a contradiction", () => {
    clearStoreSettings();
    const path = join(home, "same.db");
    process.env[DATABASE_PATH_SETTINGS[0]] = path;
    process.env[DATABASE_PATH_SETTINGS[1]] = path;
    expect(refusalMessage()).toBe("");
  });

  it("REFUSES a client-environment pointer whose payload was never loaded", () => {
    clearStoreSettings();
    process.env[API_SETTINGS_POINTER] = "vault/item/name";
    const message = refusalMessage();
    expect(message).toContain("cannot tell where this installation's delivery events would be stored");
    expect(message).toContain(API_SETTINGS_POINTER);
    expect(message).toContain(API_BASE_URL_SETTING);
  });

  it("does NOT phrase an unresolvable configuration as a contradiction between two stores", () => {
    // Two different faults arrive as one kind, and only one of them is about naming two stores.
    // The resolver's own message says which; this module must not assert the wrong one over it.
    clearStoreSettings();
    process.env[API_SETTINGS_POINTER] = "vault/item/name";
    const message = refusalMessage();
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("two configured places");
  });

  it("RUNS against an in-memory local database, which is the configuration the receiver is for", () => {
    const { url } = startReceiver();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("RUNS against an on-disk local database, and the file the events land in is the configured one", async () => {
    clearStoreSettings();
    const path = join(home, "on-disk.db");
    process.env[DATABASE_PATH_SETTINGS[1]] = path;
    resetDatabase();
    db = getDatabase();
    db.run(
      "INSERT INTO providers (id, name, type, api_key, active, created_at, updated_at) VALUES (?, ?, 'resend', 'k', 1, ?, ?)",
      [PROVIDER_ID, PROVIDER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    const { url } = startReceiver();
    expect((await postResend(url, resendBody("evt-on-disk"), "msg_on_disk")).status).toBe(200);
    expect(existsSync(path)).toBe(true);
    // Read through a SECOND, independent handle rather than the memoised one, so this proves the
    // row is in the FILE and not merely in a connection the test is holding open.
    const independent = new Database(path, { readonly: true });
    try {
      const rows = independent.query("SELECT provider_event_id FROM events").all() as { provider_event_id: string }[];
      expect(rows.map((row) => row.provider_event_id)).toEqual(["msg_on_disk"]);
    } finally {
      independent.close();
    }
  });
});

// ── the Resend route ────────────────────────────────────────────────────────────────────

describe("createWebhookServer /webhook/resend", () => {
  it("persists a signed delivery event and acknowledges it", async () => {
    const { url } = startReceiver();
    const body = resendBody("evt-resend-1");
    const response = await postResend(url, body, "msg_resend_1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    const rows = eventRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      provider_id: PROVIDER_ID,
      // The SIGNED envelope id wins over the payload's own id, which is what makes the fence
      // agree with the signature that was actually verified.
      provider_event_id: "msg_resend_1",
      type: "delivered",
      recipient: "user@example.com",
      occurred_at: "2026-05-01T10:00:00.000Z",
    });
  });

  it("stores every event type it recognises", async () => {
    const { url } = startReceiver();
    const cases: [string, string][] = [
      ["email.delivered", "delivered"],
      ["email.bounced", "bounced"],
      ["email.complained", "complained"],
      ["email.opened", "opened"],
      ["email.clicked", "clicked"],
    ];
    for (const [payloadType, stored] of cases) {
      const response = await postResend(url, resendBody(`evt-${stored}`, payloadType), `msg_${stored}`);
      expect(response.status, `${payloadType} was not accepted`).toBe(200);
    }
    expect(eventRows().map((row) => row.type)).toEqual(cases.map(([, stored]) => stored));
  });

  it("short-circuits a REPLAY of the same signed envelope and stores exactly one row", async () => {
    const { url } = startReceiver();
    const body = resendBody("evt-resend-replay");
    expect((await postResend(url, body, "msg_replay")).status).toBe(200);
    const second = await postResend(url, body, "msg_replay");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("Webhook already processed");
    expect(eventRows().length).toBe(1);
  });

  it("rejects a body signed with the wrong secret and stores nothing", async () => {
    const { url } = startReceiver();
    const response = await postResend(url, resendBody("evt-wrong-secret"), "msg_wrong", "whsec_d3JvbmdzZWNyZXQ=");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(eventRows().length).toBe(0);
  });

  it("rejects a signed body whose payload was altered after signing", async () => {
    const { url } = startReceiver();
    const headers = await svixHeaders("msg_tampered", resendBody("evt-tampered"));
    const response = await fetch(`${url}/webhook/resend`, {
      method: "POST",
      body: resendBody("evt-tampered", "email.bounced"),
      headers,
    });
    expect(response.status).toBe(401);
    expect(eventRows().length).toBe(0);
  });

  it("requires the svix envelope id", async () => {
    const { url } = startReceiver();
    const body = resendBody("evt-no-id");
    const headers = await svixHeaders("msg_dropped", body);
    delete headers["svix-id"];
    const response = await fetch(`${url}/webhook/resend`, { method: "POST", body, headers });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Resend svix-id is required");
  });

  it("refuses the route entirely when no signing secret is configured", async () => {
    const { url } = startReceiver({ webhookSecret: undefined });
    const response = await postResend(url, resendBody("evt-no-secret"), "msg_no_secret");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Resend webhook secret is not configured");
    expect(eventRows().length).toBe(0);
  });

  it("acknowledges an unrecognised event type WITHOUT storing it", async () => {
    const { url } = startReceiver();
    const body = JSON.stringify({ type: "email.something_new", data: { email_id: "evt-unknown" } });
    const response = await postResend(url, body, "msg_unknown");
    // 200 on purpose: the provider must not retry a payload this build will never understand.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Unrecognized event type");
    expect(eventRows().length).toBe(0);
  });

  it("refuses to store a recognised event when no provider was named", async () => {
    const { url } = startReceiver({ providerId: undefined });
    const response = await postResend(url, resendBody("evt-no-provider"), "msg_no_provider");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("A provider id is required for durable webhook persistence");
    expect(eventRows().length).toBe(0);
  });

  it("reports a persistence failure as RETRYABLE rather than acknowledging it", async () => {
    const { url } = startReceiver();
    db.run("DROP TABLE events");
    const response = await postResend(url, resendBody("evt-broken-store"), "msg_broken_store");
    // 500, not 200: the provider must retry, because nothing was recorded.
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Webhook persistence failed");
  });

  it("does not remember an envelope whose event was never stored, so the retry is not swallowed", async () => {
    // The replay cache is written only when a row was CREATED. If it were written unconditionally,
    // a failed persist followed by the provider's retry would be answered "already processed" and
    // the event would be lost silently.
    const { url } = startReceiver();
    db.run("DROP TABLE events");
    expect((await postResend(url, resendBody("evt-retry"), "msg_retry")).status).toBe(500);
    db.run(`CREATE TABLE events (
      id TEXT PRIMARY KEY, email_id TEXT, provider_id TEXT NOT NULL, provider_event_id TEXT,
      type TEXT NOT NULL, recipient TEXT, metadata TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const retry = await postResend(url, resendBody("evt-retry"), "msg_retry");
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("OK");
    expect(eventRows().map((row) => row.provider_event_id)).toEqual(["msg_retry"]);
  });
});

// ── the SES / SNS route ─────────────────────────────────────────────────────────────────

describe("createWebhookServer /webhook/ses", () => {
  it("persists an allowlisted, signature-verified SES delivery notification", async () => {
    const { url } = startReceiver();
    const response = await postSes(url, snsBody("sns-1"));
    expect(response.status).toBe(200);

    const rows = eventRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      provider_id: PROVIDER_ID,
      provider_event_id: "sns-1",
      type: "delivered",
      recipient: "ses@example.com",
      occurred_at: "2026-05-01T10:00:00.000Z",
    });
  });

  it("maps the three SES delivery notification types it recognises", async () => {
    const { url } = startReceiver();
    const cases: [string, string][] = [
      ["Delivery", "delivered"],
      ["Bounce", "bounced"],
      ["Complaint", "complained"],
    ];
    for (const [notificationType, stored] of cases) {
      const response = await postSes(url, snsBody(`sns-${stored}`, notificationType));
      expect(response.status, `${notificationType} was not accepted`).toBe(200);
    }
    expect(eventRows().map((row) => row.type)).toEqual(cases.map(([, stored]) => stored));
  });

  it("stores exactly ONE row for a repeated SNS MessageId — the database fence, not the cache", async () => {
    // The in-memory replay set is consulted on the Resend path only (named as an inherited defect
    // in the module header), so this duplicate reaches persistence a second time and is stopped by
    // the partial unique index instead. Both attempts are acknowledged; one row exists.
    const { url } = startReceiver();
    expect((await postSes(url, snsBody("sns-duplicate"))).status).toBe(200);
    expect((await postSes(url, snsBody("sns-duplicate"))).status).toBe(200);
    expect(eventRows().length).toBe(1);
  });

  it("refuses the route when the SNS allowlist is not configured", async () => {
    delete process.env[SNS_TOPIC_SETTING];
    delete process.env[SNS_ACCOUNT_SETTING];
    const { url } = startReceiver();
    const response = await postSes(url, snsBody("sns-no-allowlist"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("SNS allowlist is not configured");
    expect(eventRows().length).toBe(0);
  });

  it("rejects a topic that is not on the allowlist", async () => {
    const { url } = startReceiver();
    const body = JSON.parse(snsBody("sns-other-topic")) as Record<string, unknown>;
    body["TopicArn"] = `arn:aws:sns:us-east-1:${ACCOUNT_ID}:someone-elses-topic`;
    const response = await postSes(url, JSON.stringify(body));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("SNS topic or account is not allowed");
    expect(eventRows().length).toBe(0);
  });

  it("rejects an allowlisted topic ARN belonging to an account that is not allowlisted", async () => {
    const { url } = startReceiver();
    const foreign = "arn:aws:sns:us-east-1:210987654321:emails-delivery-events";
    process.env[SNS_TOPIC_SETTING] = `${TOPIC_ARN},${foreign}`;
    const body = JSON.parse(snsBody("sns-foreign-account")) as Record<string, unknown>;
    body["TopicArn"] = foreign;
    const response = await postSes(url, JSON.stringify(body));
    expect(response.status).toBe(401);
    expect(eventRows().length).toBe(0);
  });

  it("rejects a payload whose SNS signature does not verify", async () => {
    const { url } = startReceiver({ verifySns: async () => false });
    const response = await postSes(url, snsBody("sns-bad-signature"));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid SNS signature");
    expect(eventRows().length).toBe(0);
  });

  it("treats a THROWING signature verifier as a rejection, not as a crash", async () => {
    const { url } = startReceiver({
      verifySns: async () => { throw new Error("certificate fetch failed"); },
    });
    const response = await postSes(url, snsBody("sns-verifier-threw"));
    expect(response.status).toBe(401);
    expect(eventRows().length).toBe(0);
  });

  it("rejects a payload that does not look like SNS at all", async () => {
    const { url } = startReceiver();
    const response = await postSes(url, JSON.stringify({ Type: "SomethingElse" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid SNS payload");
  });

  it("requires an SNS MessageId, because it is the fence", async () => {
    const { url } = startReceiver();
    const body = JSON.parse(snsBody("sns-no-message-id")) as Record<string, unknown>;
    delete body["MessageId"];
    const response = await postSes(url, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SNS MessageId is required");
    expect(eventRows().length).toBe(0);
  });

  it("rejects a Notification whose inner Message is not JSON", async () => {
    const { url } = startReceiver();
    const body = JSON.parse(snsBody("sns-bad-inner")) as Record<string, unknown>;
    body["Message"] = "not json at all";
    const response = await postSes(url, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid SNS Message");
  });

  it("accepts a direct SES payload that is not wrapped in a Notification envelope", async () => {
    const { url } = startReceiver();
    const body = JSON.stringify({
      MessageId: "sns-direct",
      TopicArn: TOPIC_ARN,
      notificationType: "Delivery",
      mail: { messageId: "ses-direct", destination: ["direct@example.com"], timestamp: "2026-05-01T10:00:00.000Z" },
    });
    const response = await postSes(url, body);
    expect(response.status).toBe(200);
    expect(eventRows().map((row) => row.recipient)).toEqual(["direct@example.com"]);
  });
});

// ── transport-level guards ──────────────────────────────────────────────────────────────

describe("createWebhookServer transport guards", () => {
  it("answers 405 to anything that is not a POST", async () => {
    const { url } = startReceiver();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${url}/webhook/resend`, { method });
      expect(response.status, `${method} was not rejected`).toBe(405);
    }
  });

  it("answers 404 on a path it does not serve", async () => {
    const { url } = startReceiver();
    const response = await fetch(`${url}/webhook/somewhere-else`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("answers 400 to a body that is not JSON", async () => {
    const { url } = startReceiver();
    const response = await fetch(`${url}/webhook/resend`, {
      method: "POST",
      body: "{ not json",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid JSON");
  });

  it("answers 413 to a body over the 1 MiB bound", async () => {
    const { url } = startReceiver();
    const response = await fetch(`${url}/webhook/resend`, {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 64) }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload too large");
    expect(eventRows().length).toBe(0);
  });

  it("accepts a body EXACTLY at the bound rather than rejecting it off by one", async () => {
    // The bound is a `>` comparison, so the limit itself must pass. Without this, widening or
    // narrowing the comparison by one byte is invisible.
    const { url } = startReceiver();
    const envelope = JSON.stringify({ type: "email.delivered", data: { email_id: "", to: ["a@b.test"], created_at: "2026-05-01T10:00:00.000Z" } });
    const body = JSON.stringify({
      type: "email.delivered",
      data: { email_id: "x".repeat(1024 * 1024 - envelope.length), to: ["a@b.test"], created_at: "2026-05-01T10:00:00.000Z" },
    });
    expect(body.length).toBe(1024 * 1024);
    const response = await postResend(url, body, "msg_at_bound");
    expect(response.status).toBe(200);
    expect(eventRows().length).toBe(1);
  });

  it("answers 413 to an oversize STREAM whose length was never declared", async () => {
    // The case above is stopped by the DECLARED-length check, which shadows the streaming bound
    // entirely: `fetch` sets `content-length` for a string body. A chunked request declares no
    // length, so only the accumulating check inside the reader can stop this one.
    const { url } = startReceiver();
    const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 1024 * 1024 + 128 * 1024) { controller.close(); return; }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await fetch(`${url}/webhook/resend`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      // @ts-expect-error `duplex` is required by the fetch spec for a streaming body and is not in
      // the ambient `RequestInit` this build compiles against.
      duplex: "half",
    }).catch(() => null);
    // The server cancels the reader mid-upload, which can surface to the client as a broken pipe
    // rather than as a response. Either outcome proves the bound held; a 200 would not, and
    // neither would a hang.
    expect(response === null || response.status === 413).toBe(true);
    expect(eventRows().length).toBe(0);
  });

  it("treats an empty body as a JSON failure rather than crashing", async () => {
    const { url } = startReceiver();
    const response = await fetch(`${url}/webhook/resend`, { method: "POST", headers: { "content-length": "0" } });
    expect(response.status).toBe(400);
  });
});

// ── the pure parsers and verifiers, re-exported unchanged from both deleted arms ─────────

describe("parseResendWebhook", () => {
  it("parses email.delivered event", () => {
    const body = {
      type: "email.delivered",
      data: {
        email_id: "evt-123",
        to: ["user@example.com"],
        created_at: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_event_id).toBe("evt-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses email.bounced event", () => {
    const body = {
      type: "email.bounced",
      data: {
        email_id: "evt-456",
        to: "bounce@example.com",
        created_at: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses email.complained event", () => {
    const body = {
      type: "email.complained",
      data: {
        email_id: "evt-789",
        to: ["complainer@example.com"],
        created_at: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("parses email.opened event", () => {
    const body = {
      type: "email.opened",
      data: {
        email_id: "evt-open",
        to: ["reader@example.com"],
        created_at: "2025-01-15T13:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("opened");
  });

  it("parses email.clicked event", () => {
    const body = {
      type: "email.clicked",
      data: {
        email_id: "evt-click",
        to: ["clicker@example.com"],
        created_at: "2025-01-15T14:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("clicked");
  });

  it("returns null for unknown event type", () => {
    const body = { type: "email.unknown", data: {} };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("returns null for completely unrecognized payload", () => {
    const body = { something: "else" };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("handles missing data gracefully", () => {
    const body = { type: "email.delivered" };
    const event = parseResendWebhook(body);
    expect(event).toBeNull();
  });
});

describe("parseSesWebhook", () => {
  it("parses Delivery notification", () => {
    const body = {
      notificationType: "Delivery",
      mail: {
        messageId: "ses-msg-123",
        destination: ["user@example.com"],
        timestamp: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_message_id).toBe("ses-msg-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses Bounce notification", () => {
    const body = {
      notificationType: "Bounce",
      mail: {
        messageId: "ses-msg-456",
        destination: ["bounce@example.com"],
        timestamp: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses Complaint notification", () => {
    const body = {
      notificationType: "Complaint",
      mail: {
        messageId: "ses-msg-789",
        destination: ["complainer@example.com"],
        timestamp: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("returns null for unknown notification type", () => {
    const body = { notificationType: "Unknown", mail: {} };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("returns null for missing notificationType", () => {
    const body = { mail: { messageId: "test" } };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("handles missing mail fields gracefully", () => {
    const body = { notificationType: "Delivery" };
    const event = parseSesWebhook(body);
    expect(event).toBeNull();
  });
});

describe("verifyResendSignature", () => {
  it("returns false when svix headers are missing", async () => {
    const result = await verifyResendSignature('{"type":"test"}', {}, "whsec_test");
    expect(result).toBe(false);
  });

  it("returns false when timestamp is too old (> 5 min)", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const result = await verifyResendSignature('{}', {
      "svix-id": "msg_123",
      "svix-timestamp": String(oldTs),
      "svix-signature": "v1,fakesig",
    }, "whsec_dGVzdA==");
    expect(result).toBe(false);
  });

  it("returns false with wrong secret", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = await verifyResendSignature('{}', {
      "svix-id": "msg_123",
      "svix-timestamp": String(ts),
      "svix-signature": "v1,wrongsignature==",
    }, "whsec_dGVzdA==");
    expect(result).toBe(false);
  });

  it("returns TRUE for a signature it computed itself, so the three negatives above are not vacuous", async () => {
    const body = '{"type":"email.delivered"}';
    const headers = await svixHeaders("msg_positive_control", body);
    expect(await verifyResendSignature(body, headers, WEBHOOK_SECRET)).toBe(true);
  });
});

describe("verifySnsStructure", () => {
  it("returns true for valid SNS Notification", () => {
    const result = verifySnsStructure({ Type: "Notification", TopicArn: "arn:aws:sns:us-east-1:123:topic" });
    expect(result).toBe(true);
  });

  it("returns true for payload without Type (direct SES format)", () => {
    const result = verifySnsStructure({ notificationType: "Delivery", mail: {} });
    expect(result).toBe(true);
  });

  it("returns false when TopicArn is not from amazonaws.com", () => {
    const result = verifySnsStructure({ Type: "Notification", TopicArn: "arn:evil:attacker:topic" });
    expect(result).toBe(false);
  });

  it("returns false for invalid Type", () => {
    const result = verifySnsStructure({ Type: "RandomUnknownType" });
    expect(result).toBe(false);
  });
});
