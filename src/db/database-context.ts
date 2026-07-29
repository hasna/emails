import type { Database } from "bun:sqlite";

// A Database object does not expose a stable, typed pathname across every Bun
// version we support. Keep the path selected by database.ts beside the handle
// instead. Secret storage uses this only to distinguish ephemeral databases;
// root key material is deliberately stored outside the SQLite directory.
const databasePaths = new WeakMap<Database, string>();

export function registerDatabasePath(db: Database, path: string): void {
  databasePaths.set(db, path);
}

export function databasePathFor(db: Database): string | null {
  return databasePaths.get(db) ?? null;
}
