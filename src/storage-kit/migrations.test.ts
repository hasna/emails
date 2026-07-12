import { describe, expect, test } from "bun:test";
import {
  defineMigration,
  MigrationLedger,
  withAcceptedMigrationChecksums,
  type AppliedMigration,
  type TypedQueryClient,
} from "./index.js";

function clientWithApplied(rows: AppliedMigration[]): TypedQueryClient {
  return {
    async query<T>() {
      return { rows: rows as unknown as T[], rowCount: rows.length };
    },
    async many<T>() {
      return rows as unknown as T[];
    },
    async get() {
      return null;
    },
    async one() {
      throw new Error("one() is not used by this test");
    },
    async execute() {},
  };
}

describe("MigrationLedger accepted checksums", () => {
  test("accepts explicitly declared published checksums for already-applied migrations", async () => {
    const migration = withAcceptedMigrationChecksums(defineMigration("0001_test", "SELECT 1"), [
      "sha256:published",
    ]);
    const ledger = new MigrationLedger(clientWithApplied([
      { id: migration.id, checksum: "sha256:published", appliedAt: "2026-07-12T00:00:00.000Z" },
    ]), [migration]);

    const result = await ledger.migrate({ dryRun: true });

    expect(result.plan).toEqual([{ migration, state: "already_applied" }]);
  });

  test("still rejects undeclared checksum drift", async () => {
    const migration = withAcceptedMigrationChecksums(defineMigration("0001_test", "SELECT 1"), [
      "sha256:published",
    ]);
    const ledger = new MigrationLedger(clientWithApplied([
      { id: migration.id, checksum: "sha256:other", appliedAt: "2026-07-12T00:00:00.000Z" },
    ]), [migration]);

    await expect(ledger.migrate({ dryRun: true })).rejects.toThrow("Migration checksum mismatch");
  });
});
