// Scoped send keys.
//
// The token format and hashing are LIFTED FROM the local repository unchanged —
// `esk_` plus 24 random bytes in hex, SHA-256 at rest, a 12-character prefix for
// display — because keys already in this database have to keep verifying. The
// SHAPE is the seam's: `SendKeyRecord` never carries the hash, and the plaintext
// token is returned exactly once, at mint.
//
// `updated_at` is DERIVED. This table has no such column; the meaningful mtime is
// the LATEST of the three timestamps it does have — created, last used, revoked.
// `MAX()` over them is correct by construction rather than by an argument about
// which transition can follow which, which is what a precedence COALESCE would be.
// It is a projection of stored facts, not a fabricated timestamp.

import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import { cappedLimit, safeOffset } from "../db/pagination.js";
import { now, uuid } from "../db/runtime.js";
import type { Outcome } from "../store/outcome.js";
import type { ListOptions, MintedSendKey, SendKeyRecord } from "../store/records.js";
import type { SendKeysRepository } from "../store/repositories.js";
import { guard, invalidInput, ok, unavailable } from "./outcome.js";
import { withImmediateTransaction } from "./transaction.js";

const TOKEN_PREFIX = "esk_";
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** The non-secret projection. `key_hash` is not in it, and must never be. */
const SEND_KEY_COLUMNS = `
  id, owner_id, prefix, label, last_used_at, revoked_at, created_at,
  MAX(created_at, COALESCE(last_used_at, ''), COALESCE(revoked_at, '')) AS updated_at
`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type Row = Record<string, unknown>;

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapSendKey(row: Row): SendKeyRecord {
  return {
    id: String(row["id"] ?? ""),
    owner_id: textOrNull(row["owner_id"]),
    prefix: textOrNull(row["prefix"]),
    label: textOrNull(row["label"]),
    last_used_at: textOrNull(row["last_used_at"]),
    revoked_at: textOrNull(row["revoked_at"]),
    created_at: String(row["created_at"] ?? ""),
    updated_at: String(row["updated_at"] ?? ""),
  };
}

function selectKey(db: Database, id: string): SendKeyRecord | null {
  const row = db.query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE id = ?`).get(id) as Row | null;
  return row ? mapSendKey(row) : null;
}

export function createSendKeysRepository(db: Database): SendKeysRepository {
  return {
    async listSendKeys(opts?: ListOptions): Promise<Outcome<SendKeyRecord[]>> {
      return guard(() => {
        const rows = db
          .query(
            `SELECT ${SEND_KEY_COLUMNS} FROM send_keys ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          )
          .all(cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE), safeOffset(opts?.offset)) as Row[];
        return ok(rows.map(mapSendKey));
      });
    },

    async getSendKey(id: string): Promise<Outcome<SendKeyRecord | null>> {
      return guard(() => ok(selectKey(db, id)));
    },

    async mintSendKey(input: { owner_id: string; label?: string | null }): Promise<Outcome<MintedSendKey>> {
      const ownerId = input.owner_id?.trim();
      if (!ownerId) return invalidInput("a send key must be bound to an owner");
      return guard(() =>
        withImmediateTransaction(db, () => {
          const owner = db.query("SELECT id FROM owners WHERE id = ?").get(ownerId) as { id: string } | null;
          if (!owner) return invalidInput(`no owner matches ${ownerId}`);
          const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
          const id = uuid();
          db.run(
            "INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [id, ownerId, hashToken(token), token.slice(0, 12), input.label ?? null, now()],
          );
          const key = selectKey(db, id);
          if (!key) throw new Error(`send key ${id} disappeared immediately after insert`);
          // The ONLY time the plaintext token is readable. Never logged, never cached.
          return ok({ token, key });
        }),
      );
    },

    async verifySendKey(token: string): Promise<Outcome<SendKeyRecord | null>> {
      // null for an unknown, malformed or revoked token — the seam says so, and it
      // is the right shape here: "this token does not authorize anything" is a
      // complete answer, not a refusal to answer.
      if (!token || !token.startsWith(TOKEN_PREFIX)) return ok(null);
      return guard(() =>
        withImmediateTransaction(db, () => {
          const row = db
            .query(`SELECT ${SEND_KEY_COLUMNS} FROM send_keys WHERE key_hash = ?`)
            .get(hashToken(token)) as Row | null;
          if (!row) return ok(null);
          const key = mapSendKey(row);
          if (key.revoked_at) return ok(null);
          db.run("UPDATE send_keys SET last_used_at = ? WHERE id = ?", [now(), key.id]);
          return ok(selectKey(db, key.id));
        }),
      );
    },

    async revokeSendKey(id: string): Promise<Outcome<SendKeyRecord | null>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          if (!selectKey(db, id)) return ok(null);
          db.run("UPDATE send_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id]);
          return ok(selectKey(db, id));
        }),
      );
    },

    async isOwnerAuthorizedFrom(_ownerId: string, _fromEmail: string): Promise<Outcome<boolean>> {
      // Gated on `outboundPolicy`, which this store declares false — so the ONLY
      // legal answer is the refusal, and returning `false` here would be the
      // false-as-unknown the seam names explicitly.
      //
      // Worth being precise about WHY the capability is false rather than this
      // operation in particular: the ownership columns needed to answer this one
      // question do exist here (`addresses.owner_id` / `administrator_id`). What
      // does not exist is a policy MODEL — no definition of sender readiness, no
      // configuration of when a key is required, no suppression or warming
      // enforcement — so a partial evaluator would be a SECOND, divergent policy.
      // Two policies that disagree about whether mail may leave is strictly worse
      // than one store that says "ask something that knows".
      return unavailable("outboundPolicy");
    },
  };
}
