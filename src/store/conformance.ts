// The conformance suite: ONE set of behavioural cases, run against EVERY store.
//
// EVERY CASE IS BEHAVIOURAL. A case WRITES, then READS BACK, then asserts that
// the read reflects the write. That rule is the difference between a suite and a
// smoke test: a case that only checks a call returns without throwing is passed
// by `return []`, which is precisely the answer this whole program exists to
// delete. Where a write is impossible (an id that does not exist), the case
// asserts the exact refusal instead — never merely "something came back".
//
// THE TWO RULES THE HARNESS ENFORCES
//
// 1. EVERY IMPLEMENTATION EXECUTES EVERY CASE. There is no per-store skip, no
//    `it.if`, no capability-based exclusion. `assertUniformCaseCoverage` fails
//    unless each store's executed case-id list is EXACTLY the declared list.
//
// 2. A MISSING CAPABILITY IS STILL A BEHAVIOUR. A case whose capability the store
//    declares false is not skipped: it is run, and the store is required to answer
//    with the canonical typed refusal. That is what closes the "return an empty
//    array and move on" escape hatch — under this harness, an empty success FAILS
//    the case a refusal would have passed.
//
// WHY `exercise` AND `expect` ARE SPLIT, and why the split shapes every case
// below: the HARNESS — not the case — decides what the right answer is for a
// store lacking the capability. So a gated case performs its ungated setup, calls
// the gated operation, and hands the OUTCOME back unexamined; when the capability
// is missing that outcome IS the refusal, and when it is present `expect` gets
// the read-back it asked for. A case never inspects a capability itself, because
// "I lack the capability so I will return early" must not be expressible inside
// one.
//
// Nothing here reads a deployment mode, and nothing branches on
// `descriptor.kind`. The suite's only inputs are the declared capabilities and
// the observed answers.

import { CAPABILITY_KEYS, isCapabilityRefusal, type CapabilityKey } from "./capabilities.js";
import type { EmailStore } from "./email-store.js";
import type { Outcome } from "./outcome.js";
import type {
  AddressRecord,
  AttachmentInventoryItem,
  DomainRecord,
  MessageCountsRecord,
  MessageInput,
  MessageListRecord,
  MessageRecord,
  Page,
  ResourceInput,
  ResourceRow,
} from "./records.js";
import type { ResourceRepository } from "./repositories.js";

/**
 * One behavioural case.
 *
 * `exercise` and `expect` are split so the HARNESS — not the case — decides what the
 * right answer is for a store lacking the capability. If each case had to handle both
 * paths itself, "I lack the capability so I will just return early" would be
 * expressible inside a case, and the rule above would be advisory.
 */
export interface ConformanceCase {
  /** Stable, unique id. Appears in coverage output; never reused after removal. */
  id: string;
  /** One-line behavioural statement, in terms of observable answers. */
  what: string;
  /**
   * The capability this case needs, or null when every store must be able to do it.
   * When the store declares it false, the case's expected answer becomes the typed
   * capability refusal.
   */
  requires: CapabilityKey | null;
  /** Perform the operation and hand back its raw answer, unexamined. */
  exercise(store: EmailStore): Promise<unknown>;
  /** Assert the SUCCESS expectation. Throws on mismatch. */
  expect(value: unknown, store: EmailStore): void;
}

/**
 * Every case, in declaration order.
 *
 * `capabilityCoverageGaps()` below is the gate: an implementation PR may not land
 * while any declared capability has no case, because an untested capability is
 * exactly where "false" quietly becomes "returns nothing". Built by a hoisted
 * function so this declaration stays at the top of the file while the cases
 * themselves live below the helpers they use.
 */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = Object.freeze(buildConformanceCases());

export interface CaseResult {
  caseId: string;
  /** `refused` is a PASS: the store correctly declined a capability it lacks. */
  status: "passed" | "refused" | "failed";
  detail: string | null;
}

export interface ImplementationReport {
  /** `StoreDescriptor.kind`, used ONLY to label the report. */
  store: string;
  results: CaseResult[];
}

export type ConformanceReport = ImplementationReport[];

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Run every case against every store. Never skips, never short-circuits: a case that
 * throws is recorded as `failed` and the run continues, so one broken case cannot hide
 * the coverage of the rest.
 */
export async function runConformanceSuite(
  stores: EmailStore[],
  cases: readonly ConformanceCase[] = CONFORMANCE_CASES,
): Promise<ConformanceReport> {
  // SNAPSHOT the case list before running anything. A case's `exercise` receives no
  // reference to it, but an implementation under test can reach the exported array (it
  // is the default argument, and it is frozen for the same reason), and a single
  // `cases.length = 1` inside the first case made every store execute one case of three
  // while the coverage assertion — comparing against the mutated array — stayed green.
  const declared = [...cases];
  const report: ConformanceReport = [];
  for (const store of stores) {
    const results: CaseResult[] = [];
    for (const testCase of declared) {
      const mustRefuse = testCase.requires !== null && !store.capabilities[testCase.requires];
      try {
        // DROP any state this case left behind on an earlier store or an earlier run.
        // Without this the `asserted before it wrote anything` guard is inert after the
        // first pass through the suite, and a case whose `exercise` returned early —
        // before its own `stash` — silently asserts against the PREVIOUS store's ids
        // and can pass. Found by adversarial review, which reproduced exactly that.
        CASE_STATE.delete(testCase.id);
        const value = await testCase.exercise(store);
        if (mustRefuse) {
          // The store declared it cannot do this, so the ONLY acceptable answer is the
          // canonical refusal, NAMING THIS CAPABILITY. An empty array, a zero, a null,
          // or a blanket refusal for some other capability all land here as a failure —
          // which is the entire point of running the case instead of skipping it.
          if (!isCapabilityRefusal(value, testCase.requires ?? undefined)) {
            results.push({
              caseId: testCase.id,
              status: "failed",
              detail:
                `declares ${testCase.requires} unavailable but did not return the capability ` +
                `refusal; got ${JSON.stringify(value)}`,
            });
            continue;
          }
          results.push({ caseId: testCase.id, status: "refused", detail: null });
          continue;
        }
        // The OTHER direction, which an earlier version let through: a store that
        // declares a capability AVAILABLE and then refuses the call is also wrong, and
        // was being reported as a pass because the refusal was simply handed to
        // `expect`. A declaration that does not match behaviour is a bug either way
        // round.
        if (testCase.requires !== null && isCapabilityRefusal(value)) {
          results.push({
            caseId: testCase.id,
            status: "failed",
            detail: `declares ${testCase.requires} available but refused the call`,
          });
          continue;
        }
        testCase.expect(value, store);
        results.push({ caseId: testCase.id, status: "passed", detail: null });
      } catch (error) {
        results.push({ caseId: testCase.id, status: "failed", detail: describeError(error) });
      }
    }
    report.push({ store: store.descriptor.kind, results });
  }
  return report;
}

/**
 * Fail unless EVERY implementation executed EVERY declared case.
 *
 * The empty-input checks are not defensive noise. A coverage assertion over zero cases
 * or zero stores passes trivially, and this repo has already shipped two guards that
 * certified nothing that way — a pack guard that blessed an empty tarball, and ban
 * patterns with no positive controls. So an empty run is a FAILURE here, not a pass:
 * the caller has to hand over cases and stores or hear about it.
 */
export function assertUniformCaseCoverage(report: ConformanceReport, cases: readonly ConformanceCase[]): void {
  if (cases.length === 0) {
    throw new Error("conformance run had no cases; a suite that asserts nothing certifies nothing");
  }
  if (report.length === 0) {
    throw new Error("conformance run had no implementations; at least one store must be exercised");
  }
  const expected = cases.map((testCase) => testCase.id);
  const duplicates = expected.filter((id, index) => expected.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`conformance case ids must be unique; duplicated: ${[...new Set(duplicates)].join(", ")}`);
  }
  // Two runs of the SAME store are not two implementations. Uniform coverage across a
  // list that is secretly one backend twice proves nothing about the second one.
  const kinds = report.map((implementation) => implementation.store);
  if (new Set(kinds).size !== kinds.length) {
    throw new Error(`conformance run exercised the same store more than once: ${kinds.join(", ")}`);
  }
  const canonical = [...expected].sort().join("\n");
  for (const implementation of report) {
    const executed = implementation.results.map((result) => result.caseId);
    if (executed.length !== expected.length || [...executed].sort().join("\n") !== canonical) {
      const missing = expected.filter((id) => !executed.includes(id));
      const extra = executed.filter((id) => !expected.includes(id));
      throw new Error(
        `${implementation.store} executed ${executed.length} of ${expected.length} conformance cases` +
          (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
      );
    }
  }
}

/** Every failed case, flattened for a readable assertion message. */
export function conformanceFailures(report: ConformanceReport): string[] {
  return report.flatMap((implementation) =>
    implementation.results
      .filter((result) => result.status === "failed")
      .map((result) => `${implementation.store}/${result.caseId}: ${result.detail ?? "failed"}`),
  );
}

// ---- case-writing helpers ---------------------------------------------------
//
// Deliberately small and deliberately loud. Every one of them THROWS on a
// mismatch rather than returning a boolean, so a case cannot quietly assert
// nothing by forgetting to look at a result.

