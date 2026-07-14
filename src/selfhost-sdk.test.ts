import { describe, expect, it } from "bun:test";
import { EmailsSelfHostClient } from "./selfhost.js";

function okFetch(capture: (request: Request) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture(new Request(input, init));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("generated self-hosted SDK identity contract", () => {
  it("sends a user session as Authorization Bearer and does not duplicate credentials", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      bearerToken: "session-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.listTenants();
    expect(request?.headers.get("authorization")).toBe("Bearer session-placeholder");
    expect(request?.headers.has("x-api-key")).toBe(false);
  });

  it("keeps tenant API-key authentication and exposes the formalized identity surface", async () => {
    let request: Request | null = null;
    const client = new EmailsSelfHostClient({
      baseUrl: "https://emails.example.test",
      apiKey: "api-key-placeholder",
      fetch: okFetch((value) => { request = value; }),
    });

    await client.getCurrentPrincipal();
    expect(request?.headers.get("x-api-key")).toBe("api-key-placeholder");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(typeof client.signUp).toBe("function");
    expect(typeof client.bootstrapPrimarySuperAdmin).toBe("function");
    expect(typeof client.listEmailIdentities).toBe("function");
    expect(typeof client.updateMembership).toBe("function");
    expect(typeof client.createTenantKey).toBe("function");
  });
});
