// Write transactions for the SQLite store.
//
// BEGIN IMMEDIATE, NEVER A BARE BEGIN — and never `SAVEPOINT` as the OUTERMOST
// scope either, because a savepoint opened outside a transaction starts a
// DEFERRED one and inherits the same defect.
//
// A deferred BEGIN takes only a WAL read snapshot on its first statement and
// then has to upgrade to a write transaction on the first write. If another
// connection commits in between, that upgrade fails with SQLITE_BUSY_SNAPSHOT —
// which SQLite deliberately does NOT route through the busy handler, so
// `busy_timeout` cannot absorb it. The failure mode is the dangerous kind: the
// writes are skipped while the now read-only COMMIT still succeeds, so the
// caller is told the write landed. Taking the write lock up front makes the race
// impossible, and a failure to acquire it surfaces as ordinary SQLITE_BUSY,
// which `busy_timeout` does absorb.
//
// (This is the same reasoning, and the same fix, as the cold-open migration
// batch in src/db/database.ts.)

import type { Database } from "../db/database.js";

/**
 * Run `work` inside an immediate (write-locked) transaction.
 *
 * When the connection is ALREADY inside a transaction — a caller's, or the
 * migration batch a cold open holds — SQLite rejects a nested BEGIN. In that
 * case the work joins the enclosing transaction rather than opening a second
 * one, and the enclosing scope owns the commit. Any OTHER failure to begin
 * (SQLITE_BUSY after the busy timeout, a corrupt file) is rethrown: silently
 * proceeding un-transacted is how a partial write gets reported as a whole one.
 */
export function withImmediateTransaction<TResult>(db: Database, work: () => TResult): TResult {
  let owned = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    owned = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/within a transaction/i.test(message)) throw error;
  }
  if (!owned) return work();
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite already ended the transaction itself (SQLITE_FULL, SQLITE_IOERR).
    }
    throw error;
  }
}
