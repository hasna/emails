import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { listInboundEmails } from "../../db/inbound.js";
import { handleResendWebhook } from "./resend-webhook.js";

const SECRET = `whsec_${Buffer.from("resend-route-test-secret").toString("base64")}`;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["RESEND_WEBHOOK_SECRET"] = SECRET;
  resetDatabase();
  createProvider({ name: "Resend", type: "resend", active: true });
});
afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["RESEND_WEBHOOK_SECRET"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_DATABASE_URL"];
});

async function post(body: unknown, id = crypto.randomUUID()): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(SECRET.replace(/^whsec_/, ""), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`));
  return new Request("http://x/webhook/resend-inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${Buffer.from(signature).toString("base64")}`,
    },
    body: raw,
  });
}
const inboundEvent = {
  type: "inbound.email.received",
  created_at: "2026-06-03T10:00:00.000Z",
  data: { email_id: "re_123", from: "alice@ext.com", to: ["ops@mine.com"], subject: "Hello via Resend", text: "hi there", html: "<p>hi there</p>", headers: {} },
};

describe("resend inbound webhook", () => {
  it("returns null for other paths", async () => {
    expect(await handleResendWebhook(new Request("http://x/api/x", { method: "POST" }), "/api/x", "POST")).toBeNull();
  });

  it("rejects oversized bodies before signature processing", async () => {
    const res = (await handleResendWebhook(new Request("http://x/webhook/resend-inbound", {
      method: "POST",
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: "{}",
    }), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(413);
  });

  it("stores an inbound Resend email", async () => {
    const res = (await handleResendWebhook(await post(inboundEvent), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBeTruthy();
    const inbox = listInboundEmails({}, getDatabase());
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe("Hello via Resend");
    expect(inbox[0]!.from_address).toBe("alice@ext.com");
  });

  it("ignores non-inbound events", async () => {
    const res = (await handleResendWebhook(await post({ type: "email.sent", data: {} }), "/webhook/resend-inbound", "POST"))!;
    expect((await res.json()).ignored).toBeTruthy();
    expect(listInboundEmails({}, getDatabase())).toHaveLength(0);
  });

  it("rejects a bad signature", async () => {
    const res = (await handleResendWebhook(new Request("http://x/webhook/resend-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json", "svix-id": "bad", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,bad" },
      body: JSON.stringify(inboundEvent),
    }), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(401);
    expect(listInboundEmails({}, getDatabase())).toHaveLength(0);
  });

  it("returns 200 for a duplicate without storing twice", async () => {
    const first = (await handleResendWebhook(await post(inboundEvent, "evt-duplicate"), "/webhook/resend-inbound", "POST"))!;
    const second = (await handleResendWebhook(await post(inboundEvent, "evt-duplicate"), "/webhook/resend-inbound", "POST"))!;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(listInboundEmails({}, getDatabase())).toHaveLength(1);
  });

  it("fails closed when the signature secret is missing", async () => {
    delete process.env["RESEND_WEBHOOK_SECRET"];
    const res = (await handleResendWebhook(await post(inboundEvent), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(503);
  });
});
