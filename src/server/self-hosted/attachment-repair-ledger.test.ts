import { describe, expect, it } from "bun:test";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import {
  MAX_ATTACHMENT_REPAIR_MANIFEST_ITEMS,
  MAX_ATTACHMENT_REPAIR_PAGE_ITEMS,
  normalizeAttachmentRepairManifestEntries,
  processAttachmentRepairPage,
  type AttachmentRepairLedgerEntry,
  type AttachmentRepairLedgerRun,
  type AttachmentRepairLedgerStore,
  type AttachmentRepairResult,
} from "./attachment-repair.js";
import {
  EmailsSelfHostedStore,
  attachmentRepairRequestHash,
} from "./store.js";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEST_MAX_ATTEMPTS = 3;
const TEST_RETRY_BACKOFF_MS = 1_000;

type TestLedgerEntry = AttachmentRepairLedgerEntry & {
  claim_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
};

function ledgerFixture(options: { apply?: boolean; count?: number } = {}) {
  const seed: Array<Pick<
    AttachmentRepairLedgerEntry,
    "object_key" | "recipients" | "canary_message_ids" | "attachment_count"
  >> = [
    {
      object_key: "source/one",
      recipients: ["one@example.test"],
      canary_message_ids: ["message-1"],
      attachment_count: 2,
    },
    {
      object_key: "source/two",
      recipients: ["two@example.test"],
      canary_message_ids: ["message-2"],
      attachment_count: 1,
    },
    {
      object_key: "source/three",
      recipients: ["three@example.test"],
      canary_message_ids: ["message-3"],
      attachment_count: 3,
    },
  ];
  const count = options.count ?? seed.length;
  let clockMs = Date.parse("2026-07-24T00:00:00.000Z");
  let claimSequence = 0;
  const entries: TestLedgerEntry[] = Array.from({ length: count }, (_, position) => {
    const fixture = seed[position] ?? {
      object_key: `source/${position + 1}`,
      recipients: [`recipient-${position + 1}@example.test`],
      canary_message_ids: [`message-${position + 1}`],
      attachment_count: 1,
    };
    return {
      tenant_id: TENANT_A,
      run_id: "run-1",
      position,
      ...fixture,
      status: "pending",
      operator_action: false,
      attempts: 0,
      last_error_code: null,
      last_attempt_at: null,
      claim_token: null,
      lease_expires_at: null,
      next_attempt_at: new Date(clockMs).toISOString(),
      source_byte_limit: 8,
    };
  });
  const inventoryTotal = entries.reduce((total, entry) => total + entry.attachment_count, 0);
  const run = {
    id: "run-1",
    tenant_id: TENANT_A,
    apply: options.apply === true,
    status: "pending",
    entry_total: entries.length,
    inventory_total: inventoryTotal,
    repaired: 0,
    would_repair: 0,
    unavailable: 0,
    operator_action: 0,
    pending: inventoryTotal,
    retrying: 0,
    entry_repaired: 0,
    entry_would_repair: 0,
    entry_unavailable: 0,
    entry_operator_action: 0,
    entry_pending: entries.length,
    entry_retrying: 0,
    attempts: 0,
    checkpoint: 0,
    byte_budget: 1024,
    bytes_consumed: 0,
    time_budget_ms: 60_000,
    deadline_at: "2026-07-24T00:01:00.000Z",
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
    completed_at: null,
  } as AttachmentRepairLedgerRun & {
    operator_action: number;
    entry_operator_action: number;
  };
  const refresh = () => {
    run.repaired = entries
      .filter((entry) => entry.status === "repaired")
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.would_repair = entries
      .filter((entry) => entry.status === "would_repair")
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.unavailable = entries
      .filter((entry) => entry.status === "unavailable")
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.operator_action = entries
      .filter((entry) => entry.operator_action)
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.pending = entries
      .filter((entry) => entry.status === "pending")
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.retrying = entries
      .filter((entry) => entry.status === "pending" && entry.attempts > 0)
      .reduce((total, entry) => total + entry.attachment_count, 0);
    run.entry_repaired = entries.filter((entry) => entry.status === "repaired").length;
    run.entry_would_repair = entries.filter((entry) => entry.status === "would_repair").length;
    run.entry_unavailable = entries.filter((entry) => entry.status === "unavailable").length;
    run.entry_operator_action = entries.filter((entry) => entry.operator_action).length;
    run.entry_pending = entries.filter((entry) => entry.status === "pending").length;
    run.entry_retrying = entries.filter(
      (entry) => entry.status === "pending" && entry.attempts > 0,
    ).length;
    run.attempts = entries.reduce((total, entry) => total + entry.attempts, 0);
    const firstPending = entries.find((entry) => entry.status === "pending");
    run.checkpoint = firstPending?.position ?? entries.length;
    run.status = entries.some((entry) => entry.status === "pending") ? "pending" : "completed";
    run.completed_at = run.status === "completed" ? "2026-07-24T00:01:00.000Z" : null;
  };
  const store = {
    async getAttachmentRepairRun(runId) {
      return runId === run.id ? { ...run } : null;
    },
    async listPendingAttachmentRepairEntries(runId, limit) {
      if (runId !== run.id) return [];
      return entries.filter((entry) => entry.status === "pending").slice(0, limit).map((entry) => ({ ...entry }));
    },
    async claimAttachmentRepairEntry(runId: string, leaseMs: number) {
      if (runId !== run.id) return null;
      for (const entry of entries) {
        const leaseExpired = entry.lease_expires_at === null
          || Date.parse(entry.lease_expires_at) <= clockMs;
        if (entry.status === "pending" && entry.attempts >= TEST_MAX_ATTEMPTS && leaseExpired) {
          entry.status = "unavailable";
          entry.operator_action = true;
          entry.last_error_code = "retry_exhausted";
          entry.claim_token = null;
          entry.lease_expires_at = null;
        }
      }
      const entry = entries
        .filter((candidate) =>
          candidate.status === "pending"
          && Date.parse(candidate.next_attempt_at) <= clockMs
          && (candidate.lease_expires_at === null
            || Date.parse(candidate.lease_expires_at) <= clockMs)
          && candidate.attempts < TEST_MAX_ATTEMPTS)
        .sort((left, right) =>
          Date.parse(left.next_attempt_at) - Date.parse(right.next_attempt_at)
          || left.attempts - right.attempts
          || left.position - right.position)[0];
      if (!entry) {
        refresh();
        return null;
      }
      entry.attempts++;
      entry.last_attempt_at = new Date(clockMs).toISOString();
      entry.claim_token = `claim-${++claimSequence}`;
      entry.lease_expires_at = new Date(clockMs + leaseMs).toISOString();
      refresh();
      return { ...entry };
    },
    async recordAttachmentRepairEntryOutcome(
      runId: string,
      position: number,
      claimToken: string,
      status: AttachmentRepairLedgerEntry["status"],
      errorCode: string | null = null,
    ) {
      expect(runId).toBe(run.id);
      const entry = entries.find((candidate) => candidate.position === position);
      if (!entry) throw new Error("missing fixture entry");
      if (entry.claim_token !== claimToken) return;
      if (status === "pending" && entry.attempts >= TEST_MAX_ATTEMPTS) {
        entry.status = "unavailable";
        entry.operator_action = true;
        entry.last_error_code = "retry_exhausted";
      } else {
        entry.status = status;
        entry.operator_action = false;
        entry.last_error_code = errorCode;
      }
      entry.last_attempt_at = new Date(clockMs).toISOString();
      entry.claim_token = null;
      entry.lease_expires_at = null;
      if (status === "pending" && entry.status === "pending") {
        entry.next_attempt_at = new Date(clockMs + TEST_RETRY_BACKOFF_MS).toISOString();
      }
      refresh();
    },
  };
  refresh();
  return {
    run,
    entries,
    store: store as unknown as AttachmentRepairLedgerStore,
    advance(ms: number) {
      clockMs += ms;
    },
  };
}

