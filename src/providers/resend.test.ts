import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Provider } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";

// ─── Mocks for resend ──────────────────────────────────────────────────────────

const mockDomainsList = mock(async () => ({
  data: {
    data: [
      { id: "domain-1", name: "example.com", status: "verified" },
      { id: "domain-2", name: "test.com", status: "not_started" },
    ],
  },
  error: null,
}));

const mockDomainsGet = mock(async (_id: string) => ({
  data: {
    id: "domain-1",
    name: "example.com",
    status: "verified",
    records: [
      { type: "CNAME", name: "resend._domainkey.example.com", value: "resend.domainkey.resend.com" },
      { type: "TXT", name: "example.com", value: "v=spf1 include:resend.com ~all" },
    ],
  },
  error: null,
}));

const mockDomainsVerify = mock(async (_id: string) => ({
  data: { id: _id },
  error: null,
}));

const mockDomainsCreate = mock(async (_opts: { name: string }) => ({
  data: { id: "new-domain-id", name: _opts.name },
  error: null,
}));

const mockEmailsSend = mock(async (_payload: unknown) => ({
  data: { id: "email-msg-id-123" },
  error: null,
}));

const mockEmailsList = mock(async (_opts?: { limit?: number }) => ({
  data: [
    {
      id: "email-1",
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Test",
      created_at: new Date().toISOString(),
      last_event: "delivered",
    },
    {
      id: "email-2",
      from: "sender@example.com",
      to: ["other@example.com"],
      subject: "Test 2",
      created_at: new Date().toISOString(),
      last_event: "bounced",
    },
  ],
  error: null,
}));

// Mock the entire resend module
mock.module("resend", () => ({
  Resend: class MockResend {
    domains = {
      list: mockDomainsList,
      get: mockDomainsGet,
      verify: mockDomainsVerify,
      create: mockDomainsCreate,
    };
    emails = {
      send: mockEmailsSend,
      list: mockEmailsList,
    };
  },
}));

// Import after mock setup
const { ResendAdapter } = await import("./resend.js");

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-resend-1",
    name: "My Resend",
    type: "resend",
    api_key: "re_test_key_abc123",
    region: null,
    access_key: null,
    secret_key: null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe("ResendAdapter constructor", () => {
  it("throws ProviderConfigError if api_key is missing", () => {
    expect(() => new ResendAdapter(makeProvider({ api_key: null }))).toThrow(ProviderConfigError);
  });

  it("throws ProviderConfigError with helpful message", () => {
    expect(() => new ResendAdapter(makeProvider({ api_key: null }))).toThrow(/API key/);
  });

  it("constructs successfully with api_key set", () => {
    expect(() => new ResendAdapter(makeProvider())).not.toThrow();
  });
});

// ─── listDomains ─────────────────────────────────────────────────────────────

describe("ResendAdapter.listDomains", () => {
  beforeEach(() => {
    mockDomainsList.mockReset();
    mockDomainsList.mockImplementation(async () => ({
      data: {
        data: [
          { id: "domain-1", name: "example.com", status: "verified" },
          { id: "domain-2", name: "test.com", status: "not_started" },
          { id: "domain-3", name: "failed.com", status: "failed" },
        ],
      },
      error: null,
    }));
  });

  it("returns RemoteDomain[] mapped from Resend domains", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains).toHaveLength(3);
    expect(domains[0]!.domain).toBe("example.com");
    expect(domains[1]!.domain).toBe("test.com");
    expect(domains[2]!.domain).toBe("failed.com");
  });

  it("maps verified status correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains[0]!.dkim_status).toBe("verified");
    expect(domains[0]!.spf_status).toBe("verified");
    expect(domains[0]!.dmarc_status).toBe("pending");
  });

  it("maps not_started to pending", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains[1]!.dkim_status).toBe("pending");
    expect(domains[1]!.spf_status).toBe("pending");
  });

  it("maps failed status correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();

    expect(domains[2]!.dkim_status).toBe("failed");
    expect(domains[2]!.spf_status).toBe("failed");
  });

  it("returns empty array when data is null", async () => {
    mockDomainsList.mockImplementation(async () => ({ data: null, error: null }));
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();
    expect(domains).toEqual([]);
  });

  it("returns empty array when data.data is null/undefined", async () => {
    mockDomainsList.mockImplementation(async () => ({ data: { data: null }, error: null }));
    const adapter = new ResendAdapter(makeProvider());
    const domains = await adapter.listDomains();
    expect(domains).toEqual([]);
  });
});

