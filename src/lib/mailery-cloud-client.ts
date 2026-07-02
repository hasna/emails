export const DEFAULT_MAILERY_CLOUD_API_URL = "https://mailery.co";

export type MaileryCloudAuthVia = "session" | "api_key" | "admin_key" | string;
export type MaileryCloudUserRole = "owner" | "admin" | "member" | "viewer";
export type MaileryCloudMailboxProvider = "manual" | "resend" | "ses" | "gmail" | "sandbox";
export type MaileryCloudMailboxStatus = "active" | "paused" | "error";
export type MaileryCloudMessageDirection = "inbound" | "outbound";
export type MaileryCloudDigestWindow = "today" | "yesterday" | "last_7_days" | "month";
export type MaileryCloudCheckoutKind = "subscription" | "credit_pack";

export interface MaileryCloudClientOptions {
  apiUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MaileryCloudRequestOptions {
  method?: string;
  body?: unknown;
  tokenRequired?: boolean;
  idempotencyKey?: string;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface MaileryCloudUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: MaileryCloudUserRole;
  isPlatformAdmin: boolean;
}

export interface MaileryCloudTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudMeResponse {
  user: MaileryCloudUser | null;
  tenant: MaileryCloudTenant | null;
  auth: { via: MaileryCloudAuthVia; scopes: string[] };
}

export interface MaileryCloudAuthResponse {
  token: string;
  user?: MaileryCloudUser;
  tenant?: MaileryCloudTenant;
}

export interface MaileryCloudMailbox {
  id: string;
  tenantId: string;
  name: string | null;
  email: string;
  provider: MaileryCloudMailboxProvider;
  status: MaileryCloudMailboxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  download_url?: string;
}

export interface MaileryCloudMessage {
  id: string;
  tenantId: string;
  mailboxId: string;
  direction: MaileryCloudMessageDirection;
  status: string;
  subject: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  receivedAt: string | null;
  sentAt: string | null;
  textBody: string | null;
  htmlBody: string | null;
  cleanMarkdown: string | null;
  summary: string | null;
  parserModel: string | null;
  classification: Record<string, unknown>;
  importanceScore: number;
  isRead: boolean;
  isImportant: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudMessageWithAttachments extends MaileryCloudMessage {
  attachments: MaileryCloudAttachment[];
}

export interface MaileryCloudMessagePage {
  data: MaileryCloudMessage[];
  nextCursor: string | null;
}

export interface MaileryCloudMessageUploadInput {
  mailboxId: string;
  direction?: MaileryCloudMessageDirection;
  status?: string;
  subject?: string;
  from?: string;
  fromAddress?: string;
  to?: string[];
  toAddresses?: string[];
  cc?: string[];
  ccAddresses?: string[];
  receivedAt?: string;
  sentAt?: string;
  text?: string;
  textBody?: string | null;
  html?: string;
  htmlBody?: string | null;
  parse?: boolean;
  externalId?: string;
}

export interface MaileryCloudGroupCounts {
  inbox?: number;
  important?: number;
  unread?: number;
  archived?: number;
  spam?: number;
  trash?: number;
  [key: string]: number | undefined;
}

export interface MaileryCloudDigest {
  id: string;
  window: MaileryCloudDigestWindow;
  title: string;
  summary: string;
  periodStart: string;
  periodEnd: string;
  messageCount: number;
  importantCount: number;
  createdAt: string;
}

export interface MaileryCloudPlan {
  name: string;
  amountCents: number;
  monthlyCredits: number;
}

export interface MaileryCloudCreditTransaction {
  id: string;
  delta: number;
  reason: string;
  source: string;
  balanceAfter: number;
  createdAt: string;
}

export interface MaileryCloudBillingOverview {
  balance: number;
  plans: Record<string, MaileryCloudPlan>;
  credit_packs: Record<string, number>;
  subscriptions: Array<Record<string, unknown>>;
  ledger: MaileryCloudCreditTransaction[];
}

export interface MaileryCloudApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MaileryCloudDomainAvailability {
  domain: string;
  available: boolean;
  price?: string | number;
  currency?: string;
  premium?: boolean;
}

export interface MaileryCloudDomainSetupInput {
  domain: string;
  address?: string;
  purchase?: boolean;
  provider?: "ses" | "route53" | "open-domains" | string;
  catchAll?: boolean;
  mxMigrationConsent?: boolean;
}

export interface MaileryCloudDomainSetupResult {
  domain: string;
  status: string;
  steps?: string[];
  records?: unknown[];
}

export class MaileryCloudError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "MaileryCloudError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

function normalizeApiUrl(apiUrl: string | undefined): string {
  const raw = (apiUrl || DEFAULT_MAILERY_CLOUD_API_URL).trim();
  if (!raw) return DEFAULT_MAILERY_CLOUD_API_URL;
  return raw.replace(/\/+$/, "");
}

function apiPath(path: string): string {
  if (!path || path === "/") return "/api/v1";
  if (path.startsWith("/api/v1")) return path;
  return `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function coerceErrorMessage(data: unknown, fallback: string): { message: string; code?: string; details?: unknown } {
  if (!data || typeof data !== "object") return { message: fallback };
  const record = data as Record<string, unknown>;
  const error = record["error"];
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    return {
      message: typeof err["message"] === "string" ? err["message"] : fallback,
      code: typeof err["code"] === "string" ? err["code"] : undefined,
      details: err["details"],
    };
  }
  return {
    message: typeof record["message"] === "string" ? String(record["message"]) : fallback,
    code: typeof record["code"] === "string" ? String(record["code"]) : undefined,
    details: record["details"],
  };
}

function normalizeMessageResponse(value: MaileryCloudMessageWithAttachments | {
  message: MaileryCloudMessage;
  attachments?: MaileryCloudAttachment[];
}): MaileryCloudMessageWithAttachments {
  if ("message" in value) return { ...value.message, attachments: value.attachments ?? [] };
  return { ...value, attachments: value.attachments ?? [] };
}

function normalizeMessagePageResponse(value: { data: MaileryCloudMessage[]; next_cursor?: string | null; nextCursor?: string | null }): MaileryCloudMessagePage {
  return { data: value.data, nextCursor: value.next_cursor ?? value.nextCursor ?? null };
}

export class MaileryCloudClient {
  private apiUrl: string;
  private token?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: MaileryCloudClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 1;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  setToken(token: string | undefined): void {
    this.token = token || undefined;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  async request<T>(path: string, opts: MaileryCloudRequestOptions = {}): Promise<T> {
    const method = (opts.method ?? (opts.body === undefined ? "GET" : "POST")).toUpperCase();
    const retries = Math.max(0, opts.retries ?? this.retries);
    const timeoutMs = Math.max(1, opts.timeoutMs ?? this.timeoutMs);
    const url = `${this.apiUrl}${apiPath(path)}`;
    const tokenRequired = opts.tokenRequired ?? true;
    if (tokenRequired && !this.token) {
      throw new MaileryCloudError("Mailery Cloud authentication is required. Run `mailery cloud login` first.", {
        code: "unauthorized",
        status: 401,
      });
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        if (opts.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
        if (this.token) headers["authorization"] = `Bearer ${this.token}`;
        if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await response.text();
        const data = text ? JSON.parse(text) as unknown : {};
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < retries) {
            await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          const err = coerceErrorMessage(data, `${method} ${apiPath(path)} failed (${response.status})`);
          throw new MaileryCloudError(err.message, {
            status: response.status,
            code: err.code,
            retryable,
            details: err.details,
          });
        }
        return data as T;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof MaileryCloudError) throw error;
        const retryable = attempt < retries;
        if (retryable) {
          await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
          continue;
        }
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MaileryCloudError(aborted ? `Mailery Cloud request timed out after ${timeoutMs}ms` : `Cannot reach Mailery Cloud at ${this.apiUrl}`, {
          code: aborted ? "timeout" : "network",
          retryable: aborted,
        });
      }
    }
  }

  health(): Promise<{ version: string; service: string; open_source?: string }> {
    return this.request("", { tokenRequired: false });
  }

  signup(input: { email: string; password: string; name?: string }): Promise<MaileryCloudAuthResponse> {
    return this.request("/auth/signup", { method: "POST", body: input, tokenRequired: false });
  }

  login(input: { email: string; password: string }): Promise<MaileryCloudAuthResponse> {
    return this.request("/auth/login", { method: "POST", body: input, tokenRequired: false });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("/auth/logout", { method: "POST", tokenRequired: false });
  }

  me(): Promise<MaileryCloudMeResponse> {
    return this.request("/auth/me");
  }

  listMailboxes(): Promise<MaileryCloudMailbox[]> {
    return this.request<{ data: MaileryCloudMailbox[] }>("/mailboxes").then((result) => result.data);
  }

  createMailbox(input: { email: string; name?: string; provider?: MaileryCloudMailboxProvider }): Promise<MaileryCloudMailbox> {
    return this.request("/mailboxes", { method: "POST", body: input });
  }

  messageGroups(): Promise<MaileryCloudGroupCounts> {
    return this.request("/messages/groups");
  }

  listMessagesPage(opts: { group?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<MaileryCloudMessagePage> {
    const params = new URLSearchParams();
    if (opts.group) params.set("group", opts.group);
    if (opts.q) params.set("q", opts.q);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const query = params.toString();
    return this.request<{ data: MaileryCloudMessage[]; next_cursor?: string | null; nextCursor?: string | null }>(`/messages${query ? `?${query}` : ""}`)
      .then(normalizeMessagePageResponse);
  }

  listMessages(opts: { group?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<MaileryCloudMessage[]> {
    return this.listMessagesPage(opts).then((result) => result.data);
  }

  createMessage(input: MaileryCloudMessageUploadInput): Promise<MaileryCloudMessageWithAttachments> {
    return this.request<MaileryCloudMessageWithAttachments>("/messages", { method: "POST", body: input });
  }

  getMessage(id: string): Promise<MaileryCloudMessageWithAttachments> {
    return this.request<MaileryCloudMessageWithAttachments | { message: MaileryCloudMessage; attachments?: MaileryCloudAttachment[] }>(`/messages/${encodeURIComponent(id)}`)
      .then(normalizeMessageResponse);
  }

  patchMessage(id: string, patch: Partial<Pick<MaileryCloudMessage, "isRead" | "isImportant" | "isArchived" | "isSpam" | "isTrash">>): Promise<MaileryCloudMessage> {
    return this.request(`/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  }