function resultFor(entry: AttachmentRepairLedgerEntry, status: AttachmentRepairResult["items"][number]["status"]): AttachmentRepairResult {
  return {
    key: entry.object_key,
    apply: true,
    items: [{
      tenant_id: entry.tenant_id,
      message_id: entry.canary_message_ids[0],
      status,
      attachments: entry.attachment_count,
    }],
  };
}

function repairRunStoreWithInventoryRows(rows: Record<string, unknown>[]) {
  const tx: TypedQueryClient = {
    async query() { return { rows: [], rowCount: 0 }; },
    async many<T>(sql: string): Promise<T[]> {
      return sql.includes("FROM messages") ? rows as T[] : [];
    },
    async get<T>(sql: string): Promise<T | null> {
      if (!sql.includes("INSERT INTO attachment_repair_runs")) return null;
      return {
        id: "run-1",
        tenant_id: TENANT_A,
        apply: false,
        status: "pending",
        entry_total: 1,
        inventory_total: Number(rows[0]?.["attachment_count"] ?? 0),
        repaired: 0,
        would_repair: 0,
        unavailable: 0,
        pending: Number(rows[0]?.["attachment_count"] ?? 0),
        retrying: 0,
        entry_repaired: 0,
        entry_would_repair: 0,
        entry_unavailable: 0,
        entry_pending: 1,
        entry_retrying: 0,
        attempts: 0,
        checkpoint: 0,
        created_at: "2026-07-24T00:00:00.000Z",
        updated_at: "2026-07-24T00:00:00.000Z",
        completed_at: null,
      } as T;
    },
    async one<T>() {
      return { active_runs: 0, ledger_runs: 0, ledger_entries: 0 } as T;
    },
    async execute() {},
  };
  const root = new EmailsSelfHostedStore({
    ...tx,
    transaction: async <T>(fn: (client: TypedQueryClient) => Promise<T>) => fn(tx),
  } as never);
  return root.forTenant(TENANT_A);
}

