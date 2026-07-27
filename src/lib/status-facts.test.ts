// The status facts, checked against ONE question: can the store actually be observed
// to say what the payload claims?
//
// The recurring defect in this surface is not a wrong number — it is a MEASUREMENT
// INCAPABLE OF DETECTING WHAT IT CLAIMS. A count of a table nobody read. A verdict
// derived from a column that does not decide it. A `0` where the honest answer is
// "the store has no operation for that". So every case below pairs a refusal with a
// POSITIVE CONTROL: the same field, on the same seeded data, measured through a store
// that can answer it. A test suite where every field is null passes vacuously, and
// that is the failure mode this file is written against.
//
// The store is injected in the cases that need a store which cannot answer. There is
// no other way to reach a capability refusal or a moved paging window from a healthy
// local database, and faking the ANSWER rather than the STORE would test the test.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.local.js";
import { createDomain } from "../db/domains.local.js";
import { createAddress } from "../db/addresses.local.js";
import { setDomainProvisioning } from "../db/provisioning.local.js";
import { createSqliteEmailStore } from "../store-sqlite/index.js";
import { collectStatusFacts, type StatusFactsInput } from "./status-facts.js";
import { statusGapClass } from "./status-availability.js";
import type { EmailStore } from "../store/email-store.js";
import type { DomainRecord } from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import { emptyMailboxCounts, type MailboxSourceSummary } from "./mail-types.js";

const DB_PATH_ENV = "EMAILS_DB_PATH";
const API_URL_ENV = "EMAILS_SELF_HOSTED_URL";
const API_KEY_ENV = "EMAILS_SELF_HOSTED_API_KEY";
const TOUCHED_ENV = [DB_PATH_ENV, API_URL_ENV, API_KEY_ENV, "HASNA_EMAILS_DB_PATH"] as const;

let saved: Array<readonly [string, string | undefined]> = [];
let scratch: string | null = null;

beforeEach(() => {
  saved = TOUCHED_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env[DB_PATH_ENV] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

const INPUT: StatusFactsInput = {
  mailboxSources: [],
  domainLimit: 25,
  usableFromLimit: 25,
  sourceLimit: 50,
};

function facts(overrides: Partial<StatusFactsInput> = {}, store?: EmailStore) {
  return collectStatusFacts({ ...INPUT, ...overrides }, store);
}

/**
 * Two providers (one inactive), two domains (one verified, one with a failed
 * provisioning row), three addresses (one verified, one suspended, one ready).
 *
 * Seeded through the repositories the CLI itself writes with, so the rows are the
 * shape a real installation holds rather than one this test invented.
 */
async function seed(): Promise<EmailStore> {
  const db = getDatabase();
  const ses = createProvider({ name: "SES production", type: "ses" }, db);
  const sandbox = createProvider({ name: "Sandbox", type: "sandbox" }, db);
  const alpha = createDomain(ses.id, "alpha.example", db);
  const beta = createDomain(ses.id, "beta.example", db);
  setDomainProvisioning(beta.id, { provisioning_status: "failed", last_error: "DNS never propagated" }, db);
  const ops = createAddress({ provider_id: ses.id, email: "ops@alpha.example" }, db);
  createAddress({ provider_id: ses.id, email: "old@alpha.example" }, db);
  createAddress({ provider_id: ses.id, email: "hi@beta.example" }, db);

  const store = createSqliteEmailStore({ database: db, detail: "SQLite (test)" });
  // Written through the seam so the columns it reads and the columns this test sets
  // cannot drift apart. `createProvider` always writes `active = 1`, so the inactive
  // provider — the whole point of asserting `active` separately from `total` — has to
  // be deactivated here.
  const deactivated = await store.providers.update(sandbox.id, { active: false });
  expect(deactivated.ok, "fixture: the second provider must really be inactive").toBe(true);
  const verified = await store.domains.updateDomain(alpha.id, { verified: true });
  expect(verified.ok, "fixture: the domain must really be marked verified").toBe(true);
  const sender = await store.addresses.updateAddress(ops.id, { verified: true });
  expect(sender.ok, "fixture: the address must really be marked verified").toBe(true);
  return store;
}

/** A store that is healthy except for the one repository handed in. */
function storeExcept(base: EmailStore, patch: Partial<EmailStore>): EmailStore {
  return { ...base, ...patch };
}

function refusal(code: "capability_unavailable" | "invalid_input", status: 501 | 422, message: string) {
  return { ok: false as const, code, message, status };
}

function domainRows(count: number): DomainRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `dom-${String(index).padStart(5, "0")}`,
    domain: `d${index}.example`,
    status: "pending",
    provider: "prov-1",
    verified: false,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  }));
}

