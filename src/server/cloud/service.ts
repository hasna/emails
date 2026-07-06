// HTTP request handler for the Mailery self_hosted cloud service.
//
// Surfaces the fleet-standard operational probes (/health, /ready, /version)
// plus the authenticated, versioned /v1 API. Every /v1 route requires a valid
// Hasna API key (@hasna/contracts/auth) scoped to `mailery:read` / `mailery:write`.
//
// Amendment A1 (PURE REMOTE): all data operations hit the cloud Postgres via the
// store, which wraps the vendored storage kit's typed client.

import type { ApiKeyVerifier, ApiKeyPrincipal } from "@hasna/contracts/auth";
import type { TypedQueryClient, Migration } from "../../generated/storage-kit/index.js";
import { checkHealth } from "../../generated/storage-kit/index.js";
import { MaileryCloudStore } from "./store.js";
import { maileryCloudOpenApi } from "./openapi.js";

interface ReadyResult {
  ok: boolean;
  latencyMs: number;
  pendingMigrations: string[];
  error?: string;
}

/**
 * SELECT-only readiness: reachable AND every defined migration is recorded in
 * `schema_migrations`. Unlike the kit's `checkReady`, this never issues DDL, so
 * it works under the least-privileged app role (which has no CREATE on public).
 */
async function readinessCheck(deps: CloudServiceDeps): Promise<ReadyResult> {
  const start = Date.now();
  try {
    const rows = await deps.client.many<{ id: string }>(`SELECT id FROM schema_migrations`);
    const applied = new Set(rows.map((r) => r.id));
    const pending = deps.migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
    return { ok: pending.length === 0, latencyMs: Date.now() - start, pendingMigrations: pending };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      pendingMigrations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CloudServiceDeps {
  client: TypedQueryClient;
  store: MaileryCloudStore;
  verifier: ApiKeyVerifier;
  migrations: readonly Migration[];
  version: string;
}

const MODE = "cloud" as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
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

interface AuthOk {
  ok: true;
  principal: ApiKeyPrincipal;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authenticate(
  deps: CloudServiceDeps,
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
export async function handleCloudRequest(
  deps: CloudServiceDeps,
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
      name: "mailery",
      db: { ok: health.ok, latencyMs: health.latencyMs, ...(health.error ? { error: health.error } : {}) },
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
      ...(ready.error ? { error: ready.error } : {}),
    });
  }

  if (path === "/version") {
    return json(200, { status: "ok", version: deps.version, mode: MODE, name: "mailery" });
  }

  if (path === "/openapi.json" || path === "/v1/openapi.json") {
    return json(200, { ...maileryCloudOpenApi, info: { ...maileryCloudOpenApi.info, version: deps.version } });
  }

  if (!path.startsWith("/v1/") && path !== "/v1") return null;

  // ---- /v1 (authenticated) -----------------------------------------------
  const read = ["mailery:read"];
  const write = ["mailery:write"];
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
        const created = await store.createAddress({
          email,
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status ? String(body.status) : undefined,
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
        const rec = await store.updateAddress(id, {
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status === undefined ? undefined : String(body.status),
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

    // /v1/messages
    if (path === "/v1/messages") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { messages: await store.listMessages({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
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
        const created = await store.createMessage({
          from_addr: from,
          to_addrs: to,
          subject: body.subject === undefined ? undefined : (body.subject as string | null),
          body_text: body.text === undefined ? (body.body_text as string | null | undefined) : (body.text as string | null),
          body_html: body.html === undefined ? (body.body_html as string | null | undefined) : (body.html as string | null),
          status: body.status ? String(body.status) : undefined,
          provider_message_id: body.provider_message_id === undefined ? undefined : (body.provider_message_id as string | null),
        });
        return json(201, { message: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getMessage(id);
        return rec ? json(200, { message: rec }) : json(404, { error: "message not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const rec = await store.updateMessageStatus(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider_message_id: body.provider_message_id === undefined ? undefined : (body.provider_message_id as string | null),
        });
        return rec ? json(200, { message: rec }) : json(404, { error: "message not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteMessage(id)) ? json(200, { deleted: true, id }) : json(404, { error: "message not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes("JSON"))) {
      return json(400, { error: `invalid request body: ${err.message}` });
    }
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: "internal error", detail: message });
  }
}
