/**
 * The webhook type maps are plain object literals, so `typeMap[body.type]`
 * with an Object.prototype key ("constructor", "__proto__", "toString", …)
 * returns an inherited FUNCTION or OBJECT instead of undefined. The truthy
 * check then lets the payload through with a garbage event type, and the
 * downstream persist throws — a permanently retried 500 an attacker can
 * trigger with one crafted payload. Both parsers must answer null.
 */
import { describe, expect, it } from "bun:test";
import { parseResendWebhook, parseSesWebhook } from "./webhook-events.js";

const PROTOTYPE_KEYS = ["constructor", "__proto__", "hasOwnProperty", "toString"];

describe("webhook parsers — Object.prototype keys must not escape the type map", () => {
  for (const key of PROTOTYPE_KEYS) {
    it(`parseSesWebhook rejects notificationType "${key}"`, () => {
      const event = parseSesWebhook({
        notificationType: key,
        mail: { messageId: "m-proto", destination: ["ops@acme.com"], timestamp: "2025-01-15T10:00:00Z" },
      });
      expect(event).toBeNull();
    });

    it(`parseResendWebhook rejects type "${key}"`, () => {
      const event = parseResendWebhook({
        type: key,
        data: { email_id: "evt-proto", to: ["user@example.com"], created_at: "2025-01-15T10:00:00Z" },
      });
      expect(event).toBeNull();
    });
  }

  it("still parses genuine event types (guard is an allowlist, not a blocklist)", () => {
    expect(parseSesWebhook({ notificationType: "Delivery", mail: { messageId: "m-ok", destination: ["a@b.co"] } })?.type).toBe("delivered");
    expect(parseResendWebhook({ type: "email.delivered", data: { email_id: "evt-ok", to: ["a@b.co"] } })?.type).toBe("delivered");
  });
});
