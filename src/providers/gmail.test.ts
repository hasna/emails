import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Provider } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";

// ─── Mocks for googleapis ──────────────────────────────────────────────────────

const mockGetProfile = mock(async () => ({
  data: { emailAddress: "user@gmail.com", messagesTotal: 100 },
}));

const mockMessagesSend = mock(async () => ({
  data: { id: "mock-message-id-123", threadId: "thread-abc" },
}));

const mockMessagesList = mock(async () => ({
  data: {
    messages: [
      { id: "msg1" },
      { id: "msg2" },
    ],
  },
}));

const mockMessagesGet = mock(async ({ id }: { id: string }) => ({
  data: {
    id,
    threadId: "thread-abc",
    labelIds: ["SENT"],
    internalDate: "1700000000000",
    payload: {
      headers: [
        { name: "To", value: "recipient@example.com" },
        { name: "Subject", value: "Test" },
      ],
    },
  },
}));

// Mock the entire googleapis module
mock.module("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        setCredentials() {}
      },
    },
    gmail: () => ({
      users: {
        getProfile: mockGetProfile,
        messages: {
          send: mockMessagesSend,
          list: mockMessagesList,
          get: mockMessagesGet,
        },
      },
    }),
  },
}));

// Import after mock setup
const { GmailAdapter, buildMimeMessage } = await import("./gmail.js");

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-123",
    name: "My Gmail",
    type: "gmail",
    api_key: null,
    region: null,
    access_key: null,
    secret_key: null,
    oauth_client_id: "client-id-abc",
    oauth_client_secret: "client-secret-xyz",
    oauth_refresh_token: "refresh-token-123",
    oauth_access_token: "access-token-456",
    oauth_token_expiry: new Date(Date.now() + 3600_000).toISOString(),
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe("GmailAdapter constructor", () => {
  it("throws ProviderConfigError if oauth_client_id is missing", () => {
    expect(() => new GmailAdapter(makeProvider({ oauth_client_id: null }))).toThrow(ProviderConfigError);
  });

  it("throws ProviderConfigError if oauth_client_secret is missing", () => {
    expect(() => new GmailAdapter(makeProvider({ oauth_client_secret: null }))).toThrow(ProviderConfigError);
  });

  it("throws ProviderConfigError if oauth_refresh_token is missing", () => {
    expect(() => new GmailAdapter(makeProvider({ oauth_refresh_token: null }))).toThrow(ProviderConfigError);
  });

  it("constructs successfully with all required fields", () => {
    expect(() => new GmailAdapter(makeProvider())).not.toThrow();
  });
});

// ─── listAddresses ────────────────────────────────────────────────────────────

describe("GmailAdapter.listAddresses", () => {
  beforeEach(() => {
    mockGetProfile.mockReset();
    mockGetProfile.mockImplementation(async () => ({
      data: { emailAddress: "user@gmail.com" },
    }));
  });

  it("returns the authenticated user email as a verified address", async () => {
    const adapter = new GmailAdapter(makeProvider());
    const addresses = await adapter.listAddresses();

    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.email).toBe("user@gmail.com");
    expect(addresses[0]!.verified).toBe(true);
  });

  it("returns empty array if getProfile returns no emailAddress", async () => {
    mockGetProfile.mockImplementation(async () => ({ data: {} }));
    const adapter = new GmailAdapter(makeProvider());
    const addresses = await adapter.listAddresses();
    expect(addresses).toHaveLength(0);
  });
});

// ─── addAddress ───────────────────────────────────────────────────────────────

describe("GmailAdapter.addAddress", () => {
  it("throws an error explaining Gmail addresses are OAuth-managed", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await expect(adapter.addAddress("test@gmail.com")).rejects.toThrow(/OAuth/);
  });
});

// ─── addDomain ────────────────────────────────────────────────────────────────

describe("GmailAdapter.addDomain", () => {
  it("throws an error explaining Gmail does not support domain management", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await expect(adapter.addDomain("example.com")).rejects.toThrow(/domain management/i);
  });
});

// ─── listDomains / getDnsRecords / verifyDomain ───────────────────────────────

