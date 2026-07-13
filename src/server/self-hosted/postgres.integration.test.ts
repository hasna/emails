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

  // Regression for the production redeploy blocker: an earlier backfill created
  // the parity tables ad-hoc OUTSIDE the migration ledger with SQLite-ported
  // types (INTEGER booleans, TEXT json) and NO primary key on
  // email_agent_settings.agent_key. Against that drifted schema, 0009's
  // `CREATE TABLE IF NOT EXISTS` no-ops so the columns keep INTEGER, and the
  // boolean seed `INSERT ... VALUES (..., FALSE, ...)` failed with
  // `column "enabled" is of type integer but expression is of type boolean`.
  // This test recreates the drift, then asserts the FULL migration set applies,
  // reconciles the boolean columns, seeds the agent settings (defensive
  // ON CONFLICT arbiter), leaves the text-json columns writable, and is
  // idempotent on a second run.
  it.skipIf(!client)("migrates the drifted ad-hoc (integer-boolean / text-json) prod schema", async () => {
    await resetPublicSchema();

    // Base tables domains/addresses pre-exist with the drifted 0010 columns as
    // TEXT (nameservers_json / next_check_at), so 0010's ADD COLUMN IF NOT EXISTS
    // must no-op safely rather than choke on the type mismatch.
    await client!.execute(`
      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT,
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        provisioning_status TEXT,
        nameservers_json TEXT,
        next_check_at TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        domain TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        daily_quota INTEGER,
        provisioning_status TEXT,
        last_validated_at TEXT,
        next_check_at TEXT,
        owner_id TEXT,
        administrator_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Drifted ad-hoc parity tables: INTEGER booleans, TEXT json, and
      -- email_agent_settings has NO primary key on agent_key (worst case).
      CREATE TABLE aliases (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        local_part TEXT NOT NULL,
        target_address TEXT NOT NULL DEFAULT '',
        protected INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE forwarding_rules (
        id TEXT PRIMARY KEY,
        source_address TEXT NOT NULL,
        target_address TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'app-copy',
        provider_id TEXT,
        from_address TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE email_agent_settings (
        agent_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        always_on INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'external',
        model TEXT,
        apply_labels INTEGER DEFAULT 1,
        use_network_tools INTEGER DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- A pre-existing row (legacy integer boolean + text json) must survive the
      -- type reconcile intact: enabled=1 -> true, apply_labels NULL -> default.
      INSERT INTO email_agent_settings (agent_key, enabled, always_on, apply_labels, use_network_tools, config_json)
      VALUES ('categorizer', 1, 0, NULL, 1, '{"seeded":true}');

      -- A couple of text-json parity tables that pre-exist too (proves
      -- CREATE TABLE IF NOT EXISTS no-ops and the store tolerates TEXT json).
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        email_id TEXT,
        provider_id TEXT,
        provider_event_id TEXT,
        type TEXT NOT NULL,
        recipient TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE provisioning_events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // (b) run the FULL migration set against the drifted schema.
    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = (await ledger.listApplied()).map((row) => row.id);
    expect(applied).toContain("0009_emails_selfhosted_parity_tables");
    expect(applied).toContain("0010_emails_selfhosted_provisioning_columns");
    expect(applied).toContain("0011_emails_selfhosted_parity_tables_2");

    // (c) reconciled boolean columns end up the correct type.
    const boolType = async (table: string, column: string): Promise<string | null> => {
      const row = await client!.get<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      return row?.data_type ?? null;
    };
    expect(await boolType("aliases", "protected")).toBe("boolean");
    expect(await boolType("forwarding_rules", "enabled")).toBe("boolean");
    expect(await boolType("email_agent_settings", "enabled")).toBe("boolean");
    expect(await boolType("email_agent_settings", "always_on")).toBe("boolean");
    expect(await boolType("email_agent_settings", "apply_labels")).toBe("boolean");
    expect(await boolType("email_agent_settings", "use_network_tools")).toBe("boolean");
    // JSON columns are intentionally LEFT as text (tolerated by the store); the
    // migration must not needlessly rewrite them.
    expect(await boolType("email_agent_settings", "config_json")).toBe("text");
    expect(await boolType("events", "metadata")).toBe("text");

    // The pre-existing legacy row survived the reconcile with correct values.
    const seededRow = await client!.get<{ enabled: boolean; apply_labels: boolean; config_json: string }>(
      `SELECT enabled, apply_labels, config_json FROM email_agent_settings WHERE agent_key = $1`,
      ["categorizer"],
    );
    expect(seededRow?.enabled).toBe(true); // legacy 1 -> true
    expect(seededRow?.apply_labels).toBe(true); // legacy NULL -> default true

    // The boolean seed INSERT (the exact statement that failed in prod) applied:
    // the two NEW agent rows exist alongside the preserved legacy one.
    const settings = await client!.many<{ agent_key: string }>(
      `SELECT agent_key FROM email_agent_settings ORDER BY agent_key`,
    );
    expect(settings.map((r) => r.agent_key)).toEqual(["categorizer", "fraud", "labeler"]);

    // 0010 no-op'd cleanly over the drifted text columns.
    expect(await boolType("domains", "nameservers_json")).toBe("text");
    expect(await boolType("domains", "next_check_at")).toBe("text");

    // The store round-trips through the reconciled boolean + tolerated text-json.
    const store = new EmailsSelfHostedStore(client!);
    const fwd = await store.createResource(resourceSpecForPath("forwarding")!, {
      source_address: "a@x.com", target_address: "b@x.com", mode: "app-copy", enabled: true,
    });
    expect(fwd["enabled"]).toBe(true);
    const evt = await store.createResource(resourceSpecForPath("events")!, {
      email_id: "m1", provider_id: "ses", type: "delivery", recipient: "b@x.com",
      metadata: { foo: "bar" }, occurred_at: "2026-07-13T00:00:00.000Z",
    });
    // metadata was written via `$n::jsonb` into a TEXT column; it round-trips.
    expect(JSON.parse(String(evt["metadata"]))).toEqual({ foo: "bar" });
    const agent = await store.updateResource(resourceSpecForPath("email-agents")!, "labeler", { enabled: true });
    expect(agent?.["enabled"]).toBe(true);

    // Idempotency: a second full run over the now-reconciled schema is a clean
    // no-op (the guarded reconcile skips already-boolean columns; every CREATE /
    // ADD / seed is IF NOT EXISTS / ON CONFLICT DO NOTHING).
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    expect(await boolType("email_agent_settings", "enabled")).toBe("boolean");
    const settingsAfter = await client!.many<{ agent_key: string }>(
      `SELECT agent_key FROM email_agent_settings ORDER BY agent_key`,
    );
    expect(settingsAfter.map((r) => r.agent_key)).toEqual(["categorizer", "fraud", "labeler"]);
  });
});