  parseMessage(id: string): Promise<unknown> {
    return this.request(`/messages/${encodeURIComponent(id)}/parse`, { method: "POST" });
  }

  listDigests(opts: { limit?: number } = {}): Promise<MaileryCloudDigest[]> {
    const query = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return this.request<{ data: MaileryCloudDigest[] }>(`/digests${query}`).then((result) => result.data);
  }

  generateDigest(window: MaileryCloudDigestWindow): Promise<MaileryCloudDigest> {
    return this.request("/digests/generate", { method: "POST", body: { window } });
  }

  billingOverview(opts: { limit?: number } = {}): Promise<MaileryCloudBillingOverview> {
    const query = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return this.request(`/billing/overview${query}`);
  }

  createCheckout(input: { kind: MaileryCloudCheckoutKind; plan?: string; credits?: number }): Promise<{ url: string }> {
    return this.request("/billing/checkout", { method: "POST", body: input });
  }

  createPortal(): Promise<{ url: string }> {
    return this.request("/billing/portal", { method: "POST", body: {} });
  }

  listApiKeys(): Promise<MaileryCloudApiKey[]> {
    return this.request<{ data: MaileryCloudApiKey[] }>("/api-keys").then((result) => result.data);
  }

  createApiKey(input: { name: string; scopes?: string[] }): Promise<{ key: string; api_key: MaileryCloudApiKey }> {
    return this.request("/api-keys", { method: "POST", body: input });
  }

  revokeApiKey(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  checkDomainAvailability(domain: string): Promise<MaileryCloudDomainAvailability> {
    return this.request(`/domains/availability?domain=${encodeURIComponent(domain)}`);
  }

  setupDomain(input: MaileryCloudDomainSetupInput): Promise<MaileryCloudDomainSetupResult> {
    return this.request("/domains/setup", { method: "POST", body: input });
  }
}
