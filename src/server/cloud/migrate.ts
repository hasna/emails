// Migration runner for the Mailery self_hosted cloud Postgres schema.
//
// Used by the one-shot deploy migration task (`mailery db migrate`) and by the
// `mailery db status` command. PURE REMOTE (A1): runs against cloud Postgres.

import { MigrationLedger } from "../../generated/storage-kit/index.js";
import { getCloudPool, closeCloudPool, isCloudMode } from "./env.js";
import { maileryCloudMigrations } from "./migrations.js";

export interface MigrateOutcome {
  applied: string[];
  alreadyApplied: string[];
  pending: string[];
}

function assertCloud(): void {
  if (!isCloudMode()) {
    throw new Error(
      "mailery db migrate requires cloud mode. Set HASNA_MAILERY_STORAGE_MODE=cloud and " +
        "HASNA_MAILERY_DATABASE_URL (or provide DATABASE_URL). Local mode uses SQLite and needs no migration runner.",
    );
  }
}

/** Apply all pending migrations (or report the plan with `dryRun`). */
export async function runMigrations(opts: { dryRun?: boolean } = {}): Promise<MigrateOutcome> {
  assertCloud();
  const { client } = getCloudPool();
  const migrations = maileryCloudMigrations();
  try {
    const ledger = new MigrationLedger(client, migrations);
    const result = await ledger.migrate({ dryRun: opts.dryRun === true });
    const appliedIds = new Set(result.applied.map((a) => a.id));
    return {
      applied: result.plan.filter((p) => p.state === "pending").map((p) => p.migration.id),
      alreadyApplied: result.plan.filter((p) => p.state === "already_applied").map((p) => p.migration.id),
      pending: opts.dryRun
        ? result.plan.filter((p) => p.state === "pending").map((p) => p.migration.id)
        : migrations.filter((m) => !appliedIds.has(m.id)).map((m) => m.id),
    };
  } finally {
    await closeCloudPool();
  }
}
