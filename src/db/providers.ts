import type { Database } from "./database.js";
import type { CreateProviderInput, Provider, ProviderRow, ProviderSummary, ProviderType } from "../types/index.js";
import { ProviderNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid, resolvePartialId } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { cloudResource, cloudListQuery, cloudPage, cbool, ciso, cstr, cstrOrNull } from "./cloud-resource.js";

const PROVIDER_RESOURCE = "providers";

// The cloud `providers` resource carries only NON-SECRET metadata (id, name,
// type, region, active, timestamps) — provider credentials (api_key/secret_key/
// oauth tokens) are never distributed to or fetched by a client. Secret columns
// map to null; a flipped client uses cloud-side send (`/v1/send`), not local
// provider secrets. So `provider list` shows the cloud inventory, not secrets.
function apiToProviderSummary(e: Record<string, unknown>): ProviderSummary {
  const updatedAt = ciso(e["updated_at"]);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    type: cstr(e["type"]) as Provider["type"],
    region: cstrOrNull(e["region"]),
    active: cbool(e["active"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function apiToProvider(e: Record<string, unknown>): Provider {
  return {
    ...apiToProviderSummary(e),
    api_key: null,
    access_key: null,
    secret_key: null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
  };
}

function rowToProvider(row: ProviderRow): Provider {
  return {
    ...row,
    active: !!row.active,
    type: row.type as Provider["type"],
  };
}

interface ProviderSummaryRow {
  id: string;
  name: string;
  type: string;
  region: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

const PROVIDER_COLUMNS = [
  "id",
  "name",
  "type",
  "api_key",
  "region",
  "access_key",
  "secret_key",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_refresh_token",
  "oauth_access_token",
  "oauth_token_expiry",
  "active",
  "created_at",
  "updated_at",
].join(", ");

const PROVIDER_SUMMARY_COLUMNS = [
  "id",
  "name",
  "type",
  "region",
  "active",
  "created_at",
  "updated_at",
].join(", ");

function rowToProviderSummary(row: ProviderSummaryRow): ProviderSummary {
  return {
    ...row,
    active: !!row.active,
    type: row.type as Provider["type"],
  };
}

export function createProvider(input: CreateProviderInput, db?: Database): Provider {
  // Cloud mode: register the provider's NON-SECRET metadata (name/type/region)
  // through the /v1/providers API so a flipped client no longer writes to the
  // local SQLite island while `provider list` reads the cloud (the split-brain
  // bug: "✓ created" but /v1/providers stays empty). Credentials are never sent
  // to or stored by the cloud resource — a flipped client sends via the server.
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    return apiToProvider(cloud.create({
      name: input.name,
      type: input.type,
      region: input.region || null,
      active: true,
    }));
  }

  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO providers (id, name, type, api_key, region, access_key, secret_key,
       oauth_client_id, oauth_client_secret, oauth_refresh_token, oauth_access_token, oauth_token_expiry,
       active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.name,
      input.type,
      input.api_key || null,
      input.region || null,
      input.access_key || null,
      input.secret_key || null,
      input.oauth_client_id || null,
      input.oauth_client_secret || null,
      input.oauth_refresh_token || null,
      input.oauth_access_token || null,
      input.oauth_token_expiry || null,
      timestamp,
      timestamp,
    ],
  );

  return getProvider(id, d)!;
}

export function getProvider(id: string, db?: Database): Provider | null {
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    const rec = cloud.get(id);
    return rec ? apiToProvider(rec) : null;
  }

  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`).get(id) as ProviderRow | null;
  if (!row) return null;
  return rowToProvider(row);
}

/**
 * Resolve a full or partial provider id to a canonical id, routed through the
 * active Store. In cloud mode a full-length id is confirmed via the /v1/providers
 * endpoint and a prefix is matched against the cloud provider list; in local
 * mode it falls back to the SQLite partial-id resolver. Keeps `provider
 * remove`/`update` consistent with `provider list` instead of always reading the
 * (empty, in cloud mode) local `providers` table.
 */
export function resolveProviderId(id: string, db?: Database): string | null {
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    const trimmed = id.trim();
    if (!trimmed) return null;
    if (trimmed.length >= 36) return cloud.get(trimmed) ? trimmed : null;
    const matches = cloud
      .list({ limit: 1000 })
      .map((row) => cstr(row["id"]))
      .filter((pid) => pid.startsWith(trimmed));
    return matches.length === 1 ? matches[0]! : null;
  }

  return resolvePartialId(db || getDatabase(), "providers", id);
}

export function getProviderByNameAndType(name: string, type: ProviderType, db?: Database): Provider | null {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE name = ? AND type = ?`).get(name, type) as ProviderRow | null;
  return row ? rowToProvider(row) : null;
}

export interface ListProviderOptions {
  limit?: number;
  offset?: number;
}

