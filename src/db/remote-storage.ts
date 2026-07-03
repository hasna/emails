import pg from "pg";
import type { Pool } from "pg";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  return connectionString.includes("sslmode=require") || connectionString.includes("ssl=true")
    ? { rejectUnauthorized: false }
    : undefined;
}

export interface PgSession {
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  all(sql: string, ...params: unknown[]): Promise<unknown[]>;
}

export class PgAdapterAsync {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: sslConfigFor(connectionString) });
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return { changes: result.rowCount ?? 0 };
  }

  /**
   * Runs `fn` against a single pooled connection so session-scoped state
   * (advisory locks, statement_timeout) stays on one backend for the whole
   * callback. `pool.query` may route every statement to a different
   * connection, which silently breaks pg_advisory_lock/unlock pairing.
   *
   * If `fn` throws, the connection is destroyed instead of returned to the
   * pool so leftover session state can never leak into unrelated queries.
   */
  async withSession<T>(fn: (session: PgSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      return await fn({
        run: async (sql: string, ...params: unknown[]) => {
          const result = await client.query(translatePlaceholders(sql), normalizeParams(params));
          return { changes: result.rowCount ?? 0 };
        },
        all: async (sql: string, ...params: unknown[]) => {
          const result = await client.query(translatePlaceholders(sql), normalizeParams(params));
          return result.rows;
        },
      });
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
