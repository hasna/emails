import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ProjectPanelSchema, SCHEMA_IDS } from "@hasna/contracts";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { storeInboundEmail } from "../db/inbound.js";
import { createEmailsProjectPanel } from "./project-panel.js";

const savedDbPath = process.env["EMAILS_DB_PATH"];

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  if (savedDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
  else process.env["EMAILS_DB_PATH"] = savedDbPath;
});

describe("createEmailsProjectPanel", () => {
  it("emits a contract-valid mailbox panel without email body or credential leakage", () => {
    const provider = createProvider({
      name: "Private SES",
      type: "ses",
      region: "us-east-1",
      access_key: "provider-access-value",
      secret_key: "provider-secret-value",
    });
    const inbound = storeInboundEmail({
      provider_id: provider.id,
      message_id: "message-1",
      in_reply_to_email_id: null,
      from_address: "ionut@example.com",
      to_addresses: ["andrei@example.com"],
      cc_addresses: [],
      subject: "Potential contract",
      text_body: "Sensitive body text should not appear in project panels.",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: { "x-private-header": "do-not-emit" },
      raw_size: 128,
      received_at: "2026-06-29T00:00:00.000Z",
    });

    const panel = createEmailsProjectPanel("Swiss Bank Account", { limit: 5 });
    const serialized = JSON.stringify(panel);

    expect(ProjectPanelSchema.safeParse(panel).success).toBe(true);
    expect(panel.schema).toBe(SCHEMA_IDS.projectPanel);
    expect(panel.projectId).toBe("swiss-bank-account");
    expect(panel.provider.kind).toBe("custom");
    expect(panel.metrics.find((metric) => metric.id === "providers_active")?.value).toBe(1);
    expect(panel.metrics.find((metric) => metric.id === "inbox_unread")?.value).toBe(1);
    expect(panel.items.some((item) => item.id === inbound.id && item.resourceRefs.some((ref) => ref.uri === `integration://emails/inbound/${inbound.id}`))).toBe(true);
    expect(serialized).toContain("Potential contract");
    expect(serialized).not.toContain("Sensitive body text");
    expect(serialized).not.toContain("provider-secret-value");
    expect(serialized).not.toContain("do-not-emit");
  });

  it("emits empty state for an unconfigured workspace", () => {
    const panel = createEmailsProjectPanel("Empty Mail Project");

    expect(ProjectPanelSchema.safeParse(panel).success).toBe(true);
    expect(panel.projectId).toBe("empty-mail-project");
    expect(panel.state).toBe("empty");
    expect(panel.warnings[0]).toContain("project-to-email mapping");
  });
});
