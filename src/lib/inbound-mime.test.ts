import { describe, it, expect } from "bun:test";
import { parseInboundMime, flattenHeaders } from "./inbound-mime.js";

const rawMultipart = [
  `From: "Acme Billing" <no-reply@acme.com>`,
  `To: andrei@hasna.com, ops@hasna.com`,
  `Cc: audit@hasna.com`,
  `Subject: Your invoice is ready`,
  `Message-ID: <inv-9001@acme.com>`,
  `In-Reply-To: <req-42@hasna.com>`,
  `Date: Wed, 01 Jul 2026 16:37:06 +0000`,
  `MIME-Version: 1.0`,
  `Content-Type: multipart/alternative; boundary="b0undary"`,
  ``,
  `--b0undary`,
  `Content-Type: text/plain; charset="utf-8"`,
  ``,
  `Hello Andrei, your invoice is attached.`,
  `--b0undary`,
  `Content-Type: text/html; charset="utf-8"`,
  ``,
  `<p>Hello Andrei, your invoice is attached.</p>`,
  `--b0undary--`,
  ``,
].join("\r\n");

describe("parseInboundMime", () => {
  it("normalizes a multipart/alternative message to store fields", async () => {
    const r = await parseInboundMime(rawMultipart);
    expect(r.from_addr).toBe(`"Acme Billing" <no-reply@acme.com>`);
    expect(r.to_addrs).toEqual(["andrei@hasna.com", "ops@hasna.com"]);
    expect(r.cc_addrs).toEqual(["audit@hasna.com"]);
    expect(r.subject).toBe("Your invoice is ready");
    expect(r.body_text).toContain("your invoice is attached");
    expect(r.body_html).toContain("<p>");
    expect(r.rfc_message_id).toBe("inv-9001@acme.com");
    expect(r.in_reply_to).toBe("req-42@hasna.com");
    expect(r.received_at).toBe("2026-07-01T16:37:06.000Z");
    // The RFC Message-ID is preserved in the flattened headers.
    expect(r.headers["message-id"]).toContain("inv-9001@acme.com");
    expect(r.attachments).toEqual([]);
  });

  it("handles a plain text message with no date", async () => {
    const raw = [
      `From: sender@example.com`,
      `To: andrei@hasna.com`,
      `Subject: hi`,
      ``,
      `just text`,
      ``,
    ].join("\r\n");
    const r = await parseInboundMime(raw);
    expect(r.from_addr).toContain("sender@example.com");
    expect(r.to_addrs).toEqual(["andrei@hasna.com"]);
    expect(r.body_text).toContain("just text");
    expect(r.received_at).toBeNull();
  });
});

describe("flattenHeaders", () => {
  it("flattens a Map of header values", () => {
    const m = new Map<string, unknown>([
      ["subject", "hi"],
      ["received", ["a", "b"]],
      ["from", { text: "X <x@y.com>", value: [] }],
    ]);
    const out = flattenHeaders(m);
    expect(out["subject"]).toBe("hi");
    expect(out["received"]).toBe("a b");
    expect(out["from"]).toBe("X <x@y.com>");
  });

  it("returns an empty object for nullish input", () => {
    expect(flattenHeaders(undefined)).toEqual({});
    expect(flattenHeaders(null)).toEqual({});
  });
});
