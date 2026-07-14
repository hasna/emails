// Self-hosted-ONLY: the sandbox repo routes every read/write to the /v1
// `sandbox-emails` resource. Exercises the REAL synchronous curl transport
// against an out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Providers are no longer a
// local table (a provider_id is just an opaque string filter), so the old
// createProvider/makeProvider helpers are replaced by literal ids. The list
// helpers dropped their trailing `db` slot; malformed-JSON tolerance is now
// exercised by seeding raw column values on the /v1 store.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  storeSandboxEmail,
  listSandboxEmails,
  listSandboxEmailSummaries,
  getSandboxEmail,
  clearSandboxEmails,
  getSandboxCount,
} from "./sandbox.js";
import type { StoreSandboxEmailInput } from "./sandbox.js";

let stub: V1Stub;

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

const P1 = "provider-1";
const P2 = "provider-2";

function input(overrides: Partial<StoreSandboxEmailInput> = {}): StoreSandboxEmailInput {
  return {
    provider_id: P1,
    from_address: "a@a.com",
    to_addresses: ["b@b.com"],
    cc_addresses: [],
    bcc_addresses: [],
    reply_to: null,
    subject: "subject",
    html: null,
    text_body: "t",
    attachments: [],
    headers: {},
    ...overrides,
  };
}

describe("storeSandboxEmail", () => {
  it("stores an email and returns it with parsed arrays", () => {
    const email = storeSandboxEmail(input({
      provider_id: P1,
      from_address: "from@example.com",
      to_addresses: ["to@example.com"],
      subject: "Hello sandbox",
      html: "<p>Hello</p>",
      text_body: "Hello",
    }));

    expect(email.id).toHaveLength(36);
    expect(email.provider_id).toBe(P1);
    expect(email.from_address).toBe("from@example.com");
    expect(email.to_addresses).toEqual(["to@example.com"]);
    expect(email.cc_addresses).toEqual([]);
    expect(email.bcc_addresses).toEqual([]);
    expect(email.reply_to).toBeNull();
    expect(email.subject).toBe("Hello sandbox");
    expect(email.html).toBe("<p>Hello</p>");
    expect(email.text_body).toBe("Hello");
    expect(email.attachments).toEqual([]);
    expect(email.headers).toEqual({});
    expect(email.created_at).toBeTruthy();
  });

  it("stores multiple recipients in to/cc/bcc", () => {
    const email = storeSandboxEmail(input({
      to_addresses: ["a@example.com", "b@example.com"],
      cc_addresses: ["cc@example.com"],
      bcc_addresses: ["bcc@example.com"],
      reply_to: "reply@example.com",
      subject: "Multi",
      text_body: "text",
      headers: { "X-Custom": "value" },
    }));

    expect(email.to_addresses).toEqual(["a@example.com", "b@example.com"]);
    expect(email.cc_addresses).toEqual(["cc@example.com"]);
    expect(email.bcc_addresses).toEqual(["bcc@example.com"]);
    expect(email.reply_to).toBe("reply@example.com");
    expect(email.headers).toEqual({ "X-Custom": "value" });
  });
});