describe("GmailAdapter domain no-ops", () => {
  it("listDomains returns empty array", async () => {
    const adapter = new GmailAdapter(makeProvider());
    expect(await adapter.listDomains()).toEqual([]);
  });

  it("getDnsRecords returns empty array", async () => {
    const adapter = new GmailAdapter(makeProvider());
    expect(await adapter.getDnsRecords("example.com")).toEqual([]);
  });

  it("verifyDomain returns all pending", async () => {
    const adapter = new GmailAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");
    expect(result).toEqual({ dkim: "pending", spf: "pending", dmarc: "pending" });
  });
});

// ─── sendEmail ────────────────────────────────────────────────────────────────

describe("GmailAdapter.sendEmail", () => {
  beforeEach(() => {
    mockMessagesSend.mockReset();
    mockMessagesSend.mockImplementation(async () => ({
      data: { id: "mock-message-id-123" },
    }));
  });

  it("calls gmail.users.messages.send and returns the message ID", async () => {
    const adapter = new GmailAdapter(makeProvider());
    const messageId = await adapter.sendEmail({
      from: "user@gmail.com",
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Hello world",
    });

    expect(messageId).toBe("mock-message-id-123");
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);

    // Verify the raw message was base64url encoded
    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    expect(typeof requestBody.raw).toBe("string");

    // Decode and check MIME headers
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("From: user@gmail.com");
    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: Test Subject");
  });

  it("handles array 'to' field", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await adapter.sendEmail({
      from: "user@gmail.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Multi-recipient",
      text: "Test",
    });

    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: a@example.com, b@example.com");
  });

  it("includes CC, BCC, and Reply-To headers", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await adapter.sendEmail({
      from: "user@gmail.com",
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      reply_to: "reply@example.com",
      subject: "Headers Test",
      text: "Body",
    });

    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
    expect(decoded).toContain("Reply-To: reply@example.com");
  });

  it("sends HTML email with correct content type", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await adapter.sendEmail({
      from: "user@gmail.com",
      to: "to@example.com",
      subject: "HTML Email",
      html: "<h1>Hello</h1>",
    });

    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(decoded).toContain("<h1>Hello</h1>");
  });

  it("sends multipart/alternative when both html and text are provided", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await adapter.sendEmail({
      from: "user@gmail.com",
      to: "to@example.com",
      subject: "Alt Email",
      html: "<p>HTML</p>",
      text: "Plain text",
    });

    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain("<p>HTML</p>");
    expect(decoded).toContain("Plain text");
  });

  it("sends multipart/mixed when attachments are included", async () => {
    const adapter = new GmailAdapter(makeProvider());
    await adapter.sendEmail({
      from: "user@gmail.com",
      to: "to@example.com",
      subject: "With Attachment",
      text: "See attached",
      attachments: [
        {
          filename: "test.txt",
          content: Buffer.from("file content").toString("base64"),
          content_type: "text/plain",
        },
      ],
    });

    const call = mockMessagesSend.mock.calls[0]!;
    const requestBody = (call[0] as { requestBody: { raw: string } }).requestBody;
    const decoded = Buffer.from(requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("multipart/mixed");
    expect(decoded).toContain('filename="test.txt"');
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
  });

  it("returns empty string if response has no id", async () => {
    mockMessagesSend.mockImplementation(async () => ({ data: {} }));
    const adapter = new GmailAdapter(makeProvider());
    const id = await adapter.sendEmail({
      from: "user@gmail.com",
      to: "to@example.com",
      subject: "Test",
      text: "Body",
    });
    expect(id).toBe("");
  });
});

// ─── pullEvents ───────────────────────────────────────────────────────────────

