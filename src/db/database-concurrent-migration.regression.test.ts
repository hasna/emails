// Cold database initialisation is batched into one transaction so it commits
// once instead of ~340 times (see runMigrations in src/db/database.ts). That
// batching is only safe if the transaction takes the write lock UP FRONT.
//
// With a deferred `BEGIN`, the first statement of the pass is a read
// (`SELECT MAX(id) FROM _migrations`), which takes a WAL read snapshot; each
// DDL then has to upgrade it to a write transaction. If another connection
// commits in between, that upgrade fails with SQLITE_BUSY_SNAPSHOT — and SQLite
// deliberately does not invoke the busy handler for it, so `busy_timeout` does
// not help. Because every statement in the pass tolerates its own failure, the
// whole migration would be skipped while the now-read-only COMMIT still
// succeeded: `getDatabase()` would return successfully with a stale schema.
//
// That is silent data-shape corruption, so it gets a guard. This spawns a real
// second process because the defect only exists BETWEEN connections — a
// single-connection test cannot reach it, which is exactly why the rest of the
// suite missed it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "./database.ts";

const tempDirs: string[] = [];
let previousDbPath: string | undefined;

beforeEach(() => {
  previousDbPath = process.env["EMAILS_DB_PATH"];
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  if (previousDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
  else process.env["EMAILS_DB_PATH"] = previousDbPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrated file-backed database, rewound so a later open has real work to do. */
function seedRewoundDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "emails-concurrent-migration-"));
  tempDirs.push(dir);
  const path = join(dir, "emails.db");

  closeDatabase();
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = path;
  getDatabase();
  closeDatabase();
  resetDatabase();

  const raw = new Database(path);
  try {
    raw.run("PRAGMA journal_mode = WAL");
    // Drop an object a later migration creates, and rewind the sentinel past it
    // so the next open must actually apply DDL rather than no-op.
    raw.run("DELETE FROM _migrations WHERE id > 40");
    raw.run("DROP TABLE IF EXISTS forwarding_rules");
  } finally {
    raw.close();
  }
  return path;
}

describe("concurrent migration safety", () => {
  it("applies pending migrations even while another connection is committing", () => {
    const path = seedRewoundDatabase();

    // A second connection committing in a loop. Under a deferred BEGIN this is
    // what invalidates the read snapshot and silently voids the whole pass.
    const writer = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.run("PRAGMA journal_mode = WAL");
         db.run("PRAGMA busy_timeout = 5000");
         db.run("CREATE TABLE IF NOT EXISTS _migration_race (n INTEGER)");
         const until = Date.now() + 10_000;
         let n = 0;
         while (Date.now() < until) {
           try { db.run("INSERT INTO _migration_race (n) VALUES (?)", [n++]); } catch {}
         }`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      Bun.sleepSync(250); // let the writer start committing

      closeDatabase();
      resetDatabase();
      process.env["EMAILS_DB_PATH"] = path;
      const db = getDatabase();

      // The pass must have actually run. A rewound sentinel that is still
      // rewound means every statement was rejected and the failure was swallowed.
      const level = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
      expect(level?.max_id ?? 0).toBeGreaterThan(40);

      // And the concrete object a skipped migration would have left missing.
      expect(() => db.query("SELECT 1 FROM forwarding_rules LIMIT 1").all()).not.toThrow();
    } finally {
      writer.kill();
    }
  }, 30_000);

  it("still reaches the same schema level with no competing writer (control)", () => {
    const path = seedRewoundDatabase();

    closeDatabase();
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = path;
    const db = getDatabase();

    const level = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
    expect(level?.max_id ?? 0).toBeGreaterThan(40);
    expect(() => db.query("SELECT 1 FROM forwarding_rules LIMIT 1").all()).not.toThrow();
  }, 30_000);
});
