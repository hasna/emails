import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { getEmail } from "../db/emails.js";
import { createForwardingRule } from "../db/forwarding.js";
import { storeInboundEmail } from "../db/inbound.js";
import { processForwardingRules } from "./forwarding.js";

const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
  "HASNA_EMAILS_DB_PATH",
] as const;

let originalEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string | undefined>> = {};

beforeEach(() => {
  originalEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const key of MODE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv = {};
});

describe("processForwardingRules", () => {
  it("forwards pending inbound mail once through the injected sender", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createForwardingRule({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      provider_id: provider.id,
      from_address: "user@example.com",
    });
    getDatabase().run("UPDATE forwarding_rules SET created_at = ? WHERE source_address = ?", ["2025-01-01T00:00:00.000Z", "user@example.com"]);
    storeInboundEmail({
      provider_id: null,
      message_id: "<msg@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["user@example.com"],
      cc_addresses: [],
      subject: "Verify",
      text_body: "123456",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 6,
      received_at: "2026-01-01T00:00:00.000Z",
    });

    const sends: unknown[] = [];
    const first = await processForwardingRules({
      send: async (_providerId, opts) => {
        sends.push(opts);
        return { messageId: "provider-message-1", providerId: provider.id, usedFailover: false };
      },
    });
    const second = await processForwardingRules({
      send: async () => {
        throw new Error("should not resend");
      },
    });

    expect(first.sent).toBe(1);
    expect(second.attempted).toBe(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      from: "user@example.com",
      to: "archive@example.net",
      subject: "Fwd: Verify",
    });
    expect(getEmail(first.items[0]!.sent_email_id!)).toMatchObject({
      provider_message_id: "provider-message-1",
      from_address: "user@example.com",
    });
  });

  it("fails closed in self_hosted mode before opening local forwarding state", async () => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
    delete process.env["HASNA_EMAILS_DB_PATH"];
    const root = mkdtempSync(join(tmpdir(), "emails-forwarding-self-hosted-"));
    const previousHome = process.env["HOME"];
    const home = join(root, "home");
    process.env["HOME"] = home;
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";

    try {
      await expect(processForwardingRules()).rejects.toThrow("self_hosted API-only mode");
      expect(existsSync(join(home, ".hasna", "emails", "emails.db"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
