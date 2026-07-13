import { afterAll, describe, expect, it } from "bun:test";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { resourceSpecForPath } from "./resources.js";

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

  it.skipIf(!client)("round-2 parity: new generic resources round-trip through real jsonb", async () => {
    await resetPublicSchema();
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    const store = new EmailsSelfHostedStore(client!);

    // group-members: the client pre-serializes `vars`; confirm it round-trips
    // through a real jsonb column + node-pg (the crux of the double-encode path).
    const gmSpec = resourceSpecForPath("group-members")!;
    const gm = await store.createResource(gmSpec, {
      group_id: "g1", email: "a@x.com", name: "Ada",
      vars: JSON.stringify({ team: "eng" }), added_at: "2026-07-13T00:00:00.000Z",
    });
    expect(typeof gm["id"]).toBe("string");
    expect(JSON.parse(String(gm["vars"]))).toEqual({ team: "eng" });
    const gmList = await store.listResource(gmSpec, { filters: { group_id: "g1" } });
    expect(gmList).toHaveLength(1);

    // sandbox-emails: raw arrays store native; pre-serialized json round-trips.
    const sbSpec = resourceSpecForPath("sandbox-emails")!;
    const sb = await store.createResource(sbSpec, {
      provider_id: "sandbox", from_address: "s@x.com",
      to_addresses: ["a@x.com"], cc_addresses: [], bcc_addresses: [],
      reply_to: null, subject: "Hi", html: "<p>hi</p>", text_body: "hi",
      attachments_json: JSON.stringify([{ filename: "a.txt" }]),
      headers_json: JSON.stringify({ "X-Test": "1" }),
      created_at: "2026-07-13T00:00:00.000Z",
    });
    expect(sb["to_addresses"]).toEqual(["a@x.com"]);
    expect(JSON.parse(String(sb["attachments_json"]))).toEqual([{ filename: "a.txt" }]);
    expect(JSON.parse(String(sb["headers_json"]))).toEqual({ "X-Test": "1" });

    // address-ownership-events: the client-minted id must be honored (idColumn).
    const aoSpec = resourceSpecForPath("address-ownership-events")!;
    const eventId = `evt-${crypto.randomUUID()}`;
    const created = await store.createResource(aoSpec, {
      id: eventId, address_id: "a1", action: "assign", previous_owner_id: null,
      previous_administrator_id: null, owner_id: "o1", administrator_id: "ag1",
      actor: "cli", reason: null, created_at: "2026-07-13T00:00:00.000Z",
    });
    expect(created["id"]).toBe(eventId);
    const fetched = await store.getResource(aoSpec, eventId);
    expect(fetched?.["owner_id"]).toBe("o1");

    // sequence steps + enrollments + webhook receipts persist and list.
    const stepSpec = resourceSpecForPath("sequence-steps")!;
    const step = await store.createResource(stepSpec, { sequence_id: "s1", step_number: 1, delay_hours: 24, template_name: "t" });
    expect(step["step_number"]).toBe(1);
    expect(step["delay_hours"]).toBe(24);

    const enrSpec = resourceSpecForPath("sequence-enrollments")!;
    const enr = await store.createResource(enrSpec, {
      sequence_id: "s1", contact_email: "c@x.com", provider_id: null, current_step: 0,
      status: "active", enrolled_at: "2026-07-13T00:00:00.000Z", next_send_at: null, completed_at: null,
    });
    const enrUpdated = await store.updateResource(enrSpec, String(enr["id"]), { status: "cancelled" });
    expect(enrUpdated?.["status"]).toBe("cancelled");

    const whSpec = resourceSpecForPath("webhook-receipts")!;
    const wh = await store.createResource(whSpec, { provider: "ses", event_id: "e9", resource_id: "m1", completed_at: "2026-07-13T00:00:00.000Z" });
    expect(wh["provider"]).toBe("ses");
  });

  it.skipIf(!client)("round-2 parity: send-key mint/verify/revoke + address ownership authorization", async () => {
    await resetPublicSchema();
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    const store = new EmailsSelfHostedStore(client!);

    // Ownership: assign an owner + agent administrator, then authorize sends.
    const address = await store.createAddress({ email: "mine@x.com" });
    await store.applyAddressOwnership(address.id, { owner_id: "owner1", administrator_id: "agent1" });
    expect(await store.isOwnerAuthorizedFrom("owner1", "Ops <mine@x.com>")).toBe(true);
    expect(await store.isOwnerAuthorizedFrom("agent1", "mine@x.com")).toBe(true);
    expect(await store.isOwnerAuthorizedFrom("other", "mine@x.com")).toBe(false);
    expect(await store.isOwnerAuthorizedFrom("owner1", "victim@x.com")).toBe(false);
    // Clearing ownership (unassign) revokes authorization.
    await store.applyAddressOwnership(address.id, { owner_id: null, administrator_id: null });
    expect(await store.isOwnerAuthorizedFrom("owner1", "mine@x.com")).toBe(false);

    // Send-key mint → verify → revoke → verify fails. The hash is never on the
    // generic send_keys resource row.
    const { token, key } = await store.mintSendKey({ owner_id: "owner1", label: "ci" });
    expect(token.startsWith("esk_")).toBe(true);
    const skRow = await store.getResource(resourceSpecForPath("send-keys")!, key.id);
    expect(skRow).not.toBeNull();
    expect(skRow).not.toHaveProperty("key_hash");

    const verified = await store.verifySendKey(token);
    expect(verified?.id).toBe(key.id);
    expect(verified?.last_used_at).toBeTruthy();
    expect(await store.verifySendKey("esk_bogus")).toBeNull();

    await client!.execute("UPDATE send_keys SET revoked_at = now() WHERE id = $1", [key.id]);
    expect(await store.verifySendKey(token)).toBeNull();
  });
});
