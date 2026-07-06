// @generated from src/server/cloud/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
// @generated from OpenAPI by @hasna/contracts SDK generator — DO NOT EDIT.
// Source: Mailery Self-Hosted API 1.0.0

export interface Domain { "id": string; "domain": string; "status": string; "provider"?: string | null; "verified": boolean; "notes"?: string | null; "created_at": string; "updated_at": string }

export interface Address { "id": string; "email": string; "domain"?: string | null; "display_name"?: string | null; "status": string; "created_at": string; "updated_at": string }

export interface Message { "id": string; "from_addr": string; "to_addrs": Array<string>; "subject"?: string | null; "body_text"?: string | null; "body_html"?: string | null; "status": string; "provider_message_id"?: string | null; "created_at": string; "updated_at": string }

export interface MailerySelfHostClientOptions {
  /** Base URL, e.g. process.env.APP_API_URL. */
  baseUrl: string;
  /** API key, e.g. process.env.APP_API_KEY. Sent as the 'x-api-key' header. */
  apiKey?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class MailerySelfHostClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: MailerySelfHostClientOptions) {
    if (!options.baseUrl) throw new Error("MailerySelfHostClient requires a baseUrl.");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseHeaders = options.headers ?? {};
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown>; init?: RequestInit }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.baseHeaders, ...(opts.init?.headers as Record<string, string> | undefined) };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let payload: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!response.ok) {
      throw new ApiError(response.status, `${method} ${path} failed: ${response.status}`, data);
    }
    return data as T;
  }

    /** Liveness probe with database reachability */
    async getHealth(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/health`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Readiness probe (reachable and fully migrated) */
    async getReady(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/ready`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async listAddresses(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "addresses"?: Array<Address> }> {
      return this.request("GET", `/v1/addresses`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Register an email address (scope mailery:write) */
    async createAddress(body: { "email": string; "display_name"?: string | null; "status"?: string }, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("POST", `/v1/addresses`, {
        body,
        query: undefined,
        init,
      });
    }

    async getAddress(id: string, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("GET", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteAddress(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateAddress(id: string, body: { "display_name"?: string | null; "status"?: string }, init?: RequestInit): Promise<{ "address"?: Address }> {
      return this.request("PATCH", `/v1/addresses/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** List sending domains */
    async listDomains(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "domains"?: Array<Domain> }> {
      return this.request("GET", `/v1/domains`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Register a sending domain (scope mailery:write) */
    async createDomain(body: { "domain": string; "status"?: string; "provider"?: string | null; "verified"?: boolean; "notes"?: string | null }, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("POST", `/v1/domains`, {
        body,
        query: undefined,
        init,
      });
    }

    async getDomain(id: string, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("GET", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteDomain(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateDomain(id: string, body: { "status"?: string; "provider"?: string | null; "verified"?: boolean; "notes"?: string | null }, init?: RequestInit): Promise<{ "domain"?: Domain }> {
      return this.request("PATCH", `/v1/domains/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    async listMessages(query?: { "limit"?: number; "offset"?: number }, init?: RequestInit): Promise<{ "messages"?: Array<Message> }> {
      return this.request("GET", `/v1/messages`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Record an outbound message in the ledger (scope mailery:write) */
    async createMessage(body: { "from": string; "to": Array<string>; "subject"?: string | null; "text"?: string | null; "html"?: string | null; "status"?: string }, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("POST", `/v1/messages`, {
        body,
        query: undefined,
        init,
      });
    }

    async getMessage(id: string, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("GET", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async deleteMessage(id: string, init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("DELETE", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    async updateMessage(id: string, body: { "status"?: string; "provider_message_id"?: string | null }, init?: RequestInit): Promise<{ "message"?: Message }> {
      return this.request("PATCH", `/v1/messages/${encodeURIComponent(String(id))}`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Service version and mode */
    async getVersion(init?: RequestInit): Promise<Record<string, unknown>> {
      return this.request("GET", `/version`, {
        body: undefined,
        query: undefined,
        init,
      });
    }
}