export function listProviders(db?: Database, opts?: ListProviderOptions): Provider[] {
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    const { query, limit, offset } = cloudListQuery(opts);
    const rows = cloud.list(query).map(apiToProvider);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return cloudPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderRow[]
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY created_at DESC`).all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function listProviderSummaries(db?: Database, opts?: ListProviderOptions): ProviderSummary[] {
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    const { query, limit, offset } = cloudListQuery(opts);
    const rows = cloud.list(query).map(apiToProviderSummary);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return cloudPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderSummaryRow[]
    : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers ORDER BY created_at DESC`).all() as ProviderSummaryRow[];
  return rows.map(rowToProviderSummary);
}

export function listProviderNamesByIds(providerIds: Iterable<string>, db?: Database): Map<string, string> {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d.query(`SELECT id, name FROM providers WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function listActiveProviders(type?: ProviderType, db?: Database): Provider[] {
  const d = db || getDatabase();
  const rows = type
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type = ? ORDER BY created_at DESC`).all(type) as ProviderRow[]
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at DESC`).all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function listActiveProviderSummaries(type?: ProviderType, db?: Database, opts?: ListProviderOptions): ProviderSummary[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = type
    ? (limit !== null
        ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(type, limit, offset) as ProviderSummaryRow[]
        : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type = ? ORDER BY created_at DESC`).all(type) as ProviderSummaryRow[])
    : (limit !== null
        ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderSummaryRow[]
        : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at DESC`).all() as ProviderSummaryRow[]);
  return rows.map(rowToProviderSummary);
}

export function getLatestActiveProvider(type?: ProviderType, db?: Database): Provider | null {
  const d = db || getDatabase();
  const row = type
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type = ? ORDER BY created_at DESC LIMIT 1`).get(type) as ProviderRow | null
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at DESC LIMIT 1`).get() as ProviderRow | null;
  return row ? rowToProvider(row) : null;
}

export function getLatestActiveProviderId(type?: ProviderType, db?: Database): string | null {
  const d = db || getDatabase();
  const row = type
    ? d.query("SELECT id FROM providers WHERE active = 1 AND type = ? ORDER BY created_at DESC LIMIT 1").get(type) as { id: string } | null
    : d.query("SELECT id FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | null;
  return row?.id ?? null;
}

export function updateProvider(
  id: string,
  input: Partial<CreateProviderInput> & { active?: boolean },
  db?: Database,
): Provider {
  // Cloud mode: patch the non-secret metadata via /v1/providers/:id. Secret
  // columns are never carried by the cloud resource, so credential updates are
  // silently ignored server-side (a flipped client sends via the server).
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch["name"] = input.name;
    if (input.type !== undefined) patch["type"] = input.type;
    if (input.region !== undefined) patch["region"] = input.region || null;
    if (input.active !== undefined) patch["active"] = input.active;
    return apiToProvider(cloud.update(id, patch));
  }

  const d = db || getDatabase();
  const provider = getProvider(id, d);
  if (!provider) throw new ProviderNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];

  if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
  if (input.type !== undefined) { sets.push("type = ?"); params.push(input.type); }
  if (input.api_key !== undefined) { sets.push("api_key = ?"); params.push(input.api_key || null); }
  if (input.region !== undefined) { sets.push("region = ?"); params.push(input.region || null); }
  if (input.access_key !== undefined) { sets.push("access_key = ?"); params.push(input.access_key || null); }
  if (input.secret_key !== undefined) { sets.push("secret_key = ?"); params.push(input.secret_key || null); }
  if (input.oauth_client_id !== undefined) { sets.push("oauth_client_id = ?"); params.push(input.oauth_client_id || null); }
  if (input.oauth_client_secret !== undefined) { sets.push("oauth_client_secret = ?"); params.push(input.oauth_client_secret || null); }
  if (input.oauth_refresh_token !== undefined) { sets.push("oauth_refresh_token = ?"); params.push(input.oauth_refresh_token || null); }
  if (input.oauth_access_token !== undefined) { sets.push("oauth_access_token = ?"); params.push(input.oauth_access_token || null); }
  if (input.oauth_token_expiry !== undefined) { sets.push("oauth_token_expiry = ?"); params.push(input.oauth_token_expiry || null); }
  if (input.active !== undefined) { sets.push("active = ?"); params.push(input.active ? 1 : 0); }

  params.push(id);
  d.run(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`, params);

  return getProvider(id, d)!;
}

export function deleteProvider(id: string, db?: Database): boolean {
  const cloud = cloudResource(PROVIDER_RESOURCE);
  if (cloud) return cloud.del(id);

  const d = db || getDatabase();
  const result = d.run("DELETE FROM providers WHERE id = ?", [id]);
  return result.changes > 0;
}

export function getActiveProvider(db?: Database): Provider {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type != 'gmail' ORDER BY created_at LIMIT 1`).get() as ProviderRow | null;
  if (!row) throw new ProviderNotFoundError("(no active provider)");
  return rowToProvider(row);
}
