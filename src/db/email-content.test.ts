// Self-hosted-ONLY: a sent email's body/headers live on its /v1/messages record
// (body_text / body_html / headers). storeEmailContent PATCHes those fields and
// getEmailContent maps them back. Exercises the REAL curl transport against an
// out-of-process /v1 stub — see src/test-support/v1-stub.ts.
//
// Migrated from the deleted local-SQLite pattern (getDatabase/resetDatabase/
// :memory:/EMAILS_DB_PATH). The former "tolerates malformed header JSON" test
// mutated the local `email_content.headers_json` column with db.run; here we seed
// the malformed value onto the /v1 message row instead.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createEmail } from "./emails.js";
import { storeEmailContent, getEmailContent } from "./email-content.js";

let stub: V1Stub;

const providerId = "prov-1";

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test Subject",
  text: "Hello world",
};

/** Create a sent /v1/messages row and return its id (the body starts empty). */
function newMessageId(): string {
  return createEmail(providerId, baseOpts).id;
}

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("storeEmailContent", () => {
  it("stores text content", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, { text: "Hello world" });
    const content = getEmailContent(emailId);
    expect(content).not.toBeNull();
    expect(content!.text_body).toBe("Hello world");
    expect(content!.html).toBeNull();
    expect(content!.headers).toEqual({});
  });

  it("stores html content", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, { html: "<p>Hello</p>" });
    const content = getEmailContent(emailId);
    expect(content).not.toBeNull();
    expect(content!.html).toBe("<p>Hello</p>");
    expect(content!.text_body).toBeNull();
  });

  it("stores both html and text", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, { html: "<p>Hello</p>", text: "Hello" });
    const content = getEmailContent(emailId);
    expect(content!.html).toBe("<p>Hello</p>");
    expect(content!.text_body).toBe("Hello");
  });

  it("stores headers", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, {
      text: "body",
      headers: { "X-Custom": "value", "X-Priority": "1" },
    });
    const content = getEmailContent(emailId);
    expect(content!.headers).toEqual({ "X-Custom": "value", "X-Priority": "1" });
  });

  it("replaces existing content on re-store", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, { text: "first" });
    storeEmailContent(emailId, { text: "second" });
    const content = getEmailContent(emailId);
    expect(content!.text_body).toBe("second");
  });
});

describe("getEmailContent", () => {
  it("returns null for unknown email id", () => {
    expect(getEmailContent("nonexistent")).toBeNull();
  });

  it("returns stored content with email_id", () => {
    const emailId = newMessageId();
    storeEmailContent(emailId, { text: "test" });
    const content = getEmailContent(emailId);
    expect(content!.email_id).toBe(emailId);
  });

  it("coerces malformed header JSON to an empty object", async () => {
    // A /v1 message row whose `headers` is not valid JSON must map to {} (cobj).
    await stub.seed({
      messages: [
        {
          id: "bad-headers",
          direction: "outbound",
          from_addr: "sender@example.com",
          to_addrs: ["recipient@example.com"],
          subject: "Bad headers",
          status: "sent",
          body_text: "test",
          headers: "not-json",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const content = getEmailContent("bad-headers");
    expect(content?.headers).toEqual({});
    expect(content?.text_body).toBe("test");
  });
});
