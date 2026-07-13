// HTTP request handler for the Emails self-hosted service.
//
// Surfaces operational probes (/health, /ready, /version)
// plus the authenticated, versioned /v1 API. Every /v1 route requires a valid
// Hasna API key (@hasna/contracts/auth) scoped to `emails:read` / `emails:write`.
//
// All data operations hit the operator-owned Postgres via the
// store, which wraps the product-owned storage utilities' typed client.

import type { ApiKeyVerifier, ApiKeyPrincipal } from "@hasna/contracts/auth";
import { createHash } from "node:crypto";
import { migrationAcceptsChecksum, type TypedQueryClient, type Migration } from "../../storage-kit/index.js";
import { checkHealth } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore, IdempotencyKeyConflictError, type MessageListRecord, type MessageRecord } from "./store.js";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { resourceSpecForPath } from "./resources.js";
import type { SelfHostedSender } from "./sender.js";

interface ReadyResult {
  ok: boolean;
  latencyMs: number;
  pendingMigrations: string[];
  migrationIssues: string[];
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

/**
 * SELECT-only readiness: reachable AND every defined migration is recorded in
 * `schema_migrations`. Unlike the kit's `checkReady`, this never issues DDL, so
 * it works under the least-privileged app role (which has no CREATE on public).
 */
async function readinessCheck(deps: SelfHostedServiceDeps): Promise<ReadyResult> {
  const start = Date.now();
  try {
    const rows = await deps.client.many<{ id: string; checksum: string }>(`SELECT id, checksum FROM schema_migrations`);
    const expected = new Map(deps.migrations.map((migration) => [migration.id, migration.checksum]));
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));
    const pending = deps.migrations.filter((migration) => !applied.has(migration.id)).map((migration) => migration.id);
    const drifted = rows
      .filter((row) => {
        const migration = deps.migrations.find((item) => item.id === row.id);
        return migration !== undefined && !migrationAcceptsChecksum(migration, row.checksum);
      })
      .map((row) => `checksum mismatch: ${row.id}`);
    const unknown = rows.filter((row) => !expected.has(row.id)).map((row) => `unknown migration: ${row.id}`);
    const migrationIssues = [...drifted, ...unknown];
    return {
      ok: pending.length === 0 && migrationIssues.length === 0,
      latencyMs: Date.now() - start,
      pendingMigrations: pending,
      migrationIssues,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      pendingMigrations: [],
      migrationIssues: ["migration ledger unavailable"],
    };
  }
}

export interface SelfHostedServiceDeps {
  client: TypedQueryClient;
  store: EmailsSelfHostedStore;
  verifier: ApiKeyVerifier;
  sender: SelfHostedSender;
  migrations: readonly Migration[];
  version: string;
}

const MODE = "self_hosted" as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function publicMessage(record: MessageRecord): Omit<MessageRecord, "idempotency_key" | "send_payload_hash"> {
  const { idempotency_key: _key, send_payload_hash: _hash, ...safe } = record;
  return safe;
}

function publicMessageListItem(record: MessageRecord | MessageListRecord): MessageListRecord {
  const {
    body_text: bodyText,
    body_html: _bodyHtml,
    idempotency_key: _key,
    send_payload_hash: _hash,
    snippet: providedSnippet,
    ...safe
  } = record as MessageRecord & { snippet?: string | null };
  const rawSnippet = typeof providedSnippet === "string"
    ? providedSnippet
    : typeof bodyText === "string"
      ? bodyText
      : "";
  const snippet = rawSnippet.replace(/\s+/g, " ").trim().slice(0, 500);
  return { ...safe, snippet: snippet || null } as MessageListRecord;
}

function sendPayloadHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decodeStrictBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("attachment content must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("attachment content must be canonical base64");
  return decoded;
}

const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+~-]+\/[A-Za-z0-9!#$&^_.+~-]+$/;

function safeHeaderValue(label: string, value: string): string {
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error(`${label} contains forbidden control characters`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new Error(`${label} contains non-well-formed Unicode`);
      index++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new Error(`${label} contains non-well-formed Unicode`);
    }
  }
  return value;
}

function sendLeaseExpired(record: MessageRecord, now = Date.now()): boolean {
  const started = record.send_started_at ? Date.parse(record.send_started_at) : NaN;
  const configured = Number(process.env["EMAILS_SEND_LEASE_SECONDS"] ?? "300");
  const leaseMs = (Number.isFinite(configured) && configured > 0 ? configured : 300) * 1000;
  return Number.isFinite(started) && now - started >= leaseMs;
}