describe("listSandboxEmails", () => {
  it("returns all emails when no provider filter", () => {
    storeSandboxEmail(input({ provider_id: P1, subject: "Email 1" }));
    storeSandboxEmail(input({ provider_id: P2, subject: "Email 2" }));
    expect(listSandboxEmails(undefined, 50).length).toBe(2);
  });

  it("filters by provider_id", () => {
    storeSandboxEmail(input({ provider_id: P1, subject: "P1 Email" }));
    storeSandboxEmail(input({ provider_id: P2, subject: "P2 Email" }));

    const p1Emails = listSandboxEmails(P1, 50);
    expect(p1Emails.length).toBe(1);
    expect(p1Emails[0]!.subject).toBe("P1 Email");

    const p2Emails = listSandboxEmails(P2, 50);
    expect(p2Emails.length).toBe(1);
    expect(p2Emails[0]!.subject).toBe("P2 Email");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) storeSandboxEmail(input({ subject: `Email ${i}` }));
    expect(listSandboxEmails(undefined, 3).length).toBe(3);
  });

  it("respects offset", async () => {
    // Seed explicit created_at so the newest-first page windows deterministically.
    await stub.seed({
      "sandbox-emails": Array.from({ length: 5 }, (_v, i) => ({
        id: `sbx-${i}`,
        provider_id: P1,
        from_address: "a@a.com",
        to_addresses: ["b@b.com"],
        cc_addresses: [],
        bcc_addresses: [],
        reply_to: null,
        subject: `Offset ${i}`,
        html: null,
        text_body: "t",
        attachments_json: "[]",
        headers_json: "{}",
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const page1 = listSandboxEmails(undefined, 2, 0).map((e) => e.id);
    const page2 = listSandboxEmails(undefined, 2, 2).map((e) => e.id);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page2).not.toEqual(page1);
    expect(page2.some((id) => page1.includes(id))).toBe(false);
  });

  it("clamps negative pagination values", () => {
    for (let i = 0; i < 3; i++) storeSandboxEmail(input({ subject: `Clamp ${i}` }));
    expect(listSandboxEmails(undefined, -5, -10).length).toBe(1);
  });

  it("lists summary rows without body or header payloads", () => {
    storeSandboxEmail(input({
      from_address: "from@example.com",
      to_addresses: ["to@example.com"],
      subject: "Large summary",
      html: `<p>${"large html ".repeat(1000)}</p>`,
      text_body: "large body ".repeat(1000),
      headers: { "x-large": "header" },
    }));

    const [summary] = listSandboxEmailSummaries(P1, 1);

    expect(summary?.subject).toBe("Large summary");
    expect("html" in summary!).toBe(false);
    expect("text_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
  });
});

describe("getSandboxEmail", () => {
  it("returns the email by id", () => {
    const stored = storeSandboxEmail(input({ subject: "Find me", text_body: null }));
    const found = getSandboxEmail(stored.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(stored.id);
    expect(found!.subject).toBe("Find me");
  });

  it("tolerates malformed attachment and header JSON on the /v1 row", async () => {
    // A stored row whose JSON columns are not valid JSON must coerce to safe
    // defaults ([] / {}) rather than throwing.
    await stub.seed({
      "sandbox-emails": [
        {
          id: "sbx-bad",
          provider_id: P1,
          from_address: "a@a.com",
          to_addresses: ["b@b.com"],
          cc_addresses: [],
          bcc_addresses: [],
          reply_to: null,
          subject: "Bad JSON",
          html: null,
          text_body: null,
          attachments_json: "not-json",
          headers_json: "not-json",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const found = getSandboxEmail("sbx-bad");
    expect(found?.to_addresses).toEqual(["b@b.com"]);
    expect(found?.attachments).toEqual([]);
    expect(found?.headers).toEqual({});
  });

  it("returns null for unknown id", () => {
    expect(getSandboxEmail("nonexistent-id")).toBeNull();
  });
});

describe("clearSandboxEmails", () => {
  it("clears all emails and returns count", () => {
    storeSandboxEmail(input({ subject: "S1" }));
    storeSandboxEmail(input({ subject: "S2" }));
    expect(clearSandboxEmails(undefined)).toBe(2);
    expect(listSandboxEmails(undefined, 50).length).toBe(0);
  });

  it("clears only emails for specified provider", () => {
    storeSandboxEmail(input({ provider_id: P1, subject: "P1 Email" }));
    storeSandboxEmail(input({ provider_id: P2, subject: "P2 Email" }));

    expect(clearSandboxEmails(P1)).toBe(1);

    const remaining = listSandboxEmails(undefined, 50);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.provider_id).toBe(P2);
  });

  it("returns 0 when nothing to clear", () => {
    expect(clearSandboxEmails(undefined)).toBe(0);
  });
});

describe("getSandboxCount", () => {
  it("returns total count without filter", () => {
    expect(getSandboxCount(undefined)).toBe(0);
    storeSandboxEmail(input({ subject: "S1" }));
    storeSandboxEmail(input({ subject: "S2" }));
    expect(getSandboxCount(undefined)).toBe(2);
  });

  it("returns count for specific provider", () => {
    storeSandboxEmail(input({ provider_id: P1, subject: "P1" }));
    storeSandboxEmail(input({ provider_id: P1, subject: "P1 2" }));
    storeSandboxEmail(input({ provider_id: P2, subject: "P2" }));

    expect(getSandboxCount(P1)).toBe(2);
    expect(getSandboxCount(P2)).toBe(1);
  });
});
