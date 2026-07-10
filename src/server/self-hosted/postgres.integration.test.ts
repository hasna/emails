import { afterAll, describe, expect, it } from "bun:test";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const client = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

afterAll(async () => { await client?.close(); });

describe("self-hosted Postgres integration", () => {
  it.skipIf(!client)("migrates a fresh database and enforces durable send idempotency", async () => {
    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = await ledger.listApplied();
    expect(applied.map((row) => row.id)).toContain("0006_emails_rename_bridge");

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
});