// ─── getDnsRecords ───────────────────────────────────────────────────────────

describe("ResendAdapter.getDnsRecords", () => {
  beforeEach(() => {
    mockDomainsList.mockReset();
    mockDomainsGet.mockReset();

    mockDomainsList.mockImplementation(async () => ({
      data: {
        data: [{ id: "domain-1", name: "example.com", status: "verified" }],
      },
      error: null,
    }));

    mockDomainsGet.mockImplementation(async (_id: string) => ({
      data: {
        id: "domain-1",
        name: "example.com",
        status: "verified",
        records: [
          { type: "CNAME", name: "resend._domainkey.example.com", value: "resend.domainkey.resend.com" },
          { type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com" },
        ],
      },
      error: null,
    }));
  });

  it("returns DnsRecord[] for a known domain", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    // Should include CNAME + MX from resend + SPF + DMARC
    expect(records.length).toBeGreaterThanOrEqual(3);
  });

  it("includes CNAME records from resend dnsRecords", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const cname = records.find((r) => r.type === "CNAME");
    expect(cname).toBeDefined();
    expect(cname!.purpose).toBe("DKIM");
    expect(cname!.name).toBe("resend._domainkey.example.com");
  });

  it("always includes SPF TXT record", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const spf = records.find((r) => r.purpose === "SPF");
    expect(spf).toBeDefined();
    expect(spf!.type).toBe("TXT");
    expect(spf!.value).toContain("v=spf1");
  });

  it("always includes DMARC TXT record", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    const dmarc = records.find((r) => r.purpose === "DMARC");
    expect(dmarc).toBeDefined();
    expect(dmarc!.type).toBe("TXT");
    expect(dmarc!.name).toBe("_dmarc.example.com");
    expect(dmarc!.value).toContain("v=DMARC1");
  });

  it("returns empty array when domain not found in list", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("unknown.com");
    expect(records).toEqual([]);
  });

  it("returns empty array when domains list has no data", async () => {
    mockDomainsList.mockImplementation(async () => ({ data: null, error: null }));
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");
    expect(records).toEqual([]);
  });

  it("returns only SPF+DMARC when detail has no records", async () => {
    mockDomainsGet.mockImplementation(async (_id: string) => ({
      data: { id: "domain-1", name: "example.com", status: "verified", records: null },
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const records = await adapter.getDnsRecords("example.com");

    // Only SPF + DMARC
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.purpose)).toEqual(["SPF", "DMARC"]);
  });
});

// ─── verifyDomain ─────────────────────────────────────────────────────────────

