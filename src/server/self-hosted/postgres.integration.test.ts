import { afterAll, describe, expect, it } from "bun:test";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const client = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

afterAll(async () => { await client?.close(); });

async function resetPublicSchema(): Promise<void> {
  await client!.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await client!.execute("CREATE SCHEMA public");
}

describe("self-hosted Postgres integration", () => {
  it.skipIf(!client)("migrates dirty text legacy rows and enforces durable send idempotency", async () => {
    await resetPublicSchema();
    await client!.execute(`
      CREATE TABLE inbound_emails (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        text_body TEXT,
        html_body TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        provider_message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO inbound_emails (
        id, message_id, from_address, to_addresses, cc_addresses, subject,
        text_body, html_body, received_at, created_at
      ) VALUES (
        'in-dirty', 's3-key-dirty', 'sender@example.com', 'not-json', '{bad',
        'legacy inbound', 'plain', '<p>html</p>', 'not-a-date', 'also-not-a-date'
      );
      INSERT INTO emails (
        id, provider_message_id, from_address, to_addresses, cc_addresses,
        subject, status, sent_at, created_at, updated_at
      ) VALUES (
        'sent-dirty', 'provider-dirty', 'sender@example.com', 'not-json', '{bad',
        'legacy sent', 'sent', 'not-a-date', 'also-not-a-date', 'still-not-a-date'
      );
    `);

    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = await ledger.listApplied();
    expect(applied.map((row) => row.id)).toContain("0006b_emails_legacy_messages_backfill_prep");
    expect(applied.map((row) => row.id)).toContain("0006_emails_rename_bridge");
    expect(applied.map((row) => row.id)).toContain("0008_emails_legacy_messages_backfill_dedupe");

    const legacyRows = await client!.many<{ id: string; direction: string; subject: string | null }>(
      "SELECT id, direction, subject FROM messages WHERE id IN ($1, $2) ORDER BY id",
      ["legacy-inbound:in-dirty", "legacy-sent:sent-dirty"],
    );
    expect(legacyRows).toEqual([
      { id: "legacy-inbound:in-dirty", direction: "inbound", subject: "legacy inbound" },
      { id: "legacy-sent:sent-dirty", direction: "outbound", subject: "legacy sent" },
    ]);

    const store = new EmailsSelfHostedStore(client!);
    const key = `ci-${crypto.randomUUID()}`;
    const input = {
      from_addr: "sender@example.com",
      to_addrs: ["recipient@example.com"],
      subject: "integration",
      idempotency_key: key,
      send_payload_hash: "sha256-integration",
    };
    const first = await store.reserveSendIntent(input);
    const duplicate = await store.reserveSendIntent(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.id).toBe(first.record.id);
    const claimed = await store.claimSendIntent(first.record.id);
    expect(claimed?.send_state).toBe("sending");
    expect((await store.completeSendIntent(first.record.id, "provider-ci")).send_state).toBe("sent");
  });

  it.skipIf(!client)("migrates typed timestamp legacy rows without text-assignment failures", async () => {
    await resetPublicSchema();
    await client!.execute(`
      CREATE TABLE inbound_emails (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        text_body TEXT,
        html_body TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        provider_message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO inbound_emails (
        id, message_id, from_address, to_addresses, cc_addresses, subject,
        text_body, html_body, received_at, created_at
      ) VALUES (
        'in-typed', 's3-key-typed', 'typed@example.com', '["to@example.com"]', '[]',
        'typed inbound', 'plain', '<p>html</p>', '2026-07-12T12:00:00Z', '2026-07-12T12:00:01Z'
      );
      INSERT INTO emails (
        id, provider_message_id, from_address, to_addresses, cc_addresses,
        subject, status, sent_at, created_at, updated_at
      ) VALUES (
        'sent-typed', 'provider-typed', 'typed@example.com', '["to@example.com"]', '[]',
        'typed sent', 'sent', '2026-07-12T12:01:00Z', '2026-07-12T12:01:01Z', '2026-07-12T12:01:02Z'
      );
    `);

    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();

    const legacyRows = await client!.many<{ id: string; direction: string; subject: string | null }>(
      "SELECT id, direction, subject FROM messages WHERE id IN ($1, $2) ORDER BY id",
      ["legacy-inbound:in-typed", "legacy-sent:sent-typed"],
    );
    expect(legacyRows).toEqual([
      { id: "legacy-inbound:in-typed", direction: "inbound", subject: "typed inbound" },
      { id: "legacy-sent:sent-typed", direction: "outbound", subject: "typed sent" },
    ]);
  });
});