/**
 * A list that loses rows from above the cursor between pages, so the paging window
 * moves forward and rows are skipped without any row ever being returned twice.
 */
function shrinkingDomainList(all: DomainRecord[], dropPerPage: number) {
  let order = [...all];
  return async (opts?: { limit?: number; offset?: number }): Promise<Outcome<DomainRecord[]>> => {
    order = order.slice(dropPerPage);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return { ok: true, value: order.slice(offset, offset + limit) };
  };
}

function source(over: Partial<MailboxSourceSummary>): MailboxSourceSummary {
  return {
    id: "s",
    label: "s",
    kind: "s3",
    badges: [],
    counts: emptyMailboxCounts(),
    total: 0,
    unread: 0,
    latestReceivedAt: null,
    ...over,
  };
}

describe("status facts are measured on the store, or refused", () => {
  it("POSITIVE CONTROL: every count comes from the configured store, with its provenance", async () => {
    // If this test ever goes green while the refusal tests below also go green for
    // the wrong reason, the suite has stopped being able to tell a measurement from
    // a null. So the provenance is asserted, not just the numbers.
    await seed();
    const bundle = await facts();

    expect(bundle.providers.total).toBe(2);
    expect(bundle.providers.active).toBe(1);
    expect(bundle.providers.by_type).toEqual({ ses: 1 });
    expect(bundle.domains.total).toBe(2);
    expect(bundle.domains.verified).toBe(1);
    expect(bundle.addresses.total).toBe(3);
    expect(bundle.addresses.active).toBe(3);
    expect(bundle.addresses.verified).toBe(1);
    expect(bundle.provisioning.domains_failed).toBe(1);

    // ONE implementation, so the provenance names the STORE and the family rather
    // than a deployment word and a transport.
    expect(bundle.providers.availability.source).toBe("sqlite:providers");
    expect(bundle.domains.availability.source).toBe("sqlite:domains");
    expect(bundle.addresses.availability.source).toBe("sqlite:addresses");
    // `client_enumeration`, because the seam publishes list operations and no
    // aggregate — so every count carries a completeness flag that an exact SQL
    // `COUNT(*)` had no way to express.
    expect(bundle.providers.availability.basis).toBe("client_enumeration");
    expect(bundle.providers.availability.complete).toBe(true);
    expect(bundle.gaps["providers.total"]).toBeUndefined();
  });

  it("refuses send eligibility instead of deriving it from `verified`", async () => {
    // The seeded data is chosen so a `verified = 1 AND status != 'suspended'` query
    // returns exactly one row: an implementation that answers this field from that
    // proxy publishes a confident list here. Send eligibility is
    // `getAddressSendability`, gated on `outboundPolicy`, which this store declares
    // false — and the store's address record carries no provider_id, so the enriched
    // sender row the field is typed as cannot be built from store rows at all.
    const store = await seed();
    expect(store.capabilities.outboundPolicy).toBe(false);

    const bundle = await facts();

    expect(bundle.addresses.verified).toBe(1);
    expect(bundle.addresses.usable_from).toBeNull();
    expect(bundle.gaps["addresses.usable_from"]?.reason)
      .toMatch(/^not_modelled_on_store:store_capability_outboundPolicy/);
    expect(bundle.gaps["addresses.usable_from"]?.reason).toContain("outboundPolicy");
    expect(statusGapClass(bundle.gaps["addresses.usable_from"]?.reason)).toBe("structural");
    // A refused list has no answerable truncation either. `false` there would be a
    // confident claim about a list that was never produced, so the field is nullable
    // and null — the type was widened rather than filled with the comfortable value.
    expect(bundle.addresses.usable_from_truncated).toBeNull();
    expect(bundle.gaps["addresses.usable_from_truncated"]?.reason)
      .toMatch(/^not_modelled_on_store:store_capability_outboundPolicy/);
  });

  it("refuses the DNS readiness verdicts, and keeps the columns the store does carry", async () => {
    await seed();
    const bundle = await facts();

    expect(bundle.domains.send_ready).toBeNull();
    expect(bundle.domains.receive_ready).toBeNull();
    expect(bundle.gaps["domains.send_ready"]?.reason).toMatch(/^not_modelled_on_store:domain_dns_evidence/);

    // The refusal is FIELD level, not block level: the sample rows are still
    // published, with every column the store really returned.
    const rows = bundle.domains.usable ?? [];
    expect(rows).toHaveLength(2);
    const broken = rows.find((row) => row.domain === "beta.example");
    expect(broken).toMatchObject({ provisioning_status: "failed", last_error: "DNS never propagated" });
    expect(broken?.issues).toContain("DNS never propagated");
    expect(broken?.state).toBeNull();
    expect(broken?.send_ready).toBeNull();
    // ...and the remedy is a command that RUNS. `emails domain check` / `domain
    // status` refuse in every configuration, and this list feeds `next_actions`.
    expect(broken?.fix_commands).toEqual(["emails domain list --json", "emails address list --json"]);
  });

  it("turns a capability refusal into a null with a reason, never into a zero", async () => {
    const base = await seed();
    // POSITIVE CONTROL FIRST: the same database, read through a store that can
    // answer, produces a number. Without this the assertion below would also pass
    // against an empty database.
    expect((await facts({}, base)).providers.total).toBe(2);

    const store = storeExcept(base, {
      providers: {
        ...base.providers,
        list: async () => refusal("capability_unavailable", 501, "the test store does not provide providers"),
      },
    });
    const bundle = await facts({}, store);

    expect(bundle.providers.total).toBeNull();
    expect(bundle.providers.active).toBeNull();
    expect(bundle.providers.by_type).toBeNull();
    expect(bundle.providers.availability.available).toBe(false);
    expect(bundle.gaps["providers.total"]?.reason)
      .toMatch(/^not_modelled_on_store:store_refusal:capability_unavailable/);
    // A declared-false capability is permanent for this store, so it is a published
    // limitation rather than something an operator can go and fix.
    expect(statusGapClass(bundle.gaps["providers.total"]?.reason)).toBe("structural");
  });

  it("classifies a NON-capability refusal as a live failure, not as a limitation", async () => {
    const base = await seed();
    expect((await facts({}, base)).domains.total).toBe(2);

    const store = storeExcept(base, {
      domains: {
        ...base.domains,
        listDomains: async () => refusal("invalid_input", 422, "offset out of range"),
      },
    });
    const bundle = await facts({}, store);

    expect(bundle.domains.total).toBeNull();
    expect(bundle.domains.usable).toBeNull();
    expect(bundle.gaps["domains.total"]?.reason).toMatch(/^source_unreachable:store_refusal:invalid_input/);
    expect(statusGapClass(bundle.gaps["domains.total"]?.reason)).toBe("failure");
    // Nothing was read, so whether a sample would leave rows out is unknown.
    expect(bundle.domains.usable_truncated).toBeNull();
    expect(bundle.gaps["domains.usable_truncated"]?.reason)
      .toMatch(/^source_unreachable:store_refusal:invalid_input/);
    // The provisioning block spans domains AND addresses, so it inherits the weaker
    // of the two rather than reporting the half it could read as a whole.
    expect(bundle.provisioning.domains_failed).toBeNull();
    expect(bundle.provisioning.availability.available).toBe(false);
  });

  it("turns a thrown transport fault into a null with the fault text", async () => {
    const base = await seed();
    expect((await facts({}, base)).addresses.total).toBe(3);

    const store = storeExcept(base, {
      addresses: {
        ...base.addresses,
        listAddresses: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); },
      },
    });
    const bundle = await facts({}, store);

    expect(bundle.addresses.total).toBeNull();
    expect(bundle.addresses.ready_to_receive).toBeNull();
    expect(bundle.addresses.usable_from_truncated).toBeNull();
    expect(bundle.gaps["addresses.total"]?.reason).toMatch(/^source_unreachable:/);
    expect(bundle.gaps["addresses.total"]?.reason).toContain("ECONNREFUSED");
    expect(statusGapClass(bundle.gaps["addresses.total"]?.reason)).toBe("failure");
    // The per-domain ready-address count aggregates the ADDRESS inventory, so it must
    // go too — and it must carry the address block's reason, not a bare null.
    for (const row of bundle.domains.usable ?? []) expect(row.ready_addresses).toBeNull();
    expect(bundle.gaps["domains.usable[].ready_addresses"]?.reason).toMatch(/^source_unreachable:/);
  });

  it("publishes a moved paging window as a lower bound rather than as a total", async () => {
    const base = await seed();
    const all = domainRows(1300);
    const store = storeExcept(base, {
      domains: { ...base.domains, listDomains: shrinkingDomainList(all, 7) },
    });
    const bundle = await facts({}, store);

    // Rows really were read — this is not a read failure.
    expect(bundle.domains.availability.available).toBe(true);
    expect(bundle.domains.total).not.toBeNull();
    expect(bundle.domains.total!).toBeGreaterThan(0);
    // ...but rows were also skipped, so the number is a floor and says so.
    expect(bundle.domains.availability.complete).toBe(false);
    expect(bundle.domains.availability.reason).toMatch(/^enumeration_unstable:/);
    expect(bundle.domains.total!).toBeLessThan(all.length);
    // A single list call would have capped this at the store's page maximum, so the
    // count also proves the enumeration paged.
    expect(bundle.domains.total!).toBeGreaterThan(500);
    // `usable_truncated` admits no null, so `false` here would be a claim that the
    // 25-row sample is the whole list — made about a read that is known incomplete.
    expect(bundle.domains.usable_truncated).toBe(true);
  });

  it("nulls a derived per-row column when the inventory it aggregates was only PARTLY read", async () => {
    // `provider_name` is looked up in the provider inventory. When that inventory
    // answered but not in full, a provider that really exists is simply one of the
    // rows the enumeration skipped — so a `null` there reads as "no provider is
    // attached" unless the gap is registered. `available` alone does not catch this:
    // a partial enumeration still returns rows.
    const base = await seed();
    const store = storeExcept(base, {
      providers: {
        ...base.providers,
        list: async (opts) => {
          const answer = await base.providers.list(opts);
          if (!answer.ok) return answer;
          // The same padding rows on every page: the pager never reaches a short page
          // and keeps seeing rows it already holds, so the read comes back as an
          // explicit lower bound rather than as a total.
          return { ok: true, value: [...answer.value, ...domainRows(500)] as never };
        },
      },
    });
    const bundle = await facts({}, store);

    expect(bundle.providers.availability.available).toBe(true);
    expect(bundle.providers.availability.complete).toBe(false);
    expect(bundle.gaps["domains.usable[].provider_name"]?.reason).not.toBeUndefined();
    expect(statusGapClass(bundle.gaps["domains.usable[].provider_name"]?.reason)).toBe("bound");
  });

  it("reports a contradictory storage configuration as a failure instead of throwing", async () => {
    // `emails status` is the command an operator runs to find out what is wrong, so
    // it must not be the command that dies on a bad configuration — and it must not
    // quietly pick one of the two configured stores either. `planEmailStore` treats a
    // database path AND an API as unresolvable, and the payload says so, naming both
    // settings.
    scratch = mkdtempSync(join(tmpdir(), "emails-status-facts-"));
    process.env[DB_PATH_ENV] = join(scratch, "emails.db");
    process.env[API_URL_ENV] = "http://127.0.0.1:9";
    process.env[API_KEY_ENV] = "test-key";

    const bundle = await facts();

    expect(bundle.database.data_dir).toBeNull();
    expect(bundle.gaps["database.data_dir"]?.reason).toMatch(/^source_unreachable:store_unresolved/);
    expect(bundle.gaps["database.data_dir"]?.reason).toContain(DB_PATH_ENV);
    expect(bundle.gaps["database.data_dir"]?.reason).toContain(API_URL_ENV);
    // No store was resolved, so NOTHING was read — and every count says so rather
    // than reading as an empty installation.
    expect(bundle.providers.total).toBeNull();
    expect(bundle.domains.total).toBeNull();
    expect(bundle.addresses.total).toBeNull();
    expect(bundle.gaps["providers.total"]?.reason).toMatch(/^source_unreachable:store_unresolved/);
    expect(statusGapClass(bundle.gaps["providers.total"]?.reason)).toBe("failure");
    // Ingestion belongs to whichever store holds the mail, and that is exactly what
    // is unknown here.
    expect(bundle.inboundBuckets.items).toBeNull();
    expect(bundle.realtime.queue_configured).toBeNull();
  });

  it("PRESERVED: names the directory the rows are actually in, not the default one", async () => {
    // The deleted local module derived this from the resolved database path rather
    // than from the data directory, precisely so an overridden path is reported
    // correctly instead of naming a directory the data is not in. Collapsing the
    // family must not lose that.
    scratch = mkdtempSync(join(tmpdir(), "emails-status-facts-"));
    const file = join(scratch, "emails.db");
    process.env[DB_PATH_ENV] = file;
    resetDatabase();

    const bundle = await facts();

    expect(bundle.database.availability.available).toBe(true);
    expect(bundle.database.data_dir).toBe(dirname(file));
    expect(bundle.gaps["database.data_dir"]).toBeUndefined();
  });

  it("PRESERVED: an in-memory database has no data directory, and says which kind of gap that is", async () => {
    const bundle = await facts();

    expect(bundle.database.data_dir).toBeNull();
    expect(bundle.gaps["database.data_dir"]?.reason).toMatch(/^not_applicable:in_memory_database/);
    expect(statusGapClass(bundle.gaps["database.data_dir"]?.reason)).toBe("structural");
  });

  it("PRESERVED: ingestion wiring is measured from this installation's own config", async () => {
    // An installation that keeps its mail in its own database performs its own
    // ingestion, so the bucket list and the realtime queue ARE observable and must
    // not be refused along with everything else.
    const bundle = await facts();

    expect(bundle.inboundBuckets.availability.available).toBe(true);
    expect(bundle.inboundBuckets.items).toEqual([]);
    expect(bundle.inboundBuckets.total).toBe(0);
    expect(bundle.realtime.availability.available).toBe(true);
    expect(bundle.realtime.queue_configured).toBe(false);
    expect(bundle.realtime.availability.basis).toBe("local_config");
  });
});