describe("ResendAdapter.verifyDomain", () => {
  beforeEach(() => {
    mockDomainsList.mockReset();
    mockDomainsVerify.mockReset();
    mockDomainsGet.mockReset();

    mockDomainsList.mockImplementation(async () => ({
      data: {
        data: [{ id: "domain-1", name: "example.com", status: "verified" }],
      },
      error: null,
    }));

    mockDomainsVerify.mockImplementation(async (_id: string) => ({
      data: { id: _id },
      error: null,
    }));

    mockDomainsGet.mockImplementation(async (_id: string) => ({
      data: { id: "domain-1", name: "example.com", status: "verified" },
      error: null,
    }));
  });

  it("returns verified status for a verified domain", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("verified");
    expect(result.spf).toBe("verified");
    expect(result.dmarc).toBe("pending");
  });

  it("calls domains.verify with the domain id", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.verifyDomain("example.com");
    expect(mockDomainsVerify).toHaveBeenCalledTimes(1);
    expect(mockDomainsVerify.mock.calls[0]![0]).toBe("domain-1");
  });

  it("returns all pending when domain not found", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyDomain("notfound.com");

    expect(result).toEqual({ dkim: "pending", spf: "pending", dmarc: "pending" });
  });

  it("returns all pending when domains.list returns no data", async () => {
    mockDomainsList.mockImplementation(async () => ({ data: null, error: null }));
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result).toEqual({ dkim: "pending", spf: "pending", dmarc: "pending" });
  });

  it("maps failed domain status to failed", async () => {
    mockDomainsGet.mockImplementation(async (_id: string) => ({
      data: { id: "domain-1", name: "example.com", status: "failed" },
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("failed");
    expect(result.spf).toBe("failed");
  });

  it("maps temporary_failure to failed", async () => {
    mockDomainsGet.mockImplementation(async (_id: string) => ({
      data: { id: "domain-1", name: "example.com", status: "temporary_failure" },
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyDomain("example.com");

    expect(result.dkim).toBe("failed");
  });
});

// ─── addDomain ────────────────────────────────────────────────────────────────

describe("ResendAdapter.addDomain", () => {
  beforeEach(() => {
    mockDomainsCreate.mockReset();
    mockDomainsCreate.mockImplementation(async (opts: { name: string }) => ({
      data: { id: "new-id", name: opts.name },
      error: null,
    }));
  });

  it("calls domains.create with the domain name", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.addDomain("newdomain.com");

    expect(mockDomainsCreate).toHaveBeenCalledTimes(1);
    const call = mockDomainsCreate.mock.calls[0]![0] as { name: string };
    expect(call.name).toBe("newdomain.com");
  });

  it("resolves without error", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await expect(adapter.addDomain("newdomain.com")).resolves.toBeUndefined();
  });
});

// ─── listAddresses ────────────────────────────────────────────────────────────

describe("ResendAdapter.listAddresses", () => {
  it("returns empty array (Resend has no address list concept)", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const addresses = await adapter.listAddresses();
    expect(addresses).toEqual([]);
  });
});

// ─── addAddress ───────────────────────────────────────────────────────────────

describe("ResendAdapter.addAddress", () => {
  it("resolves without error (no-op for Resend)", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await expect(adapter.addAddress("sender@example.com")).resolves.toBeUndefined();
  });
});

// ─── verifyAddress ────────────────────────────────────────────────────────────

describe("ResendAdapter.verifyAddress", () => {
  it("returns true (Resend allows sending from verified domain addresses)", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const result = await adapter.verifyAddress("sender@example.com");
    expect(result).toBe(true);
  });
});

// ─── sendEmail ────────────────────────────────────────────────────────────────

