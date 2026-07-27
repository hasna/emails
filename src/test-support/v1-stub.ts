// Reusable /v1 stub-server test helper for the self-hosted-ONLY client.
//
// WHY A SEPARATE PROCESS: the client's resource store (src/db/self-hosted-store.ts)
// performs its HTTP call SYNCHRONOUSLY via a spawned `curl` (spawnSync), which
// blocks Bun's event loop. An in-process `Bun.serve` on the same loop would
// deadlock (it can never accept the connection while the main thread is parked in
// spawnSync). So the stub runs OUT OF PROCESS, exactly like
// src/cli/commands/domain.self-hosted.test.ts and
// src/db/self-hosted-resource-routing.test.ts. Because it listens on a real TCP
// port it ALSO serves the async fetch path used by SelfHostedMailDataSource, so
// one helper covers db repos, CLI commands, MCP tools, and inbox/mail reads.
//
// WHAT IT SERVES (all under /v1, Bearer-authenticated):
//   - Generic CRUD for any resource: GET/POST /v1/<resource>,
//     GET/PATCH/PUT/DELETE /v1/<resource>/<id>. Lists are returned under both the
//     resource key and `items` so the store's envelope extraction always resolves.
//     Single entities are returned as `{ <singular>: entity }`.
//   - Messages semantics matching the real API and the mail-data-source fake:
//     GET /v1/messages (direction/to/from/subject/search/since/limit/offset filters,
//     newest-first), GET /v1/messages/counts, POST /v1/messages/send.
//   - Control endpoints (unauthenticated so a beforeEach can always reset):
//     POST /v1/__reset  { resources? }  -> replace the whole store (empty clears it)
//     GET  /v1/__dump                   -> read the whole store back for assertions
//     GET  /v1/__list_queries?resource= -> query strings of every list request made
//
// SAFETY: no secret is ever logged. The API key lives only in the subprocess env
// and the Authorization header; the helper never prints it.

import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";
import { SELF_HOSTED_RESOURCES, resourceListOrderBy } from "../server/self-hosted/resources.js";

/**
 * The ORDER BY the real generic list route applies to each `/v1/<resource>`, parsed
 * into sort terms for the stub.
 *
 * Read from the server's own registry rather than restated here, so the stub can
 * never drift from the order production actually returns. That matters because a
 * client is allowed to page a window SERVER-side and trust the server to order
 * first — against a stub that returned insertion order, such a client would look
 * broken while being right, or look right while being broken.
 */
function declaredListOrder(): Record<string, Array<{ column: string; desc: boolean }>> {
  const order: Record<string, Array<{ column: string; desc: boolean }>> = {};
  for (const spec of SELF_HOSTED_RESOURCES) {
    order[spec.path] = resourceListOrderBy(spec)
      .split(",")
      .map((term) => term.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => ({ column: parts[0]!, desc: (parts[1] ?? "ASC").toUpperCase() === "DESC" }));
  }
  return order;
}

/** Seed data keyed by /v1 resource name (e.g. `{ domains: [...], messages: [...] }`). */
export type V1StubResources = Record<string, Array<Record<string, unknown>>>;

export interface V1StubOptions {
  /** Bearer key the stub requires (default: a fixed test key). */
  apiKey?: string;
  /** Initial resources. Also used as the baseline restored by `reset()`. */
  seed?: V1StubResources;
}

export interface V1Stub {
  /** Origin only, e.g. `http://127.0.0.1:PORT` (NO trailing `/v1`). */
  readonly baseUrl: string;
  /** The Bearer key the stub requires. */
  readonly apiKey: string;
  /** Replace the entire store with `resources`. */
  seed(resources: V1StubResources): Promise<void>;
  /** Restore the store to the initial seed passed to `startV1Stub` (or empty). */
  reset(): Promise<void>;
  /** Read a resource's current rows back from the stub (for assertions). */
  list(resource: string): Promise<Array<Record<string, unknown>>>;
  /** Read the entire store back from the stub. */
  dump(): Promise<V1StubResources>;
  /**
   * Emulate a non-total list ORDER BY: before every list window the named
   * resources (or all of them) are rotated by `rotate` positions, so a
   * limit/offset pager sees duplicates and misses rows — the production
   * `/v1/sources` failure mode. `rotate: 0` restores stable order.
   */
  setListOrderInstability(rotate: number, resources?: string[]): Promise<void>;
  /**
   * Query strings (without the leading `?`) of every generic list request the
   * client made for `resource`, in order. Use it to assert a filter was pushed
   * SERVER-side rather than applied in memory over the whole table.
   */
  listQueries(resource: string): Promise<string[]>;
  /** Read the current email-verification token for an address (test helper). */
  verifyToken(email: string): Promise<string | null>;
  /** Mark a signed-up user verified without a token (fixture shortcut). */
  markVerified(email: string): Promise<void>;
  /** Seed a user with explicit memberships (multi-tenant fixtures). */
  seedUser(user: {
    email: string;
    password: string;
    name?: string;
    verified?: boolean;
    tenants?: Array<{ slug: string; name: string; role: string }>;
  }): Promise<void>;
  /**
   * Point the client at this stub: EMAILS_MODE=self_hosted, EMAILS_SELF_HOSTED_URL,
   * EMAILS_SELF_HOSTED_API_KEY, then reset the config + mail-data-source caches.
   * Call in `beforeEach`.
   */
  applyEnv(): void;
  /** Remove the env this helper set and reset caches. Call in `afterEach`. */
  clearEnv(): void;
  /** Kill the subprocess. Call in `afterAll`. */
  stop(): void;
}

const DEFAULT_API_KEY = "hasna_emails_stub_key_0123456789";
const NOW_DEFAULT = "__v1_stub_now__";

const V1_STUB_RESOURCE_SPECS = Object.fromEntries(
  SELF_HOSTED_RESOURCES.map((spec) => [
    spec.path,
    {
      idColumn: spec.idColumn ?? null,
      columns: spec.columns.map((column) => ({
        name: column.name,
        bool: column.bool === true,
        int: column.int === true,
        num: column.num === true,
        json: column.json === true,
      })),
    },
  ]),
);

