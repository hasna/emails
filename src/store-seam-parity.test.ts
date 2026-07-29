// Two-store PARITY probes for the store seam.
//
// Every probe here runs against BOTH shipped stores — the SQLite store directly, and
// the HTTP store pointed at a `/v1` fixture backed by the SAME SQLite database — and
// asserts they answer the SAME thing. Each block pins one divergence that was found
// between the arms:
//
//  1. BLANK IDS. Through an API, `get("")` builds `GET /v1/<family>/`, the service
//     strips the trailing slash and dispatches the COLLECTION route — so a blank id
//     answered a fabricated "record" (the list envelope) where SQLite answered null,
//     and `update("")` issued a request that was not a by-id write at all. A blank or
//     whitespace id is ABSENCE, decided at the seam, with the value outcome.ts RULE 2
//     assigns the operation's return type: null for the row shapes, false for the
//     boolean.
//
//  2. SERVER-OWNED COLUMNS. The HTTP arm refuses a write naming `id` / `created_at` /
//     `updated_at` (they are not in the service's published writable-column contract),
//     while SQLite honored the id and timestamps a caller smuggled in — so
//     `update(id, rowFromCreate)` round-tripped on one store and 422'd on the other.
//     Both arms must refuse, per family, with the two contract-declared exceptions
//     (`sandbox_emails.created_at`, `sequence_steps.created_at`) staying writable.
//
//  3. REDACTED FILTER ORACLE. SQLite's generic list accepted equality filters on the
//     redacted provider-credential columns, answering "is this exact api_key stored
//     here?" — a value-confirmation oracle the HTTP arm refuses. Both must refuse.
//
//  4. REVOCATION INSTANT. A repeat `revokeSendKey` PATCHed a fresh client-clock
//     `revoked_at` over the original on the API store, while SQLite preserves the
//     first instant. A revoked key's instant is an audit fact; both arms must keep it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAlias } from "./db/aliases.js";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./db/database.js";
import { getGroup } from "./db/groups.js";
import { getSandboxEmail } from "./db/sandbox.js";
import { advanceEnrollment } from "./db/sequences.js";
import { getTemplate } from "./db/templates.js";
import {
  assertUniformCaseCoverage,
  conformanceFailures,
  runConformanceSuite,
  type ConformanceCase,
} from "./store/conformance.js";
import type { EmailStore } from "./store/email-store.js";
import type { Outcome, Refusal } from "./store/outcome.js";
import type { ResourceInput, ResourceRow } from "./store/records.js";
import type { ResourceRepository } from "./store/repositories.js";
import { createHttpEmailStore } from "./store-http/index.js";
import { sequenceSubledgerOf } from "./store-sequence-subledger.js";
import { createSqliteEmailStore } from "./store-sqlite/index.js";
import { startV1StoreApi, type V1StoreApi } from "./test-support/v1-store-api.js";

let INHERITED_PROCESS_ENV: NodeJS.ProcessEnv;

function captureInheritedProcessEnv(): void {
  INHERITED_PROCESS_ENV = { ...process.env };
}

function restoreInheritedProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(INHERITED_PROCESS_ENV, key)) delete process.env[key];
  }
  Object.assign(process.env, INHERITED_PROCESS_ENV);
}

// Every probe is several HTTP round trips on the API arm; well past the 5s default.
const SUITE_TIMEOUT_MS = 120_000;

let db: Database;
let api: V1StoreApi;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "parity fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  restoreInheritedProcessEnv();
});

/** Both arms, labelled, over ONE backing database so their answers are comparable. */
function bothStores(): Array<{ arm: string; store: EmailStore }> {
  return [
    { arm: "sqlite", store: createSqliteEmailStore({ database: db, detail: "parity (direct)" }) },
    { arm: "api", store: createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey }) },
  ];
}

let uniqueness = 0;

