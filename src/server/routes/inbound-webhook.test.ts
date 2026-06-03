import { describe, it, expect } from "bun:test";
import { handleInboundWebhook } from "./inbound-webhook.js";

const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: { messageId: "msg-1", destination: ["ops@acme.com"] },
  receipt: { recipients: ["ops@acme.com"], action: { type: "S3", bucketName: "acme-inbound", objectKey: "inbound/acme.com/msg-1" } },
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://x/webhook/ses-inbound", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("inbound webhook", () => {
  it("returns null for unrelated paths", async () => {
    const r = await handleInboundWebhook(new Request("http://x/api/whatever", { method: "POST" }), "/api/whatever", "POST");
    expect(r).toBeNull();
  });

  it("auto-confirms an SNS subscription by fetching SubscribeURL", async () => {
    const fetched: string[] = [];
    const res = await handleInboundWebhook(
      post({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.confirm/abc" }),
      "/webhook/ses-inbound", "POST",
      { fetchUrl: async (u) => { fetched.push(u); } },
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, confirmed: true });
    expect(fetched).toEqual(["https://sns.confirm/abc"]);
  });

  it("syncs on a raw-delivery notification (Body is the SES message)", async () => {
    const calls: Array<{ bucket: string }> = [];
    const res = await handleInboundWebhook(
      post(JSON.parse(sesNotification)),
      "/webhook/ses-inbound", "POST",
      { sync: async (bucket) => { calls.push({ bucket }); return { synced: 1 }; } },
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.synced).toBe(1);
    expect(body.message_id).toBe("msg-1");
    expect(calls[0]!.bucket).toBe("acme-inbound");
  });

  it("syncs on an SNS-wrapped Notification", async () => {
    let synced = 0;
    const res = await handleInboundWebhook(
      post({ Type: "Notification", Message: sesNotification }),
      "/webhook/ses-inbound", "POST",
      { sync: async () => { synced++; return { synced: 2 }; } },
    );
    expect((await res!.json()).synced).toBe(2);
    expect(synced).toBe(1);
  });

  it("ignores an unrecognized notification gracefully", async () => {
    const res = await handleInboundWebhook(
      post({ Type: "Notification", Message: JSON.stringify({ hello: "world" }) }),
      "/webhook/ses-inbound", "POST",
      { sync: async () => ({ synced: 0 }) },
    );
    expect((await res!.json()).ignored).toBeTruthy();
  });
});
