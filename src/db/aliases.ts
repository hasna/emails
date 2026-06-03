/**
 * Per-domain aliases and catch-all routing. An alias maps a recipient
 * local-part on a domain to a target (owned) address; a catch-all maps every
 * otherwise-unmatched recipient on a domain. Resolution prefers a specific
 * alias over the domain catch-all.
 */
import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";

/** Sentinel local-part used to represent a domain catch-all. */
export const CATCH_ALL = "*";

export interface Alias {
  id: string;
  domain: string;
  local_part: string;
  target_address: string;
  created_at: string;
  updated_at: string;
}

function splitAddress(address: string): { local_part: string; domain: string } {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`Invalid email address (expected local@domain): ${address}`);
  }
  return { local_part: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

function rowToAlias(row: Alias): Alias {
  return row;
}

function upsert(domain: string, localPart: string, target: string, db: Database): Alias {
  const d = db;
  const existing = d.query("SELECT * FROM aliases WHERE domain = ? AND local_part = ?").get(domain, localPart) as Alias | null;
  if (existing) {
    d.run("UPDATE aliases SET target_address = ?, updated_at = ? WHERE id = ?", [target, now(), existing.id]);
    return getAlias(existing.id, d)!;
  }
  const id = uuid();
  const ts = now();
  d.run(
    "INSERT INTO aliases (id, domain, local_part, target_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, domain, localPart, target, ts, ts],
  );
  return getAlias(id, d)!;
}

/** Create (or update) a specific alias: `alias@domain` → `target`. */
export function createAlias(aliasAddress: string, target: string, db?: Database): Alias {
  const d = db || getDatabase();
  const { local_part, domain } = splitAddress(aliasAddress);
  return upsert(domain, local_part, target.toLowerCase(), d);
}

/** Create (or update) a catch-all for `domain` → `target`. */
export function createCatchAll(domain: string, target: string, db?: Database): Alias {
  const d = db || getDatabase();
  return upsert(domain.toLowerCase(), CATCH_ALL, target.toLowerCase(), d);
}

export function getAlias(id: string, db?: Database): Alias | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM aliases WHERE id = ?").get(id) as Alias | null;
  return row ? rowToAlias(row) : null;
}

export function listAliases(domain?: string, db?: Database): Alias[] {
  const d = db || getDatabase();
  const rows = domain
    ? d.query("SELECT * FROM aliases WHERE domain = ? ORDER BY local_part").all(domain.toLowerCase()) as Alias[]
    : d.query("SELECT * FROM aliases ORDER BY domain, local_part").all() as Alias[];
  return rows.map(rowToAlias);
}

export function removeAlias(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("DELETE FROM aliases WHERE id = ?", [id]).changes > 0;
}

/**
 * Resolve a recipient address to its target via aliases. A specific alias
 * wins over the domain catch-all. Returns null when nothing matches.
 */
export function resolveAlias(recipient: string, db?: Database): string | null {
  const d = db || getDatabase();
  let local_part: string, domain: string;
  try { ({ local_part, domain } = splitAddress(recipient)); } catch { return null; }
  const specific = d.query("SELECT target_address FROM aliases WHERE domain = ? AND local_part = ?").get(domain, local_part) as { target_address: string } | null;
  if (specific) return specific.target_address;
  const catchAll = d.query("SELECT target_address FROM aliases WHERE domain = ? AND local_part = ?").get(domain, CATCH_ALL) as { target_address: string } | null;
  return catchAll ? catchAll.target_address : null;
}
