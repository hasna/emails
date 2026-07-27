// The retired `local.mailery` mailbox identity must not come back.
//
// Migration 46 renamed `mbx:legacy-inbound@local.mailery` to `...@local.emails`
// and deleted the old row. But `ensureMailArchitecture` DROPs and re-CREATEs the
// inbound trigger on every single `getDatabase()` call, and that trigger embedded
// the pre-rename literal in its recipient fallback. So the migration deleted the
// mailbox and the very next open re-minted it: recipient-less inbound mail split
// across two mailboxes forever, and a retired product identity stayed live.
//
// These tests are file-backed and open the database TWICE on purpose. An
// in-memory database is a fresh database on every open and cannot observe a
// resurrection at all.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeDatabase, getDatabase, now, resetDatabase, uuid } from "./database.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;
function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}
function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

const RETIRED_ADDRESS = "legacy-inbound@local.mailery";
const RETIRED_MAILBOX_ID = `mbx:${RETIRED_ADDRESS}`;
const CURRENT_MAILBOX_ID = "mbx:legacy-inbound@local.emails";

// Each case opens a real file-backed database twice, replaying every migration
// both times. That is well past the 5s default on a loaded CI runner.
const DOUBLE_OPEN_TIMEOUT_MS = 30_000;

let root: string;
let path: string;

beforeEach(() => {
  captureInheritedProcessEnv();
  root = mkdtempSync(join(tmpdir(), "emails-retired-identity-"));
  path = join(root, "emails.db");
  closeDatabase();
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = path;
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  delete process.env["EMAILS_DB_PATH"];
  rmSync(root, { recursive: true, force: true });
  restoreInheritedProcessEnv();
});

/** Inbound mail whose `to` header has no parseable recipient. */
function storeRecipientLessInbound(db: Database): string {
  const id = uuid();
  db.run(
    `INSERT INTO inbound_emails (id, message_id, from_address, to_addresses, cc_addresses,
       subject, text_body, headers_json, attachments_json, label_ids_json, received_at, created_at)
     VALUES (?,?,?,?,'[]',?,?,'{}','[]','[]',?,?)`,
    [id, `no-recipient-${id}`, "sender@example.com", "[]", "orphan", "body", now(), now()],
  );
  return id;
}

function retiredIdentityRows(db: Database): Record<string, unknown>[] {
  return [
    ...db.query("SELECT 'mailboxes.id' AS site, id AS value FROM mailboxes WHERE id LIKE '%local.mailery%'").all(),
    ...db.query("SELECT 'mailboxes.address' AS site, address AS value FROM mailboxes WHERE address LIKE '%local.mailery%'").all(),
    ...db.query("SELECT 'mailbox_sources.id' AS site, id AS value FROM mailbox_sources WHERE id LIKE '%local.mailery%'").all(),
    ...db.query("SELECT 'mailbox_sources.mailbox_id' AS site, mailbox_id AS value FROM mailbox_sources WHERE mailbox_id LIKE '%local.mailery%'").all(),
    ...db.query("SELECT 'mailbox_sources.external_mailbox' AS site, external_mailbox AS value FROM mailbox_sources WHERE external_mailbox LIKE '%local.mailery%'").all(),
  ] as Record<string, unknown>[];
}

