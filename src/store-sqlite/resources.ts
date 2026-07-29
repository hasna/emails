// The uniform row-per-thing families, served by ONE schema-driven path.
//
// The strongest arm serves ten-plus families through a single generic CRUD path
// whose per-resource columns come from a spec table. This is the same idea with
// the same single chokepoint, except the column list is not hand-copied: it is
// read out of SQLite with `PRAGMA table_info`, which IS the source of truth for
// what a table holds. Copying the server's spec would have created a second
// source of truth for a different physical schema — the server's `groups` live in
// `contact_groups` and its providers in `self_hosted_providers` — and a hand
// written list here would go stale silently the first time a migration adds a
// column.
//
// The only per-family knowledge in this file is a table NAME. Ordering, the
// primary key, which columns are writable and which timestamps to stamp are all
// derived from the schema.
//
// SAFETY. Table names come from the frozen map below (never from a caller) and
// column names come from `PRAGMA table_info` (never from a caller). A caller's
// keys are VALIDATED AGAINST that list and refused when unknown — they are never
// interpolated. Every value is a bound parameter.

import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "../db/database.js";
import { cappedLimit, safeOffset } from "../db/pagination.js";
import { now, uuid } from "../db/runtime.js";
import type { Outcome } from "../store/outcome.js";
import type { ListOptions, ResourceInput, ResourceRow } from "../store/records.js";
import type { ResourceRepository } from "../store/repositories.js";
import { guard, invalidInput, ok } from "./outcome.js";
import { withImmediateTransaction } from "./transaction.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/**
 * Every uniform family on `EmailStore`, mapped to the SQLite table that holds it.
 *
 * This is the one thing that cannot be derived: the seam names families in the
 * vocabulary of the product (`scheduled`, `forwarding`, `warming`) and SQLite
 * names tables in the vocabulary of its own history (`scheduled_emails`,
 * `forwarding_rules`, `warming_schedules`). Frozen so it cannot be mutated into
 * pointing a family at another family's rows.
 */
export const RESOURCE_TABLES = Object.freeze({
  contacts: "contacts",
  groups: "groups",
  // The group MEMBERSHIP ledger (src/store-group-membership.ts). Not a seam family yet —
  // `EmailStore` declares only `groups` — but the same schema-driven path serves it. Its
  // composite natural key (group_id, email) means this path addresses its rows by
  // `rowid`, exactly as it does for `webhook_receipts`.
  groupMembers: "group_members",
  owners: "owners",
  // The address-ownership audit LEDGER (src/store-address-ownership-ledger.ts). Not a
  // seam family yet — `EmailStore` declares only `owners` — but the same schema-driven
  // path serves it, exactly as it serves `group_members` for the membership ledger.
  // Its TEXT primary key is CLIENT-minted (the ledger writer stamps a monotonic
  // `created_at` beside it), which this path already honours: an explicit `id` on a
  // create is written, not replaced.
  addressOwnershipEvents: "address_ownership_events",
  providers: "providers",
  templates: "templates",
  sequences: "sequences",
  // The sequence SUB-LEDGER (src/store-sequence-subledger.ts). Not seam families yet —
  // `EmailStore` declares only `sequences` — but the same schema-driven path serves them,
  // exactly as it serves `provisioning_events` for the provisioning repository.
  sequenceSteps: "sequence_steps",
  sequenceEnrollments: "sequence_enrollments",
  scheduled: "scheduled_emails",
  aliases: "aliases",
  forwarding: "forwarding_rules",
  warming: "warming_schedules",
  events: "events",
  emailDigests: "email_digests",
  webhookReceipts: "webhook_receipts",
  sandbox: "sandbox_emails",
});

export type ResourceFamily = keyof typeof RESOURCE_TABLES;

/**
 * Columns a generic resource read must NEVER project, per table.
 *
 * The `providers` table carries live sending credentials. A generic `SELECT *` path
 * would hand them to every caller of `providers.list()`, and this seam is published
 * on a library subpath — so the same care that keeps `key_hash` off `SendKeyRecord`
 * applies here. The strongest arm makes the same choice for the same reason (its
 * resource registry calls it `redactColumns`), and its resources are summary-only.
 *
 * Redaction is enforced in BOTH directions: these columns are not read, and a write
 * that names one is refused rather than accepted. Credentials belong to the code that
 * owns them (src/db/provider-credentials.ts), not to a generic CRUD path.
 */