function token(hint: string): string {
  uniqueness += 1;
  return `${hint}-${uniqueness.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function must<TValue>(outcome: Outcome<TValue>, what: string): TValue {
  if (!outcome.ok) throw new Error(`${what} refused: ${outcome.code} ${outcome.message}`);
  return outcome.value;
}

function refusalOf(outcome: Outcome<unknown>, what: string): Refusal {
  if (outcome.ok) throw new Error(`${what} was expected to refuse but answered ${JSON.stringify(outcome.value)}`);
  return outcome;
}

async function sampleProviderId(store: EmailStore): Promise<string> {
  const created = must(
    await store.providers.create({ name: token("provider"), type: "sandbox" }),
    "providers.create",
  );
  return String(created["id"]);
}

const BLANK_IDS = ["", "   "] as const;

describe("store seam parity: blank ids are absence on both arms", () => {
  it(
    "get answers null, update answers null, and remove answers false for a blank or whitespace id",
    async () => {
      for (const { arm, store } of bothStores()) {
        // A real row proves the blank-id answers are not "the table is empty".
        const seeded = must(
          await store.aliases.create({
            domain: `${token("d")}.example.test`,
            local_part: "keep",
            target_address: "keep@example.test",
          }),
          `${arm} aliases.create`,
        );
        for (const blank of BLANK_IDS) {
          expect(must(await store.aliases.get(blank), `${arm} aliases.get(${JSON.stringify(blank)})`)).toBeNull();
          expect(
            must(
              await store.aliases.update(blank, { target_address: "moved@example.test" }),
              `${arm} aliases.update(${JSON.stringify(blank)})`,
            ),
          ).toBeNull();
          expect(
            must(await store.aliases.remove(blank), `${arm} aliases.remove(${JSON.stringify(blank)})`),
          ).toBe(false);
        }
        // No blind write landed anywhere: the seeded row is untouched.
        const after = must(await store.aliases.get(String(seeded["id"])), `${arm} aliases.get(seeded)`);
        expect(after).not.toBeNull();
        expect((after as ResourceRow)["target_address"]).toBe("keep@example.test");
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "advanceEnrollment('') answers null on both arms instead of fabricating an enrollment",
    async () => {
      for (const { arm, store } of bothStores()) {
        expect(await advanceEnrollment("", store)).toBeNull();
        // The sub-ledger's own blank-id update is the operation advanceEnrollment
        // would have reached: it must answer absence, not write blind.
        const subledger = sequenceSubledgerOf(store);
        if (subledger === null) throw new Error(`${arm} store carries no sequence sub-ledger`);
        expect(
          must(
            await subledger.sequenceEnrollments.update("", { status: "cancelled" }),
            `${arm} sequenceEnrollments.update('')`,
          ),
        ).toBeNull();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "the library readers keep answering null for a blank reference on both arms",
    async () => {
      for (const { store } of bothStores()) {
        expect(await getAlias("", store)).toBeNull();
        expect(await getGroup("  ", store)).toBeNull();
        expect(await getSandboxEmail("", store)).toBeNull();
        expect(await getTemplate("", store)).toBeNull();
        expect(await getTemplate("   ", store)).toBeNull();
      }
    },
    SUITE_TIMEOUT_MS,
  );
});

// ---- server-owned write columns, one conformance case per uniform family ----------

/**
 * One probe per seam family: a valid create input, and the server-owned column whose
 * write both arms must refuse. The probe column is chosen per family to be
 * server-owned on BOTH contracts — `updated_at`/`created_at` where the local table
 * carries it, `id` for the two families whose `created_at` the published contract
 * deliberately leaves caller-writable (sandbox) or which have no timestamp columns at
 * all (webhook receipts).
 */
interface FamilyProbe {
  family: string;
  probe: string;
  probeValue: string;
  input(context: { providerId: string }): ResourceInput;
  needsProvider?: boolean;
}

const PROBE_INSTANT = "2020-02-02T02:02:02.000Z";

const FAMILY_PROBES: readonly FamilyProbe[] = [
  { family: "contacts", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ email: `${token("c")}@example.test` }) },
  { family: "groups", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ name: token("group") }) },
  { family: "owners", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ type: "human", name: token("owner") }) },
  { family: "providers", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ name: token("provider"), type: "sandbox" }) },
  { family: "templates", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ name: token("template"), subject_template: "s" }) },
  { family: "sequences", probe: "updated_at", probeValue: PROBE_INSTANT, input: () => ({ name: token("sequence") }) },
  {
    family: "scheduled",
    probe: "created_at",
    probeValue: PROBE_INSTANT,
    needsProvider: true,
    input: ({ providerId }) => ({
      provider_id: providerId,
      from_address: "from@example.test",
      subject: token("scheduled"),
      scheduled_at: "2030-01-01T00:00:00.000Z",
    }),
  },
  {
    family: "aliases",
    probe: "updated_at",
    probeValue: PROBE_INSTANT,
    input: () => ({ domain: `${token("d")}.example.test`, local_part: "a", target_address: "t@example.test" }),
  },
  {
    family: "forwarding",
    probe: "updated_at",
    probeValue: PROBE_INSTANT,
    input: () => ({ source_address: `${token("s")}@example.test`, target_address: "t@example.test" }),
  },
  {
    family: "warming",
    probe: "updated_at",
    probeValue: PROBE_INSTANT,
    input: () => ({ domain: `${token("w")}.example.test`, target_daily_volume: 10, start_date: "2030-01-01" }),
  },
  {
    family: "events",
    probe: "created_at",
    probeValue: PROBE_INSTANT,
    needsProvider: true,
    input: ({ providerId }) => ({ provider_id: providerId, type: "delivered", occurred_at: "2030-01-01T00:00:00.000Z" }),
  },
  {
    family: "emailDigests",
    probe: "created_at",
    probeValue: PROBE_INSTANT,
    input: () => ({
      period: "today",
      since: "2030-01-01T00:00:00.000Z",
      until: "2030-01-02T00:00:00.000Z",
      provider: "local",
      model: "none",
      status: "ok",
      started_at: "2030-01-02T00:00:01.000Z",
      completed_at: "2030-01-02T00:00:02.000Z",
    }),
  },
  {
    family: "webhookReceipts",
    probe: "id",
    probeValue: "imposed-webhook-receipt-id",
    input: () => ({ provider: "ses", event_id: token("evt") }),
  },
  {
    family: "sandbox",
    probe: "id",
    probeValue: "imposed-sandbox-id",
    needsProvider: true,
    input: ({ providerId }) => ({ provider_id: providerId, from_address: "from@example.test", subject: token("cap") }),
  },
];

function familyRepository(store: EmailStore, family: string): ResourceRepository<ResourceRow> {
  const repo = (store as unknown as Record<string, unknown>)[family];
  if (typeof repo !== "object" || repo === null) throw new Error(`store carries no ${family} repository`);
  return repo as ResourceRepository<ResourceRow>;
}

function rowIdOf(row: ResourceRow, family: string): string {
  const id = row["id"] ?? row["rowid"];
  if (id === undefined || id === null) throw new Error(`${family} row carries neither id nor rowid`);
  return String(id);
}

function serverOwnedColumnCases(): ConformanceCase[] {
  return FAMILY_PROBES.map((familyProbe) => ({
    id: `resources/${familyProbe.family}-refuses-a-server-owned-${familyProbe.probe}-write`,
    what: `${familyProbe.family}: a create or update naming ${familyProbe.probe} is refused rather than honored or dropped`,
    requires: null,
    async exercise(store: EmailStore): Promise<unknown> {
      const repo = familyRepository(store, familyProbe.family);
      const context = { providerId: familyProbe.needsProvider ? await sampleProviderId(store) : "" };
      const input = familyProbe.input(context);

      const refusedCreate = refusalOf(
        await repo.create({ ...input, [familyProbe.probe]: familyProbe.probeValue }),
        `${familyProbe.family}.create naming ${familyProbe.probe}`,
      );
      const created = must(await repo.create(input), `${familyProbe.family}.create (control)`);
      const id = rowIdOf(created, familyProbe.family);
      const refusedUpdate = refusalOf(
        await repo.update(id, { [familyProbe.probe]: familyProbe.probeValue }),
        `${familyProbe.family}.update naming ${familyProbe.probe}`,
      );
      const after = must(await repo.get(id), `${familyProbe.family}.get after refused update`);
      return { refusedCreate, refusedUpdate, created, after };
    },
    expect(value: unknown): void {
      const { refusedCreate, refusedUpdate, created, after } = value as {
        refusedCreate: Refusal;
        refusedUpdate: Refusal;
        created: ResourceRow;
        after: ResourceRow | null;
      };
      for (const [which, refused] of [
        ["create", refusedCreate],
        ["update", refusedUpdate],
      ] as const) {
        if (refused.code !== "invalid_input" || refused.status !== 422) {
          throw new Error(
            `${familyProbe.family}.${which} naming ${familyProbe.probe} must refuse invalid_input/422, ` +
              `got ${refused.code}/${refused.status}`,
          );
        }
        if (!refused.message.includes(familyProbe.probe)) {
          throw new Error(
            `${familyProbe.family}.${which}'s refusal must name the offending column ${familyProbe.probe}: ` +
              refused.message,
          );
        }
      }
      if (after === null) throw new Error(`${familyProbe.family}: the control row vanished`);
      // The refused update wrote NOTHING: the row still reads back exactly as created.
      const beforeJson = JSON.stringify(created);
      const afterJson = JSON.stringify(after);
      if (beforeJson !== afterJson) {
        throw new Error(`${familyProbe.family}: a refused update still changed the row: ${beforeJson} -> ${afterJson}`);
      }
    },
  }));
}