describe("ResendAdapter.sendEmail", () => {
  beforeEach(() => {
    mockEmailsSend.mockReset();
    mockEmailsSend.mockImplementation(async (_payload: unknown) => ({
      data: { id: "email-msg-id-123" },
      error: null,
    }));
  });

  it("calls emails.send and returns message ID", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const id = await adapter.sendEmail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Hello",
      text: "World",
    });

    expect(id).toBe("email-msg-id-123");
    expect(mockEmailsSend).toHaveBeenCalledTimes(1);
  });

  it("sends plain text email", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Plain",
      text: "Hello plain text",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.text).toBe("Hello plain text");
    expect(payload.html).toBeUndefined();
  });

  it("sends HTML email", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "HTML",
      html: "<h1>Hello</h1>",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.html).toBe("<h1>Hello</h1>");
  });

  it("handles array 'to' field", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: ["b@example.com", "c@example.com"],
      subject: "Multi",
      text: "Hello",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(Array.isArray(payload.to)).toBe(true);
    expect(payload.to).toEqual(["b@example.com", "c@example.com"]);
  });

  it("includes cc as array", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      cc: "cc@example.com",
      subject: "CC Test",
      text: "Body",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.cc).toEqual(["cc@example.com"]);
  });

  it("includes bcc as array", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      bcc: "bcc@example.com",
      subject: "BCC Test",
      text: "Body",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.bcc).toEqual(["bcc@example.com"]);
  });

  it("includes reply_to as replyTo", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      reply_to: "reply@example.com",
      subject: "Reply-To Test",
      text: "Body",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.replyTo).toBe("reply@example.com");
  });

  it("includes attachments", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Attachment Test",
      text: "See attached",
      attachments: [
        {
          filename: "test.txt",
          content: Buffer.from("file content").toString("base64"),
          content_type: "text/plain",
        },
      ],
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    const attachments = payload.attachments as Array<{ filename: string; content: Buffer }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("test.txt");
    expect(attachments[0]!.content).toBeInstanceOf(Buffer);
  });

  it("returns empty string when response has no id", async () => {
    mockEmailsSend.mockImplementation(async (_payload: unknown) => ({
      data: {},
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const id = await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Test",
      text: "Body",
    });
    expect(id).toBe("");
  });

  it("throws when result has an error", async () => {
    mockEmailsSend.mockImplementation(async (_payload: unknown) => ({
      data: null,
      error: { message: "API rate limit exceeded" },
    }));
    const adapter = new ResendAdapter(makeProvider());
    await expect(
      adapter.sendEmail({
        from: "a@example.com",
        to: "b@example.com",
        subject: "Test",
        text: "Body",
      }),
    ).rejects.toThrow(/API rate limit exceeded/);
  });

  it("includes tags when provided", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Tagged",
      text: "Body",
      tags: { campaign: "newsletter", version: "v2" },
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    const tags = payload.tags as Array<{ name: string; value: string }>;
    expect(tags).toHaveLength(2);
    expect(tags.some((t) => t.name === "campaign" && t.value === "newsletter")).toBe(true);
  });

  it("sends both html and text when both provided", async () => {
    const adapter = new ResendAdapter(makeProvider());
    await adapter.sendEmail({
      from: "a@example.com",
      to: "b@example.com",
      subject: "Both",
      html: "<p>HTML</p>",
      text: "Plain",
    });

    const payload = mockEmailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.html).toBe("<p>HTML</p>");
    expect(payload.text).toBe("Plain");
  });
});

// ─── pullEvents ───────────────────────────────────────────────────────────────