describe("checkpointed attachment repair ledger", () => {
  it("binds request hashes to canonical payload-stripped per-canary attachment JSON", () => {
    const entries = [{
      object_key: "source/one",
      recipients: ["one@example.test"],
      canary_message_ids: ["message-1"],
    }];
    const base = [{
      tenant_id: TENANT_A,
      message_id: "message-1",
      object_key: "source/one",
      attachments: [{
        filename: "one.txt",
        content_type: "text/plain",
        size: 3,
        sha256: "a".repeat(64),
        review_metadata: { beta: 2, alpha: 1 },
        content_base64: "b25l",
      }],
    }];
    const reorderedKeys = [{
      object_key: "source/one",
      message_id: "message-1",
      tenant_id: TENANT_A,
      attachments: [{
        content_base64: "DIFFERENT-BYTES",
        review_metadata: { alpha: 1, beta: 2 },
        sha256: "a".repeat(64),
        size: 3,
        content_type: "text/plain",
        filename: "one.txt",
      }],
    }];
    const hash = attachmentRepairRequestHash("canonical-ingest", entries, false, base);
    expect(attachmentRepairRequestHash(
      "canonical-ingest",
      entries,
      false,
      reorderedKeys,
    )).toBe(hash);
    expect(attachmentRepairRequestHash(
      "canonical-ingest",
      entries,
      false,
      [{
        ...base[0]!,
        attachments: [{ ...base[0]!.attachments[0]!, sha256: "b".repeat(64) }],
      }],
    )).not.toBe(hash);
    expect(attachmentRepairRequestHash(
      "canonical-ingest",
      entries,
      false,
      [{
        ...base[0]!,
        attachments: [{
          ...base[0]!.attachments[0]!,
          review_metadata: { alpha: 1, beta: 3 },
        }],
      }],
    )).not.toBe(hash);
    expect(attachmentRepairRequestHash(
      "canonical-ingest",
      entries,
      false,
      [{
        ...base[0]!,
        attachments: [
          { ...base[0]!.attachments[0]!, filename: "second.txt" },
          base[0]!.attachments[0]!,
        ],
      }],
    )).not.toBe(hash);
  });

  it("defines a tenant-scoped, reconciled, bounded repair ledger migration", () => {
    const migration = emailsSelfHostedMigrations().find(
      (candidate) => candidate.id === "0020_attachment_repair_ledger",
    );
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("attachment_repair_runs");
    expect(migration!.sql).toContain("attachment_repair_entries");
    expect(migration!.sql).toContain("repaired + would_repair + unavailable + pending = inventory_total");
    expect(migration!.sql).toContain("entry_repaired + entry_would_repair + entry_unavailable + entry_pending = entry_total");
    expect(migration!.sql).toContain("last_error_code");
    expect(migration!.sql).toContain("last_attempt_at");
    expect(migration!.sql).toContain("UNIQUE (tenant_id, request_hash)");
    expect(migration!.sql).toContain("UNIQUE (tenant_id, id, request_hash)");
    expect(migration!.sql).toContain("byte_budget");
    expect(migration!.sql).toContain("bytes_consumed");
    expect(migration!.sql).toContain("time_budget_ms");
    expect(migration!.sql).toContain("deadline_at");
    expect(migration!.sql).toContain("reserved_bytes");
    expect(migration!.sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration!.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration!.sql).toContain("app.current_tenant");
    expect(migration!.sql).toContain("FOREIGN KEY (tenant_id, run_id, request_hash)");
    expect(migration!.sql).toContain("REFERENCES attachment_repair_runs (tenant_id, id, request_hash)");
    expect(migration!.sql).not.toContain("content_base64");
  });

  it("keeps page and manifest bounds explicit", () => {
    expect(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS).toBeGreaterThan(0);
    expect(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS).toBeLessThanOrEqual(25);
    expect(MAX_ATTACHMENT_REPAIR_MANIFEST_ITEMS).toBeGreaterThanOrEqual(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS);
    expect(MAX_ATTACHMENT_REPAIR_MANIFEST_ITEMS).toBeLessThanOrEqual(200);
  });

  it("rejects inline payload fields and malformed canary arrays at the manifest boundary", () => {
    expect(() => normalizeAttachmentRepairManifestEntries([{
      object_key: "source/one",
      recipients: ["one@example.test"],
      canary_message_ids: ["message-1"],
      content_base64: "aGVsbG8=",
    } as never])).toThrow(/unsupported.*content_base64/i);
    expect(() => normalizeAttachmentRepairManifestEntries([{
      object_key: "source/one",
      recipients: ["one@example.test"],
      canary_message_ids: ["message-1", 42],
    } as never])).toThrow(/canary_message_ids/i);
  });

  it("is dry-run by default, checkpoints a bounded page, and reconciles totals without payloads", async () => {
    const f = ledgerFixture();
    const seen: Array<{ key: string; apply: boolean }> = [];
    const summary = await processAttachmentRepairPage({
      store: f.store,
      repair: async (entry, apply) => {
        seen.push({ key: entry.object_key, apply });
        return {
          ...resultFor(entry, "would_repair"),
          apply,
        };
      },
    }, {
      runId: f.run.id,
      limit: 2,
    });

    expect(seen).toEqual([
      { key: "source/one", apply: false },
      { key: "source/two", apply: false },
    ]);
    expect(summary).toMatchObject({
      status: "pending",
      inventory_total: 6,
      repaired: 0,
      would_repair: 3,
      unavailable: 0,
      pending: 3,
      checkpoint: 2,
    });
    expect(f.entries.map((entry) => entry.status)).toEqual(["would_repair", "would_repair", "pending"]);
    expect(summary.repaired + summary.would_repair + summary.unavailable + summary.pending)
      .toBe(summary.inventory_total);
    expect(JSON.stringify(summary)).not.toContain("source/");
    expect(JSON.stringify(summary)).not.toContain("content_base64");
  });

  it("checkpoints the exact source-byte charge returned by a bounded repair attempt", async () => {
    const f = ledgerFixture({ apply: true, count: 1 });
    f.entries[0]!.source_byte_limit = 8;
    const recorded: number[] = [];
    const originalRecord = f.store.recordAttachmentRepairEntryOutcome.bind(f.store);
    f.store.recordAttachmentRepairEntryOutcome = async (
      runId,
      position,
      claimToken,
      status,
      errorCode,
      sourceBytes,
    ) => {
      recorded.push(sourceBytes);
      await originalRecord(runId, position, claimToken, status, errorCode, sourceBytes);
    };

    await processAttachmentRepairPage({
      store: f.store,
      repair: async (entry) => ({
        ...resultFor(entry, "repaired"),
        source_bytes: 5,
      }),
    }, {
      runId: f.run.id,
      limit: 1,
    });

    expect(recorded).toEqual([5]);
  });

  it("reports completed dry-run outcomes separately from unfinished attachment inventory", async () => {
    const f = ledgerFixture();
    const summary = await processAttachmentRepairPage({
      store: f.store,
      repair: async (entry, apply) => ({
        ...resultFor(entry, "would_repair"),
        apply,
      }),
    }, {
      runId: f.run.id,
      limit: 3,
    });

    expect(summary).toMatchObject({
      status: "completed",
      inventory_total: 6,
      repaired: 0,
      would_repair: 6,
      unavailable: 0,
      pending: 0,
      entry_total: 3,
      entry_repaired: 0,
      entry_would_repair: 3,
      entry_unavailable: 0,
      entry_pending: 0,
    });
  });

  it("keeps transient source failures pending and safely retries the exact entry", async () => {
    const f = ledgerFixture({ apply: true, count: 1 });
    let attempts = 0;
    const repair = async (entry: AttachmentRepairLedgerEntry) => {
      attempts++;
      return resultFor(entry, attempts === 1 ? "error" : "repaired");
    };

    const failed = await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: 1 },
    );
    expect(f.entries[0]?.status).toBe("pending");
    expect(failed).toMatchObject({
      status: "pending",
      repaired: 0,
      unavailable: 0,
      pending: 2,
      entry_retrying: 1,
    });

    f.advance(TEST_RETRY_BACKOFF_MS);
    const retried = await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: 1 },
    );
    expect(attempts).toBe(2);
    expect(f.entries[0]?.status).toBe("repaired");
    expect(retried).toMatchObject({
      status: "completed",
      repaired: 2,
      unavailable: 0,
      pending: 0,
      entry_retrying: 0,
    });
  });

  it("backs off early transient failures so a manifest larger than one page remains fair", async () => {
    const f = ledgerFixture({ apply: true, count: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS + 5 });
    const seen: number[] = [];
    const repair = async (entry: AttachmentRepairLedgerEntry) => {
      seen.push(entry.position);
      return resultFor(
        entry,
        entry.position < MAX_ATTACHMENT_REPAIR_PAGE_ITEMS ? "error" : "repaired",
      );
    };

    await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS },
    );
    await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS },
    );

    expect(seen.slice(0, MAX_ATTACHMENT_REPAIR_PAGE_ITEMS)).toEqual(
      Array.from({ length: MAX_ATTACHMENT_REPAIR_PAGE_ITEMS }, (_, index) => index),
    );
    expect(seen.slice(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS)).toEqual(
      Array.from({ length: 5 }, (_, index) => MAX_ATTACHMENT_REPAIR_PAGE_ITEMS + index),
    );
    expect(f.entries.slice(0, MAX_ATTACHMENT_REPAIR_PAGE_ITEMS)
      .every((entry) => entry.attempts === 1 && entry.status === "pending")).toBe(true);
    expect(f.entries.slice(MAX_ATTACHMENT_REPAIR_PAGE_ITEMS)
      .every((entry) => entry.status === "repaired")).toBe(true);
  });

  it("moves retry exhaustion to an aggregate operator-action terminal status", async () => {
    const f = ledgerFixture({ apply: true, count: 1 });
    const repair = async (entry: AttachmentRepairLedgerEntry) => resultFor(entry, "error");

    for (let attempt = 0; attempt < TEST_MAX_ATTEMPTS; attempt++) {
      await processAttachmentRepairPage(
        { store: f.store, repair },
        { runId: f.run.id, limit: 1 },
      );
      f.advance(TEST_RETRY_BACKOFF_MS);
    }

    expect(f.entries[0]?.status).toBe("unavailable");
    expect(f.entries[0]).toMatchObject({
      operator_action: true,
      attempts: TEST_MAX_ATTEMPTS,
      last_error_code: "retry_exhausted",
    });
    expect(f.run).toMatchObject({
      status: "completed",
      operator_action: 2,
      entry_operator_action: 1,
      pending: 0,
      entry_pending: 0,
    });
  });

  it("resumes after interruption, replays the unfinished CAS idempotently, and reaches terminal reconciliation", async () => {
    const f = ledgerFixture({ apply: true });
    const attempts = new Map<number, number>();
    const repair = async (entry: AttachmentRepairLedgerEntry) => {
      const attempt = (attempts.get(entry.position) ?? 0) + 1;
      attempts.set(entry.position, attempt);
      if (entry.position === 1 && attempt === 1) {
        throw new Error("simulated interruption after the previous item checkpoint");
      }
      if (entry.position === 2) return resultFor(entry, "metadata_mismatch");
      return resultFor(entry, attempt > 1 ? "already_complete" : "repaired");
    };

    const interrupted = await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: 2 },
    );
    expect(interrupted).toMatchObject({
      status: "pending",
      repaired: 2,
      pending: 4,
      entry_retrying: 1,
    });
    expect(f.entries.map((entry) => entry.status)).toEqual(["repaired", "pending", "pending"]);
    expect(f.run.checkpoint).toBe(1);

    f.advance(TEST_RETRY_BACKOFF_MS);
    const resumed = await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: 2 },
    );
    expect(attempts.get(0)).toBe(1);
    expect(attempts.get(1)).toBe(2);
    expect(attempts.get(2)).toBe(1);
    expect(f.entries.map((entry) => entry.status)).toEqual(["repaired", "repaired", "unavailable"]);
    expect(resumed).toMatchObject({
      status: "completed",
      inventory_total: 6,
      repaired: 3,
      unavailable: 3,
      pending: 0,
      checkpoint: 3,
    });
    expect(resumed.repaired + resumed.would_repair + resumed.unavailable + resumed.pending)
      .toBe(resumed.inventory_total);

    const idempotent = await processAttachmentRepairPage(
      { store: f.store, repair },
      { runId: f.run.id, limit: 2 },
    );
    expect(idempotent).toEqual(resumed);
    expect(attempts).toEqual(new Map([[0, 1], [1, 2], [2, 1]]));
  });

  it("does not accept a foreign-tenant repair result as success", async () => {
    const f = ledgerFixture({ apply: true });
    const summary = await processAttachmentRepairPage({
      store: f.store,
      repair: async (entry) => ({
        ...resultFor(entry, "repaired"),
        items: [{
          tenant_id: TENANT_B,
          message_id: "foreign-message",
          status: "repaired",
          attachments: entry.attachment_count,
        }],
      }),
    }, {
      runId: f.run.id,
      limit: 1,
    });

    expect(f.entries[0]?.status).toBe("unavailable");
    expect(summary).toMatchObject({ repaired: 0, unavailable: 2, pending: 4 });
    expect(JSON.stringify(summary)).not.toContain(TENANT_B);
    expect(JSON.stringify(summary)).not.toContain("foreign-message");
  });
});

