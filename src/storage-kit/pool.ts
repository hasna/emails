// Product-owned Emails Postgres storage utilities.
// Forked from storage-kit 0.4.2 and maintained in this repository.

// Postgres pool factory for the Emails Postgres storage utilities.
//
// The single sanctioned way to open a self_hosted Postgres connection. TLS is
// resolved through `tls.ts` (one correct approach). Mode and database-URL
// resolution belong to the callers' resolvers (src/lib/mode.ts and
// src/server/self-hosted/env.ts). PURE REMOTE (Amendment A1): a Pool is only
// ever built for `self_hosted` mode; there is no local/hybrid Postgres path.

import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import {
  connectionStringWithoutTlsParameters,
  resolveTlsConfig,
  sslNegotiationFromConnectionString,
  type TlsResolveOptions,
} from "./tls.js";

export interface CreatePgPoolOptions extends TlsResolveOptions {
  connectionString: string;
  /** Max clients in the pool. Defaults to pg's default (10). */
  max?: number;
  /** Idle client timeout (ms). */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout (ms). */
  connectionTimeoutMillis?: number;
  /** Application name reported to Postgres (shows in pg_stat_activity). */
  applicationName?: string;
}

/** Build a `pg.Pool` with consistent TLS handling. */
export function createPgPool(options: CreatePgPoolOptions): Pool {
  const ssl = resolveTlsConfig(options.connectionString, {
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ...(options.caCertPath !== undefined ? { caCertPath: options.caCertPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const connectionString = connectionStringWithoutTlsParameters(options.connectionString);
  const sslnegotiation = sslNegotiationFromConnectionString(options.connectionString);

  const config: PoolConfig & { sslnegotiation?: "postgres" | "direct" } = { connectionString };
  if (ssl !== undefined) config.ssl = ssl;
  if (sslnegotiation !== undefined) config.sslnegotiation = sslnegotiation;
  if (options.max !== undefined) config.max = options.max;
  if (options.idleTimeoutMillis !== undefined) config.idleTimeoutMillis = options.idleTimeoutMillis;
  if (options.connectionTimeoutMillis !== undefined) config.connectionTimeoutMillis = options.connectionTimeoutMillis;
  if (options.applicationName !== undefined) config.application_name = options.applicationName;

  return new pg.Pool(config);
}