describe("the mailbox view's source block reports only what the view enumerated", () => {
  it("refuses the source count when the view publishes only its aggregate row", async () => {
    // Neither deleted module got this right: one counted the aggregate row as an
    // ingestion source, the other reported a flat zero for a view that enumerates
    // none. The aggregate stays in `items`; the COUNT is refused.
    const bundle = await facts({ mailboxSources: [source({ id: "all", kind: "all", badges: ["shared"] })] });

    expect(bundle.sources.total).toBeNull();
    expect(bundle.gaps["sources.total"]?.reason).toMatch(/^not_modelled_on_store:aggregate_only_mailbox_view/);
    expect(bundle.sources.items).toHaveLength(1);
    expect(bundle.sources.availability.available).toBe(true);
  });

  it("POSITIVE CONTROL: counts and classifies the sources a view really does enumerate", async () => {
    const bundle = await facts({
      mailboxSources: [
        source({ id: "all", kind: "all", badges: [] }),
        source({ id: "s3:a", kind: "s3", badges: ["configured", "legacy"] }),
        source({ id: "provider:p", kind: "provider", badges: ["active", "capability:ses"] }),
        source({ id: "orphan:p", kind: "orphaned", badges: ["orphaned"] }),
      ],
    });

    // The aggregate row is excluded from the count and kept in `items`.
    expect(bundle.sources.total).toBe(3);
    expect(bundle.sources.items).toHaveLength(4);
    expect(bundle.sources.active).toBe(2);
    expect(bundle.sources.legacy).toBe(1);
    expect(bundle.sources.orphaned).toBe(1);
    expect(bundle.gaps["sources.legacy"]).toBeUndefined();
  });

  it("refuses the classification when the view badges nothing, rather than reporting no legacy sources", async () => {
    // A count of `0` here cannot be distinguished from "this view has no notion of
    // legacy", and only one of those is a measurement.
    const bundle = await facts({
      mailboxSources: [
        source({ id: "all", kind: "all", badges: [] }),
        source({ id: "s3:a", kind: "s3", badges: [] }),
      ],
    });

    expect(bundle.sources.total).toBe(1);
    expect(bundle.sources.active).toBeNull();
    expect(bundle.sources.legacy).toBeNull();
    expect(bundle.sources.orphaned).toBeNull();
    expect(bundle.gaps["sources.legacy"]?.reason).toMatch(/^not_modelled_on_store:source_classification/);
  });

  it("refuses the configured ingestion-source inventory, because no store operation answers it", async () => {
    await seed();
    const bundle = await facts();

    expect(bundle.sources.configured.total).toBeNull();
    expect(bundle.sources.configured.by_status).toBeNull();
    expect(bundle.sources.configured.latest_last_synced_at).toBeNull();
    expect(bundle.gaps["sources.configured.total"]?.reason)
      .toMatch(/^not_modelled_on_store:no_ingestion_source_repository/);
    expect(statusGapClass(bundle.gaps["sources.configured.total"]?.reason)).toBe("structural");
  });
});