describe("GmailAdapter.pullEvents", () => {
  beforeEach(() => {
    mockMessagesList.mockReset();
    mockMessagesGet.mockReset();

    mockMessagesList.mockImplementation(async () => ({
      data: { messages: [{ id: "msg1" }, { id: "msg2" }] },
    }));

    mockMessagesGet.mockImplementation(async ({ id }: { userId: string; id: string; format?: string; metadataHeaders?: string[] }) => ({
      data: {
        id,
        labelIds: ["SENT"],
        internalDate: "1700000000000",
        payload: {
          headers: [{ name: "To", value: "recipient@example.com" }],
        },
      },
    }));
  });

  it("returns RemoteEvent[] from SENT messages", async () => {
    const adapter = new GmailAdapter(makeProvider());
    const events = await adapter.pullEvents();

    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("delivered");
    expect(events[0]!.provider_event_id).toBe("msg1");
    expect(events[0]!.recipient).toBe("recipient@example.com");
    expect(typeof events[0]!.occurred_at).toBe("string");
  });

  it("passes since date as Gmail query parameter", async () => {
    const adapter = new GmailAdapter(makeProvider());
    const since = "2024-01-15T00:00:00.000Z";
    await adapter.pullEvents(since);

    const call = mockMessagesList.mock.calls[0]!;
    const params = call[0] as { q: string };
    expect(params.q).toContain("after:");
  });

  it("returns empty array if messages list is empty", async () => {
    mockMessagesList.mockImplementation(async () => ({ data: { messages: [] } }));
    const adapter = new GmailAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toEqual([]);
  });

  it("returns empty array if list call fails", async () => {
    mockMessagesList.mockImplementation(async () => { throw new Error("Network error"); });
    const adapter = new GmailAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toEqual([]);
  });

  it("skips messages where detail fetch fails", async () => {
    mockMessagesList.mockImplementation(async () => ({
      data: { messages: [{ id: "msg1" }, { id: "bad" }] },
    }));
    mockMessagesGet.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "bad") throw new Error("Not found");
      return {
        data: {
          id,
          labelIds: ["SENT"],
          internalDate: "1700000000000",
          payload: { headers: [{ name: "To", value: "r@e.com" }] },
        },
      };
    });

    const adapter = new GmailAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.provider_event_id).toBe("msg1");
  });
});

// ─── getStats ─────────────────────────────────────────────────────────────────

describe("GmailAdapter.getStats", () => {
  it("returns Stats object with provider_id and period", async () => {
    mockMessagesList.mockImplementation(async () => ({ data: { messages: [] } }));

    const adapter = new GmailAdapter(makeProvider());
    const stats = await adapter.getStats("7d");

    expect(stats.provider_id).toBe("provider-123");
    expect(stats.period).toBe("7d");
    expect(typeof stats.sent).toBe("number");
    expect(typeof stats.delivery_rate).toBe("number");
  });
});

// ─── buildMimeMessage ─────────────────────────────────────────────────────────

describe("buildMimeMessage", () => {
  it("builds a plain text message", () => {
    const msg = buildMimeMessage(
      { from: "a@b.com", to: "c@d.com", subject: "Hello", text: "World" },
      ["c@d.com"],
    );
    expect(msg).toContain("From: a@b.com");
    expect(msg).toContain("To: c@d.com");
    expect(msg).toContain("Subject: Hello");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain("World");
  });

  it("builds an HTML-only message", () => {
    const msg = buildMimeMessage(
      { from: "a@b.com", to: "c@d.com", subject: "Hi", html: "<b>Bold</b>" },
      ["c@d.com"],
    );
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(msg).toContain("<b>Bold</b>");
  });

  it("builds multipart/alternative for html + text", () => {
    const msg = buildMimeMessage(
      { from: "a@b.com", to: "c@d.com", subject: "Alt", html: "<p>html</p>", text: "plain" },
      ["c@d.com"],
    );
    expect(msg).toContain("multipart/alternative");
    expect(msg).toContain("<p>html</p>");
    expect(msg).toContain("plain");
  });

  it("builds multipart/mixed when attachments present", () => {
    const msg = buildMimeMessage(
      {
        from: "a@b.com",
        to: "c@d.com",
        subject: "Att",
        text: "body",
        attachments: [
          { filename: "f.txt", content: "aGVsbG8=", content_type: "text/plain" },
        ],
      },
      ["c@d.com"],
    );
    expect(msg).toContain("multipart/mixed");
    expect(msg).toContain('filename="f.txt"');
    expect(msg).toContain("Content-Transfer-Encoding: base64");
  });
});