// Actual database defaults for every generic resource. Fields absent here have
// no SQL default: the fixture factory still projects them as null (or the
// registry-declared primitive zero value) because SELECT * returns every column.
const V1_STUB_RESOURCE_DEFAULTS: Record<string, Record<string, unknown>> = {
  contacts: { send_count: 0, bounce_count: 0, complaint_count: 0, suppressed: false },
  providers: { active: true },
  templates: { subject_template: "", metadata: {} },
  groups: {},
  sequences: { status: "active" },
  owners: { type: "human" },
  "send-keys": {},
  scheduled: {
    to_addresses: [],
    cc_addresses: [],
    bcc_addresses: [],
    subject: "",
    attachments_json: [],
    status: "pending",
  },
  aliases: { target_address: "", protected: false },
  forwarding: { mode: "app-copy", enabled: true },
  warming: { target_daily_volume: 0, status: "active" },
  triage: { priority: 3, confidence: 0, triaged_at: NOW_DEFAULT },
  provisioning: { detail_json: {} },
  sources: {
    name: "",
    status: "active",
    settings_json: {},
    provider_snapshot_json: {},
  },
  events: { metadata: {}, occurred_at: NOW_DEFAULT },
  "email-agents": {
    enabled: false,
    always_on: false,
    provider: "external",
    apply_labels: true,
    use_network_tools: true,
    config_json: {},
  },
  "email-agent-runs": {
    labels_json: [],
    tool_calls_json: [],
    output_json: {},
  },
  "email-digests": {
    since: NOW_DEFAULT,
    until: NOW_DEFAULT,
    message_count: 0,
    highlights_json: [],
    action_items_json: [],
    important_email_ids_json: [],
    label_counts_json: {},
  },
  "group-members": { vars: "{}", added_at: NOW_DEFAULT },
  "sequence-steps": {
    step_number: 0,
    delay_hours: 0,
    template_name: "",
    created_at: NOW_DEFAULT,
  },
  "sequence-enrollments": {
    current_step: 0,
    status: "active",
    enrolled_at: NOW_DEFAULT,
  },
  "address-ownership-events": { created_at: NOW_DEFAULT },
  "webhook-receipts": { completed_at: NOW_DEFAULT },
  "sandbox-emails": {
    to_addresses: [],
    cc_addresses: [],
    bcc_addresses: [],
    subject: "",
    attachments_json: "[]",
    headers_json: "{}",
    created_at: NOW_DEFAULT,
  },
};

const missingResourceDefaults = SELF_HOSTED_RESOURCES
  .map((spec) => spec.path)
  .filter((path) => !(path in V1_STUB_RESOURCE_DEFAULTS));
if (missingResourceDefaults.length > 0) {
  throw new Error(`V1 stub defaults missing resources: ${missingResourceDefaults.join(", ")}`);
}

