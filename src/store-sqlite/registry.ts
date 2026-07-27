// The domain and address registry: domains, addresses, address lifecycle,
// provisioning.
//
// MAPPING NOTES, because these are the shapes where the two arms differ most and
// a silent guess would be worse than a documented choice. The record shapes come
// from the strongest arm; the columns come from SQLite; each seam field maps onto
// the SQLite column that means the SAME THING rather than the one with the same
// name:
//
//   DomainRecord.status   <-> domains.ownership_status  (pending | verified | failed,
//                             the same vocabulary the server's `status` defaults into)
//   DomainRecord.verified <-> domains.verified_at IS NOT NULL
//   DomainRecord.provider <-> domains.provider_id
//   AddressRecord.domain   -- DERIVED from the email, never stored or accepted,
//                             which is what the strongest arm does
//
// `ownership_status` carries a CHECK constraint, so a status outside
// pending/verified/failed is refused (`invalid_input`) rather than stored. That is a
// real difference from the server, which takes any string — and it is reported as a
// refusal instead of being silently coerced.
//
// PROVIDERS ARE A PRECONDITION HERE, NOT A PARAMETER. `domains.provider_id` and
// `addresses.provider_id` are NOT NULL foreign keys; the seam's inputs carry no
// provider because the strongest arm has no such column. So the store RESOLVES one
// (the named provider, else the active provider, else the oldest) and REFUSES when
// the database has none at all. A refusal is right and a fabricated provider row
// would not be: "there is nowhere to attach this domain yet" is a true, actionable
// answer that stops being true the moment a provider is registered.

import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "../db/database.js";
import { parseJsonArray } from "../db/json.js";
import { cappedLimit, safeOffset } from "../db/pagination.js";
import { now, uuid } from "../db/runtime.js";
import type { Outcome } from "../store/outcome.js";
import type {
  AddressInput,
  AddressOwnershipPatch,
  AddressPatch,
  AddressProvisioningPatch,
  AddressRecord,
  AddressSendability,
  DomainInput,
  DomainPatch,
  DomainProvisioningPatch,
  DomainRecord,
  ListOptions,
  ResourceInput,
  ResourceRow,
} from "../store/records.js";
import type {
  AddressLifecycleRepository,
  AddressesRepository,
  DomainsRepository,
  ProvisioningRepository,
} from "../store/repositories.js";
import { guard, invalidInput, ok, unavailable } from "./outcome.js";
import { createResourceRepository } from "./resources.js";
import { withImmediateTransaction } from "./transaction.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

const DOMAIN_COLUMNS = `
  d.id AS id, d.domain AS domain, d.ownership_status AS status, d.provider_id AS provider,
  CASE WHEN d.verified_at IS NOT NULL THEN 1 ELSE 0 END AS verified, d.notes AS notes,
  d.provisioning_status, d.purchase_provider, d.dns_provider, d.send_provider,
  d.cf_zone_id, d.registrar, d.nameservers_json, d.mail_from_domain, d.last_error,
  d.next_check_at, d.created_at, d.updated_at
`;