function show(subject: unknown): string {
  try {
    const encoded = JSON.stringify(subject);
    return encoded === undefined ? String(subject) : encoded;
  } catch {
    return String(subject);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

/**
 * The success value of an outcome, or a thrown failure naming what refused.
 *
 * Used for a case's SETUP, which is always operations no store may refuse. A
 * refusal there is a genuine failure of the case, not an expected answer.
 */
async function must<TValue>(answer: Promise<Outcome<TValue>>, what: string): Promise<TValue> {
  const outcome = await answer;
  if (!outcome.ok) fail(`${what} refused: ${show(outcome)}`);
  return outcome.value;
}

/** Unwrap an outcome handed to `expect`, failing loudly if it is not a success. */
function value(outcome: unknown, what: string): unknown {
  if (outcome === null || typeof outcome !== "object") fail(`${what} did not return an outcome: ${show(outcome)}`);
  const candidate = outcome as { ok?: unknown; value?: unknown };
  if (candidate.ok !== true) fail(`${what} was not a success: ${show(outcome)}`);
  return candidate.value;
}

/** Assert a refusal with an exact code and status — never just "not a success". */
function refusal(outcome: unknown, code: string, status: number, what: string): void {
  if (outcome === null || typeof outcome !== "object") fail(`${what} did not return an outcome: ${show(outcome)}`);
  const candidate = outcome as { ok?: unknown; code?: unknown; status?: unknown; message?: unknown };
  same(candidate.ok, false, `${what} should be a refusal`);
  same(candidate.code, code, `${what} refusal code`);
  same(candidate.status, status, `${what} refusal status`);
  check(typeof candidate.message === "string" && candidate.message.length > 0, `${what} refusal carries no message`);
}

function asObject(subject: unknown, what: string): Record<string, unknown> {
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
    fail(`${what} is not a record: ${show(subject)}`);
  }
  return subject as Record<string, unknown>;
}

function asArray(subject: unknown, what: string): unknown[] {
  if (!Array.isArray(subject)) fail(`${what} is not an array: ${show(subject)}`);
  return subject;
}

function countsOf(subject: unknown, what: string): MessageCountsRecord {
  return asObject(subject, what) as unknown as MessageCountsRecord;
}

function recordOf(subject: unknown, what: string): MessageRecord {
  const row = asObject(subject, what);
  asArray(row["labels"], `${what} labels`);
  asArray(row["to_addrs"], `${what} recipients`);
  return row as unknown as MessageRecord;
}

function pageOf(subject: unknown, what: string): Page<MessageListRecord> {
  const page = asObject(subject, what);
  asArray(page["items"], `${what} items`);
  return page as unknown as Page<MessageListRecord>;
}

/**
 * State a case carries from its write to its assertion.
 *
 * The harness calls `exercise` and `expect` separately and hands `expect` only the
 * final answer, so the ids and tokens the write minted have to travel some other
 * way. Keyed by case id, written by `exercise`, read by `expect` — the smallest
 * thing that works, and visible here rather than hidden in a closure that would be
 * shared across every store in a run.
 */
const CASE_STATE = new Map<string, Record<string, unknown>>();

function stash(caseId: string, state: Record<string, unknown>): void {
  CASE_STATE.set(caseId, state);
}

function stashed(caseId: string): Record<string, unknown> {
  const state = CASE_STATE.get(caseId);
  if (!state) fail(`case ${caseId} asserted before it wrote anything`);
  return state;
}

// Unique-per-run tokens, so a suite run twice against one store never collides with
// its own earlier rows. Two consequences worth stating rather than assuming:
//
//   * COUNT assertions are DELTAS (read before, write, read after) unless the count is
//     itself token-scoped, in which case it is absolute and safe.
//   * LIST assertions read the FIRST page and require the row just written to be on
//     it. That is not an assumption about an empty database — it is an assertion about
//     ORDERING: every list on this seam is newest-first, so a row created a moment ago
//     is on page one. A store that ordered its lists arbitrarily would fail here, and
//     should.
const RUN_TAG = Math.random().toString(36).slice(2, 10);
let mintCounter = 0;

function token(hint: string): string {
  mintCounter += 1;
  return `${hint}-${RUN_TAG}-${mintCounter}`;
}

function domainToken(): string {
  return `${token("dom")}.test`;
}

/** An unread inbound message addressed to `to`, with a subject nothing else shares. */
function inboundMessage(to: string, subject: string): MessageInput {
  return {
    direction: "inbound",
    from_addr: `sender-${RUN_TAG}@example.test`,
    to_addrs: [to],
    subject,
    body_text: `body of ${subject}`,
    received_at: new Date().toISOString(),
    is_read: false,
  };
}

function outboundMessage(subject: string): MessageInput {
  return {
    direction: "outbound",
    from_addr: `outbound-${RUN_TAG}@example.test`,
    to_addrs: [`recipient-${RUN_TAG}@example.test`],
    subject,
    body_text: `body of ${subject}`,
    status: "queued",
  };
}

async function provider(store: EmailStore): Promise<string> {
  const row = await must(store.providers.create({ name: token("provider"), type: "sandbox" }), "providers.create");
  return String(asObject(row, "provider row")["id"]);
}

async function ownerId(store: EmailStore): Promise<string> {
  const row = await must(store.owners.create({ type: "human", name: token("owner") }), "owners.create");
  return String(asObject(row, "owner row")["id"]);
}

async function domain(store: EmailStore): Promise<DomainRecord> {
  const providerId = await provider(store);
  return must(store.domains.createDomain({ domain: domainToken(), provider: providerId }), "domains.createDomain");
}

async function address(
  store: EmailStore,
  quota?: number | null,
  displayName?: string,
): Promise<AddressRecord> {
  const registered = await domain(store);
  const input = {
    email: `user-${token("addr")}@${registered.domain}`,
    daily_quota: quota ?? null,
    display_name: displayName ?? null,
  };
  return must(store.addresses.createAddress(input), "addresses.createAddress");
}

/** Walk every page of a message keyset scan, stopping at the first refusal. */
async function drainMessages(
  store: EmailStore,
  base: { subject: string; limit: number },
): Promise<{ ids: string[] } | { refused: unknown }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const answer = await store.messages.listMessages({ subject: base.subject, limit: base.limit, cursor });
    if (!answer.ok) return { refused: answer };
    ids.push(...answer.value.items.map((item) => item.id));
    if (answer.value.next_cursor === null) return { ids };
    cursor = answer.value.next_cursor;
  }
  fail("a keyset scan of five rows did not terminate within 20 pages");
}

async function drainAttachments(
  store: EmailStore,
  limit: number,
): Promise<{ items: AttachmentInventoryItem[] } | { refused: unknown }> {
  const items: AttachmentInventoryItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const answer = await store.emailContent.listAttachments({ limit, cursor });
    if (!answer.ok) return { refused: answer };
    items.push(...answer.value.items);
    if (answer.value.next_cursor === null) return { items };
    cursor = answer.value.next_cursor;
  }
  fail("an attachment inventory scan did not terminate within 200 pages");
}

// ---- uniform resource case-writing helpers --------------------------------

type UniformResourceRepository = ResourceRepository<ResourceRow>;

interface UniformResourceFixture {
  input: ResourceInput;
  /** Scalar fields whose exact round trip proves the family used the right schema. */
  expected: ResourceInput;
}

interface UniformResourceCaseSpec {
  family: string;
  repository(store: EmailStore): UniformResourceRepository;
  create(store: EmailStore, variant: "first" | "second"): Promise<UniformResourceFixture>;
  patch: UniformResourceFixture;
}

function uniformResourceId(row: Record<string, unknown>, what: string): string {
  // SQLite's webhook-receipts table has a composite primary key and is addressed by
  // rowid; Postgres gives that resource an ordinary id. The repository deliberately
  // exposes whichever identity its backing schema can address.
  const id = row["id"] ?? row["rowid"];
  if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0) {
    fail(`${what} carries no addressable id: ${show(row)}`);
  }
  return String(id);
}

function assertResourceFields(row: Record<string, unknown>, expected: ResourceInput, what: string): void {
  for (const [field, wanted] of Object.entries(expected)) {
    same(row[field], wanted, `${what} ${field}`);
  }
}

/**
 * Enumerate a uniform family through its public offset paging contract.
 *
 * The stores intentionally publish different row orders, so callers compare the
 * resulting identities as a set. Paging still requires each store's own order to be
 * total: a repeated or missing row makes one of the per-family cases fail.
 */
async function drainUniformResource(repository: UniformResourceRepository, family: string): Promise<ResourceRow[]> {
  const rows: ResourceRow[] = [];
  const limit = 2;
  for (let page = 0; page < 250; page += 1) {
    const batch = await must(repository.list({ limit, offset: rows.length }), `${family}.list page ${page + 1}`);
    rows.push(...batch);
    if (batch.length < limit) return rows;
  }
  fail(`${family}.list did not terminate within 250 pages`);
}

function uniformResourceCase(spec: UniformResourceCaseSpec): ConformanceCase {
  const caseId = `resources/${spec.family}/uniform-crud-round-trip`;
  return {
    id: caseId,
    what: `${spec.family} create/read/list/update/delete behaviour round-trips through its uniform resource repository`,
    requires: null,
    async exercise(store: EmailStore): Promise<unknown> {
      const repository = spec.repository(store);
      const firstFixture = await spec.create(store, "first");
      const secondFixture = await spec.create(store, "second");
      const first = asObject(
        await must(repository.create(firstFixture.input), `${spec.family}.create first`),
        `created ${spec.family}`,
      );
      const second = asObject(
        await must(repository.create(secondFixture.input), `${spec.family}.create second`),
        `second ${spec.family}`,
      );
      const firstId = uniformResourceId(first, `created ${spec.family}`);
      const secondId = uniformResourceId(second, `second ${spec.family}`);
      check(firstId !== secondId, `${spec.family}.create returned the same identity for two writes`);
      assertResourceFields(first, firstFixture.expected, `created ${spec.family}`);

      const read = asObject(await must(repository.get(firstId), `${spec.family}.get`), `read ${spec.family}`);
      assertResourceFields(read, firstFixture.expected, `read ${spec.family}`);

      const listed = await drainUniformResource(repository, spec.family);
      const createdIds = [firstId, secondId].sort();
      const listedIds = listed
        .map((row) => uniformResourceId(row, `listed ${spec.family}`))
        .filter((id) => createdIds.includes(id))
        .sort();
      same(show(listedIds), show(createdIds), `${spec.family}.list emits both created rows exactly once`);

      // Every family performs its own validation. Testing this only on contacts lets
      // one miswired schema accept and silently drop a field while the suite stays green.
      refusal(
        await repository.create({ nonsense_column: 1 }),
        "invalid_input",
        422,
        `${spec.family}.create with an unknown column`,
      );

      const updated = asObject(
        await must(repository.update(firstId, spec.patch.input), `${spec.family}.update`),
        `updated ${spec.family}`,
      );
      assertResourceFields(updated, spec.patch.expected, `updated ${spec.family}`);
      const readAfterUpdate = asObject(
        await must(repository.get(firstId), `${spec.family}.get after update`),
        `read updated ${spec.family}`,
      );
      assertResourceFields(readAfterUpdate, spec.patch.expected, `read updated ${spec.family}`);

      same(await must(repository.remove(secondId), `${spec.family}.remove second`), true, "the companion remove");
      same(await must(repository.remove(firstId), `${spec.family}.remove`), true, "the first remove");
      same(await must(repository.remove(firstId), `${spec.family}.remove again`), false, "the second remove");
      stash(caseId, { id: firstId });
      return repository.get(firstId);
    },
    expect(outcome: unknown): void {
      stashed(caseId);
      same(value(outcome, `${spec.family}.get after remove`), null, `a removed ${spec.family} row must not be readable`);
    },
  };
}

function simpleFixture(input: ResourceInput, expected: ResourceInput = input): UniformResourceFixture {
  return { input, expected };
}

