import { afterEach, describe, expect, it, mock } from "bun:test";
import { EmailsClient } from "./src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

describe("EmailsClient", () => {
  it("normalizes the server URL and sends JSON requests", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";

    installFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "provider-1",
        name: "dev",
        type: "sandbox",
        active: true,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "http://localhost:3900/" });
    const provider = await client.addProvider({ name: "dev", type: "sandbox" });

    expect(seenUrl).toBe("http://localhost:3900/api/providers");
    expect(seenMethod).toBe("POST");
    expect(JSON.parse(seenBody)).toEqual({ name: "dev", type: "sandbox" });
    expect(provider.id).toBe("provider-1");
  });

  it("serializes query parameters", async () => {
    let seenUrl = "";

    installFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listEmails({ status: "sent", limit: 5 });

    expect(seenUrl).toBe("https://emails.example/api/emails?status=sent&limit=5");
  });

  it("throws API error messages from JSON responses", async () => {
    installFetch(() => new Response(JSON.stringify({ error: "no provider" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    const client = new EmailsClient({ serverUrl: "https://emails.example" });

    await expect(client.listProviders()).rejects.toThrow("no provider");
  });
});