const REDACTED_COLUMNS: Record<string, readonly string[]> = Object.freeze({
  providers: Object.freeze([
    "api_key",
    "access_key",
    "secret_key",
    "oauth_client_secret",
    "oauth_refresh_token",
    "oauth_access_token",
  ]),
});

function redactedFor(table: string): readonly string[] {
  return REDACTED_COLUMNS[table] ?? [];
}

interface ColumnInfo {
  name: string;
  primaryKeyPosition: number;
}

interface TableShape {
  /** Every column the table physically has. */
  columns: string[];
  /**
   * The column rows are addressed by.
   *
   * A table with exactly one primary-key column uses it. `webhook_receipts` has a
   * COMPOSITE key `(provider, event_id)` and therefore no single-column identity,
   * so it is addressed by SQLite's own `rowid` — the honest answer rather than
   * picking one half of the key and pretending it identifies a row.
   */
  idColumn: string;
  /** Whether `idColumn` is the implicit rowid rather than a real column. */
  idIsRowid: boolean;
  /** Whether an absent id should be minted (a TEXT primary key named `id`). */
  mintsId: boolean;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  orderBy: string;
}

function describeTable(db: Database, table: string): TableShape {
  const info = db.query(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  const columns: ColumnInfo[] = info.map((row) => ({
    name: String(row["name"]),
    primaryKeyPosition: Number(row["pk"] ?? 0),
  }));
  if (columns.length === 0) throw new Error(`table ${table} has no columns; the schema is not migrated`);
  const names = columns.map((column) => column.name);
  const keyColumns = columns.filter((column) => column.primaryKeyPosition > 0);
  const single = keyColumns.length === 1 ? (keyColumns[0] as ColumnInfo).name : null;
  const idColumn = single ?? "rowid";
  const hasCreatedAt = names.includes("created_at");
  const hasUpdatedAt = names.includes("updated_at");
  // Newest first when the table records time, and always with the identity as the
  // tiebreaker so a page boundary cannot repeat or drop a row.
  const timeOrder = hasUpdatedAt ? "updated_at DESC" : hasCreatedAt ? "created_at DESC" : null;
  return {
    columns: names,
    idColumn,
    idIsRowid: single === null,
    mintsId: single === "id",
    hasCreatedAt,
    hasUpdatedAt,
    orderBy: timeOrder ? `${timeOrder}, ${idColumn} DESC` : `${idColumn} ASC`,
  };
}

/** SQLite has no boolean, object or array storage class; everything lands as one of four. */
function bindable(value: unknown): SQLQueryBindings {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Reject unknown keys instead of dropping them; a dropped field is a silent lie. */
function writableColumns(
  shape: TableShape,
  table: string,
  input: ResourceInput,
): { columns: string[] } | { refusal: string } {
  // `rowid` is projected on a composite-key table so the caller can address the row,
  // but it is SQLite's own identity and not a column of the table. Accepting it back
  // in a read-modify-write is what makes that round trip possible at all; rejecting
  // it made `update(id, rowFromCreate)` impossible for those families.
  const keys = Object.keys(input).filter((key) => !(shape.idIsRowid && key === "rowid"));
  const unknown = keys.filter((key) => !shape.columns.includes(key));
  if (unknown.length > 0) {
    return { refusal: `unknown column(s) for this resource: ${unknown.sort().join(", ")}` };
  }
  const secret = keys.filter((key) => redactedFor(table).includes(key));
  if (secret.length > 0) {
    return {
      refusal:
        `credential column(s) may not be written through the generic resource path: ${secret.sort().join(", ")}`,
    };
  }
  return { columns: keys.filter((key) => input[key] !== undefined) };
}

function projection(shape: TableShape, table: string): string {
  // An explicit column list, not `*`: a redacted column must not reach a caller, and
  // a future migration that adds a credential column must not silently publish it.
  const redacted = redactedFor(table);
  const visible = shape.columns.filter((column) => !redacted.includes(column));
  const columns = visible.map((column) => `${table}.${column}`).join(", ");
  return shape.idIsRowid ? `${table}.rowid AS rowid, ${columns}` : columns;
}

function readRow(db: Database, table: string, shape: TableShape, id: SQLQueryBindings): ResourceRow | null {
  return db
    .query(`SELECT ${projection(shape, table)} FROM ${table} WHERE ${shape.idColumn} = ?`)
    .get(id) as ResourceRow | null;
}

/**
 * One family. The `table` argument is a value from `RESOURCE_TABLES` (or another
 * table this package owns, such as `provisioning_events`) — never caller input.
 */
export function createResourceRepository(db: Database, table: string): ResourceRepository<ResourceRow> {
  let cached: TableShape | null = null;
  const shapeOf = (): TableShape => {
    if (!cached) cached = describeTable(db, table);
    return cached;
  };

  return {
    async list(opts?: ListOptions & { filters?: Record<string, string> }): Promise<Outcome<ResourceRow[]>> {
      return guard(() => {
        const shape = shapeOf();
        const filters = opts?.filters ?? {};
        const unknown = Object.keys(filters).filter((key) => !shape.columns.includes(key));
        if (unknown.length > 0) {
          return invalidInput(`unknown filter column(s) for this resource: ${unknown.sort().join(", ")}`);
        }
        const keys = Object.keys(filters);
        const where = keys.length > 0 ? `WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}` : "";
        const rows = db
          .query(
            `SELECT ${projection(shape, table)} FROM ${table} ${where}
              ORDER BY ${shape.orderBy} LIMIT ? OFFSET ?`,
          )
          .all(
            ...keys.map((key) => bindable(filters[key])),
            cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE),
            safeOffset(opts?.offset),
          ) as ResourceRow[];
        return ok(rows);
      });
    },

    async get(id: string): Promise<Outcome<ResourceRow | null>> {
      return guard(() => ok(readRow(db, table, shapeOf(), id)));
    },

    async create(input: ResourceInput): Promise<Outcome<ResourceRow>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          const shape = shapeOf();
          const writable = writableColumns(shape, table, input);
          if ("refusal" in writable) return invalidInput(writable.refusal);
          const values = new Map<string, SQLQueryBindings>();
          for (const column of writable.columns) values.set(column, bindable(input[column]));
          const timestamp = now();
          if (shape.mintsId && !values.has("id")) values.set("id", uuid());
          if (shape.hasCreatedAt && !values.has("created_at")) values.set("created_at", timestamp);
          if (shape.hasUpdatedAt && !values.has("updated_at")) values.set("updated_at", timestamp);
          const columns = [...values.keys()];
          if (columns.length === 0) return invalidInput("a create needs at least one column");
          // A table whose single key is neither `id` (mintable) nor the rowid must be
          // given its key by the caller. Refusing beats inserting a row this repository
          // would then be unable to address.
          if (!shape.mintsId && !shape.idIsRowid && !values.has(shape.idColumn)) {
            return invalidInput(`this resource requires an explicit ${shape.idColumn}`);
          }
          const result = db.run(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            columns.map((column) => values.get(column) as SQLQueryBindings),
          );
          const id = shape.idIsRowid ? Number(result.lastInsertRowid) : (values.get(shape.idColumn) ?? null);
          const row = id === null ? null : readRow(db, table, shape, id);
          if (!row) throw new Error(`row disappeared from ${table} immediately after insert`);
          return ok(row);
        }),
      );
    },

    async update(id: string, patch: ResourceInput): Promise<Outcome<ResourceRow | null>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          const shape = shapeOf();
          if (!readRow(db, table, shape, id)) return ok(null);
          const writable = writableColumns(shape, table, patch);
          if ("refusal" in writable) return invalidInput(writable.refusal);
          const columns = writable.columns.filter((column) => column !== shape.idColumn);
          const sets = columns.map((column) => `${column} = ?`);
          const params = columns.map((column) => bindable(patch[column]));
          if (shape.hasUpdatedAt && !columns.includes("updated_at")) {
            sets.push("updated_at = ?");
            params.push(now());
          }
          if (sets.length === 0) return ok(readRow(db, table, shape, id));
          db.run(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${shape.idColumn} = ?`, [...params, id]);
          return ok(readRow(db, table, shape, id));
        }),
      );
    },

    async remove(id: string): Promise<Outcome<boolean>> {
      return guard(() => {
        const shape = shapeOf();
        return ok(db.run(`DELETE FROM ${table} WHERE ${shape.idColumn} = ?`, [id]).changes > 0);
      });
    },
  };
}