function buildUniformResourceCases(): ConformanceCase[] {
  const specs: UniformResourceCaseSpec[] = [
    {
      family: "contacts",
      repository(store) {
        return store.contacts;
      },
      async create(_store, variant) {
        const email = `${token(`contact-${variant}`)}@example.test`;
        return simpleFixture({ email, name: `Contact ${variant}` });
      },
      patch: simpleFixture({ name: "Updated contact" }),
    },
    {
      family: "groups",
      repository(store) {
        return store.groups;
      },
      async create(_store, variant) {
        return simpleFixture({ name: token(`group-${variant}`), description: `Group ${variant}` });
      },
      patch: simpleFixture({ description: "Updated group" }),
    },
    {
      family: "owners",
      repository(store) {
        return store.owners;
      },
      async create(_store, variant) {
        return simpleFixture({ type: "human", name: token(`owner-${variant}`) });
      },
      patch: simpleFixture({ name: "Updated owner" }),
    },
    {
      family: "providers",
      repository(store) {
        return store.providers;
      },
      async create(_store, variant) {
        return simpleFixture({ name: token(`provider-${variant}`), type: "sandbox", region: `test-${variant}` });
      },
      patch: simpleFixture({ region: "test-updated" }),
    },
    {
      family: "templates",
      repository(store) {
        return store.templates;
      },
      async create(_store, variant) {
        return simpleFixture({ name: token(`template-${variant}`), subject_template: `Subject ${variant}` });
      },
      patch: simpleFixture({ subject_template: "Updated subject" }),
    },
    {
      family: "sequences",
      repository(store) {
        return store.sequences;
      },
      async create(_store, variant) {
        return simpleFixture({
          name: token(`sequence-${variant}`),
          description: `Sequence ${variant}`,
          status: "active",
        });
      },
      patch: simpleFixture({ description: "Updated sequence", status: "paused" }),
    },
    {
      family: "scheduled",
      repository(store) {
        return store.scheduled;
      },
      async create(store, variant) {
        const providerId = await provider(store);
        return simpleFixture({
          provider_id: providerId,
          from_address: `${token(`scheduled-${variant}`)}@example.test`,
          subject: `Scheduled ${variant}`,
          scheduled_at: variant === "first" ? "2030-01-01T01:00:00.000Z" : "2030-01-01T02:00:00.000Z",
        });
      },
      patch: simpleFixture({ subject: "Updated scheduled message" }),
    },
    {
      family: "aliases",
      repository(store) {
        return store.aliases;
      },
      async create(_store, variant) {
        return simpleFixture({
          domain: `${token(`alias-${variant}`)}.test`,
          local_part: `local-${variant}`,
          target_address: `${token(`target-${variant}`)}@example.test`,
        });
      },
      patch: simpleFixture({ target_address: "updated-alias@example.test" }),
    },
    {
      family: "forwarding",
      repository(store) {
        return store.forwarding;
      },
      async create(_store, variant) {
        return simpleFixture({
          source_address: `${token(`forward-source-${variant}`)}@example.test`,
          target_address: `${token(`forward-target-${variant}`)}@example.test`,
          mode: "app-copy",
        });
      },
      patch: simpleFixture({ target_address: "updated-forward@example.test" }),
    },
    {
      family: "warming",
      repository(store) {
        return store.warming;
      },
      async create(_store, variant) {
        return simpleFixture({
          domain: `${token(`warming-${variant}`)}.test`,
          target_daily_volume: variant === "first" ? 100 : 200,
          start_date: variant === "first" ? "2030-02-01" : "2030-02-02",
          status: "active",
        });
      },
      patch: simpleFixture({ status: "paused" }),
    },
    {
      family: "events",
      repository(store) {
        return store.events;
      },
      async create(store, variant) {
        const providerId = await provider(store);
        return simpleFixture({
          provider_id: providerId,
          provider_event_id: token(`event-${variant}`),
          type: "delivered",
          recipient: `${variant}@example.test`,
          occurred_at: variant === "first" ? "2030-03-01T01:00:00.000Z" : "2030-03-01T02:00:00.000Z",
        });
      },
      patch: simpleFixture({ recipient: "updated-event@example.test" }),
    },
    {
      family: "emailDigests",
      repository(store) {
        return store.emailDigests;
      },
      async create(_store, variant) {
        const hour = variant === "first" ? "01" : "02";
        return simpleFixture({
          period: "today",
          since: `2030-04-01T${hour}:00:00.000Z`,
          until: `2030-04-01T${hour}:30:00.000Z`,
          provider: "local",
          model: `model-${variant}`,
          status: "ok",
          summary: `Digest ${variant}`,
          started_at: `2030-04-01T${hour}:00:00.000Z`,
          completed_at: `2030-04-01T${hour}:01:00.000Z`,
        });
      },
      patch: simpleFixture({ summary: "Updated digest" }),
    },
    {
      family: "webhookReceipts",
      repository(store) {
        return store.webhookReceipts;
      },
      async create(_store, variant) {
        return simpleFixture({
          provider: "resend",
          event_id: token(`webhook-${variant}`),
          resource_id: `resource-${variant}`,
          completed_at: variant === "first" ? "2030-05-01T01:00:00.000Z" : "2030-05-01T02:00:00.000Z",
        });
      },
      patch: simpleFixture({ resource_id: "updated-resource" }),
    },
    {
      family: "sandbox",
      repository(store) {
        return store.sandbox;
      },
      async create(store, variant) {
        const providerId = await provider(store);
        return simpleFixture({
          provider_id: providerId,
          from_address: `${token(`sandbox-${variant}`)}@example.test`,
          subject: `Sandbox ${variant}`,
        });
      },
      patch: simpleFixture({ subject: "Updated sandbox message" }),
    },
  ];
  return specs.map(uniformResourceCase);
}

// ---- the cases --------------------------------------------------------------