describe("the retired local.mailery inbound identity", () => {
  it("does not reappear when the database is reopened after recipient-less mail arrives", () => {
    const first = getDatabase();
    storeRecipientLessInbound(first);
    // The trigger attributes it somewhere on the way in.
    expect(first.query("SELECT COUNT(*) AS count FROM mailboxes").get()).toMatchObject({ count: 1 });
    closeDatabase();
    resetDatabase();

    // Second open: `ensureMailArchitecture` re-creates the inbound trigger and
    // re-runs the rename bridge. This is where the resurrection used to happen.
    const second = getDatabase();
    expect(retiredIdentityRows(second)).toEqual([]);

    // And the mail is attributed to the current identity, not dropped on the floor.
    const current = second.query("SELECT id FROM mailboxes WHERE id = ?").get(CURRENT_MAILBOX_ID);
    expect(current).toMatchObject({ id: CURRENT_MAILBOX_ID });
    // Exactly one synthetic mailbox — not one per product name.
    expect(second.query("SELECT COUNT(*) AS count FROM mailboxes").get()).toMatchObject({ count: 1 });
  }, DOUBLE_OPEN_TIMEOUT_MS);

  it("re-points a released database's source row instead of cascading it away", () => {
    // Stand in for a database that migration 46 renamed and the trigger then
    // re-infected. The seeded source carries provenance that exists ONLY under the
    // retired identity, so the bridge has to move it — dropping it would take
    // source history with it, and `mailbox_sources.mailbox_id` cascades on delete.
    const seed = getDatabase();
    const inboundId = storeRecipientLessInbound(seed);
    const providerId = uuid();
    seed.run(
      "INSERT INTO providers (id, name, type, api_key, active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)",
      [providerId, "retired-era", "resend", "k", now(), now()],
    );
    seed.run(
      "INSERT OR IGNORE INTO mailboxes (id, address, display_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)",
      [RETIRED_MAILBOX_ID, RETIRED_ADDRESS, "Legacy inbound", now(), now()],
    );
    seed.run(
      `INSERT INTO mailbox_sources (id, mailbox_id, provider_id, type, name, external_mailbox,
         status, settings_json, provider_snapshot_json, created_at, updated_at)
       VALUES (?,?,?,'resend','retired-era resend',?,'active','{}','{}',?,?)`,
      [`msrc:${RETIRED_MAILBOX_ID}:${providerId}:resend`, RETIRED_MAILBOX_ID, providerId, RETIRED_ADDRESS, now(), now()],
    );
    seed.run("DELETE FROM _migrations WHERE id = 48");
    const before = seed.query("SELECT COUNT(*) AS count FROM mailbox_sources").get() as { count: number };
    closeDatabase();
    resetDatabase();

    const upgraded = getDatabase();
    expect(retiredIdentityRows(upgraded)).toEqual([]);

    // The row moved rather than vanished: same count, re-keyed identity.
    expect(upgraded.query("SELECT COUNT(*) AS count FROM mailbox_sources").get())
      .toMatchObject({ count: before.count });
    expect(upgraded.query("SELECT id, mailbox_id, external_mailbox FROM mailbox_sources WHERE provider_id = ?").get(providerId))
      .toMatchObject({
        id: `msrc:${CURRENT_MAILBOX_ID}:${providerId}:resend`,
        mailbox_id: CURRENT_MAILBOX_ID,
        external_mailbox: "legacy-inbound@local.emails",
      });
    // The provider guard still sees the history, so the provider stays undeletable.
    expect(() => upgraded.run("DELETE FROM providers WHERE id = ?", [providerId]))
      .toThrow(/mail\/source history/);
    expect(upgraded.query("SELECT id FROM inbound_emails WHERE id = ?").get(inboundId))
      .toMatchObject({ id: inboundId });
  }, DOUBLE_OPEN_TIMEOUT_MS);

  it("collapses a source recorded under both names onto the current identity", () => {
    const seed = getDatabase();
    // The trigger has already created the legacy_inbound source under the CURRENT
    // identity for this mail, so the seeded retired-name row is the same
    // provenance recorded twice. Re-keying it would collide on the primary key.
    storeRecipientLessInbound(seed);
    const currentSources = seed.query("SELECT COUNT(*) AS count FROM mailbox_sources").get() as { count: number };
    expect(currentSources.count).toBe(1);
    seed.run(
      "INSERT OR IGNORE INTO mailboxes (id, address, display_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)",
      [RETIRED_MAILBOX_ID, RETIRED_ADDRESS, "Legacy inbound", now(), now()],
    );
    seed.run(
      `INSERT INTO mailbox_sources (id, mailbox_id, provider_id, type, name, external_mailbox,
         status, settings_json, provider_snapshot_json, created_at, updated_at)
       VALUES (?,?,NULL,'legacy_inbound','Legacy inbound',?,'legacy','{}','{}',?,?)`,
      [`msrc:${RETIRED_MAILBOX_ID}:none:legacy_inbound`, RETIRED_MAILBOX_ID, RETIRED_ADDRESS, now(), now()],
    );
    seed.run("DELETE FROM _migrations WHERE id = 48");
    closeDatabase();
    resetDatabase();

    const upgraded = getDatabase();
    expect(retiredIdentityRows(upgraded)).toEqual([]);
    // Collapsed to one, and it is the current-identity row that survived.
    expect(upgraded.query("SELECT COUNT(*) AS count FROM mailbox_sources").get()).toMatchObject({ count: 1 });
    expect(upgraded.query("SELECT id FROM mailbox_sources").get())
      .toMatchObject({ id: `msrc:${CURRENT_MAILBOX_ID}:none:legacy_inbound` });
    expect(upgraded.query("SELECT COUNT(*) AS count FROM mailboxes").get()).toMatchObject({ count: 1 });
  }, DOUBLE_OPEN_TIMEOUT_MS);
});