const ADDRESS_COLUMNS = `
  a.id AS id, a.email AS email,
  CASE WHEN instr(a.email, '@') > 0 THEN lower(substr(a.email, instr(a.email, '@') + 1)) ELSE NULL END AS domain,
  a.display_name, COALESCE(a.status, 'active') AS status, a.verified, a.daily_quota,
  a.owner_id, a.administrator_id, a.domain_id, a.receive_strategy, a.forward_to,
  a.routing_rule_id, a.provisioning_status, a.last_validated_at, a.last_error,
  a.next_check_at, a.created_at, a.updated_at
`;

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function flag(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapDomain(row: Row): DomainRecord {
  return {
    id: text(row["id"]),
    domain: text(row["domain"]),
    status: text(row["status"]),
    provider: textOrNull(row["provider"]),
    verified: flag(row["verified"]),
    notes: textOrNull(row["notes"]),
    provisioning_status: text(row["provisioning_status"]),
    purchase_provider: textOrNull(row["purchase_provider"]),
    dns_provider: text(row["dns_provider"]),
    send_provider: textOrNull(row["send_provider"]),
    cf_zone_id: textOrNull(row["cf_zone_id"]),
    registrar: textOrNull(row["registrar"]),
    nameservers_json: parseJsonArray<unknown>(textOrNull(row["nameservers_json"])).map((value) => String(value)),
    mail_from_domain: textOrNull(row["mail_from_domain"]),
    last_error: textOrNull(row["last_error"]),
    next_check_at: textOrNull(row["next_check_at"]),
    created_at: text(row["created_at"]),
    updated_at: text(row["updated_at"]),
  };
}

function mapAddress(row: Row): AddressRecord {
  return {
    id: text(row["id"]),
    email: text(row["email"]),
    domain: textOrNull(row["domain"]),
    display_name: textOrNull(row["display_name"]),
    status: text(row["status"]),
    verified: flag(row["verified"]),
    daily_quota: integerOrNull(row["daily_quota"]),
    owner_id: textOrNull(row["owner_id"]),
    administrator_id: textOrNull(row["administrator_id"]),
    domain_id: textOrNull(row["domain_id"]),
    receive_strategy: textOrNull(row["receive_strategy"]),
    forward_to: textOrNull(row["forward_to"]),
    routing_rule_id: textOrNull(row["routing_rule_id"]),
    provisioning_status: text(row["provisioning_status"]),
    last_validated_at: textOrNull(row["last_validated_at"]),
    last_error: textOrNull(row["last_error"]),
    next_check_at: textOrNull(row["next_check_at"]),
    created_at: text(row["created_at"]),
    updated_at: text(row["updated_at"]),
  };
}

function selectDomain(db: Database, id: string): DomainRecord | null {
  const row = db.query(`SELECT ${DOMAIN_COLUMNS} FROM domains d WHERE d.id = ?`).get(id) as Row | null;
  return row ? mapDomain(row) : null;
}

function selectAddress(db: Database, id: string): AddressRecord | null {
  const row = db.query(`SELECT ${ADDRESS_COLUMNS} FROM addresses a WHERE a.id = ?`).get(id) as Row | null;
  return row ? mapAddress(row) : null;
}

/** A provider to attach a new registry row to, or the reason there is none. */
type ProviderResolution = { id: string } | { missing: string };

function resolveProviderId(db: Database, requested?: string | null): ProviderResolution {
  const wanted = requested?.trim();
  if (wanted) {
    const named = db
      .query("SELECT id FROM providers WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1")
      .get(wanted, wanted) as { id: string } | null;
    if (named) return { id: named.id };
    return { missing: `no provider matches ${wanted}` };
  }
  const fallback = db
    .query("SELECT id FROM providers ORDER BY active DESC, created_at ASC LIMIT 1")
    .get() as { id: string } | null;
  if (fallback) return { id: fallback.id };
  return { missing: "this database has no provider to attach the row to; register one first" };
}

export function createDomainsRepository(db: Database): DomainsRepository {
  return {
    async listDomains(opts?: ListOptions): Promise<Outcome<DomainRecord[]>> {
      return guard(() => {
        const rows = db
          .query(`SELECT ${DOMAIN_COLUMNS} FROM domains d ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`)
          .all(cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE), safeOffset(opts?.offset)) as Row[];
        return ok(rows.map(mapDomain));
      });
    },

    async getDomain(id: string): Promise<Outcome<DomainRecord | null>> {
      return guard(() => ok(selectDomain(db, id)));
    },

    async getDomainByName(domain: string): Promise<Outcome<DomainRecord | null>> {
      const name = domain.trim();
      if (!name) return invalidInput("a domain name is required");
      return guard(() => {
        const row = db
          .query(
            `SELECT ${DOMAIN_COLUMNS} FROM domains d
              WHERE d.domain = ? COLLATE NOCASE ORDER BY d.created_at DESC LIMIT 1`,
          )
          .get(name) as Row | null;
        return ok(row ? mapDomain(row) : null);
      });
    },

    async createDomain(input: DomainInput): Promise<Outcome<DomainRecord>> {
      const name = input.domain?.trim();
      if (!name) return invalidInput("a domain name is required");
      return guard(() =>
        withImmediateTransaction(db, () => {
          const provider = resolveProviderId(db, input.provider);
          if ("missing" in provider) return invalidInput(provider.missing);
          const id = uuid();
          const timestamp = now();
          db.run(
            `INSERT INTO domains (id, provider_id, domain, ownership_status, notes, verified_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              provider.id,
              name,
              input.status ?? "pending",
              input.notes ?? null,
              input.verified ? timestamp : null,
              timestamp,
              timestamp,
            ],
          );
          const record = selectDomain(db, id);
          if (!record) throw new Error(`domain ${id} disappeared immediately after insert`);
          return ok(record);
        }),
      );
    },

    async updateDomain(id: string, patch: DomainPatch): Promise<Outcome<DomainRecord | null>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          if (!selectDomain(db, id)) return ok(null);
          const sets: string[] = ["updated_at = ?"];
          const params: SQLQueryBindings[] = [now()];
          if (patch.status !== undefined) {
            sets.push("ownership_status = ?");
            params.push(patch.status);
          }
          if (patch.notes !== undefined) {
            sets.push("notes = ?");
            params.push(patch.notes);
          }
          if (patch.verified !== undefined) {
            sets.push("verified_at = ?");
            params.push(patch.verified ? now() : null);
          }
          if (patch.provider !== undefined) {
            const provider = resolveProviderId(db, patch.provider);
            if ("missing" in provider) return invalidInput(provider.missing);
            sets.push("provider_id = ?");
            params.push(provider.id);
          }
          db.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
          return ok(selectDomain(db, id));
        }),
      );
    },

    async deleteDomain(id: string): Promise<Outcome<boolean>> {
      return guard(() => ok(db.run("DELETE FROM domains WHERE id = ?", [id]).changes > 0));
    },
  };
}

export function createAddressesRepository(db: Database): AddressesRepository {
  return {
    async listAddresses(opts?: ListOptions): Promise<Outcome<AddressRecord[]>> {
      return guard(() => {
        const rows = db
          .query(`SELECT ${ADDRESS_COLUMNS} FROM addresses a ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
          .all(cappedLimit(opts?.limit, DEFAULT_PAGE, MAX_PAGE), safeOffset(opts?.offset)) as Row[];
        return ok(rows.map(mapAddress));
      });
    },

    async getAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      return guard(() => ok(selectAddress(db, id)));
    },

    async createAddress(input: AddressInput): Promise<Outcome<AddressRecord>> {
      const email = input.email?.trim();
      if (!email || !email.includes("@")) return invalidInput("a well-formed email address is required");
      return guard(() =>
        withImmediateTransaction(db, () => {
          // An address belongs to its domain's provider when the domain is
          // registered; otherwise it falls back to the active provider.
          const domain = email.slice(email.indexOf("@") + 1).toLowerCase();
          const owning = db
            .query("SELECT id, provider_id FROM domains WHERE domain = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1")
            .get(domain) as { id: string; provider_id: string } | null;
          const provider = owning
            ? { id: owning.provider_id }
            : resolveProviderId(db, null);
          if ("missing" in provider) return invalidInput(provider.missing);
          const id = uuid();
          const timestamp = now();
          db.run(
            `INSERT INTO addresses
               (id, provider_id, email, display_name, status, verified, daily_quota, domain_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              provider.id,
              email,
              input.display_name ?? null,
              input.status ?? "active",
              input.verified ? 1 : 0,
              input.daily_quota ?? null,
              owning?.id ?? null,
              timestamp,
              timestamp,
            ],
          );
          const record = selectAddress(db, id);
          if (!record) throw new Error(`address ${id} disappeared immediately after insert`);
          return ok(record);
        }),
      );
    },

    async updateAddress(id: string, patch: AddressPatch): Promise<Outcome<AddressRecord | null>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          if (!selectAddress(db, id)) return ok(null);
          const sets: string[] = ["updated_at = ?"];
          const params: SQLQueryBindings[] = [now()];
          if (patch.display_name !== undefined) {
            sets.push("display_name = ?");
            params.push(patch.display_name);
          }
          if (patch.status !== undefined) {
            sets.push("status = ?");
            params.push(patch.status);
          }
          if (patch.verified !== undefined) {
            sets.push("verified = ?");
            params.push(patch.verified ? 1 : 0);
          }
          // `dailyQuotaSet` is the flag that separates "not provided" (keep the
          // quota) from an explicit clear (`daily_quota: null`). Without it a
          // `quota <id> none` silently becomes a no-op, which is why the seam
          // carries the ugliness verbatim and this store honours it.
          if (patch.dailyQuotaSet || patch.daily_quota !== undefined) {
            sets.push("daily_quota = ?");
            params.push(patch.daily_quota ?? null);
          }
          db.run(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
          return ok(selectAddress(db, id));
        }),
      );
    },

    async deleteAddress(id: string): Promise<Outcome<boolean>> {
      return guard(() => ok(db.run("DELETE FROM addresses WHERE id = ?", [id]).changes > 0));
    },
  };
}

function setAddressColumns(
  db: Database,
  id: string,
  columns: Array<[string, SQLQueryBindings]>,
): Outcome<AddressRecord | null> {
  return guard(() =>
    withImmediateTransaction(db, () => {
      if (!selectAddress(db, id)) return ok(null);
      const sets = ["updated_at = ?", ...columns.map(([column]) => `${column} = ?`)];
      const params: SQLQueryBindings[] = [now(), ...columns.map(([, value]) => value)];
      db.run(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
      return ok(selectAddress(db, id));
    }),
  );
}

export function createAddressLifecycleRepository(db: Database): AddressLifecycleRepository {
  return {
    async suspendAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      return setAddressColumns(db, id, [["status", "suspended"]]);
    },

    async activateAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      return setAddressColumns(db, id, [["status", "active"]]);
    },

    async setAddressQuota(id: string, dailyQuota: number | null): Promise<Outcome<AddressRecord | null>> {
      if (dailyQuota !== null && (!Number.isInteger(dailyQuota) || dailyQuota < 0)) {
        return invalidInput(`a daily quota must be a non-negative integer or null, got ${dailyQuota}`);
      }
      return setAddressColumns(db, id, [["daily_quota", dailyQuota]]);
    },

    async applyAddressOwnership(id: string, patch: AddressOwnershipPatch): Promise<Outcome<AddressRecord | null>> {
      const columns: Array<[string, SQLQueryBindings]> = [];
      if (patch.owner_id !== undefined) columns.push(["owner_id", patch.owner_id]);
      if (patch.administrator_id !== undefined) columns.push(["administrator_id", patch.administrator_id]);
      if (columns.length === 0) return guard(() => ok(selectAddress(db, id)));
      return setAddressColumns(db, id, columns);
    },

    async getAddressSendability(_email: string): Promise<Outcome<AddressSendability>> {
      // THIS IS THE OPERATION THE REFUSAL CHANNEL WAS BUILT FOR. The local
      // repository answers `{ sendable: true }` for an address it has never heard
      // of — "I know nothing about this sender, go ahead" — and nothing in this
      // schema can do better: there is no sender-readiness state, no suppression
      // list, no warming ledger and no send-key scope model, so "no policy
      // configured" and "policy passed" are indistinguishable here. Answering
      // either way would be a guess about whether mail may leave, so the store
      // refuses and the caller has to decide with the refusal in hand.
      return unavailable("outboundPolicy");
    },
  };
}

export function createProvisioningRepository(db: Database): ProvisioningRepository {
  // Provisioning events are a plain append-only table, so they go through the same
  // schema-driven resource path as every other row-per-thing family.
  const events = createResourceRepository(db, "provisioning_events");

  return {
    async applyDomainProvisioning(id: string, patch: DomainProvisioningPatch): Promise<Outcome<DomainRecord | null>> {
      return guard(() =>
        withImmediateTransaction(db, () => {
          if (!selectDomain(db, id)) return ok(null);
          const sets: string[] = ["updated_at = ?"];
          const params: SQLQueryBindings[] = [now()];
          const set = (column: string, value: SQLQueryBindings): void => {
            sets.push(`${column} = ?`);
            params.push(value);
          };
          if (patch.provisioning_status !== undefined) set("provisioning_status", patch.provisioning_status);
          if (patch.purchase_provider !== undefined) set("purchase_provider", patch.purchase_provider);
          if (patch.dns_provider !== undefined) set("dns_provider", patch.dns_provider);
          if (patch.send_provider !== undefined) set("send_provider", patch.send_provider);
          if (patch.cf_zone_id !== undefined) set("cf_zone_id", patch.cf_zone_id);
          if (patch.registrar !== undefined) set("registrar", patch.registrar);
          if (patch.nameservers_json !== undefined) set("nameservers_json", JSON.stringify(patch.nameservers_json));
          if (patch.mail_from_domain !== undefined) set("mail_from_domain", patch.mail_from_domain);
          if (patch.last_error !== undefined) set("last_error", patch.last_error);
          if (patch.next_check_at !== undefined) set("next_check_at", patch.next_check_at);
          db.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
          return ok(selectDomain(db, id));
        }),
      );
    },

    async applyAddressProvisioning(id: string, patch: AddressProvisioningPatch): Promise<Outcome<AddressRecord | null>> {
      const columns: Array<[string, SQLQueryBindings]> = [];
      if (patch.domain_id !== undefined) columns.push(["domain_id", patch.domain_id]);
      if (patch.receive_strategy !== undefined) columns.push(["receive_strategy", patch.receive_strategy]);
      if (patch.forward_to !== undefined) columns.push(["forward_to", patch.forward_to]);
      if (patch.routing_rule_id !== undefined) columns.push(["routing_rule_id", patch.routing_rule_id]);
      if (patch.provisioning_status !== undefined) columns.push(["provisioning_status", patch.provisioning_status]);
      if (patch.last_validated_at !== undefined) columns.push(["last_validated_at", patch.last_validated_at]);
      if (patch.last_error !== undefined) columns.push(["last_error", patch.last_error]);
      if (patch.next_check_at !== undefined) columns.push(["next_check_at", patch.next_check_at]);
      if (columns.length === 0) return guard(() => ok(selectAddress(db, id)));
      return setAddressColumns(db, id, columns);
    },

    recordProvisioningEvent(event: ResourceInput): Promise<Outcome<ResourceRow>> {
      return events.create(event);
    },

    listProvisioningEvents(opts?: ListOptions): Promise<Outcome<ResourceRow[]>> {
      return events.list(opts);
    },
  };
}