function buildConformanceCases(): ConformanceCase[] {
  return [
    // ---- domains ---------------------------------------------------------
    {
      id: "domains/create-then-read-back",
      what: "a created domain is readable by id with the fields it was created with",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const providerId = await provider(store);
        const name = domainToken();
        const created = await must(
          store.domains.createDomain({ domain: name, provider: providerId, status: "pending", notes: "hello" }),
          "createDomain",
        );
        stash("domains/create-then-read-back", { name, id: created.id, provider: providerId });
        return store.domains.getDomain(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("domains/create-then-read-back");
        const read = asObject(value(outcome, "getDomain"), "domain record");
        same(read["id"], state["id"], "domain id");
        same(read["domain"], state["name"], "domain name");
        same(read["status"], "pending", "domain status");
        same(read["notes"], "hello", "domain notes");
        same(read["verified"], false, "domain verified flag");
        same(read["provider"], state["provider"], "the provider the domain was created against");
      },
    },
    {
      id: "domains/lookup-by-name-finds-the-created-row",
      what: "getDomainByName returns the row created under that name, and null for an unknown one",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        stash("domains/lookup-by-name-finds-the-created-row", { id: created.id, name: created.domain });
        const missing = await must(store.domains.getDomainByName(domainToken()), "getDomainByName(unknown)");
        same(missing, null, "an unregistered domain name resolves to null");
        return store.domains.getDomainByName(created.domain);
      },
      expect(outcome: unknown): void {
        const state = stashed("domains/lookup-by-name-finds-the-created-row");
        const read = asObject(value(outcome, "getDomainByName"), "domain record");
        same(read["id"], state["id"], "domain id");
        same(read["domain"], state["name"], "domain name");
      },
    },
    {
      id: "domains/update-then-read-back",
      what: "an updated domain reads back with the patched status, notes and verified flag",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        const updated = await must(
          store.domains.updateDomain(created.id, { status: "verified", verified: true, notes: "patched" }),
          "updateDomain",
        );
        check(updated !== null, "updateDomain answered null for a domain it had just created");
        stash("domains/update-then-read-back", { id: created.id });
        return store.domains.getDomain(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("domains/update-then-read-back");
        const read = asObject(value(outcome, "getDomain"), "domain record");
        same(read["id"], state["id"], "domain id");
        same(read["status"], "verified", "patched status");
        same(read["notes"], "patched", "patched notes");
        same(read["verified"], true, "patched verified flag");
      },
    },
    {
      id: "domains/delete-removes-the-row",
      what: "a deleted domain reports true once, is unreadable afterwards, and reports false on a second delete",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        same(await must(store.domains.deleteDomain(created.id), "deleteDomain"), true, "the first delete");
        same(await must(store.domains.deleteDomain(created.id), "deleteDomain again"), false, "the second delete");
        return store.domains.getDomain(created.id);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "getDomain after delete"), null, "a deleted domain must not be readable");
      },
    },
    {
      id: "domains/list-includes-the-created-row",
      what: "listDomains returns the domain that was just created, exactly once",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        stash("domains/list-includes-the-created-row", { id: created.id });
        return store.domains.listDomains({ limit: 500 });
      },
      expect(outcome: unknown): void {
        const state = stashed("domains/list-includes-the-created-row");
        const rows = asArray(value(outcome, "listDomains"), "domain list");
        const found = rows.filter((row) => asObject(row, "domain row")["id"] === state["id"]);
        same(found.length, 1, "the created domain appears exactly once in the list");
      },
    },

    // ---- addresses -------------------------------------------------------
    {
      id: "addresses/create-then-read-back",
      what: "a created address reads back by id with its email, derived domain, display name and quota",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const registered = await domain(store);
        const email = `user-${token("addr")}@${registered.domain}`;
        const created = await must(
          store.addresses.createAddress({ email, display_name: "Test User", daily_quota: 25 }),
          "createAddress",
        );
        stash("addresses/create-then-read-back", { id: created.id, email, domain: registered.domain });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("addresses/create-then-read-back");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["email"], state["email"], "address email");
        same(read["domain"], state["domain"], "address domain, derived from the email");
        same(read["display_name"], "Test User", "address display name");
        same(read["daily_quota"], 25, "address daily quota");
      },
    },
    {
      id: "addresses/list-includes-the-created-row",
      what: "listAddresses returns the address that was just created, exactly once",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        stash("addresses/list-includes-the-created-row", { id: created.id });
        return store.addresses.listAddresses({ limit: 500 });
      },
      expect(outcome: unknown): void {
        const state = stashed("addresses/list-includes-the-created-row");
        const rows = asArray(value(outcome, "listAddresses"), "address list");
        const found = rows.filter((row) => asObject(row, "address row")["id"] === state["id"]);
        same(found.length, 1, "the created address appears exactly once in the list");
      },
    },
    {
      id: "addresses/quota-clear-is-not-a-no-op",
      what: "an explicit quota clear reads back as null while an update that omits the quota preserves it",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store, 10);
        same(created.daily_quota, 10, "the address was created with a quota");
        // An update that says nothing about the quota must PRESERVE it.
        const preserved = await must(
          store.addresses.updateAddress(created.id, { display_name: "renamed" }),
          "updateAddress without a quota",
        );
        same(preserved === null ? null : preserved.daily_quota, 10, "an omitted quota is preserved");
        // An explicit clear must CLEAR it. Without `dailyQuotaSet` the two requests are
        // indistinguishable and the clear silently becomes the no-op above.
        await must(
          store.addresses.updateAddress(created.id, { dailyQuotaSet: true, daily_quota: null }),
          "updateAddress clearing the quota",
        );
        stash("addresses/quota-clear-is-not-a-no-op", { id: created.id });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("addresses/quota-clear-is-not-a-no-op");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["daily_quota"], null, "an explicit clear must read back as null");
        same(read["display_name"], "renamed", "the earlier rename survived");
      },
    },
    {
      id: "addresses/delete-removes-the-row",
      what: "a deleted address is unreadable and a second delete reports false",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        same(await must(store.addresses.deleteAddress(created.id), "deleteAddress"), true, "the first delete");
        same(await must(store.addresses.deleteAddress(created.id), "deleteAddress again"), false, "the second delete");
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "getAddress after delete"), null, "a deleted address must not be readable");
      },
    },

    // ---- address lifecycle ----------------------------------------------
    {
      id: "address-lifecycle/suspend-then-activate-round-trip",
      what: "suspending an address reads back as suspended, and activating it reads back as active",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        const suspended = await must(store.addressLifecycle.suspendAddress(created.id), "suspendAddress");
        same(suspended === null ? null : suspended.status, "suspended", "suspend answers with the new status");
        const readSuspended = await must(store.addresses.getAddress(created.id), "getAddress after suspend");
        same(readSuspended === null ? null : readSuspended.status, "suspended", "suspension is persisted");
        await must(store.addressLifecycle.activateAddress(created.id), "activateAddress");
        stash("address-lifecycle/suspend-then-activate-round-trip", { id: created.id });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("address-lifecycle/suspend-then-activate-round-trip");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["status"], "active", "activation is persisted");
      },
    },
    {
      id: "address-lifecycle/quota-write-round-trip",
      what: "setAddressQuota persists, a null clears the limit, and a negative quota is refused",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        await must(store.addressLifecycle.setAddressQuota(created.id, 7), "setAddressQuota");
        const read = await must(store.addresses.getAddress(created.id), "getAddress after the quota write");
        same(read === null ? null : read.daily_quota, 7, "the quota is persisted");
        refusal(await store.addressLifecycle.setAddressQuota(created.id, -1), "invalid_input", 422, "a negative quota");
        await must(store.addressLifecycle.setAddressQuota(created.id, null), "setAddressQuota(null)");
        stash("address-lifecycle/quota-write-round-trip", { id: created.id });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("address-lifecycle/quota-write-round-trip");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["daily_quota"], null, "a null quota clears the limit");
      },
    },
    {
      id: "address-lifecycle/ownership-patch-round-trip",
      what: "an ownership patch reads back on the address, and a null clears the assignment",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        const owner = await ownerId(store);
        await must(
          store.addressLifecycle.applyAddressOwnership(created.id, { owner_id: owner }),
          "applyAddressOwnership",
        );
        const read = await must(store.addresses.getAddress(created.id), "getAddress after the ownership write");
        same(read === null ? null : read.owner_id, owner, "the owner is persisted");
        await must(
          store.addressLifecycle.applyAddressOwnership(created.id, { owner_id: null }),
          "applyAddressOwnership clearing the owner",
        );
        stash("address-lifecycle/ownership-patch-round-trip", { id: created.id });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("address-lifecycle/ownership-patch-round-trip");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["owner_id"], null, "a null owner clears the assignment");
      },
    },

    // ---- provisioning ----------------------------------------------------
    {
      id: "provisioning/domain-patch-round-trip",
      what: "a domain provisioning patch reads back on the domain record",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        await must(
          store.provisioning.applyDomainProvisioning(created.id, {
            provisioning_status: "inbound_ready",
            mail_from_domain: `mail.${created.domain}`,
            nameservers_json: ["ns1.example.test", "ns2.example.test"],
          }),
          "applyDomainProvisioning",
        );
        stash("provisioning/domain-patch-round-trip", { id: created.id, domain: created.domain });
        return store.domains.getDomain(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("provisioning/domain-patch-round-trip");
        const read = asObject(value(outcome, "getDomain"), "domain record");
        same(read["id"], state["id"], "domain id");
        same(read["provisioning_status"], "inbound_ready", "provisioning status");
        same(read["mail_from_domain"], `mail.${String(state["domain"])}`, "mail-from domain");
        const nameservers = asArray(read["nameservers_json"], "nameservers");
        same(nameservers.length, 2, "nameserver count");
        same(nameservers[0], "ns1.example.test", "the first nameserver");
      },
    },
    {
      id: "provisioning/address-patch-round-trip",
      what: "an address provisioning patch reads back on the address record",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        await must(
          store.provisioning.applyAddressProvisioning(created.id, {
            provisioning_status: "ready",
            receive_strategy: "forward",
            forward_to: `forward-${RUN_TAG}@example.test`,
          }),
          "applyAddressProvisioning",
        );
        stash("provisioning/address-patch-round-trip", { id: created.id });
        return store.addresses.getAddress(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("provisioning/address-patch-round-trip");
        const read = asObject(value(outcome, "getAddress"), "address record");
        same(read["id"], state["id"], "address id");
        same(read["provisioning_status"], "ready", "provisioning status");
        same(read["receive_strategy"], "forward", "receive strategy");
        same(read["forward_to"], `forward-${RUN_TAG}@example.test`, "forward target");
      },
    },
    {
      id: "provisioning/event-recorded-then-listed",
      what: "a recorded provisioning event appears in the event list with the state it recorded",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await domain(store);
        await must(
          store.provisioning.recordProvisioningEvent({
            entity_type: "domain",
            entity_id: created.id,
            from_state: "none",
            to_state: "dns_pending",
          }),
          "recordProvisioningEvent",
        );
        stash("provisioning/event-recorded-then-listed", { entity: created.id });
        return store.provisioning.listProvisioningEvents({ limit: 500 });
      },
      expect(outcome: unknown): void {
        const state = stashed("provisioning/event-recorded-then-listed");
        const rows = asArray(value(outcome, "listProvisioningEvents"), "provisioning events");
        const found = rows
          .map((row) => asObject(row, "provisioning event"))
          .filter((row) => row["entity_id"] === state["entity"]);
        same(found.length, 1, "the recorded event appears exactly once");
        same(asObject(found[0], "provisioning event")["to_state"], "dns_pending", "the recorded target state");
      },
    },

    // ---- messages --------------------------------------------------------
    {
      id: "messages/create-then-read-back",
      what: "a created message reads back by id with its addresses, subject, body and labels",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("subject");
        const input = inboundMessage(`inbox-${RUN_TAG}@example.test`, subject);
        const messageId = `<${token("mid")}@example.test>`;
        const parentId = `<${token("parent")}@example.test>`;
        const receivedAt = new Date(Date.now() - 90_000).toISOString();
        const created = await must(
          store.messages.createMessage({
            ...input,
            labels: ["needs-reply"],
            cc_addrs: ["cc@example.test"],
            body_html: `<p>${subject}</p>`,
            message_id: messageId,
            in_reply_to: parentId,
            received_at: receivedAt,
            headers: { "X-Conformance": subject },
            attachments: [{ filename: `${subject}.txt`, content_type: "text/plain", size: 4 }],
          }),
          "createMessage",
        );
        stash("messages/create-then-read-back", {
          id: created.id,
          subject,
          to: input.to_addrs[0],
          messageId,
          parentId,
          receivedAt,
        });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/create-then-read-back");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        same(read.subject, state["subject"], "message subject");
        same(read.direction, "inbound", "message direction");
        same(read.to_addrs.length, 1, "recipient count");
        same(read.to_addrs[0], state["to"], "recipient");
        same(read.cc_addrs[0], "cc@example.test", "cc recipient");
        same(read.body_text, `body of ${String(state["subject"])}`, "message body");
        same(read.body_html, `<p>${String(state["subject"])}</p>`, "message html body");
        check(read.labels.includes("needs-reply"), `the written label is missing: ${show(read.labels)}`);
        same(read.is_read, false, "an unread message reads back unread");
        // Every remaining written field. Each of these was silently droppable before it
        // was asserted, and a mapper returning `[]`, `{}` or null for any of them is the
        // plausible-wrong-answer failure at record level.
        same(read.message_id, state["messageId"], "message id header");
        same(read.in_reply_to, state["parentId"], "in-reply-to");
        same(read.received_at, state["receivedAt"], "received_at is the written instant, not now");
        same(read.headers["X-Conformance"], state["subject"], "written headers round-trip");
        same(read.attachments.length, 1, "written attachment metadata round-trips");
        const attachment = asObject(read.attachments[0], "attachment metadata");
        same(attachment["filename"], `${String(state["subject"])}.txt`, "attachment filename");
        same(attachment["content_type"], "text/plain", "attachment content type");
      },
    },
    {
      id: "messages/resolve-id-answers-not-found-for-an-unknown-id",
      what: "resolveMessageId resolves a full id it just created and refuses an unknown one with not_found",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(store.messages.createMessage(outboundMessage(token("subject"))), "createMessage");
        const resolved = await must(store.messages.resolveMessageId(created.id), "resolveMessageId");
        same(resolved.id, created.id, "a full id resolves to itself");
        // A PREFIX must resolve too — that is what the operation is for (it is the short
        // id a list prints). 30 characters of a minted id is unique in practice, and an
        // implementation that only matched whole ids would fail here.
        const byPrefix = await must(
          store.messages.resolveMessageId(created.id.slice(0, 30)),
          "resolveMessageId(prefix)",
        );
        same(byPrefix.id, created.id, "a unique id prefix resolves to the whole id");
        // "no such message" is a REFUSAL, not a null: a caller has to be able to tell it
        // from "your prefix matched several", which carries a different status.
        return store.messages.resolveMessageId(`missing-${token("id")}`);
      },
      expect(outcome: unknown): void {
        refusal(outcome, "not_found", 404, "resolveMessageId for an unknown id");
      },
    },
    {
      id: "messages/upsert-is-idempotent-on-source-id",
      what: "upserting twice on one source_id inserts once, updates second, and leaves a single row",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const sourceId = token("source");
        const first = await must(
          store.messages.upsertMessage({ ...outboundMessage(token("subject")), source_id: sourceId }),
          "upsertMessage (first)",
        );
        same(first.inserted, true, "the first upsert inserts");
        // Local state, set AFTER the import and before the replay. An upsert that writes
        // its whole column set resets all of this — so a re-run of an importer marks the
        // mailbox unread, drops every label and re-sorts it to now. "Idempotent" has to
        // mean the second call leaves everything it was not told about alone.
        const keptLabel = token("kept-label");
        const importedAt = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
        await must(
          store.messages.updateMessageStatus(first.record.id, { is_read: true, is_starred: true }),
          "set the read and star flags before the replay",
        );
        await must(store.inbound.addInboundLabel(first.record.id, keptLabel), "label it before the replay");
        const secondSubject = token("subject");
        const second = await must(
          store.messages.upsertMessage({ ...outboundMessage(secondSubject), source_id: sourceId }),
          "upsertMessage (second)",
        );
        same(second.inserted, false, "the second upsert updates rather than inserting");
        same(second.record.id, first.record.id, "both upserts address the same row");
        // A source_id is the fence; without one there is nothing to be idempotent on.
        refusal(
          await store.messages.upsertMessage(outboundMessage(token("subject"))),
          "invalid_input",
          422,
          "upsertMessage without a source_id",
        );
        stash("messages/upsert-is-idempotent-on-source-id", {
          id: first.record.id,
          subject: secondSubject,
          source: sourceId,
          keptLabel,
          importedAt,
        });
        return store.messages.getMessage(first.record.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/upsert-is-idempotent-on-source-id");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        same(read.subject, state["subject"], "the second upsert's subject won");
        same(read.source_id, state["source"], "source_id round-trips");
        // Everything the replay was NOT told about must be untouched.
        same(read.is_read, true, "a replay must not reset the read flag");
        same(read.is_starred, true, "a replay must not reset the star");
        check(
          read.labels.includes(String(state["keptLabel"])),
          `a replay must not drop labels: ${show(read.labels)}`,
        );
      },
    },
    {
      id: "messages/status-patch-round-trip",
      what: "a status patch reads back on the message, and patching an unknown id answers null",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(store.messages.createMessage(outboundMessage(token("subject"))), "createMessage");
        const providerMessageId = token("provider-msg");
        const patched = await must(
          store.messages.updateMessageStatus(created.id, {
            status: "delivered",
            provider_message_id: providerMessageId,
          }),
          "updateMessageStatus",
        );
        check(patched !== null, "updateMessageStatus answered null for a message it had just created");
        same(
          await must(
            store.messages.updateMessageStatus(`missing-${token("id")}`, { status: "delivered" }),
            "updateMessageStatus for an unknown id",
          ),
          null,
          "patching an unknown message answers null",
        );
        // A patch that ADDS one label and REMOVES another, in one call. Two
        // read-modify-writes of the same stored label set inside one statement is how
        // an implementation loses the first edit; only a combined patch catches it.
        const kept = token("kept-label");
        const dropped = token("dropped-label");
        await must(store.messages.updateMessageStatus(created.id, { add_label: dropped }), "add the first label");
        await must(
          store.messages.updateMessageStatus(created.id, { add_label: kept, remove_label: dropped }),
          "add one label and remove another in one patch",
        );
        stash("messages/status-patch-round-trip", { id: created.id, providerMessageId, kept, dropped });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/status-patch-round-trip");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        same(read.status, "delivered", "patched status");
        same(read.provider_message_id, state["providerMessageId"], "patched provider message id");
        check(read.labels.includes(String(state["kept"])), `the added label is missing: ${show(read.labels)}`);
        check(!read.labels.includes(String(state["dropped"])), `the removed label survived: ${show(read.labels)}`);
      },
    },
    {
      id: "messages/delete-removes-the-row",
      what: "a deleted message is unreadable and a second delete reports false",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(store.messages.createMessage(outboundMessage(token("subject"))), "createMessage");
        same(await must(store.messages.deleteMessage(created.id), "deleteMessage"), true, "the first delete");
        same(await must(store.messages.deleteMessage(created.id), "deleteMessage again"), false, "the second delete");
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "getMessage after delete"), null, "a deleted message must not be readable");
      },
    },
    {
      id: "messages/counts-follow-the-writes",
      what: "writing one unread inbound message raises the inbox, unread and total counts by exactly one",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const before = await must(store.messages.messageCounts(), "messageCounts (before)");
        await must(
          store.messages.createMessage(inboundMessage(`counted-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        stash("messages/counts-follow-the-writes", { before });
        return store.messages.messageCounts();
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/counts-follow-the-writes");
        const before = countsOf(state["before"], "counts before");
        const after = countsOf(value(outcome, "messageCounts"), "counts after");
        same(after.total, before.total + 1, "total count");
        same(after.inbox, before.inbox + 1, "inbox count");
        same(after.unread, before.unread + 1, "unread count");
      },
    },

    {
      id: "messages/counts-scope-to-a-recipient-domain",
      what: "counts scoped to one recipient domain see that domain's mail and nothing else",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const scopedDomain = domainToken();
        for (let index = 0; index < 2; index += 1) {
          await must(
            store.messages.createMessage(inboundMessage(`scoped-${index}@${scopedDomain}`, token("subject"))),
            "createMessage (in scope)",
          );
        }
        await must(
          store.messages.createMessage(inboundMessage(`elsewhere-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage (out of scope)",
        );
        stash("messages/counts-scope-to-a-recipient-domain", { domain: scopedDomain });
        return store.messages.messageCounts({ domains: [scopedDomain] });
      },
      expect(outcome: unknown): void {
        const counts = countsOf(value(outcome, "messageCounts(domains)"), "scoped counts");
        // Absolute, not a delta: the domain is minted for this case, so only its own two
        // messages can be in scope. A scope filter that is ignored answers with the whole
        // database and fails here.
        same(counts.total, 2, "only the in-scope mail is counted");
        same(counts.inbox, 2, "the in-scope mail is in the inbox");
        same(counts.unread, 2, "the in-scope mail is unread");
        check(counts.latest_received_at !== null, "counts over real mail carry a latest received time");
      },
    },

    // ---- the inbox surface ----------------------------------------------
    {
      id: "inbound/read-flag-round-trip",
      what: "marking a message read persists, and marking it unread again persists too",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(
          store.messages.createMessage(inboundMessage(`read-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        const marked = await must(store.inbound.setInboundRead(created.id, true), "setInboundRead(true)");
        same(marked === null ? null : marked.is_read, true, "the write answers with the new flag");
        const readBack = await must(store.messages.getMessage(created.id), "getMessage after the read write");
        same(readBack === null ? null : readBack.is_read, true, "the read flag is persisted");
        await must(store.inbound.setInboundRead(created.id, false), "setInboundRead(false)");
        stash("inbound/read-flag-round-trip", { id: created.id });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/read-flag-round-trip");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        same(read.is_read, false, "clearing the read flag is persisted");
      },
    },
    {
      id: "inbound/starred-flag-round-trip",
      what: "starring a message persists and unstarring it persists",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(
          store.messages.createMessage(inboundMessage(`star-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        await must(store.inbound.setInboundStarred(created.id, true), "setInboundStarred(true)");
        const starred = await must(store.messages.getMessage(created.id), "getMessage after the star write");
        same(starred === null ? null : starred.is_starred, true, "the star is persisted");
        await must(store.inbound.setInboundStarred(created.id, false), "setInboundStarred(false)");
        stash("inbound/starred-flag-round-trip", { id: created.id });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/starred-flag-round-trip");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        same(read.is_starred, false, "unstarring is persisted");
      },
    },
    {
      id: "inbound/archive-flag-round-trip",
      what: "archiving a message moves the folder counts and shows up in the record's labels",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(
          store.messages.createMessage(inboundMessage(`archive-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        const before = await must(store.messages.messageCounts(), "messageCounts (before archive)");
        await must(store.inbound.setInboundArchived(created.id, true), "setInboundArchived(true)");
        const after = await must(store.messages.messageCounts(), "messageCounts (after archive)");
        same(after.inbox, before.inbox - 1, "archiving takes the message out of the inbox count");
        same(after.archived, before.archived + 1, "archiving raises the archived count");
        stash("inbound/archive-flag-round-trip", { id: created.id });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/archive-flag-round-trip");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        // Archived state lives in the label set on the record shape, so a reader can
        // tell an archived message from an inbox one without a second query.
        check(read.labels.includes("archived"), `archived state is not on the record: ${show(read.labels)}`);
      },
    },
    {
      id: "inbound/label-add-and-remove-round-trip",
      what: "an added label reads back on the message, is not duplicated, and is gone once removed",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(
          store.messages.createMessage(inboundMessage(`label-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        const label = token("label");
        await must(store.inbound.addInboundLabel(created.id, label), "addInboundLabel");
        const withLabel = await must(store.messages.getMessage(created.id), "getMessage after the label write");
        check(
          withLabel !== null && withLabel.labels.includes(label),
          `the added label is not on the record: ${show(withLabel)}`,
        );
        await must(store.inbound.addInboundLabel(created.id, label), "addInboundLabel again");
        const twice = await must(store.messages.getMessage(created.id), "getMessage after the second label write");
        same(
          twice === null ? -1 : twice.labels.filter((entry) => entry === label).length,
          1,
          "adding a label twice must not duplicate it",
        );
        await must(store.inbound.removeInboundLabel(created.id, label), "removeInboundLabel");
        stash("inbound/label-add-and-remove-round-trip", { id: created.id, label });
        return store.messages.getMessage(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/label-add-and-remove-round-trip");
        const read = recordOf(value(outcome, "getMessage"), "message record");
        same(read.id, state["id"], "message id");
        check(!read.labels.includes(String(state["label"])), `the removed label is still there: ${show(read.labels)}`);
      },
    },
    {
      id: "inbound/unread-count-follows-the-read-flag",
      what: "the unread count drops by exactly one when a message is marked read",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await must(
          store.messages.createMessage(inboundMessage(`unread-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage",
        );
        const before = await must(store.inbound.getUnreadCount(), "getUnreadCount (before)");
        await must(store.inbound.setInboundRead(created.id, true), "setInboundRead(true)");
        stash("inbound/unread-count-follows-the-read-flag", { before });
        return store.inbound.getUnreadCount();
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/unread-count-follows-the-read-flag");
        const before = state["before"];
        const after = value(outcome, "getUnreadCount");
        check(typeof before === "number" && typeof after === "number", "unread counts must be numbers");
        same(after, (before as number) - 1, "the unread count after marking one message read");
      },
    },
    {
      id: "inbound/clear-removes-scoped-mail",
      what: "clearing inbound mail for one domain removes that mail, reports the count, and spares the rest",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const scopedDomain = domainToken();
        // THREE in scope, not one: a count of one cannot tell a correct count from a
        // count that includes rows the cascade removed from other tables.
        const scoped: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const written = await must(
            store.messages.createMessage(inboundMessage(`cleared-${index}@${scopedDomain}`, token("subject"))),
            "createMessage",
          );
          scoped.push(written.id);
        }
        const untouched = await must(
          store.messages.createMessage(inboundMessage(`kept-${RUN_TAG}@example.test`, token("subject"))),
          "createMessage (out of scope)",
        );
        const cleared = await must(store.inbound.clearInboundEmails({ domains: [scopedDomain] }), "clearInboundEmails");
        same(cleared, 3, "exactly the three in-scope messages were cleared");
        const survivor = await must(store.messages.getMessage(untouched.id), "getMessage (out of scope)");
        check(survivor !== null, "clearing one domain must not remove another domain's mail");
        for (const id of scoped.slice(1)) {
          same(await must(store.messages.getMessage(id), "getMessage (cleared)"), null, `${id} must be gone`);
        }
        stash("inbound/clear-removes-scoped-mail", { id: scoped[0] });
        return store.messages.getMessage(scoped[0] as string);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "getMessage after clear"), null, "cleared mail must not be readable");
      },
    },

    // ---- send keys -------------------------------------------------------
    {
      id: "send-keys/mint-then-verify-then-revoke",
      what: "a minted key verifies by its token, is listed, stops verifying once revoked, and never exposes a hash",
      requires: null,
      async exercise(store: EmailStore): Promise<unknown> {
        const owner = await ownerId(store);
        const minted = await must(
          store.sendKeys.mintSendKey({ owner_id: owner, label: "conformance" }),
          "mintSendKey",
        );
        check(minted.token.length > 8, "a minted key must carry a plaintext token exactly once");
        const projected = asObject(minted.key, "minted key record");
        check(!("key_hash" in projected), "a send key record must never carry the secret hash");
        const verified = await must(store.sendKeys.verifySendKey(minted.token), "verifySendKey");
        same(verified === null ? null : verified.id, minted.key.id, "the token verifies to the key it minted");
        same(
          await must(store.sendKeys.verifySendKey(`esk_${token("bogus")}`), "verifySendKey(bogus)"),
          null,
          "an unknown token verifies to null",
        );
        const listed = await must(store.sendKeys.listSendKeys({ limit: 500 }), "listSendKeys");
        same(
          listed.filter((key) => key.id === minted.key.id).length,
          1,
          "the minted key appears exactly once in the list",
        );
        const revoked = await must(store.sendKeys.revokeSendKey(minted.key.id), "revokeSendKey");
        check(revoked !== null && revoked.revoked_at !== null, "revocation must stamp revoked_at");
        stash("send-keys/mint-then-verify-then-revoke", { id: minted.key.id });
        return store.sendKeys.verifySendKey(minted.token);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "verifySendKey after revoke"), null, "a revoked token must stop verifying");
      },
    },

    // ---- the uniform resource families ----------------------------------
    // One independently reported case per family. A single generic case over contacts
    // cannot detect that (say) warming points at the wrong schema or events pages with
    // a non-total order.
    ...buildUniformResourceCases(),

    // ---- keysetPagination ------------------------------------------------
    {
      id: "messages/keyset-scan-emits-every-row-exactly-once",
      what: "paging five written messages two at a time yields those five ids once each, newest first",
      requires: "keysetPagination",
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("keyset");
        // THREE of the five share one timestamp. That is the whole point: a keyset over
        // a timestamp alone is not total, and rows written in a batch all carry the same
        // instant, so ties are the COMMON case rather than the edge one. Five rows with
        // five distinct timestamps never touch the tiebreaker that makes the order total.
        const newer = new Date(Date.now() - 60_000).toISOString();
        const older = new Date(Date.now() - 120_000).toISOString();
        const stamps = [newer, newer, newer, older, older];
        const written: Array<{ id: string; ts: string }> = [];
        for (let index = 0; index < stamps.length; index += 1) {
          const created = await must(
            store.messages.createMessage({
              ...inboundMessage(`keyset-${RUN_TAG}@example.test`, `${subject} ${index}`),
              received_at: stamps[index] as string,
            }),
            "createMessage",
          );
          written.push({ id: created.id, ts: stamps[index] as string });
        }
        const drained = await drainMessages(store, { subject, limit: 2 });
        if ("refused" in drained) return drained.refused;
        stash("messages/keyset-scan-emits-every-row-exactly-once", { written, scanned: drained.ids });
        // The first page is handed back so the harness inspects a real store answer.
        return store.messages.listMessages({ subject, limit: 2 });
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/keyset-scan-emits-every-row-exactly-once");
        const written = asArray(state["written"], "written rows").map((row) => {
          const entry = asObject(row, "written row");
          return { id: String(entry["id"]), ts: String(entry["ts"]) };
        });
        const scanned = asArray(state["scanned"], "scanned ids").map((id) => String(id));
        // The EXACT total order, not merely the set. (ts DESC, id DESC) is the order the
        // capability claims; asserting only the first element let a scan that paged by
        // OFFSET, or dropped the id tiebreaker, pass.
        const expected = [...written]
          .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : a.ts < b.ts ? 1 : -1))
          .map((row) => row.id);
        same(scanned.join(","), expected.join(","), "the keyset scan order, exactly");
        same(new Set(scanned).size, scanned.length, "a keyset scan must not re-emit a row");
        const page = pageOf(value(outcome, "listMessages"), "message page");
        same(page.items.length, 2, "the first page holds exactly the requested limit");
        check(page.next_cursor !== null, "a full first page must offer a cursor");
      },
    },
    {
      id: "messages/keyset-scan-is-exact-once-across-a-write-during-the-scan",
      what: "a row written between two pages of a scan neither duplicates nor hides any row already being scanned",
      requires: "keysetPagination",
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("interleaved");
        const written: string[] = [];
        for (let index = 0; index < 4; index += 1) {
          const created = await must(
            store.messages.createMessage({
              ...inboundMessage(`interleaved-${RUN_TAG}@example.test`, `${subject} ${index}`),
              received_at: new Date(Date.now() - (index + 2) * 60_000).toISOString(),
            }),
            "createMessage",
          );
          written.push(created.id);
        }
        const first = await store.messages.listMessages({ subject, limit: 2 });
        if (!first.ok) return first;
        const seen = first.value.items.map((item) => item.id);
        // A row lands mid-scan, OLDER than the cursor, so it falls inside the range the
        // scan has not reached. It must appear, and it must not disturb the four already
        // being scanned. (A row newer than the cursor would legitimately be missed — it
        // lands behind the scan — which is why this one is deliberately older.)
        const interleaved = await must(
          store.messages.createMessage({
            ...inboundMessage(`interleaved-${RUN_TAG}@example.test`, `${subject} late`),
            received_at: new Date(Date.now() - 600_000).toISOString(),
          }),
          "createMessage (during the scan)",
        );
        let cursor = first.value.next_cursor;
        for (let page = 0; page < 20 && cursor !== null; page += 1) {
          const next = await store.messages.listMessages({ subject, limit: 2, cursor });
          if (!next.ok) return next;
          seen.push(...next.value.items.map((item) => item.id));
          cursor = next.value.next_cursor;
        }
        stash("messages/keyset-scan-is-exact-once-across-a-write-during-the-scan", {
          written,
          interleaved: interleaved.id,
          seen,
        });
        return store.messages.listMessages({ subject, limit: 50 });
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/keyset-scan-is-exact-once-across-a-write-during-the-scan");
        const written = asArray(state["written"], "written ids").map((id) => String(id));
        const seen = asArray(state["seen"], "scanned ids").map((id) => String(id));
        same(new Set(seen).size, seen.length, `a row was emitted twice: ${show(seen)}`);
        for (const id of written) check(seen.includes(id), `the scan lost ${id} when a row was written`);
        check(seen.includes(String(state["interleaved"])), "a row written inside the scanned range must appear");
        const page = pageOf(value(outcome, "listMessages"), "message page");
        same(page.items.length, written.length + 1, "a wide page holds every row that was written");
      },
    },
    {
      id: "inbound/folder-scope-moves-with-the-archive-flag",
      what: "an archived message leaves the inbox folder page and appears on the archived folder page",
      requires: "keysetPagination",
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("folder");
        const created = await must(
          store.messages.createMessage(inboundMessage(`folder-${RUN_TAG}@example.test`, subject)),
          "createMessage",
        );
        const inbox = await store.inbound.listInbound({ subject, limit: 50 });
        if (!inbox.ok) return inbox;
        same(inbox.value.items.length, 1, "a new inbound message is on the inbox page");
        same(inbox.value.items[0] === undefined ? null : inbox.value.items[0].id, created.id, "and it is the written one");
        await must(store.inbound.setInboundArchived(created.id, true), "setInboundArchived(true)");
        const afterArchive = await store.inbound.listInbound({ subject, limit: 50 });
        if (!afterArchive.ok) return afterArchive;
        same(afterArchive.value.items.length, 0, "an archived message leaves the inbox page");
        // A message CREATED with the folder label must land in that folder too. Folder
        // state has two representations on this seam (the label set on the record, and
        // whatever a store keeps underneath); a store that reads only one of them puts a
        // message on the inbox page while its own record says it is archived.
        const bornArchived = await must(
          store.messages.createMessage({
            ...inboundMessage(`folder-${RUN_TAG}@example.test`, subject),
            labels: ["archived"],
          }),
          "createMessage (already archived)",
        );
        const inboxAgain = await store.inbound.listInbound({ subject, limit: 50 });
        if (!inboxAgain.ok) return inboxAgain;
        same(inboxAgain.value.items.length, 0, "a message created as archived is not on the inbox page");
        stash("inbound/folder-scope-moves-with-the-archive-flag", { id: created.id, bornArchived: bornArchived.id });
        return store.inbound.listInbound({ subject, folder: "archived", limit: 50 });
      },
      expect(outcome: unknown): void {
        const state = stashed("inbound/folder-scope-moves-with-the-archive-flag");
        const page = pageOf(value(outcome, "listInbound(archived)"), "archived page");
        const ids = page.items.map((item) => item.id);
        same(ids.length, 2, `the archived folder page holds both archived messages: ${show(ids)}`);
        check(ids.includes(String(state["id"])), "the message archived by a flag write is on the archived page");
        check(ids.includes(String(state["bornArchived"])), "the message created as archived is on the archived page");
        for (const item of page.items) {
          check(item.labels.includes("archived"), `an archived row must say so: ${show(item.labels)}`);
        }
      },
    },
    {
      id: "attachments/inventory-scan-emits-every-attachment-exactly-once",
      what: "the attachment inventory pages one row at a time over every attachment of every written message",
      requires: "keysetPagination",
      async exercise(store: EmailStore): Promise<unknown> {
        const tag = token("inventory");
        const expected: string[] = [];
        for (let index = 0; index < 2; index += 1) {
          const created = await must(
            store.messages.createMessage({
              ...inboundMessage(`inventory-${RUN_TAG}@example.test`, `${tag} ${index}`),
              attachments: [
                { filename: `${tag}-${index}-a.txt`, content_type: "text/plain", size: 3 },
                { filename: `${tag}-${index}-b.txt`, content_type: "text/plain", size: 4 },
              ],
            }),
            "createMessage",
          );
          expected.push(`${created.id}#0`, `${created.id}#1`);
        }
        const drained = await drainAttachments(store, 1);
        if ("refused" in drained) return drained.refused;
        const seen = drained.items.map((item) => `${item.message_id}#${item.attachment_index}`);
        const mine = drained.items.filter((item) => String(item.filename ?? "").startsWith(tag));
        stash("attachments/inventory-scan-emits-every-attachment-exactly-once", {
          expected,
          seen,
          tag,
          mine: mine.map((item) => ({ ...item })),
        });
        return store.emailContent.listAttachments({ limit: 1 });
      },
      expect(outcome: unknown, store: EmailStore): void {
        const state = stashed("attachments/inventory-scan-emits-every-attachment-exactly-once");
        const expected = asArray(state["expected"], "expected keys").map((key) => String(key));
        const seen = asArray(state["seen"], "seen keys").map((key) => String(key));
        check(seen.length > 0, "the inventory returned nothing for messages that carry attachments");
        same(new Set(seen).size, seen.length, "the inventory must not emit an attachment twice");
        for (const key of expected) check(seen.includes(key), `the inventory scan skipped ${key}`);
        // The ROW CONTENT, not just its identity. Every field below was droppable to
        // null and `content_available` flippable to true with no case noticing, and that
        // field is the one a reader uses to decide whether a download is worth
        // attempting: these attachments were written WITHOUT bytes, so no store may
        // report them as available.
        const mine = asArray(state["mine"], "the written inventory rows");
        same(mine.length, expected.length, "every written attachment carries its own inventory row");
        for (const row of mine) {
          const item = asObject(row, "inventory row");
          check(String(item["filename"] ?? "").startsWith(String(state["tag"])), "inventory filename");
          same(item["content_type"], "text/plain", "inventory content type");
          check(typeof item["size_bytes"] === "number", `inventory size: ${show(item["size_bytes"])}`);
          same(item["content_available"], false, "metadata written without bytes is not available content");
          same(item["direction"], "inbound", "inventory direction");
          check(item["received_at"] !== null, "inventory received_at");
        }
        void store;
        const page = asObject(value(outcome, "listAttachments"), "attachment page");
        same(asArray(page["items"], "attachment items").length, 1, "a one-row page holds one row");
      },
    },

    {
      id: "messages/list-filters-narrow-to-the-written-message",
      what: "each list filter returns the message it matches and excludes the one it does not, with snippet and attachment count",
      requires: "keysetPagination",
      async exercise(store: EmailStore): Promise<unknown> {
        const shared = token("filters");
        const needle = token("needle");
        const sender = `filter-sender-${token("s")}@example.test`;
        const recipient = `filter-recipient-${token("r")}@example.test`;
        const wanted = await must(
          store.messages.createMessage({
            ...inboundMessage(recipient, `${shared} wanted`),
            from_addr: sender,
            body_text: `this body contains ${needle} and nothing else does`,
            attachments: [{ filename: `${needle}.txt`, content_type: "text/plain", size: 2 }],
          }),
          "createMessage (wanted)",
        );
        const other = await must(
          store.messages.createMessage({
            ...inboundMessage(`other-${token("o")}@example.test`, `${shared} other`),
            from_addr: `other-sender-${token("s")}@example.test`,
            body_text: "an unrelated body",
          }),
          "createMessage (other)",
        );
        const ids = async (opts: Record<string, unknown>): Promise<string[] | { refused: unknown }> => {
          const answer = await store.messages.listMessages({ subject: shared, limit: 50, ...opts });
          if (!answer.ok) return { refused: answer };
          return answer.value.items.map((item) => item.id);
        };
        const both = await ids({});
        if (!Array.isArray(both)) return both.refused;
        same(both.length, 2, "both written messages share the subject filter");
        const bySearch = await ids({ search: needle });
        if (!Array.isArray(bySearch)) return bySearch.refused;
        same(bySearch.join(","), wanted.id, "search matches exactly the message whose body carries the term");
        const byFrom = await ids({ from: sender });
        if (!Array.isArray(byFrom)) return byFrom.refused;
        same(byFrom.join(","), wanted.id, "the from filter matches exactly one sender");
        const byTo = await ids({ to: recipient });
        if (!Array.isArray(byTo)) return byTo.refused;
        same(byTo.join(","), wanted.id, "the to filter matches exactly one recipient");
        const outbound = await ids({ direction: "outbound" });
        if (!Array.isArray(outbound)) return outbound.refused;
        same(outbound.length, 0, "inbound mail is not outbound");
        const future = await ids({ since: new Date(Date.now() + 3_600_000).toISOString() });
        if (!Array.isArray(future)) return future.refused;
        same(future.length, 0, "a since in the future excludes mail that has already arrived");
        // A since nothing can parse must be REFUSED, never answered with an empty page:
        // an empty page is indistinguishable from "no mail since then".
        refusal(
          await store.messages.listMessages({ subject: shared, since: "not a timestamp at all" }),
          "invalid_input",
          422,
          "an unparseable since",
        );
        stash("messages/list-filters-narrow-to-the-written-message", {
          wanted: wanted.id,
          other: other.id,
          needle,
        });
        return store.messages.listMessages({ subject: shared, search: needle, limit: 50 });
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/list-filters-narrow-to-the-written-message");
        const page = pageOf(value(outcome, "listMessages(search)"), "filtered page");
        same(page.items.length, 1, "the search filter returns exactly the matching message");
        const item = page.items[0];
        if (item === undefined) fail("the filtered page is empty");
        same(item.id, state["wanted"], "and it is the message that was written to match");
        // The two list-only projections, which nothing else asserts.
        check(
          typeof item.snippet === "string" && item.snippet.includes(String(state["needle"])),
          `the list snippet must come from the written body: ${show(item.snippet)}`,
        );
        same(item.attachment_count, 1, "the list row counts the written attachment");
      },
    },

    // ---- attachmentContent ----------------------------------------------
    {
      id: "attachments/content-lookup-answers-with-the-stored-bytes",
      what: "an attachment written with payload bytes is looked up as available, with those bytes",
      requires: "attachmentContent",
      async exercise(store: EmailStore): Promise<unknown> {
        const filename = `${token("file")}.txt`;
        // A literal, not `Buffer.from(...)`: the seam guard's import scan reads any
        // `from` followed by a quote as a module specifier, and this file may not
        // contain one. It decodes to "conformance payload".
        const contentBase64 = "Y29uZm9ybWFuY2UgcGF5bG9hZA==";
        const created = await must(
          store.messages.createMessage({
            ...inboundMessage(`attach-${RUN_TAG}@example.test`, token("subject")),
            attachments: [{ filename, content_type: "text/plain", size: 19, content_base64: contentBase64 }],
          }),
          "createMessage",
        );
        stash("attachments/content-lookup-answers-with-the-stored-bytes", { filename, contentBase64 });
        return store.emailContent.getMessageAttachment(created.id, 0);
      },
      expect(outcome: unknown): void {
        const state = stashed("attachments/content-lookup-answers-with-the-stored-bytes");
        const lookup = asObject(value(outcome, "getMessageAttachment"), "attachment lookup");
        same(lookup["state"], "available", "an attachment written with bytes must look up as available");
        const attachment = asObject(lookup["attachment"], "attachment");
        same(attachment["filename"], state["filename"], "attachment filename");
        same(attachment["content_type"], "text/plain", "attachment content type");
        same(attachment["content_base64"], state["contentBase64"], "attachment payload bytes");
      },
    },
    {
      id: "attachments/metadata-batch-reports-content-availability",
      what: "the per-message metadata batch lists a written attachment and says whether its bytes exist",
      requires: "attachmentContent",
      async exercise(store: EmailStore): Promise<unknown> {
        const filename = `${token("meta")}.pdf`;
        const created = await must(
          store.messages.createMessage({
            ...inboundMessage(`meta-${RUN_TAG}@example.test`, token("subject")),
            attachments: [{ filename, content_type: "application/pdf", size: 128 }],
          }),
          "createMessage",
        );
        stash("attachments/metadata-batch-reports-content-availability", { id: created.id, filename });
        return store.emailContent.listAttachmentsForMessageIds([created.id]);
      },
      expect(outcome: unknown): void {
        const state = stashed("attachments/metadata-batch-reports-content-availability");
        const batch = asObject(value(outcome, "listAttachmentsForMessageIds"), "attachment batch");
        const rows = asArray(batch[String(state["id"])], "attachment metadata for the written message");
        same(rows.length, 1, "the batch reports the one attachment that was written");
        const row = asObject(rows[0], "attachment metadata");
        same(row["filename"], state["filename"], "attachment filename");
        same(row["attachment_index"], 0, "attachment index");
        // Metadata without bytes must SAY so. Reporting availability for metadata is
        // the exact confusion this field exists to prevent.
        same(row["content_available"], false, "metadata written without bytes is not available content");
      },
    },

    // ---- rawMessage -----------------------------------------------------
    {
      id: "messages/raw-mime-carries-the-written-headers",
      what: "the raw form of a written message carries its subject, its sender and its message id",
      requires: "rawMessage",
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("raw-subject");
        const messageId = `<${token("mid")}@example.test>`;
        const input = inboundMessage(`raw-${RUN_TAG}@example.test`, subject);
        const created = await must(
          store.messages.createMessage({ ...input, message_id: messageId }),
          "createMessage",
        );
        stash("messages/raw-mime-carries-the-written-headers", {
          subject,
          messageId,
          sender: input.from_addr,
        });
        return store.messages.getMessageRaw(created.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("messages/raw-mime-carries-the-written-headers");
        const raw = asObject(value(outcome, "getMessageRaw"), "raw message");
        const body = raw["raw"];
        check(typeof body === "string" && body.length > 0, `raw must be a non-empty string: ${show(body)}`);
        const text = body as string;
        check(text.includes(String(state["subject"])), "the raw form must carry the written subject");
        check(text.includes(String(state["sender"])), "the raw form must carry the written sender");
        same(raw["message_id"], state["messageId"], "the raw form reports the written message id");
      },
    },

    // ---- sendIntentLedger ------------------------------------------------
    {
      id: "send-intents/reserve-is-visible-through-the-key",
      what: "a reserved intent is found by its idempotency key and reads back as a pending outbound message",
      requires: "sendIntentLedger",
      async exercise(store: EmailStore): Promise<unknown> {
        const key = token("intent-key");
        const reserved = await store.sendIntents.reserveSendIntent(key, {
          ...outboundMessage(token("subject")),
          idempotency_key: key,
          send_payload_hash: token("hash"),
        });
        if (!reserved.ok) return reserved;
        stash("send-intents/reserve-is-visible-through-the-key", { key, id: reserved.value.id });
        return store.sendIntents.lookupSendIntent(key);
      },
      expect(outcome: unknown): void {
        const state = stashed("send-intents/reserve-is-visible-through-the-key");
        const lookup = asObject(value(outcome, "lookupSendIntent"), "send intent lookup");
        same(lookup["found"], true, "a reserved intent must be found by its key");
        same(lookup["tombstoned"], false, "a fresh reservation is not tombstoned");
        const message = recordOf(lookup["message"], "reserved message");
        same(message.id, state["id"], "the lookup returns the reserved row");
        same(message.idempotency_key, state["key"], "the reservation carries the idempotency key");
        same(message.send_state, "pending", "a reservation is pending until it is claimed");
        same(message.direction, "outbound", "a send intent is outbound");
      },
    },
    {
      id: "send-intents/claim-then-complete-records-the-provider-id",
      what: "completing a claimed intent persists the sent state and the provider message id",
      requires: "sendIntentLedger",
      async exercise(store: EmailStore): Promise<unknown> {
        const key = token("intent-key");
        const reserved = await store.sendIntents.reserveSendIntent(key, {
          ...outboundMessage(token("subject")),
          idempotency_key: key,
          send_payload_hash: token("hash"),
        });
        if (!reserved.ok) return reserved;
        const claimed = await store.sendIntents.claimSendIntent(reserved.value.id);
        if (!claimed.ok) return claimed;
        check(claimed.value !== null, "a pending intent must be claimable");
        const providerMessageId = token("provider-msg");
        const completed = await store.sendIntents.completeSendIntent(reserved.value.id, providerMessageId);
        if (!completed.ok) return completed;
        stash("send-intents/claim-then-complete-records-the-provider-id", {
          id: reserved.value.id,
          providerMessageId,
        });
        return store.messages.getMessage(reserved.value.id);
      },
      expect(outcome: unknown): void {
        const state = stashed("send-intents/claim-then-complete-records-the-provider-id");
        const message = recordOf(value(outcome, "getMessage"), "completed message");
        same(message.id, state["id"], "message id");
        same(message.send_state, "sent", "a completed intent is sent");
        same(message.provider_message_id, state["providerMessageId"], "the provider message id is persisted");
      },
    },
    {
      id: "send-intents/cancel-tombstones-the-key",
      what: "cancelling an intent tombstones its key, and every later lookup says so",
      requires: "sendIntentLedger",
      async exercise(store: EmailStore): Promise<unknown> {
        const key = token("intent-key");
        const reserved = await store.sendIntents.reserveSendIntent(key, {
          ...outboundMessage(token("subject")),
          idempotency_key: key,
          send_payload_hash: token("hash"),
        });
        if (!reserved.ok) return reserved;
        const cancelled = await store.sendIntents.cancelSendIntent(key);
        if (!cancelled.ok) return cancelled;
        same(cancelled.value.tombstoned, true, "cancellation reports a tombstone");
        stash("send-intents/cancel-tombstones-the-key", { key });
        return store.sendIntents.lookupSendIntent(key);
      },
      expect(outcome: unknown): void {
        const lookup = asObject(value(outcome, "lookupSendIntent"), "send intent lookup");
        same(lookup["tombstoned"], true, "a cancelled key stays tombstoned for every later reader");
      },
    },
    {
      id: "send-intents/uncertain-intent-is-listed-until-it-is-reconciled",
      what: "an uncertain intent appears in the uncertain list and leaves it once reconciled",
      requires: "sendIntentLedger",
      async exercise(store: EmailStore): Promise<unknown> {
        // TWO intents, and only one is reconciled. With one, an implementation that
        // cleared the whole uncertain list — or returned `[]` from it — would pass.
        const ids: string[] = [];
        for (let index = 0; index < 2; index += 1) {
          const key = token("intent-key");
          const reserved = await store.sendIntents.reserveSendIntent(key, {
            ...outboundMessage(token("subject")),
            idempotency_key: key,
            send_payload_hash: token("hash"),
          });
          if (!reserved.ok) return reserved;
          const claimed = await store.sendIntents.claimSendIntent(reserved.value.id);
          if (!claimed.ok) return claimed;
          const uncertain = await store.sendIntents.markSendUncertain(reserved.value.id, token("provider-msg"));
          if (!uncertain.ok) return uncertain;
          ids.push(reserved.value.id);
        }
        const listed = await store.sendIntents.listUncertainSendIntents({ limit: 500 });
        if (!listed.ok) return listed;
        // The non-emptiness assertion that matters most in this file: a store answering
        // `[]` here tells a reconciliation sweep that nothing is outstanding.
        for (const id of ids) {
          check(
            listed.value.some((entry) => entry.id === id),
            `an uncertain intent must be listed as uncertain: ${show(listed.value.map((entry) => entry.id))}`,
          );
        }
        const reconciled = await store.sendIntents.reconcileUncertainSendIntent(
          ids[0] as string,
          "conformance: the provider log shows the message left",
        );
        if (!reconciled.ok) return reconciled;
        stash("send-intents/uncertain-intent-is-listed-until-it-is-reconciled", {
          reconciled: ids[0],
          untouched: ids[1],
        });
        return store.sendIntents.listUncertainSendIntents({ limit: 500 });
      },
      expect(outcome: unknown): void {
        const state = stashed("send-intents/uncertain-intent-is-listed-until-it-is-reconciled");
        const rows = asArray(value(outcome, "listUncertainSendIntents"), "uncertain intents").map((row) =>
          asObject(row, "uncertain intent"),
        );
        same(
          rows.filter((row) => row["id"] === state["reconciled"]).length,
          0,
          "a reconciled intent must leave the uncertain list",
        );
        same(
          rows.filter((row) => row["id"] === state["untouched"]).length,
          1,
          "reconciling one intent must not clear the others",
        );
      },
    },

    // ---- outboundPolicy --------------------------------------------------
    {
      id: "policy/a-zero-quota-address-is-not-sendable",
      what: "an address written with a zero daily quota is reported as not sendable, with that quota",
      requires: "outboundPolicy",
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store, 0);
        stash("policy/a-zero-quota-address-is-not-sendable", { email: created.email });
        return store.addressLifecycle.getAddressSendability(created.email);
      },
      expect(outcome: unknown): void {
        const sendability = asObject(value(outcome, "getAddressSendability"), "sendability");
        same(sendability["sendable"], false, "an address with a zero daily quota cannot send");
        same(sendability["daily_quota"], 0, "the reported quota is the one that was written");
        check(typeof sendability["reason"] === "string", "a refused send must carry a reason");
      },
    },
    {
      id: "policy/a-suspended-sender-is-not-allowed",
      what: "policy evaluation for a suspended sender answers not-allowed with a sender code",
      requires: "outboundPolicy",
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        await must(store.addressLifecycle.suspendAddress(created.id), "suspendAddress");
        stash("policy/a-suspended-sender-is-not-allowed", { email: created.email });
        return store.sendIntents.evaluateOutboundPolicy({
          from_addr: created.email,
          to_addrs: [`recipient-${RUN_TAG}@example.test`],
        });
      },
      expect(outcome: unknown): void {
        const decision = asObject(value(outcome, "evaluateOutboundPolicy"), "policy decision");
        same(decision["allowed"], false, "a suspended sender must not be allowed to send");
        const code = decision["code"];
        check(
          typeof code === "string" && code.startsWith("sender_"),
          `a suspended sender must be refused with a sender code, got ${show(code)}`,
        );
      },
    },
    {
      id: "policy/owner-authorization-follows-the-ownership-write",
      what: "an owner assigned to an address may send from it, and an owner with no claim may not",
      requires: "outboundPolicy",
      async exercise(store: EmailStore): Promise<unknown> {
        const created = await address(store);
        const owner = await ownerId(store);
        const stranger = await ownerId(store);
        await must(
          store.addressLifecycle.applyAddressOwnership(created.id, { owner_id: owner }),
          "applyAddressOwnership",
        );
        const outsider = await store.sendKeys.isOwnerAuthorizedFrom(stranger, created.email);
        if (!outsider.ok) return outsider;
        same(outsider.value, false, "an owner with no claim on the address is not authorized");
        stash("policy/owner-authorization-follows-the-ownership-write", { owner, email: created.email });
        return store.sendKeys.isOwnerAuthorizedFrom(owner, created.email);
      },
      expect(outcome: unknown): void {
        same(value(outcome, "isOwnerAuthorizedFrom"), true, "the assigned owner is authorized to send");
      },
    },

    // ---- attachmentRepair ------------------------------------------------
    {
      id: "repair/a-created-run-reads-back-by-its-id",
      what: "a repair run reads back with the manifest it was created for, the same id on re-create, and null for an id that was never created",
      requires: "attachmentRepair",
      async exercise(store: EmailStore): Promise<unknown> {
        const manifest = token("manifest");
        const created = await store.attachmentRepair.createOrGetAttachmentRepairRun({ manifest_key: manifest });
        if (!created.ok) return created;
        const runId = String(asObject(created.value, "repair run")["id"]);
        // The "OrGet" half of the name: a second create for the same manifest must
        // return the SAME run, not a second one. A store that minted a new id per call
        // would hand two workers two ledgers for one repair.
        const again = await store.attachmentRepair.createOrGetAttachmentRepairRun({ manifest_key: manifest });
        if (!again.ok) return again;
        same(String(asObject(again.value, "repair run")["id"]), runId, "createOrGet must return the same run");
        // And an id that was never created must not read back. Without this, a store
        // that echoed any id it was handed would satisfy the read-back below.
        const absent = await store.attachmentRepair.getAttachmentRepairRun(`never-${token("run")}`);
        if (!absent.ok) return absent;
        same(absent.value, null, "a run that was never created must not read back");
        // Entries: the seam has NO operation that creates one (createOrGet takes only a
        // manifest), so a write-then-read over entries is not expressible here yet. What
        // IS assertable is that the pending list is a real list for a real run and that a
        // claim against an entry that does not exist does not invent one.
        const pending = await store.attachmentRepair.listPendingAttachmentRepairEntries(runId, 10);
        if (!pending.ok) return pending;
        const claimed = await store.attachmentRepair.claimAttachmentRepairEntry(runId, `never-${token("entry")}`);
        if (!claimed.ok) return claimed;
        same(claimed.value, null, "claiming an entry that does not exist must answer null");
        stash("repair/a-created-run-reads-back-by-its-id", { runId, manifest });
        return store.attachmentRepair.getAttachmentRepairRun(runId);
      },
      expect(outcome: unknown): void {
        const state = stashed("repair/a-created-run-reads-back-by-its-id");
        const run = asObject(value(outcome, "getAttachmentRepairRun"), "repair run");
        same(run["id"], state["runId"], "the run reads back under its own id");
        // The manifest the run was created FOR must be on it. Asserting only that the id
        // echoes is satisfied by a store that persists nothing.
        same(run["manifest_key"], state["manifest"], "the run carries the manifest it was created for");
      },
    },

    // ---- mailRollups -----------------------------------------------------
    {
      id: "threads/a-reply-rolls-up-with-its-parent-subject",
      what: "a message and its Re: reply roll up into one thread carrying two messages",
      requires: "mailRollups",
      async exercise(store: EmailStore): Promise<unknown> {
        const subject = token("thread");
        const sender = `thread-sender-${RUN_TAG}@example.test`;
        const parent = await must(
          store.messages.createMessage({
            ...inboundMessage(`thread-${RUN_TAG}@example.test`, subject),
            from_addr: sender,
          }),
          "createMessage (parent)",
        );
        await must(
          store.messages.createMessage({
            ...inboundMessage(`thread-${RUN_TAG}@example.test`, `Re: ${subject}`),
            from_addr: sender,
          }),
          "createMessage (reply)",
        );
        // ONE of the two is read, so message_count and unread_count must differ. Equal
        // counts are satisfied by a rollup that copies one into the other.
        await must(store.inbound.setInboundRead(parent.id, true), "setInboundRead(true)");
        stash("threads/a-reply-rolls-up-with-its-parent-subject", { key: subject.toLowerCase(), sender });
        return store.threads.listThreads({ limit: 500 });
      },
      expect(outcome: unknown): void {
        const state = stashed("threads/a-reply-rolls-up-with-its-parent-subject");
        const rows = asArray(value(outcome, "listThreads"), "thread rollups");
        const matched = rows
          .map((row) => asObject(row, "thread rollup"))
          .filter((row) => row["thread_key"] === state["key"]);
        same(matched.length, 1, `exactly one thread must carry the written subject key ${show(state["key"])}`);
        const thread = asObject(matched[0], "thread rollup");
        same(thread["message_count"], 2, "the reply rolls up with its parent");
        same(thread["unread_count"], 1, "the read message is not counted as unread");
        check(typeof thread["subject"] === "string", `the rollup carries a subject: ${show(thread["subject"])}`);
        check(thread["last_message_at"] !== null, "the rollup carries a last-message time");
        check(thread["first_message_at"] !== null, "the rollup carries a first-message time");
        const participants = asArray(thread["participants"], "participants").map((entry) => String(entry));
        check(participants.includes(String(state["sender"])), `participants lost the sender: ${show(participants)}`);
      },
    },
    {
      id: "mailboxes/a-registered-address-rolls-up-its-inbound-mail",
      what: "mail written to a registered address is counted on that address's mailbox rollup",
      requires: "mailRollups",
      async exercise(store: EmailStore): Promise<unknown> {
        const registered = await address(store, null, "Rollup Mailbox");
        await must(store.messages.createMessage(inboundMessage(registered.email, token("subject"))), "createMessage");
        // A recipient in DISPLAY-NAME form must count for the same mailbox: a rollup that
        // compares the whole stored string instead of extracting the address silently
        // under-reports every mailbox that receives mail addressed that way.
        await must(
          store.messages.createMessage(
            inboundMessage(`Rollup Mailbox <${registered.email}>`, token("subject")),
          ),
          "createMessage (display-name recipient)",
        );
        stash("mailboxes/a-registered-address-rolls-up-its-inbound-mail", {
          id: registered.id,
          email: registered.email,
          status: registered.status,
        });
        return store.threads.listMailboxes();
      },
      expect(outcome: unknown): void {
        const state = stashed("mailboxes/a-registered-address-rolls-up-its-inbound-mail");
        const rollup = asObject(value(outcome, "listMailboxes"), "mailbox rollup");
        const mailboxes = asArray(rollup["mailboxes"], "mailboxes");
        const matched = mailboxes
          .map((row) => asObject(row, "mailbox"))
          .filter((row) => row["address"] === state["email"]);
        same(matched.length, 1, "the registered address has exactly one mailbox rollup");
        const mailbox = asObject(matched[0], "mailbox");
        same(mailbox["id"], state["id"], "the mailbox is the registered address");
        same(mailbox["display_name"], "Rollup Mailbox", "the mailbox carries the address display name");
        same(mailbox["status"], state["status"], "the mailbox carries the address status");
        same(mailbox["total"], 2, "both written messages are counted, including the display-name recipient");
        same(mailbox["unread"], 2, "both written messages are counted as unread");
        const counts = countsOf(rollup["counts"], "folder counts");
        check(counts.total > 0, "a rollup with mail must report a non-zero total");
        check(counts.inbox >= 2, `the folder counts must include this mailbox's mail: ${show(counts)}`);
      },
    },
  ];
}

/**
 * Capabilities with no case exercising them.
 *
 * The gate for an implementation PR: a capability nobody exercises is a
 * capability whose `false` branch has never been observed, and that is precisely where
 * a refusal degenerates into "returns nothing". Must be empty before implementations
 * land.
 */
export function capabilityCoverageGaps(cases: readonly ConformanceCase[] = CONFORMANCE_CASES): CapabilityKey[] {
  const covered = new Set(cases.map((testCase) => testCase.requires));
  return CAPABILITY_KEYS.filter((key) => !covered.has(key));
}
