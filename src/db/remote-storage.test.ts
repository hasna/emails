import { describe, expect, it } from "bun:test";
import { PgAdapterAsync } from "./remote-storage.js";
import { REMOTE_RECONCILE_LOCK_KEY, reconcileRemoteDerivedState } from "./storage-sync.js";

interface RecordedQuery {
  text: string;
  values: unknown[];
}

type FakeResponse = { rows: unknown[]; rowCount: number };

class FakeClient {
  queries: RecordedQuery[] = [];
  releaseArgs: unknown[] = [];

  constructor(private readonly respond: (text: string, values: unknown[]) => FakeResponse) {}

  async query(text: string, values: unknown[]): Promise<FakeResponse> {
    this.queries.push({ text, values });
    return this.respond(text, values);
  }

  release(destroy?: unknown): void {
    if (this.releaseArgs.length > 0) throw new Error("release called twice");
    this.releaseArgs.push(destroy);
  }
}

function adapterWith(client: FakeClient): PgAdapterAsync {
  const adapter = new PgAdapterAsync("postgres://fake-host/fake-db");
  (adapter as unknown as { pool: { connect(): Promise<FakeClient>; end(): Promise<void> } }).pool = {
    connect: async () => client,
    end: async () => {},
  };
  return adapter;
}

describe("PgAdapterAsync.withSession", () => {
  it("pins one client for the session, translates placeholders, and returns it to the pool on success", async () => {
    const client = new FakeClient(() => ({ rows: [{ ok: 1 }], rowCount: 3 }));
    const adapter = adapterWith(client);

    const changes = await adapter.withSession(async (session) => {
      const runResult = await session.run("DELETE FROM t WHERE id = ? AND label = ?", "id-1", "spam");
      expect(await session.all("SELECT 1")).toEqual([{ ok: 1 }]);
      return runResult.changes;
    });

    expect(changes).toBe(3);
    expect(client.queries[0]).toEqual({ text: "DELETE FROM t WHERE id = $1 AND label = $2", values: ["id-1", "spam"] });
    expect(client.queries[1]).toEqual({ text: "SELECT 1", values: [] });
    // Returned to the pool healthy, not destroyed.
    expect(client.releaseArgs).toEqual([false]);
  });

  it("destroys the pooled connection when the session callback throws", async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const adapter = adapterWith(client);

    await expect(adapter.withSession(async () => {
      throw new Error("session body failed");
    })).rejects.toThrow("session body failed");

    // Destroyed so leaked session state (advisory locks, statement_timeout)
    // can never re-enter the pool.
    expect(client.releaseArgs).toEqual([true]);
  });

  it("runs the derived-state reconcile with translated, balanced placeholders end to end", async () => {
    let remainingStale = 7;
    const client = new FakeClient((text, values) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("DELETE FROM inbound_labels")) {
        const changes = Math.min(Number(values[0]), remainingStale);
        remainingStale -= changes;
        return { rows: [], rowCount: changes };
      }
      return { rows: [], rowCount: 0 };
    });
    const adapter = adapterWith(client);

    const result = await reconcileRemoteDerivedState(adapter, { labelDeleteBatchSize: 5 });

    expect(result).toEqual({ skipped: false, staleLabelBatches: 2, staleLabelsDeleted: 7, reachedBatchCap: false });
    const deletes = client.queries.filter((query) => query.text.includes("DELETE FROM inbound_labels"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((query) => query.text.includes("LIMIT $1"))).toBe(true);
    expect(deletes.map((query) => query.values)).toEqual([[5], [5]]);
    for (const query of client.queries) {
      // Placeholder balance: the highest $n must match the bound param count and
      // no untranslated `?` may remain — guards against a `?` inside a SQL
      // string literal being mangled by translatePlaceholders.
      const placeholders = query.text.match(/\$\d+/g) ?? [];
      const maxIndex = placeholders.reduce((max, placeholder) => Math.max(max, Number(placeholder.slice(1))), 0);
      expect(maxIndex).toBe(query.values.length);
      expect(query.text).not.toContain("?");
    }
    expect(client.queries[client.queries.length - 1]!.text).toContain(`pg_advisory_unlock(${REMOTE_RECONCILE_LOCK_KEY})`);
    expect(client.releaseArgs).toEqual([false]);
  });
});
