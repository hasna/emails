// Product-owned Emails Postgres storage utilities.
// Forked from storage-kit 0.4.2 and maintained in this repository.

// Migration-ledger helper for the Emails Postgres storage utilities.
//
// A `schema_migrations` ledger with per-migration sha256 checksums, modeled on
// open-loops' storage ledger. Guarantees:
//   - each migration runs at most once (idempotent by id),
//   - a migration whose SQL changed after being applied is detected as a
//     checksum mismatch and refuses to proceed (no silent drift),
//   - an applied migration unknown to this binary is detected (downgrade
//     guard),
//   - `dryRun` reports the plan without mutating anything.
//
// PURE REMOTE (Amendment A1): migrations run against the self_hosted Postgres. There
// is no local schema and no sync of ledger rows between machines.

import { createHash } from "node:crypto";
import type { TypedQueryClient } from "./query.js";

/** Default ledger table name. Override per app if a legacy name exists. */
export const DEFAULT_MIGRATION_LEDGER_TABLE = "schema_migrations";

export interface Migration {
  readonly id: string;
  readonly sql: string;
  readonly checksum: string;
  readonly acceptedChecksums?: readonly string[];
}

export type MigrationState = "already_applied" | "pending";

export interface MigrationPlanItem {
  readonly migration: Migration;
  readonly state: MigrationState;
}

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly dryRun: boolean;
  readonly applied: AppliedMigration[];
  readonly plan: MigrationPlanItem[];
}

/** Stable sha256 checksum for a migration's SQL text. */
export function checksumSql(sql: string): string {
  const normalized = sql.trim().replace(/\r\n/g, "\n");
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

/** Freeze a migration definition, computing its checksum from the SQL. */
export function defineMigration(id: string, sql: string): Migration {
  return Object.freeze({ id, sql: sql.trim(), checksum: checksumSql(sql) });
}

/**
 * Declare checksums from already-published migration bodies that remain valid
 * for upgrade compatibility. Pending migrations still run the current SQL and
 * record the current checksum.
 */
export function withAcceptedMigrationChecksums(
  migration: Migration,
  acceptedChecksums: readonly string[],
): Migration {
  const accepted = [...new Set(acceptedChecksums.filter((checksum) => checksum !== migration.checksum))];
  return Object.freeze({ ...migration, acceptedChecksums: Object.freeze(accepted) });
}

export function migrationAcceptsChecksum(migration: Migration, checksum: string): boolean {
  return migration.checksum === checksum || migration.acceptedChecksums?.includes(checksum) === true;
}

interface LedgerRow {
  id: string;
  checksum: string;
  applied_at: string | Date;
}

export interface MigrationRunnerOptions {
  ledgerTable?: string;
}

export class MigrationLedger {
  private readonly ledgerTable: string;

  constructor(
    private readonly client: TypedQueryClient,
    private readonly migrations: readonly Migration[],
    options: MigrationRunnerOptions = {},
  ) {
    this.ledgerTable = options.ledgerTable ?? DEFAULT_MIGRATION_LEDGER_TABLE;
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (seen.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
      seen.add(migration.id);
    }
  }

  async ensureLedger(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.ledgerTable} (
         id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  async listApplied(): Promise<AppliedMigration[]> {
    await this.ensureLedger();
    return this.readApplied();
  }

  private async readApplied(): Promise<AppliedMigration[]> {
    const rows = await this.client.many<LedgerRow>(
      `SELECT id, checksum, applied_at FROM ${this.ledgerTable} ORDER BY id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      checksum: row.checksum,
      appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    }));
  }

  /** Compute the migration plan and guard against drift/downgrade. */
  private buildPlan(applied: AppliedMigration[]): MigrationPlanItem[] {
    const known = new Set(this.migrations.map((m) => m.id));
    for (const row of applied) {
      if (!known.has(row.id)) {
        throw new Error(`Applied migration '${row.id}' is not recognized by this build (downgrade?).`);
      }
    }
    const appliedById = new Map(applied.map((row) => [row.id, row]));
    for (const migration of this.migrations) {
      const existing = appliedById.get(migration.id);
      if (existing && !migrationAcceptsChecksum(migration, existing.checksum)) {
        throw new Error(
          `Migration checksum mismatch for '${migration.id}': the SQL changed after it was applied.`,
        );
      }
    }
    return this.migrations.map((migration) => ({
      migration,
      state: appliedById.has(migration.id) ? "already_applied" : "pending",
    }));
  }

  /** Apply all pending migrations. With `dryRun`, report the plan only. */
  async migrate(opts: { dryRun?: boolean } = {}): Promise<MigrationResult> {
    const dryRun = opts.dryRun === true;
    await this.ensureLedger();
    const applied = await this.readApplied();
    const plan = this.buildPlan(applied);
    if (dryRun) return { dryRun, applied, plan };

    for (const item of plan) {
      if (item.state === "already_applied") continue;
      await this.client.execute(item.migration.sql);
      await this.client.execute(
        `INSERT INTO ${this.ledgerTable} (id, checksum, applied_at) VALUES ($1, $2, now())`,
        [item.migration.id, item.migration.checksum],
      );
    }
    return { dryRun, applied: await this.readApplied(), plan };
  }
}

/** Convenience: build a ledger and run all pending migrations. */
export function createMigrationLedger(
  client: TypedQueryClient,
  migrations: readonly Migration[],
  options: MigrationRunnerOptions = {},
): MigrationLedger {
  return new MigrationLedger(client, migrations, options);
}