describe("ResendAdapter.pullEvents", () => {
  beforeEach(() => {
    mockEmailsList.mockReset();
    mockEmailsList.mockImplementation(async (_opts?: { limit?: number }) => ({
      data: [
        {
          id: "email-1",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Test",
          created_at: new Date().toISOString(),
          last_event: "delivered",
        },
        {
          id: "email-2",
          from: "sender@example.com",
          to: ["other@example.com"],
          subject: "Test 2",
          created_at: new Date().toISOString(),
          last_event: "bounced",
        },
        {
          id: "email-3",
          from: "sender@example.com",
          to: ["third@example.com"],
          subject: "Test 3",
          created_at: new Date().toISOString(),
          last_event: "opened",
        },
      ],
      error: null,
    }));
  });

  it("returns RemoteEvent[] from emails list", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();

    expect(events.length).toBe(3);
  });

  it("maps delivered event type correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();

    const delivered = events.find((e) => e.type === "delivered");
    expect(delivered).toBeDefined();
    expect(delivered!.provider_message_id).toBe("email-1");
  });

  it("maps bounced event type correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();

    const bounced = events.find((e) => e.type === "bounced");
    expect(bounced).toBeDefined();
  });

  it("maps opened event type correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();

    const opened = events.find((e) => e.type === "opened");
    expect(opened).toBeDefined();
  });

  it("maps bounce alias to bounced", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "email-bounce",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Bounce alias",
          created_at: new Date().toISOString(),
          last_event: "bounce",
        },
      ],
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events[0]!.type).toBe("bounced");
  });

  it("maps complained event type correctly", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "email-complaint",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Complaint",
          created_at: new Date().toISOString(),
          last_event: "complained",
        },
      ],
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events[0]!.type).toBe("complained");
  });

  it("maps clicked event type correctly", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "email-click",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Click",
          created_at: new Date().toISOString(),
          last_event: "click",
        },
      ],
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events[0]!.type).toBe("clicked");
  });

  it("skips emails with unknown event types", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "email-unknown",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Unknown",
          created_at: new Date().toISOString(),
          last_event: "queued", // Unknown type
        },
      ],
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toHaveLength(0);
  });

  it("filters events by since date", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "old-email",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Old",
          created_at: oldDate,
          last_event: "delivered",
        },
        {
          id: "new-email",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "New",
          created_at: recentDate,
          last_event: "delivered",
        },
      ],
      error: null,
    }));

    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents(since);

    expect(events).toHaveLength(1);
    expect(events[0]!.provider_message_id).toBe("new-email");
  });

  it("returns empty array when list throws", async () => {
    mockEmailsList.mockImplementation(async () => {
      throw new Error("API unavailable");
    });
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toEqual([]);
  });

  it("returns empty array when list returns null data", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: null,
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    expect(events).toEqual([]);
  });

  it("event provider_event_id includes email id and event type", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const events = await adapter.pullEvents();
    const event = events.find((e) => e.type === "delivered");

    expect(event!.provider_event_id).toContain("email-1");
    expect(event!.provider_event_id).toContain("delivered");
  });
});

// ─── getStats ─────────────────────────────────────────────────────────────────

describe("ResendAdapter.getStats", () => {
  beforeEach(() => {
    mockEmailsList.mockReset();
    mockEmailsList.mockImplementation(async () => ({
      data: [
        {
          id: "e1",
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "S1",
          created_at: new Date().toISOString(),
          last_event: "delivered",
        },
        {
          id: "e2",
          from: "a@example.com",
          to: ["c@example.com"],
          subject: "S2",
          created_at: new Date().toISOString(),
          last_event: "bounced",
        },
        {
          id: "e3",
          from: "a@example.com",
          to: ["d@example.com"],
          subject: "S3",
          created_at: new Date().toISOString(),
          last_event: "opened",
        },
      ],
      error: null,
    }));
  });

  it("returns Stats object with correct provider_id", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.provider_id).toBe("provider-resend-1");
  });

  it("returns Stats with the period set", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats("7d");

    expect(stats.period).toBe("7d");
  });

  it("uses default period of 30d", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats();

    expect(stats.period).toBe("30d");
  });

  it("returns correct numeric stat fields", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(typeof stats.sent).toBe("number");
    expect(typeof stats.delivered).toBe("number");
    expect(typeof stats.bounced).toBe("number");
    expect(typeof stats.complained).toBe("number");
    expect(typeof stats.opened).toBe("number");
    expect(typeof stats.clicked).toBe("number");
    expect(typeof stats.delivery_rate).toBe("number");
    expect(typeof stats.bounce_rate).toBe("number");
    expect(typeof stats.open_rate).toBe("number");
  });

  it("aggregates delivered and bounced correctly", async () => {
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.delivered).toBe(1);
    expect(stats.bounced).toBe(1);
    expect(stats.opened).toBe(1);
  });

  it("returns 0 rates when no events", async () => {
    mockEmailsList.mockImplementation(async () => ({
      data: [],
      error: null,
    }));
    const adapter = new ResendAdapter(makeProvider());
    const stats = await adapter.getStats("30d");

    expect(stats.sent).toBe(0);
    expect(stats.delivery_rate).toBe(0);
    expect(stats.bounce_rate).toBe(0);
    expect(stats.open_rate).toBe(0);
  });
});