/**
 * Parse an optional `daily_quota` field off an address request body.
 * `provided` is false when the key is absent (leave the column untouched); when
 * present it must be null (clear) or a non-negative integer.
 */
function parseDailyQuota(
  body: Record<string, unknown>,
): { provided: boolean; value: number | null; error?: string } {
  if (!("daily_quota" in body)) return { provided: false, value: null };
  const raw = body.daily_quota;
  if (raw === null) return { provided: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { provided: true, value: raw };
  }
  return { provided: true, value: null, error: "daily_quota must be a non-negative integer or null" };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new RequestBodyTooLargeError("request body exceeds the limit");
  }
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError("request body exceeds the limit");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function queryInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function queryIsoDate(url: URL, key: string): { value?: string; error?: string } {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return {};
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return { error: `${key} must be a valid ISO date` };
  return { value: new Date(time).toISOString() };
}

/** Coerce a JSON body value into a string[] (array, comma/whitespace-tolerant). */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Coerce a JSON body value into a plain object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce a JSON body value into an array, else undefined. */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Optional string|null passthrough: undefined stays undefined. */
function asOptStringOrNull(value: unknown): string | null | undefined {
  return value === undefined ? undefined : (value as string | null);
}

interface AuthOk {
  ok: true;
  principal: ApiKeyPrincipal;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authenticate(
  deps: SelfHostedServiceDeps,
  req: Request,
  url: URL,
  requiredScopes: string[],
): Promise<AuthOk | AuthFail> {
  const decision = await deps.verifier.authenticate(req.headers, {
    method: req.method,
    path: url.pathname,
    requiredScopes,
  });
  if (!decision.ok) {
    return {
      ok: false,
      response: json(decision.status, { error: decision.message, reason: decision.reason }),
    };
  }
  return { ok: true, principal: decision.principal };
}

/**
 * Route + handle a single request. Returns `null` when the path is not owned by
 * this service (so a caller can fall through to other handlers).
 */
export async function handleSelfHostedRequest(
  deps: SelfHostedServiceDeps,
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // ---- operational probes (unauthenticated) ------------------------------
  if (path === "/health") {
    const health = await checkHealth(deps.client);
    return json(200, {
      status: "ok",
      version: deps.version,
      mode: MODE,
      name: "emails",
      db: { ok: health.ok, latencyMs: health.latencyMs },
    });
  }

  if (path === "/ready") {
    const ready = await readinessCheck(deps);
    return json(ready.ok ? 200 : 503, {
      status: ready.ok ? "ready" : "not_ready",
      version: deps.version,
      mode: MODE,
      db: { ok: ready.ok, latencyMs: ready.latencyMs },
      pendingMigrations: ready.pendingMigrations,
      migrationIssues: ready.migrationIssues,
    });
  }

  if (path === "/version") {
    return json(200, { status: "ok", version: deps.version, mode: MODE, name: "emails" });
  }

  if (path === "/openapi.json" || path === "/v1/openapi.json") {
    return json(200, { ...emailsSelfHostedOpenApi, info: { ...emailsSelfHostedOpenApi.info, version: deps.version } });
  }

  if (!path.startsWith("/v1/") && path !== "/v1") return null;

  // ---- /v1 (authenticated) -----------------------------------------------
  const read = ["emails:read"];
  const write = ["emails:write"];
  const store = deps.store;

  try {
    // /v1/domains
    if (path === "/v1/domains") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { domains: await store.listDomains({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const domain = String(body.domain ?? "").trim();
        if (!domain) return json(400, { error: "domain is required" });
        if (await store.getDomainByName(domain)) return json(409, { error: `domain ${domain} already exists` });
        const created = await store.createDomain({
          domain,
          status: body.status ? String(body.status) : undefined,
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        return json(201, { domain: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const domainMatch = path.match(/^\/v1\/domains\/([^/]+)$/);
    if (domainMatch) {
      const id = decodeURIComponent(domainMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getDomain(id);
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const rec = await store.updateDomain(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteDomain(id)) ? json(200, { deleted: true, id }) : json(404, { error: "domain not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/addresses
    if (path === "/v1/addresses") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { addresses: await store.listAddresses({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const email = String(body.email ?? "").trim();
        if (!email || !email.includes("@")) return json(400, { error: "a valid email is required" });
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        const created = await store.createAddress({
          email,
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status ? String(body.status) : undefined,
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          daily_quota: quota.provided ? quota.value : undefined,
        });
        return json(201, { address: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const addressMatch = path.match(/^\/v1\/addresses\/([^/]+)$/);
    if (addressMatch) {
      const id = decodeURIComponent(addressMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getAddress(id);
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        const rec = await store.updateAddress(id, {
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status === undefined ? undefined : String(body.status),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          dailyQuotaSet: quota.provided,
          daily_quota: quota.value,
        });
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteAddress(id)) ? json(200, { deleted: true, id }) : json(404, { error: "address not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    if (path === "/v1/messages/counts") {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      return json(200, { counts: await store.messageCounts() });
    }

    // /v1/messages/send — the only outbound create path. It invokes the
    // operator-selected provider only after atomically persisting and claiming
    // an idempotent send intent.
    if (path === "/v1/messages/send") {
      if (method !== "POST") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, write);
      if (!auth.ok) return auth.response;
      const body = await readJsonBody(req);
      const from = String(body.from ?? "").trim();
      const to = asStringArray(body.to);
      if (!from) return json(400, { error: "from is required" });
      if (to.length === 0) return json(400, { error: "to is required" });
      const subject = String(body.subject ?? "").trim();
      if (!subject) return json(400, { error: "subject is required" });

      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return json(400, { error: "idempotency_key is required and must be at most 200 characters" });
      }
      const cc = asStringArray(body.cc);
      const bcc = asStringArray(body.bcc);
      const rawAttachments = asArray(body.attachments) ?? [];
      if (rawAttachments.length > 5) return json(400, { error: "at most 5 inline attachments are allowed" });
      let attachments: Array<{ filename: string; content: string; content_type: string }>;
      try {
        safeHeaderValue("from", from);
        for (const value of [...to, ...cc, ...bcc]) safeHeaderValue("recipient address", value);
        safeHeaderValue("subject", subject);
        if (typeof body.reply_to === "string") safeHeaderValue("reply_to", body.reply_to);
        let totalAttachmentBytes = 0;
        attachments = rawAttachments.map((value, index) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`attachment ${index} must be an object`);
          const item = value as Record<string, unknown>;
          const content = typeof item.content === "string" ? item.content : "";
          const bytes = decodeStrictBase64(content).byteLength;
          totalAttachmentBytes += bytes;
          if (!content || bytes > 512 * 1024) {
            throw new Error(`attachment ${index} requires base64 content no larger than 512KiB`);
          }
          if (totalAttachmentBytes > 768 * 1024) {
            throw new Error("inline attachments may total at most 768KiB");
          }
          const filename = safeHeaderValue("attachment filename", String(item.filename ?? `attachment-${index + 1}`));
          if (!filename.trim() || filename.length > 255) throw new Error(`attachment ${index} filename must be 1-255 characters`);
          const contentType = safeHeaderValue("attachment content_type", String(item.content_type ?? "application/octet-stream"));
          if (!MIME_TYPE_RE.test(contentType)) throw new Error(`attachment ${index} content_type must be a safe type/subtype token`);
          return {
            filename,
            content,
            content_type: contentType,
          };
        });
      } catch (error) {
        return json(400, { error: error instanceof Error ? error.message : "invalid attachment" });
      }
      const payload = {
        from,
        to,
        cc,
        bcc,
        reply_to: typeof body.reply_to === "string" ? body.reply_to : null,
        subject,
        text: typeof body.text === "string" ? body.text : null,
        html: typeof body.html === "string" ? body.html : null,
        attachments,
        provider: deps.sender.provider,
      };
      let reserved;
      try {
        reserved = await store.reserveSendIntent({
          direction: "outbound",
          from_addr: from,
          to_addrs: to,
          cc_addrs: cc,
          subject,
          body_text: payload.text,
          body_html: payload.html,
          attachments: attachments.map(({ filename, content_type, content }) => ({
            filename,
            content_type,
            size: Buffer.byteLength(content, "base64"),
          })),
          idempotency_key: idempotencyKey,
          send_payload_hash: sendPayloadHash(payload),
        });
      } catch (error) {
        if (error instanceof IdempotencyKeyConflictError) {
          return json(409, { error: error.message, retry_safe: false });
        }
        throw error;
      }

      if (!reserved.created) {
        if (reserved.record.send_state === "sent") {
          return json(200, { message: publicMessage(reserved.record), provider: deps.sender.provider, idempotent_replay: true });
        }
        if (reserved.record.send_state === "sending") {
          if (sendLeaseExpired(reserved.record)) {
            const uncertain = await store.markSendUncertain(reserved.record.id).catch(() => null);
            return json(409, {
              error: "send lease expired with an uncertain provider outcome; reconcile before retrying",
              message: publicMessage(uncertain ?? reserved.record),
              retry_safe: false,
            });
          }
          return json(202, { message: publicMessage(reserved.record), provider: deps.sender.provider, in_progress: true });
        }
        if (reserved.record.send_state !== "pending") {
          return json(409, {
            error: "send outcome is uncertain; reconcile the provider message before any retry",
            message: publicMessage(reserved.record),
            retry_safe: false,
          });
        }
      }

      const claimed = await store.claimSendIntent(reserved.record.id);
      if (!claimed) {
        const latest = await store.getMessage(reserved.record.id);
        if (latest?.send_state === "sent") {
          return json(200, { message: publicMessage(latest), provider: deps.sender.provider, idempotent_replay: true });
        }
        return json(202, {
          message: publicMessage(latest ?? reserved.record),
          provider: deps.sender.provider,
          in_progress: true,
        });
      }

      let messageId: string;
      try {
        messageId = await deps.sender.send({
          provider_id: `self-hosted-${deps.sender.provider}`,
          from,
          to,
          cc: cc.length ? cc : undefined,
          bcc: bcc.length ? bcc : undefined,
          reply_to: typeof body.reply_to === "string" ? body.reply_to : undefined,
          subject,
          text: typeof body.text === "string" ? body.text : undefined,
          html: typeof body.html === "string" ? body.html : undefined,
          attachments: attachments.length ? attachments : undefined,
        });
      } catch {
        const uncertain = await store.markSendUncertain(claimed.id).catch(() => null);
        return json(502, {
          error: "send outcome is uncertain; reconcile the provider before retrying",
          message: publicMessage(uncertain ?? claimed),
          retry_safe: false,
        });
      }
      try {
        const completed = await store.completeSendIntent(claimed.id, messageId);
        return json(202, { message: publicMessage(completed), provider: deps.sender.provider });
      } catch {
        const uncertain = await store.markSendUncertain(claimed.id).catch(() => null);
        return json(502, {
          error: "provider accepted the send but ledger finalization failed; reconciliation is required",
          message: publicMessage(uncertain ?? claimed),
          retry_safe: false,
        });
      }
    }

    // /v1/messages — inbound import and ledger reads. Outbound writes must use
    // /v1/messages/send so the provider invocation cannot be bypassed.
    if (path === "/v1/messages") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const directionValue = url.searchParams.get("direction")?.trim().toLowerCase();
        const direction = directionValue === "inbound" || directionValue === "outbound" ? directionValue : undefined;
        const since = queryIsoDate(url, "since");
        if (since.error) return json(400, { error: since.error });
        const messages = await store.listMessages({
          limit: queryInt(url, "limit"),
          offset: queryInt(url, "offset"),
          direction,
          to: url.searchParams.get("to") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          subject: url.searchParams.get("subject") ?? undefined,
          search: url.searchParams.get("search") ?? undefined,
          since: since.value,
        });
        return json(200, { messages: messages.map(publicMessageListItem) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const from = String(body.from ?? body.from_addr ?? "").trim();
        if (!from) return json(400, { error: "from is required" });
        const rawTo = body.to ?? body.to_addrs;
        const to = Array.isArray(rawTo) ? rawTo.map((v) => String(v)) : typeof rawTo === "string" && rawTo.trim() ? [rawTo.trim()] : [];
        if (to.length === 0) return json(400, { error: "to is required" });

        // Direction defaults to outbound; any inbound signal marks it inbound so
        // the same POST route records both sent and received mail.
        const receivedAt = asOptStringOrNull(body.received_at);
        const directionRaw = body.direction === undefined ? undefined : String(body.direction);
        const direction =
          directionRaw ?? (receivedAt || body.message_id || body.in_reply_to ? "inbound" : undefined);

        const input = {
          from_addr: from,
          to_addrs: to,
          cc_addrs: body.cc === undefined && body.cc_addrs === undefined ? undefined : asStringArray(body.cc ?? body.cc_addrs),
          subject: asOptStringOrNull(body.subject),
          body_text: body.text === undefined ? asOptStringOrNull(body.body_text) : asOptStringOrNull(body.text),
          body_html: body.html === undefined ? asOptStringOrNull(body.body_html) : asOptStringOrNull(body.html),
          status: body.status ? String(body.status) : undefined,
          provider_message_id: asOptStringOrNull(body.provider_message_id),
          direction,
          message_id: asOptStringOrNull(body.message_id),
          in_reply_to: asOptStringOrNull(body.in_reply_to),
          received_at: receivedAt,
          is_read: typeof body.is_read === "boolean" ? body.is_read : undefined,
          is_starred: typeof body.is_starred === "boolean" ? body.is_starred : undefined,
          labels: body.labels === undefined ? undefined : asStringArray(body.labels),
          headers: asObject(body.headers),
          attachments: asArray(body.attachments),
          source_id: body.source_id === undefined ? undefined : String(body.source_id),
        };

        if (input.direction !== "inbound") {
          return json(409, { error: "outbound messages must be sent through POST /v1/messages/send" });
        }

        // With a source_id the write is idempotent (upsert): re-running an
        // import updates the existing row instead of creating a duplicate.
        if (input.source_id) {
          const { record, inserted } = await store.upsertMessage(input);
          return json(inserted ? 201 : 200, { message: publicMessage(record) });
        }
        const created = await store.createMessage(input);
        return json(201, { message: publicMessage(created) });
      }
      return json(405, { error: "method not allowed" });
    }

    const attachmentMatch = path.match(/^\/v1\/messages\/([^/]+)\/attachments\/(\d+)$/);
    if (attachmentMatch) {
      if (method !== "GET") return json(405, { error: "method not allowed" });
      const auth = await authenticate(deps, req, url, read);
      if (!auth.ok) return auth.response;
      const attachment = await store.getMessageAttachment(
        decodeURIComponent(attachmentMatch[1]!),
        Number(attachmentMatch[2]),
      );
      return attachment ? json(200, { attachment }) : json(404, { error: "attachment not found" });
    }

    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getMessage(id);
        return rec ? json(200, { message: publicMessage(rec) }) : json(404, { error: "message not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const rec = await store.updateMessageStatus(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider_message_id: body.provider_message_id === undefined ? undefined : (body.provider_message_id as string | null),
          is_read: typeof body.is_read === "boolean" ? body.is_read : undefined,
          is_starred: typeof body.is_starred === "boolean" ? body.is_starred : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
          add_label: typeof body.add_label === "string" ? body.add_label : undefined,
          remove_label: typeof body.remove_label === "string" ? body.remove_label : undefined,
        });
        return rec ? json(200, { message: publicMessage(rec) }) : json(404, { error: "message not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteMessage(id)) ? json(200, { deleted: true, id }) : json(404, { error: "message not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    // ---- generic resources (contacts/providers/templates/groups/…) --------
    const resourceMatch = path.match(/^\/v1\/([^/]+)(?:\/([^/]+))?$/);
    if (resourceMatch) {
      const spec = resourceSpecForPath(resourceMatch[1]!);
      if (spec) {
        const id = resourceMatch[2] ? decodeURIComponent(resourceMatch[2]) : undefined;
        if (id === undefined) {
          if (method === "GET") {
            const auth = await authenticate(deps, req, url, read);
            if (!auth.ok) return auth.response;
            const filters: Record<string, unknown> = {};
            for (const key of spec.filters ?? []) {
              const v = url.searchParams.get(key);
              if (v !== null) filters[key] = v;
            }
            const items = await store.listResource(spec, {
              limit: queryInt(url, "limit"),
              offset: queryInt(url, "offset"),
              filters,
            });
            return json(200, { items });
          }
          if (method === "POST") {
            const auth = await authenticate(deps, req, url, write);
            if (!auth.ok) return auth.response;
            const body = await readJsonBody(req);
            return json(201, await store.createResource(spec, body));
          }
          return json(405, { error: "method not allowed" });
        }
        if (method === "GET") {
          const auth = await authenticate(deps, req, url, read);
          if (!auth.ok) return auth.response;
          const rec = await store.getResource(spec, id);
          return rec ? json(200, rec) : json(404, { error: `${spec.path} not found` });
        }
        if (method === "PATCH" || method === "PUT") {
          const auth = await authenticate(deps, req, url, write);
          if (!auth.ok) return auth.response;
          const body = await readJsonBody(req);
          const rec = await store.updateResource(spec, id, body);
          return rec ? json(200, rec) : json(404, { error: `${spec.path} not found` });
        }
        if (method === "DELETE") {
          const auth = await authenticate(deps, req, url, write);
          if (!auth.ok) return auth.response;
          return (await store.deleteResource(spec, id))
            ? json(200, { deleted: true, id })
            : json(404, { error: `${spec.path} not found` });
        }
        return json(405, { error: "method not allowed" });
      }
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return json(413, { error: "request body too large" });
    }
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes("JSON"))) {
      return json(400, { error: `invalid request body: ${err.message}` });
    }
    console.error("[emails-self-hosted] request failed", {
      method,
      path,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return json(500, { error: "internal error" });
  }
}
