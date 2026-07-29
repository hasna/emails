// Migration runner for the Emails operator-owned PostgreSQL schema.
//
// Used by the one-shot deploy migration task (`emails db migrate`) and by the
// `emails db status` command. Runs directly against operator-owned Postgres.

import { MigrationLedger } from "../../storage-kit/index.js";
import { SELF_HOSTED_DATABASE_ENV, getSelfHostedPool, closeSelfHostedPool, usesPostgresBackend } from "./env.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

export interface MigrateOutcome {
  applied: string[];
  alreadyApplied: string[];
  pending: string[];
}

function assertPostgresBackend(): void {
  if (!usesPostgresBackend()) {
    throw new Error(
      `emails db migrate requires ${SELF_HOSTED_DATABASE_ENV}. ` +
        "A SQLite installation needs no PostgreSQL migration runner.",
    );
  }
}

/** Apply all pending migrations (or report the plan with `dryRun`). */
export async function runMigrations(opts: { dryRun?: boolean } = {}): Promise<MigrateOutcome> {
  assertPostgresBackend();
  const { client } = getSelfHostedPool();
  const migrations = emailsSelfHostedMigrations();
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
    await closeSelfHostedPool();
  }
}