describe("attachment repair ledger store boundary", () => {
  it("rejects missing, zero-attachment, complete-only, and wrong-object canaries before run creation", async () => {
    const repairable = [{
      filename: "legacy.txt",
      content_type: "text/plain",
      size: 3,
    }];
    const complete = [{
      ...repairable[0],
      content_base64: Buffer.from("old").toString("base64"),
    }];
    const cases = [
      {
        name: "missing",
        rows: [],
        pattern: /canar.*exact|exact.*canar/i,
      },
      {
        name: "zero attachment",
        rows: [{
          id: "message-1",
          object_key: "source/one",
          attachments: [],
          attachment_count: 0,
          metadata_valid: false,
          repairable: false,
        }],
        pattern: /repairable attachment inventory/i,
      },
      {
        name: "complete only",
        rows: [{
          id: "message-1",
          object_key: "source/one",
          attachments: complete,
          attachment_count: 1,
          metadata_valid: true,
          repairable: false,
        }],
        pattern: /repairable attachment inventory/i,
      },
      {
        name: "wrong object",
        rows: [{
          id: "message-1",
          object_key: "source/other",
          attachments: repairable,
          attachment_count: 1,
          metadata_valid: true,
          repairable: true,
        }],
        pattern: /exact.*object|canary.*object/i,
      },
    ];

    for (const scenario of cases) {
      await expect(repairRunStoreWithInventoryRows(scenario.rows)
        .createOrGetAttachmentRepairRun({
          idempotencyKey: `repair-${scenario.name}`,
          canonicalBucket: "canonical-ingest",
          entries: [{
            object_key: "source/one",
            recipients: ["one@example.test"],
            canary_message_ids: ["message-1"],
          }],
        })).rejects.toThrow(scenario.pattern);
    }
  });

  it("projects availability without reading payload bytes and keeps unknown legacy sizes null", async () => {
    const calls: string[] = [];
    const client: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async get() { return null; },
      async one() { throw new Error("not used"); },
      async execute() {},
      async many<T>(sql: string): Promise<T[]> {
        calls.push(sql);
        return [
          {
            message_id: "message-1",
            attachment_index: 0,
            filename: "legacy.pdf",
            content_type: "application/pdf",
            size_raw: "12 KB",
            sha256: null,
            content_available: false,
            direction: "inbound",
            received_at: "2026-07-24T00:00:00.000Z",
            cursor_ts: "2026-07-24T00:00:00.000000Z",
          },
          {
            message_id: "message-1",
            attachment_index: 1,
            filename: "stored.txt",
            content_type: "text/plain",
            size_raw: "5",
            sha256: "a".repeat(64),
            content_available: true,
            direction: "inbound",
            received_at: "2026-07-24T00:00:00.000Z",
            cursor_ts: "2026-07-24T00:00:00.000000Z",
          },
        ] as T[];
      },
    };
    const page = await new EmailsSelfHostedStore(client).forTenant(TENANT_A)
      .listAttachments({ limit: 10 });

    expect(page.items).toEqual([
      expect.objectContaining({
        attachment_index: 0,
        size_bytes: null,
        content_available: false,
      }),
      expect.objectContaining({
        attachment_index: 1,
        size_bytes: 5,
        content_available: true,
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain("content_base64");
    expect(calls[0]).toContain("jsonb_typeof(att.value -> 'content_base64') = 'string'");
    expect(calls[0]).not.toContain("AS content_base64");
  });

  it("returns unavailable metadata with a null size for legacy human-readable values", async () => {
    const client: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async many() { return []; },
      async one() { throw new Error("not used"); },
      async execute() {},
      async get<T>() {
        return {
          attachment: {
            filename: "legacy.pdf",
            content_type: "application/pdf",
            size: "12 KB",
          },
        } as T;
      },
    };
    const result = await new EmailsSelfHostedStore(client).forTenant(TENANT_A)
      .getMessageAttachment("message-1", 0);
    expect(result).toEqual({
      state: "content_unavailable",
      attachment: {
        filename: "legacy.pdf",
        content_type: "application/pdf",
        size: null,
      },
    });
  });

  it("creates runs idempotently under a tenant lock and never stores raw payload bytes", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const idempotencyAliases = new Map<string, { request_hash: string; run_id: string }>();
    const runById = new Map<string, Record<string, unknown>>();
    const runByTenantDigest = new Map<string, string>();
    const runByTenantRequestHash = new Map<string, string>();
    const digestKey = (tenantId: unknown, idempotencyDigest: unknown) =>
      `${String(tenantId)}::${String(idempotencyDigest)}`;
    const requestHashKey = (tenantId: unknown, requestHash: unknown) =>
      `${String(tenantId)}::${String(requestHash)}`;
    const tx: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async many<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        calls.push({ sql, params });
        if (sql.includes("FROM messages") && sql.includes("ANY")) {
          return [
            {
              id: "message-1",
              object_key: "source/one",
              attachment_count: 2,
              metadata_valid: true,
              repairable: true,
            },
            {
              id: "message-2",
              object_key: "source/two",
              attachment_count: 1,
              metadata_valid: true,
              repairable: true,
            },
          ] as T[];
        }
        return [];
      },
      async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO attachment_repair_idempotency_keys")) {
          const tenantId = String(params[0]);
          const keyDigest = String(params[1]);
          const requestHash = String(params[2]);
          const runId = String(params[3]);
          const key = digestKey(tenantId, keyDigest);
          const existing = idempotencyAliases.get(key);
          if (!existing || (existing.request_hash === requestHash && existing.run_id === runId)) {
            const row = { request_hash: requestHash, run_id: runId };
            idempotencyAliases.set(key, row);
            return row as T;
          }
          return null;
        }
        if (sql.includes("FROM attachment_repair_idempotency_keys")) {
          const key = digestKey(params[0], params[1]);
          return idempotencyAliases.get(key) as T ?? null;
        }
        if (sql.includes("INSERT INTO attachment_repair_runs")) {
          const tenantId = String(params[0]);
          const storedRunId = "run-1";
          const runId = String(params[1]);
          const idempotencyDigest = String(params[2]);
          const requestHash = String(params[3]);
          const runDigest = digestKey(tenantId, idempotencyDigest);
          if (runByTenantDigest.has(runDigest)) {
            return null;
          }
          const row = {
            id: storedRunId,
            tenant_id: tenantId,
            idempotency_key_hash: idempotencyDigest,
            request_hash: requestHash,
            apply: params[4] === true,
            status: "pending",
            entry_total: Number(params[5]),
            inventory_total: Number(params[6]),
            repaired: 0,
            would_repair: 0,
            unavailable: 0,
            pending: Number(params[6]),
            retrying: 0,
            entry_repaired: 0,
            entry_would_repair: 0,
            entry_unavailable: 0,
            entry_pending: Number(params[5]),
            entry_retrying: 0,
            attempts: 0,
            checkpoint: 0,
            byte_budget: Number(params[7]),
            bytes_consumed: 0,
            time_budget_ms: Number(params[8]),
            deadline_at: "2026-07-24T00:01:00.000Z",
            created_at: "2026-07-24T00:00:00.000Z",
            updated_at: "2026-07-24T00:00:00.000Z",
            completed_at: null,
          } as Record<string, unknown>;
          runByTenantDigest.set(runDigest, storedRunId);
          runByTenantRequestHash.set(requestHashKey(tenantId, requestHash), storedRunId);
          runById.set(storedRunId, row);
          runById.set(runId, row);
          return row as T;
        }
        if (sql.includes("FROM attachment_repair_runs") && sql.includes("id = $2::uuid")) {
          return runById.get(String(params[1])) as T ?? null;
        }
        if (sql.includes("FROM attachment_repair_runs") && sql.includes("idempotency_key_hash = $2")) {
          return runById.get(runByTenantDigest.get(digestKey(params[0], params[1]) ?? "") ?? "") as T ?? null;
        }
        if (sql.includes("FROM attachment_repair_runs")
          && sql.includes("request_hash = $2")
          && !sql.includes("(idempotency_key_hash = $2 OR request_hash = $3)")) {
          return runById.get(runByTenantRequestHash.get(requestHashKey(params[0], params[1]) ?? "") ?? "") as T ?? null;
        }
        if (sql.includes("FROM attachment_repair_runs")
          && sql.includes("(idempotency_key_hash = $2 OR request_hash = $3)")) {
          const tenantId = String(params[0]);
          const replayByDigest = runByTenantDigest.get(digestKey(tenantId, params[1]));
          const replayByRequest = runByTenantRequestHash.get(requestHashKey(tenantId, params[2]));
          return runById.get(replayByDigest ?? replayByRequest ?? "") as T ?? null;
        }
        return null;
      },
      async one<T>() {
        return { active_runs: 0, ledger_runs: 0, ledger_entries: 0 } as T;
      },
      async execute(sql: string, params: readonly unknown[] = []) { calls.push({ sql, params }); },
    };
    const root = new EmailsSelfHostedStore({
      ...tx,
      transaction: async <T>(fn: (client: TypedQueryClient) => Promise<T>) => fn(tx),
    } as never);
    const run = await root.forTenant(TENANT_A).createOrGetAttachmentRepairRun({
      idempotencyKey: "repair-ledger-1",
      canonicalBucket: "canonical-ingest",
      entries: [
        {
          object_key: "source/one",
          recipients: ["one@example.test"],
          canary_message_ids: ["message-1"],
        },
        {
          object_key: "source/two",
          recipients: ["two@example.test"],
          canary_message_ids: ["message-2"],
        },
      ],
    });

    expect(run).toMatchObject({ id: "run-1", apply: false, inventory_total: 3, pending: 3 });
    const lock = calls.find((call) => call.sql.includes("pg_advisory_xact_lock"));
    expect(lock).toBeDefined();
    expect(JSON.stringify(calls.map((call) => call.params))).not.toContain("content_base64");
    const inventoryRead = calls.find((call) => call.sql.includes("FROM messages m"));
    expect(inventoryRead?.sql).not.toContain("->> 'content_base64'");
    const runInsert = calls.find((call) => call.sql.includes("INSERT INTO attachment_repair_runs"));
    expect(runInsert?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(runInsert?.sql).not.toContain("idempotency_key,");
  });
});
