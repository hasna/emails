import { describe, expect, it } from "bun:test";
import { MaileryCloudClient, MaileryCloudError } from "./mailery-cloud-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("MaileryCloudClient", () => {
  it("prefixes platform API routes and sends bearer auth", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example/",
      token: "secret-token",
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        });
        return jsonResponse({ user: null, tenant: null, auth: { via: "api_key", scopes: ["full"] } });
      }) as typeof fetch,
    });

    await client.me();

    expect(calls).toEqual([{ url: "https://mailery.example/api/v1/auth/me", authorization: "Bearer secret-token" }]);
  });

  it("retries retryable platform errors", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      retries: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ error: { code: "busy", message: "try again" } }, { status: 503 });
        return jsonResponse({ data: [] });
      }) as typeof fetch,
    });

    const result = await client.listMailboxes();

    expect(result).toEqual([]);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("lists messages with cursor pagination metadata", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({
          data: [{ id: "cloud_msg_1", tenantId: "ten_1", mailboxId: "mbx_1" }],
          next_cursor: "cursor_2",
        });
      }) as typeof fetch,
    });

    const page = await client.listMessagesPage({ group: "inbox", limit: 10, cursor: "cursor_1" });
    const rows = await client.listMessages({ group: "inbox", limit: 10, cursor: "cursor_1" });

    expect(page.nextCursor).toBe("cursor_2");
    expect(rows).toEqual(page.data);
    expect(calls[0]).toBe("https://mailery.example/api/v1/messages?group=inbox&limit=10&cursor=cursor_1");
  });

  it("maps platform error envelopes into typed errors", async () => {
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      retries: 0,
      fetchImpl: (async () => jsonResponse({ error: { code: "forbidden", message: "billing_read scope required" } }, { status: 403 })) as typeof fetch,
    });

    try {
      await client.billingOverview();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MaileryCloudError);
      expect((error as MaileryCloudError).status).toBe(403);
      expect((error as MaileryCloudError).code).toBe("forbidden");
      expect(error instanceof Error ? error.message : "").toBe("billing_read scope required");
    }
  });

  it("sends explicit MX migration consent during cloud domain setup", async () => {
    const calls: Array<{ body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (_url, init) => {
        calls.push({ body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({ domain: "example.com", status: "pending_dns" });
      }) as typeof fetch,
    });

    await client.setupDomain({
      domain: "example.com",
      address: "agent",
      catchAll: true,
      mxMigrationConsent: true,
    });

    expect(calls[0]?.body).toEqual({
      domain: "example.com",
      address: "agent",
      catchAll: true,
      mxMigrationConsent: true,
    });
  });
});
