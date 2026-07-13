// Pure runtime helpers shared by the resource repositories.
//
// These used to live in src/db/database.ts alongside the local SQLite engine.
// The self-hosted-only client has no local database, so the pure,
// storage-independent helpers live here and every repo imports them from this
// module instead of the deleted database.ts.

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