describe("store seam parity: server-owned columns are refused per family on both arms", () => {
  it(
    "every uniform family refuses id/created_at/updated_at writes identically",
    async () => {
      const cases = serverOwnedColumnCases();
      const report = await runConformanceSuite(
        bothStores().map(({ store }) => store),
        cases,
      );
      expect(conformanceFailures(report)).toEqual([]);
      expect(() => assertUniformCaseCoverage(report, cases)).not.toThrow();
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "the contract's two caller-writable stamps stay writable: sandbox and sequence-step created_at",
    async () => {
      for (const { arm, store } of bothStores()) {
        const providerId = await sampleProviderId(store);
        const captured = must(
          await store.sandbox.create({
            provider_id: providerId,
            from_address: "from@example.test",
            subject: token("kept"),
            created_at: PROBE_INSTANT,
          }),
          `${arm} sandbox.create with created_at`,
        );
        expect(captured["created_at"]).toBe(PROBE_INSTANT);

        const subledger = sequenceSubledgerOf(store);
        if (subledger === null) throw new Error(`${arm} store carries no sequence sub-ledger`);
        const sequence = must(await store.sequences.create({ name: token("seq") }), `${arm} sequences.create`);
        const step = must(
          await subledger.sequenceSteps.create({
            sequence_id: String(sequence["id"]),
            step_number: 1,
            template_name: "welcome",
            created_at: PROBE_INSTANT,
          }),
          `${arm} sequenceSteps.create with created_at`,
        );
        expect(step["created_at"]).toBe(PROBE_INSTANT);
      }
    },
    SUITE_TIMEOUT_MS,
  );
});

describe("store seam parity: redacted credential columns are not a filter oracle", () => {
  it(
    "an equality filter on a redacted provider credential column is refused by both arms",
    async () => {
      const REDACTED_FILTERS = ["api_key", "secret_key", "oauth_refresh_token"] as const;
      for (const { arm, store } of bothStores()) {
        const created = must(
          await store.providers.create({ name: token("provider"), type: "sandbox" }),
          `${arm} providers.create`,
        );
        for (const column of REDACTED_FILTERS) {
          const refused = refusalOf(
            await store.providers.list({ filters: { [column]: "any-guess" } }),
            `${arm} providers.list filtered on ${column}`,
          );
          expect(refused.code).toBe("invalid_input");
          expect(refused.status).toBe(422);
          expect(refused.message).toContain(column);
        }
        // The refusal is about the CREDENTIAL columns, not about filtering: an honest
        // filter still answers.
        const listed = must(
          await store.providers.list({ limit: 500, filters: { type: "sandbox" } }),
          `${arm} providers.list filtered on type`,
        );
        expect(listed.map((row) => String(row["id"]))).toContain(String(created["id"]));
      }
    },
    SUITE_TIMEOUT_MS,
  );
});

describe("store seam parity: a revocation instant is written once", () => {
  it(
    "a repeat revokeSendKey preserves the original revoked_at on both arms",
    async () => {
      for (const { arm, store } of bothStores()) {
        const owner = must(
          await store.owners.create({ type: "human", name: token("owner") }),
          `${arm} owners.create`,
        );
        const minted = must(
          await store.sendKeys.mintSendKey({ owner_id: String(owner["id"]) }),
          `${arm} mintSendKey`,
        );
        const first = must(await store.sendKeys.revokeSendKey(minted.key.id), `${arm} revokeSendKey (first)`);
        if (first === null) throw new Error(`${arm}: the freshly minted key vanished before revocation`);
        const instant = first.revoked_at;
        expect(instant).not.toBeNull();

        // Long enough that a second client-clock stamp could not collide by luck.
        await new Promise((resolve) => setTimeout(resolve, 20));

        const second = must(await store.sendKeys.revokeSendKey(minted.key.id), `${arm} revokeSendKey (repeat)`);
        if (second === null) throw new Error(`${arm}: the revoked key vanished on repeat revocation`);
        expect(second.revoked_at).toBe(instant);

        const read = must(await store.sendKeys.getSendKey(minted.key.id), `${arm} getSendKey after repeat revoke`);
        if (read === null) throw new Error(`${arm}: the revoked key must remain readable`);
        expect(read.revoked_at).toBe(instant);

        // The revocation still HAPPENED: the token no longer verifies, and a revoke
        // of a key that never existed stays an absence.
        expect(must(await store.sendKeys.verifySendKey(minted.token), `${arm} verify after revoke`)).toBeNull();
        expect(must(await store.sendKeys.revokeSendKey("no-such-key"), `${arm} revoke unknown id`)).toBeNull();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "the fixture persists a client-written revoked_at verbatim, as the real service does",
    async () => {
      // Drives the fixture over RAW HTTP, not through the client under test. This is
      // the positive control that keeps the repeat-revoke probe above meaningful: if
      // the fixture quietly went back to stamping its own clock (its old divergence
      // note 2), that probe would stay green even for a client that re-PATCHes on
      // every revoke — certifying an idempotence the client does not have.
      const store = createSqliteEmailStore({ database: db, detail: "raw fixture probe" });
      const owner = must(await store.owners.create({ type: "human", name: token("owner") }), "owners.create");
      const minted = must(await store.sendKeys.mintSendKey({ owner_id: String(owner["id"]) }), "mintSendKey");
      const instant = "2020-03-03T03:03:03.000Z";
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${api.apiKey}` };
      const patched = await fetch(`${api.baseUrl}/v1/send-keys/${minted.key.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ revoked_at: instant }),
      });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { revoked_at?: unknown })["revoked_at"]).toBe(instant);
      const read = await fetch(`${api.baseUrl}/v1/send-keys/${minted.key.id}`, { headers });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { revoked_at?: unknown })["revoked_at"]).toBe(instant);
    },
    SUITE_TIMEOUT_MS,
  );
});
