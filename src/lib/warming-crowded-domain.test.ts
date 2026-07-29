// getTodaySentCount gates the local send path (assertWarmingLimit throws when
// sent >= limit), so it must count the DOMAIN'S OWN sends today — a total, never a
// windowed share. A newest-N window over ALL domains meant one busy sibling domain
// could crowd a warming domain's sends out of the window entirely: the count came
// back 0, the ramp cap never tripped, and local sends blew straight past the ramp.
//
// The probe here is the runtime proof from the audit that filed the defect: 300
// sends today from warm.test plus 1000 NEWER sends today from noisy.test. Under a
// newest-1000 window the noisy rows fill the window and warm.test counts 0; the
// correct answer is 300.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "../db/database.js";
import {
  API_BASE_URL_SETTING,
  API_CREDENTIAL_SETTINGS,
  API_SETTINGS_POINTER,
  DATABASE_PATH_SETTINGS,
} from "../store-resolution.js";
import { getTodaySentCount, getTodaySentCountsByDomain } from "./warming.js";

const PROVIDER = "crowding-provider";
let db: Database;
let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

/**
 * Leave exactly ONE store configured (the same fixture warming.test.ts uses): a
 * database path AND an API are a hard boot error, so a stray inherited API setting
 * would turn every count below into that error instead of a number.
 */
function configureLocalStoreOnly(): void {
  for (const setting of [API_BASE_URL_SETTING, API_SETTINGS_POINTER, ...API_CREDENTIAL_SETTINGS]) {
    delete process.env[setting];
  }
  for (const setting of DATABASE_PATH_SETTINGS) delete process.env[setting];
  process.env["EMAILS_DB_PATH"] = ":memory:";
}

beforeEach(() => {
  INHERITED_PROCESS_ENV = { ...process.env };
  configureLocalStoreOnly();
  resetDatabase();
  db = getDatabase();
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, ?, 'ses', 1)", [PROVIDER, PROVIDER]);
});

afterEach(() => {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
});

/** `count` sent-ledger rows from one sender, all stamped `sentAt` (today, UTC). */
function seedSentBatch(idPrefix: string, fromAddress: string, count: number, sentAt: string): void {
  const insert = `INSERT INTO emails
       (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses,
        bcc_addresses, reply_to, subject, status, has_attachments, attachment_count, tags,
        sent_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, '["client@example.com"]', '[]', '[]', NULL, 's', 'sent', 0, 0, '{}', ?, ?, ?)`;
  for (let i = 0; i < count; i++) {
    db.run(insert, [`${idPrefix}-${i}`, PROVIDER, fromAddress, sentAt, sentAt, sentAt]);
  }
}

describe("getTodaySentCount under cross-domain volume", () => {
  it("counts the warming domain's 300 sends even when a sibling domain sent 1000 newer messages today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // The noisy rows are NEWER than the warm rows, so any newest-first window
    // smaller than the whole day fills up with noisy.test before warm.test.
    seedSentBatch("warm", "ramp@warm.test", 300, `${today}T00:00:01.000Z`);
    seedSentBatch("noisy", "blast@noisy.test", 1000, `${today}T00:00:02.000Z`);

    expect(await getTodaySentCount("warm.test")).toBe(300);
  });

  it("reports totals for every requested domain in the same crowded day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seedSentBatch("warm", "ramp@warm.test", 300, `${today}T00:00:01.000Z`);
    seedSentBatch("noisy", "blast@noisy.test", 1000, `${today}T00:00:02.000Z`);

    const counts = await getTodaySentCountsByDomain(["warm.test", "noisy.test", "quiet.test"]);
    expect(counts.get("warm.test")).toBe(300);
    expect(counts.get("noisy.test")).toBe(1000);
    // Zero must still MEAN zero — a domain with no sends today.
    expect(counts.get("quiet.test")).toBe(0);
  });
});