// The stub server. Kept free of backticks and `${}` so it embeds cleanly in this
// module's template literal. Reads its key + seed from env; announces its port.
const SERVER_SRC = String.raw`
const KEY = process.env.V1_STUB_API_KEY || "";
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const RESOURCE_SPECS = safeParse(process.env.V1_STUB_RESOURCE_SPECS);
const RESOURCE_DEFAULTS = safeParse(process.env.V1_STUB_RESOURCE_DEFAULTS);
let store = safeParse(process.env.V1_STUB_SEED);
// Secret token -> send-key id map. Kept OUT of the store object so it is never
// returned by __dump (a send token must never leave the server). Cleared on __reset.
let sendTokens = {};
// Auth state (multi-tenancy client tests). Kept OUT of the store/__dump so
// passwords and session tokens never leave the server. Cleared on __reset.
let authUsers = {};      // email -> { password, name, verified, tenants:[{slug,name,role}] }
let sessions = {};       // emss_ token -> { email, tenant:{slug,name,role} }
let verifyTokens = {};   // emiv_ token -> email
let bootstrapped = false;
// Non-total list-order emulation (see /v1/__list_order). 0 = stable order.
let listRotate = 0;
let listRotateResources = null;
let listRotateCalls = {};
// Declared ORDER BY per generic resource, injected from the server's own registry
// (SELF_HOSTED_RESOURCES + resourceListOrderBy) so the stub orders lists the way the
// real route does. Shape: { resource: [{ column, desc }, ...] }.
const listOrder = safeParse(process.env.V1_STUB_LIST_ORDER);
// Query string of every generic list request, per resource (see /v1/__list_queries).
// Lets a test assert that a client pushed its filters SERVER-side instead of
// dragging the whole table over and filtering in memory. Cleared on __reset.
let listQueries = {};

function safeParse(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}
function singular(r) {
  if (r.endsWith("es") && (r.endsWith("sses") || r.endsWith("ches") || r.endsWith("xes"))) return r.slice(0, -2);
  if (r.endsWith("s")) return r.slice(0, -1);
  return r;
}
function rowsFor(resource) {
  if (!Array.isArray(store[resource])) store[resource] = [];
  store[resource] = store[resource].map(function (row) {
    return normalizeResourceRow(resource, row);
  });
  return store[resource];
}
// Apply the resource's DECLARED ORDER BY, the way the real generic list route does
// (store.ts listResource -> resourceListOrderBy). Without this the stub returned
// insertion order, so any client that pages a window SERVER-side — trusting the
// server to order first — could not be tested here at all: the stub would hand back
// a differently-ordered window and a correct client would look broken. The order
// terms come from the server's own registry (V1_STUB_LIST_ORDER), so the stub cannot
// drift from it. Resources with a bespoke handler (messages) and non-registry paths
// (domains/addresses) have no terms and keep insertion order.
function sortForList(resource, rows) {
  const terms = listOrder[resource];
  if (!Array.isArray(terms) || terms.length === 0) return rows.slice();
  return rows.slice().sort(function (a, b) {
    for (const term of terms) {
      const av = a[term.column];
      const bv = b[term.column];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC.
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        return (aNull ? 1 : -1) * (term.desc ? -1 : 1);
      }
      // Three-way, so values that merely differ by TYPE but compare equal (1 vs "1")
      // fall through to the next term instead of making the comparator inconsistent
      // (returning 1 for both cmp(a,b) and cmp(b,a), which corrupts a sort).
      const bothNumbers = typeof av === "number" && typeof bv === "number";
      const l = bothNumbers ? (av as number) : String(av);
      const r = bothNumbers ? (bv as number) : String(bv);
      const cmp = l < r ? -1 : l > r ? 1 : 0;
      if (cmp === 0) continue;
      return term.desc ? -cmp : cmp;
    }
    return 0;
  });
}
// Rotate the ORDERED rows before a list window is taken, so successive pages of one
// enumeration see different row positions (a non-total ORDER BY). The rotation
// accumulates across calls within one enumeration, which is what makes a pager see
// duplicates and miss rows. It is applied to a copy (never the backing store) so the
// declared order above stays the baseline every window is taken from.
function rotateForList(resource, rows) {
  if (!listRotate) return rows;
  if (listRotateResources && listRotateResources.indexOf(resource) < 0) return rows;
  const n = rows.length;
  if (n < 2) return rows;
  listRotateCalls[resource] = (listRotateCalls[resource] || 0) + 1;
  const by = (((listRotate * listRotateCalls[resource]) % n) + n) % n;
  return rows.slice(by).concat(rows.slice(0, by));
}
function includesText(value, query) {
  if (!query) return true;
  return String(value == null ? "" : value).toLowerCase().includes(String(query).toLowerCase());
}
function hasLabel(row, label) {
  return Array.isArray(row.labels) && row.labels.some(function (v) { return String(v).toLowerCase() === label; });
}
function isOutbound(row) { return String(row.direction || "").toLowerCase() === "outbound"; }
function normalizeMessageRow(row) {
  const source = row || {};
  const now = source.created_at || new Date().toISOString();
  return Object.assign({
    id: crypto.randomUUID(),
    direction: "inbound",
    from_addr: "",
    to_addrs: [],
    cc_addrs: [],
    subject: null,
    body_text: null,
    body_html: null,
    status: "received",
    provider_message_id: null,
    message_id: null,
    in_reply_to: null,
    received_at: null,
    is_read: false,
    is_starred: false,
    labels: [],
    headers: {},
    attachments: [],
    source_id: null,
    send_state: "none",
    send_started_at: null,
    created_at: now,
    updated_at: now,
  }, source, {
    from_addr: source.from_addr === undefined ? (source.from_address || "") : source.from_addr,
    to_addrs: source.to_addrs === undefined ? (Array.isArray(source.to_addresses) ? source.to_addresses : []) : source.to_addrs,
    cc_addrs: source.cc_addrs === undefined ? (Array.isArray(source.cc_addresses) ? source.cc_addresses : []) : source.cc_addrs,
    bcc_addrs: source.bcc_addrs === undefined ? (Array.isArray(source.bcc_addresses) ? source.bcc_addresses : []) : source.bcc_addrs,
    received_at: source.received_at === undefined ? (source.sent_at || null) : source.received_at,
  });
}
function normalizeGenericRow(row, defaults) {
  const source = row || {};
  const now = source.created_at || new Date().toISOString();
  return Object.assign({
    id: crypto.randomUUID(),
    tenant_id: DEFAULT_TENANT_ID,
    created_at: now,
    updated_at: now,
  }, defaults || {}, source);
}
function normalizeDomainRow(row) {
  const source = row || {};
  const domain = String(source.domain == null ? "" : source.domain).trim().toLowerCase();
  return Object.assign(normalizeGenericRow(source, {
    domain: domain,
    status: "pending",
    provider: null,
    verified: false,
    notes: null,
    provisioning_status: "none",
    purchase_provider: null,
    dns_provider: "cloudflare",
    send_provider: null,
    cf_zone_id: null,
    registrar: null,
    nameservers_json: [],
    mail_from_domain: null,
    last_error: null,
    next_check_at: null,
  }), {
    domain: domain,
    nameservers_json: jsonArray(source.nameservers_json),
  });
}
function normalizeAddressRow(row) {
  const source = row || {};
  const email = String(source.email == null ? "" : source.email).trim().toLowerCase();
  const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : null;
  return Object.assign(normalizeGenericRow(source, {
    email: email,
    domain: domain,
    display_name: null,
    status: "active",
    verified: false,
    daily_quota: null,
    owner_id: null,
    administrator_id: null,
    domain_id: null,
    receive_strategy: null,
    forward_to: null,
    routing_rule_id: null,
    provisioning_status: "none",
    last_validated_at: null,
    last_error: null,
    next_check_at: null,
  }), {
    email: email,
    domain: source.domain === undefined ? domain : source.domain,
  });
}
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function fixtureDefault(value, now) {
  if (value === "__v1_stub_now__") return now;
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}
function jsonArray(value) {
  if (Array.isArray(value)) return value.slice();
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function normalizeRegisteredResourceRow(resource, row) {
  const spec = RESOURCE_SPECS[resource];
  if (!spec || !Array.isArray(spec.columns)) return row;
  const source = row || {};
  const now = source.created_at || new Date().toISOString();
  const key = spec.idColumn || "id";
  const result = {
    tenant_id: source.tenant_id || DEFAULT_TENANT_ID,
    created_at: now,
    updated_at: source.updated_at || now,
  };
  result[key] = source[key] == null
    ? (key === "id" ? crypto.randomUUID() : "")
    : source[key];
  const defaults = RESOURCE_DEFAULTS[resource] || {};
  for (const column of spec.columns) {
    if (own(source, column.name)) continue;
    if (own(defaults, column.name)) {
      result[column.name] = fixtureDefault(defaults[column.name], now);
    } else if (column.bool) {
      result[column.name] = false;
    } else if (column.int || column.num) {
      result[column.name] = 0;
    } else {
      result[column.name] = null;
    }
  }
  return Object.assign(result, source, {
    tenant_id: source.tenant_id || DEFAULT_TENANT_ID,
    created_at: source.created_at || now,
    updated_at: source.updated_at || now,
  });
}
function normalizeResourceRow(resource, row) {
  if (resource === "domains") return normalizeDomainRow(row);
  if (resource === "addresses") return normalizeAddressRow(row);
  if (resource === "messages") return normalizeMessageRow(row);
  return normalizeRegisteredResourceRow(resource, row);
}
function usesEntityEnvelope(resource) {
  return resource === "domains" || resource === "addresses" || resource === "messages";
}
function resourceKey(resource) {
  return RESOURCE_SPECS[resource] && RESOURCE_SPECS[resource].idColumn
    ? RESOURCE_SPECS[resource].idColumn
    : "id";
}
function itemNotFoundError(resource) {
  if (resource === "domains") return "domain not found";
  if (resource === "addresses") return "address not found";
  if (resource === "messages") return "message not found";
  return resource + " not found";
}

// ── auth helpers (mirror the server: domain allowlist, slug derivation) ─────────
// The real server reads its allowlist from EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS and
// ships no default. This stub mirrors the SHAPE of that gate (anchored full match,
// one domain) against the fixture domain below so client tests can exercise the
// 403 path; V1_STUB_ALLOWED_EMAIL_DOMAIN lets a test point it somewhere else.
function isAllowedSignupEmail(email) {
  const domain = (process.env.V1_STUB_ALLOWED_EMAIL_DOMAIN || "example.com").toLowerCase();
  // Escape EVERY metacharacter, like the server's globToDomainSource: escaping only
  // the dot would let a configured value such as "example|evil" smuggle in an
  // alternation that escapes both anchors. (The class is ordered so a dollar sign is
  // never followed by an opening brace — this source is embedded in a String.raw
  // template literal, where that pair would start an interpolation.)
  const escaped = domain.replace(/[-.*+?^$(){}|[\]\\]/g, "\\$&");
  const value = String(email == null ? "" : email).trim();
  if (!value || value.length > 320) return false;
  return new RegExp("^[^@\\s]+@" + escaped + "$", "i").test(value);
}
function slugify(name) {
  return String(name == null ? "" : name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
}
function lastVerifyTokenFor(email) {
  const target = String(email == null ? "" : email).trim().toLowerCase();
  let found = null;
  for (const token of Object.keys(verifyTokens)) {
    if (String(verifyTokens[token]).toLowerCase() === target) found = token;
  }
  return found;
}
function bearerOf(req) {
  const header = req.headers.get("authorization") || "";
  return header.indexOf("Bearer ") === 0 ? header.slice(7) : "";
}
// Mirror the server's toPublicUser (store.ts): id/email/name/status/email_verified/created_at.
function safeUser(email) {
  const user = authUsers[email];
  return {
    id: "user-" + email,
    email: email,
    name: user ? user.name : null,
    status: user ? (user.verified ? "active" : "unverified") : "active",
    email_verified: user ? Boolean(user.verified) : false,
    created_at: (user && user.created_at) || new Date(0).toISOString(),
  };
}
// Mirror the server's toPublicTenant: { id, slug, name, status }.
function publicTenant(t) {
  return { id: "tenant-" + t.slug, slug: t.slug, name: t.name, status: "active" };
}
// Mirror the server's SCOPES_BY_ROLE.
function scopesForRole(role) {
  return role === "viewer" ? ["emails:read"] : ["emails:read", "emails:write"];
}
// Mint a session and build the server's login/switch-tenant success body.
// The server INCLUDES the user on login but OMITS it on switch-tenant.
function mintSession(email, tenant, includeUser) {
  const token = "emss_" + crypto.randomUUID().replace(/-/g, "");
  sessions[token] = { email: email, tenant: tenant };
  const body = {
    session_token: token,
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    tenant: publicTenant(tenant),
    role: tenant.role,
  };
  if (includeUser) body.user = safeUser(email);
  return json(body);
}

// Send-key From-scope check, mirroring the server: an owner may send from an
// address it OWNS or ADMINISTERS. Canonicalizes the From (a single angle-addr or a
// bare email); an ambiguous/multi-angle From is denied (spoofing resistance).
function canonicalFrom(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  if (!s) return "";
  const angles = s.match(/<[^>]*>/g);
  if (angles && angles.length === 1) {
    const inner = angles[0].slice(1, -1).trim();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner) ? inner : "";
  }
  if (angles && angles.length > 1) return "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s : "";
}
function isOwnerAuthorizedFrom(ownerId, from) {
  const email = canonicalFrom(from);
  if (!email || !ownerId) return false;
  return rowsFor("addresses").some(function (a) {
    return String(a.email == null ? "" : a.email).toLowerCase() === email &&
      (String(a.owner_id) === String(ownerId) || String(a.administrator_id) === String(ownerId));
  });
}

const MESSAGE_CURSOR_PREFIX = "v1-stub:";
function encodeMessageOffsetCursor(offset) {
  return MESSAGE_CURSOR_PREFIX + Buffer.from(JSON.stringify({ offset: offset }), "utf8").toString("base64url");
}
function decodeMessageOffsetCursor(raw) {
  if (typeof raw !== "string" || !raw.startsWith(MESSAGE_CURSOR_PREFIX)) return null;
  const encoded = raw.slice(MESSAGE_CURSOR_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) return null;
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, "offset")) return null;
    return Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : null;
  } catch {
    return null;
  }
}

function listMessages(params) {
  let ordered = rowsFor("messages").slice().sort(function (a, b) {
    return String(b.received_at || b.created_at || "").localeCompare(String(a.received_at || a.created_at || ""));
  });
  const direction = params.get("direction");
  if (direction) ordered = ordered.filter(function (r) { return String(r.direction || "").toLowerCase() === direction; });
  const to = params.get("to");
  if (to) ordered = ordered.filter(function (r) { return String(r.to_addrs || "").toLowerCase().includes(to.toLowerCase()); });
  ordered = ordered.filter(function (r) { return includesText(r.from_addr, params.get("from")); });
  ordered = ordered.filter(function (r) { return includesText(r.subject, params.get("subject")); });
  const search = params.get("search");
  if (search) {
    ordered = ordered.filter(function (r) {
      const hay = [r.from_addr, r.to_addrs, r.subject, r.body_text].join(" ").toLowerCase();
      return hay.includes(search.toLowerCase());
    });
  }
  const since = params.get("since");
  if (since) {
    const cutoff = Date.parse(since);
    ordered = ordered.filter(function (r) {
      const t = Date.parse(String(r.received_at || r.created_at || ""));
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  const limit = Number(params.get("limit") || "500");
  const cursor = params.get("cursor");
  const cursorOffset = cursor === null ? null : decodeMessageOffsetCursor(cursor);
  if (cursor !== null && cursorOffset === null) return { error: "cursor is not a valid pagination cursor" };
  const offset = cursorOffset === null ? Number(params.get("offset") || "0") : cursorOffset;
  const messages = ordered.slice(offset, offset + limit).map(leanListRow);
  return {
    messages: messages,
    next_cursor: messages.length === limit ? encodeMessageOffsetCursor(offset + messages.length) : null,
  };
}

// A /v1 list row as the self-hosted serve actually returns it: bodies, headers
// and the attachments array are NOT on list rows — only a snippet and an
// attachment_count integer. Modelling the full row here let a client that counts
// the (absent) attachments array pass every test and still report
// "0 attachments" against the real serve.
function leanListRow(row) {
  const lean = {};
  for (const key of Object.keys(row)) {
    if (key === "body_text" || key === "body_html" || key === "headers" || key === "attachments") continue;
    lean[key] = row[key];
  }
  const body = typeof row.body_text === "string" ? row.body_text : "";
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 500);
  lean.snippet = snippet || null;
  lean.attachment_count = Array.isArray(row.attachments) ? row.attachments.length : 0;
  // The serve keeps the headers object off list rows but DOES project the one field
  // inside it that explains a refusal, as its own scalar (see MESSAGE_LIST_COLUMNS in
  // src/server/self-hosted/store.ts, which selects headers ->> 'policy_denial').
  // Mirror that here: dropping it would make the stub the only place where a blocked
  // row cannot state its reason, which is the exact fake-vs-serve gap this helper's
  // comment above warns about.
  // (No backticks in this function: the whole stub server is embedded in a template
  // literal, so a backtick here terminates it and the file stops parsing.)
  const denial = row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
    ? row.headers["policy_denial"]
    : undefined;
  lean.policy_denial = typeof denial === "string" && denial.trim() ? denial.trim() : null;
  return lean;
}

// A /v1 DETAIL row as the self-hosted serve actually returns it: the stored
// attachment bytes are stripped and replaced by the derived content_available
// flag (store.mapMessageRow). Returning the raw stored row here would let a
// client that cannot tell metadata-only records from fetchable ones pass every
// test and still advertise undownloadable bytes against the real serve — the
// same fake-vs-serve gap that shipped the 1.2.6 attachment_count bug.
function detailRow(row) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = row[key];
  if (!Array.isArray(row.attachments)) return out;
  out.attachments = row.attachments.map(function (att) {
    if (!att || typeof att !== "object" || Array.isArray(att)) return att;
    const meta = {};
    for (const key of Object.keys(att)) { if (key !== "content_base64") meta[key] = att[key]; }
    meta.content_available = typeof att.content_base64 === "string";
    return meta;
  });
  return out;
}

function messageCounts() {
  const messages = rowsFor("messages");
  const inboxRows = messages.filter(function (r) {
    return !isOutbound(r) && !hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash");
  });
  let latest = null;
  for (const r of messages) {
    if (isOutbound(r)) continue;
    const d = String(r.received_at || r.created_at || "");
    if (d && (latest === null || d > latest)) latest = d;
  }
  return {
    inbox: inboxRows.length,
    unread: inboxRows.filter(function (r) { return !r.is_read; }).length,
    starred: messages.filter(function (r) {
      return !isOutbound(r) && Boolean(r.is_starred) && !hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash");
    }).length,
    sent: messages.filter(isOutbound).length,
    archived: messages.filter(function (r) { return !isOutbound(r) && hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash"); }).length,
    spam: messages.filter(function (r) { return !isOutbound(r) && (hasLabel(r, "spam") || String(r.status || "").toLowerCase() === "spam"); }).length,
    trash: messages.filter(function (r) { return !isOutbound(r) && hasLabel(r, "trash"); }).length,
    total: messages.length,
    latest_received_at: latest,
  };
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

    // Control endpoints (unauthenticated).
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__reset") {
      const body = await req.json().catch(function () { return {}; });
      store = body && body.resources ? body.resources : {};
      sendTokens = {};
      authUsers = {};
      sessions = {};
      verifyTokens = {};
      bootstrapped = false;
      listRotate = 0;
      listRotateResources = null;
      listRotateCalls = {};
      listQueries = {};
      return json({ ok: true });
    }
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "__dump") {
      return json({ resources: store });
    }
    // Test-only: the query string of every generic list request for a resource, in
    // order. A client that filters only in memory shows nothing but limit/offset.
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "__list_queries") {
      const resource = url.searchParams.get("resource") || "";
      return json({ queries: listQueries[resource] || [] });
    }
    // Test-only: emulate a NON-TOTAL list ORDER BY. The real server sorts by
    // columns that are not unique (e.g. sources by status, type, created_at), and
    // Postgres may return tied rows in a different order per query — so a
    // limit/offset pager can see the same row twice and never see others. Rotating
    // the backing array by \`rotate\` before each list window reproduces exactly
    // that, which is what makes the "3473 of 3899 rows, reported as a total" bug
    // testable.
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__list_order") {
      const body = await req.json().catch(function () { return {}; });
      listRotate = Number(body.rotate || 0) || 0;
      listRotateResources = Array.isArray(body.resources) ? body.resources : null;
      listRotateCalls = {};
      return json({ ok: true, rotate: listRotate });
    }
    // Test-only: read the current verification token for an email (the real
    // server emails it; here the test needs it to drive verify-email).
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "__verify_token") {
      return json({ token: lastVerifyTokenFor(url.searchParams.get("email") || "") });
    }
    // Test-only: mark a user verified without a token (fixture shortcut).
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__verify_user") {
      const body = await req.json().catch(function () { return {}; });
      const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
      if (authUsers[email]) authUsers[email].verified = true;
      return json({ ok: Boolean(authUsers[email]) });
    }
    // Test-only: seed a user with arbitrary memberships (multi-tenant fixtures).
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__seed_user") {
      const body = await req.json().catch(function () { return {}; });
      const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
      authUsers[email] = {
        password: String(body.password == null ? "" : body.password),
        name: body.name || null,
        verified: body.verified !== false,
        tenants: Array.isArray(body.tenants) ? body.tenants : [{ slug: "default", name: "Default Tenant", role: "owner" }],
      };
      return json({ ok: true });
    }

    // ── auth: UNAUTHENTICATED endpoints (signup/login/verify) ──────────────
    if (parts[0] === "v1" && parts[1] === "auth" && req.method === "POST") {
      const authPath = parts.slice(2).join("/");
      if (authPath === "signup") {
        const body = await req.json().catch(function () { return {}; });
        const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
        // Server shape: 200 generic { status, email, verification_required }. No
        // session/user/tenant is returned at signup (design A2). Non-enumerating:
        // a duplicate email returns the SAME generic 200 (no reveal, no new token).
        const generic = json({ status: "verification_required", email: email, verification_required: true });
        if (!isAllowedSignupEmail(email)) return json({ error: "signups are restricted", reason: "email_not_allowed" }, 403);
        if (authUsers[email]) return generic;
        const tenantName = String(body.tenant_name == null ? "" : body.tenant_name).trim() || "Org";
        const slug = String(body.tenant_slug == null ? "" : body.tenant_slug).trim() || slugify(tenantName);
        authUsers[email] = { password: String(body.password == null ? "" : body.password), name: body.name || null, verified: false, created_at: new Date().toISOString(), tenants: [{ slug: slug, name: tenantName, role: "owner" }] };
        const vt = "emiv_" + crypto.randomUUID().replace(/-/g, "");
        verifyTokens[vt] = email;
        return generic;
      }
      if (authPath === "login") {
        const body = await req.json().catch(function () { return {}; });
        const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
        if (!isAllowedSignupEmail(email)) return json({ error: "login is restricted", reason: "email_not_allowed" }, 403);
        const user = authUsers[email];
        if (!user || user.password !== String(body.password == null ? "" : body.password)) return json({ error: "invalid email or password", reason: "invalid_credentials" }, 401);
        if (!user.verified) return json({ error: "email is not verified", reason: "email_unverified" }, 403);
        const wanted = String(body.tenant_slug == null ? "" : body.tenant_slug).trim().toLowerCase();
        let tenant = null;
        if (wanted) {
          tenant = user.tenants.find(function (t) { return t.slug === wanted; }) || null;
          if (!tenant) return json({ error: "you are not a member of that organization", reason: "not_a_member" }, 403);
        } else if (user.tenants.length === 1) {
          tenant = user.tenants[0];
        } else {
          return json({ needs_tenant: true, tenants: user.tenants.map(function (t) { return { slug: t.slug, name: t.name, role: t.role }; }) });
        }
        return mintSession(email, tenant, true);
      }
      if (authPath === "verify-email") {
        const body = await req.json().catch(function () { return {}; });
        const token = String(body.token == null ? "" : body.token);
        const email = verifyTokens[token];
        if (!email || !authUsers[email]) return json({ error: "verification link is invalid or expired", reason: "invalid_token" }, 400);
        authUsers[email].verified = true;
        delete verifyTokens[token];
        return json({ verified: true, user: safeUser(email) });
      }
      if (authPath === "verify-email/resend") {
        const body = await req.json().catch(function () { return {}; });
        const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
        // Always the same generic 200 (no enumeration); only (re)issue a token for
        // a real, unverified account.
        if (authUsers[email] && !authUsers[email].verified) {
          const vt = "emiv_" + crypto.randomUUID().replace(/-/g, "");
          verifyTokens[vt] = email;
        }
        return json({ status: "verification_required", verification_required: true });
      }
      // logout / switch-tenant / bootstrap-owner require auth → fall through.
    }

    // Auth gate: accept the operator API key OR a valid user session token.
    const bearer = bearerOf(req);
    const isApiKey = Boolean(KEY) && bearer === KEY;
    const session = sessions[bearer] || null;
    if (KEY && !isApiKey && !session) return json({ error: "unauthorized" }, 401);
    if (parts[0] !== "v1" || !parts[1]) return json({ error: "not found" }, 404);

    // ── auth: AUTHENTICATED endpoints ──────────────────────────────────────
    if (parts[1] === "auth" && req.method === "POST") {
      const authPath = parts.slice(2).join("/");
      if (authPath === "logout") {
        if (bearer) delete sessions[bearer];
        return json({ logged_out: true });
      }
      if (authPath === "switch-tenant") {
        // Server: a non-session principal (api key) gets 400 not_session.
        if (!session) return json({ error: "not a session", reason: "not_session" }, 400);
        const body = await req.json().catch(function () { return {}; });
        const wanted = String(body.tenant_slug == null ? "" : body.tenant_slug).trim().toLowerCase();
        if (!wanted) return json({ error: "tenant_slug is required" }, 400);
        const user = authUsers[session.email];
        const tenant = user ? user.tenants.find(function (t) { return t.slug === wanted; }) : null;
        // Server distinguishes 404 (org unknown) from 403 (known but not a member);
        // the stub only knows the caller's own orgs, so an unknown slug is 404.
        if (!tenant) return json({ error: "organization not found", reason: "not_found" }, 404);
        return mintSession(session.email, tenant, false);
      }
      if (authPath === "bootstrap-owner") {
        if (!isApiKey) return json({ error: "bootstrap requires an api key", reason: "apikey_required" }, 403);
        const body = await req.json().catch(function () { return {}; });
        const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
        if (!isAllowedSignupEmail(email)) return json({ error: "owner email is restricted", reason: "email_not_allowed" }, 403);
        if (bootstrapped) return json({ error: "this tenant already has an owner", reason: "owner_exists" }, 409);
        const defaultTenant = { slug: "default", name: "Default Tenant", role: "owner" };
        authUsers[email] = { password: String(body.password == null ? "" : body.password), name: body.name || null, verified: true, created_at: new Date().toISOString(), tenants: [defaultTenant] };
        bootstrapped = true;
        return json({ user: safeUser(email), tenant: publicTenant(defaultTenant) }, 201);
      }
    }

    // GET /v1/me — identity/tenant context for the caller's credential.
    // Mirrors the server: snake principal_type, full tenant (id/slug/name/status),
    // derived scopes, and FLAT memberships rows (tenant_id, slug, name, role).
    if (parts[1] === "me" && parts[2] === undefined && req.method === "GET") {
      if (session) {
        const user = authUsers[session.email];
        return json({
          principal_type: "user",
          user: safeUser(session.email),
          tenant: publicTenant(session.tenant),
          role: session.tenant.role,
          scopes: scopesForRole(session.tenant.role),
          memberships: (user ? user.tenants : []).map(function (t) { return { tenant_id: "tenant-" + t.slug, slug: t.slug, name: t.name, role: t.role }; }),
          email_identities: [],
        });
      }
      return json({
        principal_type: "apikey",
        kid: "stub-operator-kid",
        tenant: { id: "tenant-default", slug: "default", name: "Default Tenant", status: "active" },
        scopes: ["emails:read", "emails:write"],
      });
    }

    // Tenant-scoped API keys — /v1/keys (token shown once; never stored/dumped).
    if (parts[1] === "keys") {
      const tenantSlug = session ? session.tenant.slug : "default";
      const kid = parts[2] !== undefined ? decodeURIComponent(parts[2]) : undefined;
      if (kid === undefined && req.method === "GET") {
        const list = rowsFor("keys")
          .filter(function (k) { return k.tenant_slug === tenantSlug; })
          .map(function (k) { return { kid: k.kid, scopes: k.scopes, revoked_at: k.revoked_at, created_at: k.created_at, expires_at: k.expires_at }; });
        return json({ keys: list });
      }
      if (kid === undefined && req.method === "POST") {
        const body = await req.json().catch(function () { return {}; });
        const scopes = Array.isArray(body.scopes) ? body.scopes : ["emails:*"];
        const token = "hasna_" + crypto.randomUUID().replace(/-/g, "");
        const newKid = "kid_" + crypto.randomUUID().slice(0, 8);
        const ttlDays = body.ttl_days == null ? null : Number(body.ttl_days);
        const rec = { kid: newKid, scopes: scopes, tenant_slug: tenantSlug, revoked_at: null, created_at: new Date().toISOString(), expires_at: ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null };
        rowsFor("keys").push(rec);
        return json({ token: token, kid: newKid, scopes: scopes, expires_at: rec.expires_at }, 201);
      }
      if (kid !== undefined && req.method === "DELETE") {
        const rec = rowsFor("keys").find(function (k) { return String(k.kid) === kid && k.tenant_slug === tenantSlug; });
        if (!rec) return json({ error: "key not found", reason: "not_found" }, 404);
        rec.revoked_at = new Date().toISOString();
        return json({ revoked: true, kid: kid });
      }
    }

    const resource = parts[1];
    const sub = parts[2];
    const id = sub !== undefined ? decodeURIComponent(sub) : undefined;

    // Messages special endpoints.
    if (resource === "messages" && sub === "counts" && req.method === "GET") {
      return json({ counts: messageCounts() });
    }
    if (resource === "messages" && sub === "send" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const now = new Date().toISOString();
      const providerMessageId = "stub-provider-" + (rowsFor("messages").length + 1);
      const rec = normalizeMessageRow({
        id: crypto.randomUUID(),
        direction: "outbound",
        from_addr: body.from || "",
        to_addrs: Array.isArray(body.to) ? body.to : [],
        cc_addrs: Array.isArray(body.cc) ? body.cc : [],
        subject: body.subject == null ? null : String(body.subject),
        body_text: typeof body.text === "string" ? body.text : null,
        body_html: typeof body.html === "string" ? body.html : null,
        status: "sent",
        provider_message_id: providerMessageId,
        message_id: "stub-" + (rowsFor("messages").length + 1),
        is_read: true,
        send_state: "sent",
        created_at: now,
        updated_at: now,
      });
      rowsFor("messages").push(rec);
      return json({
        message: detailRow(rec),
        provider: "stub",
        sent: true,
        provider_message_id: providerMessageId,
      }, 202);
    }
    // Send-intent reconciliation: enough of the real contract for CLI tests.
    if (resource === "messages" && sub === "send-intents" && parts[3] === "uncertain" && req.method === "GET") {
      const stuck = rowsFor("messages").filter(function (r) { return r.send_state === "uncertain"; });
      return json({ uncertain: stuck, count: stuck.length });
    }
    if (resource === "messages" && sub === "send-intents" && parts[3] === "reconcile" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const target = rowsFor("messages").find(function (r) { return String(r.id) === String(body.message_id); });
      if (!target) return json({ error: "message not found" }, 404);
      if (target.send_state !== "uncertain") {
        return json({ error: "only an 'uncertain' send intent can be reconciled; this one is '" + String(target.send_state) + "'", reconciled: false, message: target }, 409);
      }
      if (body.outcome === "sent") {
        if (!body.provider_message_id) return json({ error: "provider_message_id is required when reconciling an intent as sent" }, 400);
        target.send_state = "sent";
        target.status = "sent";
        target.provider_message_id = body.provider_message_id;
      } else {
        target.send_state = "failed";
        target.status = "failed";
      }
      target.updated_at = new Date().toISOString();
      return json({ reconciled: true, outcome: body.outcome, message: target });
    }
    if (resource === "messages" && id === undefined && req.method === "GET") {
      const page = listMessages(url.searchParams);
      if (page.error) return json({ error: page.error }, 400);
      return json(page);
    }
    if (resource === "messages" && id !== undefined && parts[3] === "attachments" && parts[4] !== undefined && req.method === "GET") {
      const all = rowsFor("messages");
      let rec = all.find(function (r) { return String(r.id) === id; });
      if (!rec) {
        const pref = all.filter(function (r) { return String(r.id).indexOf(id) === 0; });
        if (pref.length > 1) return json({ error: "ambiguous message id prefix", reason: "ambiguous_id" }, 409);
        rec = pref[0];
      }
      if (!rec) return json({ error: "message not found", code: "attachment_not_found" }, 404);
      const index = Number(parts[4]);
      const attachments = Array.isArray(rec.attachments) ? rec.attachments : [];
      const attachment = attachments[index];
      if (!attachment || typeof attachment !== "object") return json({ error: "attachment not found", code: "attachment_not_found" }, 404);
      if (typeof attachment.content_base64 !== "string") {
        return json({
          error: "attachment content is not stored",
          code: "attachment_content_unavailable",
          attachment: attachment,
        }, 409);
      }
      return json({ attachment: attachment });
    }
    // GET /v1/messages/<id> resolves an id PREFIX, mirroring the real server:
    // an exact id wins; otherwise a unique startsWith match resolves; multiple
    // matches -> 409 ambiguous_id; none -> 404. Lets client read/link tests use
    // the short (8-char) ids that the inbox list command prints.
    if (resource === "messages" && id !== undefined && parts[3] === undefined && req.method === "GET") {
      const all = rowsFor("messages");
      let rec = all.find(function (r) { return String(r.id) === id; });
      if (!rec) {
        const pref = all.filter(function (r) { return String(r.id).indexOf(id) === 0; });
        if (pref.length > 1) return json({ error: "ambiguous message id prefix", reason: "ambiguous_id" }, 409);
        rec = pref[0];
      }
      if (!rec) return json({ error: itemNotFoundError(resource) }, 404);
      return json({ message: detailRow(rec) });
    }

    // Scoped send keys: bespoke mint/verify (matched before the generic matcher so
    // "mint"/"verify" are not read as a send-key id). Mirrors the server: the token
    // and its hash live ONLY here; the generic /v1/send-keys resource is summary-only.
    if (resource === "send-keys" && sub === "mint" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const ownerId = String(body.owner_id == null ? "" : body.owner_id).trim();
      if (!ownerId) return json({ error: "owner_id is required" }, 400);
      const label = body.label == null ? null : String(body.label);
      const ts = new Date().toISOString();
      const token = "esk_" + crypto.randomUUID().replace(/-/g, "");
      const keyId = crypto.randomUUID();
      const key = {
        id: keyId, owner_id: ownerId, prefix: token.slice(0, 12), label: label,
        last_used_at: null, revoked_at: null, created_at: ts, updated_at: ts,
      };
      rowsFor("send-keys").push(key);
      sendTokens[token] = keyId;
      return json({ token: token, key: key }, 201);
    }
    if (resource === "send-keys" && sub === "verify" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const token = typeof body.token === "string" ? body.token : "";
      if (!token.trim()) return json({ error: "token is required" }, 400);
      const keyId = sendTokens[token];
      const key = keyId ? rowsFor("send-keys").find(function (r) { return String(r.id) === String(keyId); }) : null;
      if (!key || key.revoked_at) return json({ valid: false, authorized: false, key: null });
      key.last_used_at = new Date().toISOString();
      key.updated_at = key.last_used_at;
      const from = typeof body.from === "string" ? body.from.trim() : "";
      if (!from) return json({ valid: true, authorized: false, key: key });
      return json({ valid: true, authorized: isOwnerAuthorizedFrom(key.owner_id, from), key: key });
    }

    const rows = rowsFor(resource);

    if (id === undefined && req.method === "GET") {
      // Mirror the real server's list windowing (src/server/self-hosted/store.ts
      // clampLimit/clampOffset): a supplied \`limit\` is CAPPED at 500, and
      // \`offset\` skips rows. Without this the stub handed back every row for any
      // limit, which hid the fact that a single \`.list({ limit: 1000 })\` can only
      // ever see 500 rows — the silent-truncation trap behind fabricated totals.
      if (!Array.isArray(listQueries[resource])) listQueries[resource] = [];
      listQueries[resource].push(url.search.replace(/^\?/, ""));
      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");
      const offset = rawOffset === null || Number.isNaN(Number(rawOffset)) || Number(rawOffset) < 0
        ? 0
        : Math.floor(Number(rawOffset));
      const ordered = rotateForList(resource, sortForList(resource, rows));
      let windowed = offset > 0 ? ordered.slice(offset) : ordered;
      if (rawLimit !== null && !Number.isNaN(Number(rawLimit))) {
        const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 500);
        windowed = windowed.slice(0, limit);
      }
      if (!usesEntityEnvelope(resource)) return json({ items: windowed });
      const out = {};
      out[resource] = windowed;
      return json(out);
    }
    if (id === undefined && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const now = new Date().toISOString();
      let entity = Object.assign(
        body,
        { created_at: (body && body.created_at) || now, updated_at: now },
      );
      entity = normalizeResourceRow(resource, entity);
      rows.push(entity);
      if (!usesEntityEnvelope(resource)) return json(entity, 201);
      const wrap = {};
      wrap[singular(resource)] = entity;
      return json(wrap, 201);
    }
    if (id !== undefined && req.method === "GET") {
      const key = resourceKey(resource);
      const e = rows.find(function (r) { return String(r[key]) === id; });
      if (!e) return json({ error: itemNotFoundError(resource) }, 404);
      if (!usesEntityEnvelope(resource)) return json(e);
      const wrap = {};
      wrap[singular(resource)] = e;
      return json(wrap);
    }
    if (id !== undefined && (req.method === "PATCH" || req.method === "PUT")) {
      const key = resourceKey(resource);
      const e = rows.find(function (r) { return String(r[key]) === id; });
      if (!e) return json({ error: itemNotFoundError(resource) }, 404);
      const patch = await req.json().catch(function () { return {}; });
      if (resource === "messages") {
        // Mirror the real server updateMessageStatus: a raw labels array is
        // IGNORED; the labels column is rebuilt from add_label/remove_label and
        // the archived flag (guards the client label-write contract in tests).
        var labels = Array.isArray(e.labels) ? e.labels.slice() : [];
        var norm = function (v) { return String(v).trim().toLowerCase(); };
        if (typeof patch.add_label === "string" && !labels.some(function (l) { return norm(l) === norm(patch.add_label); })) labels.push(patch.add_label);
        if (typeof patch.remove_label === "string") labels = labels.filter(function (l) { return norm(l) !== norm(patch.remove_label); });
        if (typeof patch.archived === "boolean") { labels = labels.filter(function (l) { return norm(l) !== "archived"; }); if (patch.archived) labels.push("archived"); }
        var rest = Object.assign({}, patch);
        delete rest.add_label; delete rest.remove_label; delete rest.labels;
        Object.assign(e, rest, { labels: labels, updated_at: new Date().toISOString() });
      } else {
        Object.assign(e, patch, { updated_at: new Date().toISOString() });
        if (resource === "domains" || resource === "addresses") {
          Object.assign(e, normalizeResourceRow(resource, e));
        }
      }
      if (!usesEntityEnvelope(resource)) return json(e);
      const wrap = {};
      wrap[singular(resource)] = e;
      return json(wrap);
    }
    if (id !== undefined && req.method === "DELETE") {
      const key = resourceKey(resource);
      const i = rows.findIndex(function (r) { return String(r[key]) === id; });
      if (i < 0) return json({ error: itemNotFoundError(resource) }, 404);
      rows.splice(i, 1);
      return json({ deleted: true, id: id });
    }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

const MODE_ENV = "EMAILS_MODE";
const URL_ENV = "EMAILS_SELF_HOSTED_URL";
const KEY_ENV = "EMAILS_SELF_HOSTED_API_KEY";
const SESSION_ENV = "EMAILS_SESSION_TOKEN";
const CLIENT_ENV_SECRET_ENV = "EMAILS_CLIENT_ENV_SECRET";

/**
 * Start an out-of-process /v1 stub server and return a handle for driving it.
 *
 * Typical use:
 *
 *   let stub: V1Stub;
 *   beforeAll(async () => { stub = await startV1Stub({ seed: { domains: [...] } }); });
 *   afterAll(() => stub.stop());
 *   beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
 *   afterEach(() => stub.clearEnv());
 */
export async function startV1Stub(options: V1StubOptions = {}): Promise<V1Stub> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const initialSeed = JSON.stringify(options.seed ?? {});
  let priorEnv: Record<string, string | undefined> | undefined;

  const proc = Bun.spawn(["bun", "-e", SERVER_SRC], {
    env: {
      ...process.env,
      V1_STUB_API_KEY: apiKey,
      V1_STUB_SEED: initialSeed,
      V1_STUB_RESOURCE_SPECS: JSON.stringify(V1_STUB_RESOURCE_SPECS),
      V1_STUB_RESOURCE_DEFAULTS: JSON.stringify(V1_STUB_RESOURCE_DEFAULTS),
      V1_STUB_LIST_ORDER: JSON.stringify(declaredListOrder()),
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  // Read the announced port from stdout.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let baseUrl = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = buffer.match(/PORT=(\d+)/);
    if (match) {
      baseUrl = `http://127.0.0.1:${match[1]}`;
      break;
    }
  }
  reader.releaseLock();
  if (!baseUrl) {
    proc.kill();
    throw new Error("v1-stub server did not report a port within 10s");
  }

  async function postReset(resources?: V1StubResources): Promise<void> {
    const res = await fetch(`${baseUrl}/v1/__reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resources ? { resources } : {}),
    });
    if (!res.ok) throw new Error(`v1-stub __reset failed: HTTP ${res.status}`);
  }

  const stub: V1Stub = {
    baseUrl,
    apiKey,
    async seed(resources) {
      await postReset(resources);
    },
    async reset() {
      await postReset(options.seed ? structuredClone(options.seed) : undefined);
    },
    async list(resource) {
      const all = await stub.dump();
      return all[resource] ?? [];
    },
    async dump() {
      const res = await fetch(`${baseUrl}/v1/__dump`);
      if (!res.ok) throw new Error(`v1-stub __dump failed: HTTP ${res.status}`);
      const body = (await res.json()) as { resources?: V1StubResources };
      return body.resources ?? {};
    },
    async setListOrderInstability(rotate, resources) {
      const res = await fetch(`${baseUrl}/v1/__list_order`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rotate, resources: resources ?? null }),
      });
      if (!res.ok) throw new Error(`v1-stub __list_order failed: HTTP ${res.status}`);
    },
    async listQueries(resource) {
      const res = await fetch(`${baseUrl}/v1/__list_queries?resource=${encodeURIComponent(resource)}`);
      if (!res.ok) throw new Error(`v1-stub __list_queries failed: HTTP ${res.status}`);
      const body = (await res.json()) as { queries?: string[] };
      return body.queries ?? [];
    },
    async verifyToken(email) {
      const res = await fetch(`${baseUrl}/v1/__verify_token?email=${encodeURIComponent(email)}`);
      if (!res.ok) throw new Error(`v1-stub __verify_token failed: HTTP ${res.status}`);
      const body = (await res.json()) as { token?: string | null };
      return body.token ?? null;
    },
    async markVerified(email) {
      const res = await fetch(`${baseUrl}/v1/__verify_user`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`v1-stub __verify_user failed: HTTP ${res.status}`);
    },
    async seedUser(user) {
      const res = await fetch(`${baseUrl}/v1/__seed_user`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(user),
      });
      if (!res.ok) throw new Error(`v1-stub __seed_user failed: HTTP ${res.status}`);
    },
    applyEnv() {
      priorEnv = {
        [MODE_ENV]: process.env[MODE_ENV],
        [URL_ENV]: process.env[URL_ENV],
        [KEY_ENV]: process.env[KEY_ENV],
        [SESSION_ENV]: process.env[SESSION_ENV],
        [CLIENT_ENV_SECRET_ENV]: process.env[CLIENT_ENV_SECRET_ENV],
      };
      process.env[MODE_ENV] = "self_hosted";
      process.env[URL_ENV] = baseUrl;
      process.env[KEY_ENV] = apiKey;
      delete process.env[SESSION_ENV];
      delete process.env[CLIENT_ENV_SECRET_ENV];
      resetSelfHostedConfigCache();
      resetMailDataSource();
    },
    clearEnv() {
      for (const key of [MODE_ENV, URL_ENV, KEY_ENV, SESSION_ENV, CLIENT_ENV_SECRET_ENV]) {
        const value = priorEnv?.[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      priorEnv = undefined;
      resetSelfHostedConfigCache();
      resetMailDataSource();
    },
    stop() {
      proc.kill();
    },
  };

  return stub;
}
