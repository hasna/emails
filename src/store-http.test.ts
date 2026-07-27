// HttpEmailStore against the shared conformance suite — plus the proof that the
// suite can FAIL for THIS store, and the proof that the routes it depends on are the
// service's own.
//
// THREE THINGS THIS FILE HAS TO ESTABLISH, and they are separable:
//
// 1. THE STORE BEHAVES. The same 48 unmodified conformance cases the SQLite store
//    runs, over real HTTP, against a `/v1` service backed by a real store. No case is
//    skipped and no capability excuses one: a false capability still runs its case and
//    still has to answer with the typed refusal.
//
// 2. THE SUITE CAN GO RED FOR THIS STORE. A green run against a fixture proves nothing
//    on its own — a fixture is the easiest thing in the world to accidentally write so
//    that it agrees with its client. So the neutering block replaces exactly one method
//    with the plausible wrong answer it would otherwise be free to return and asserts
//    the corresponding case turns red while coverage stays uniform. The most important
//    of them is the WRITE THAT REPORTS SUCCESS AND CHANGES NOTHING: every other control
//    breaks a read, and a suite that only caught broken reads would miss the whole
//    "accepted and dropped" class this seam exists to remove.
//
// 3. THE ROUTES ARE REAL. The fixture could serve anything, so the route table is
//    checked against `emailsSelfHostedOpenApi` — the service's own document, generated
//    from the same resource registry its router dispatches on. That check is what makes
//    the capability declaration evidence rather than assertion, and it is deliberately
//    independent of the fixture: it would keep working if the fixture were deleted.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./db/database.js";
import { uuid } from "./db/runtime.js";
import { emailsSelfHostedOpenApi } from "./server/self-hosted/openapi.js";
import { SELF_HOSTED_RESOURCES } from "./server/self-hosted/resources.js";
import { CAPABILITY_KEYS, capabilityRefusal, isCapabilityRefusal } from "./store/capabilities.js";
import {
  CONFORMANCE_CASES,
  assertUniformCaseCoverage,
  capabilityCoverageGaps,
  conformanceFailures,
  runConformanceSuite,
  type ConformanceReport,
} from "./store/conformance.js";
import type { EmailStore } from "./store/email-store.js";
import {
  HTTP_STORE_CAPABILITIES,
  HTTP_STORE_MISSING_ROUTES,
  createHttpEmailStore,
  httpStoreDescriptor,
} from "./store-http/index.js";
import { EmailsApiFault } from "./store-http/outcome.js";
import { createTransport, toV1BaseUrl, type FetchImplementation } from "./store-http/wire.js";
import { RESOURCE_FAMILIES, RESOURCE_PATHS, ROUTES } from "./store-http/routes.js";
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

// Forty-eight cases, each one several HTTP round trips, run once clean plus once per
// neutering. Well past the 5s default.
const SUITE_TIMEOUT_MS = 120_000;

let db: Database;
let api: V1StoreApi;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
  // The service the client talks to. It stores nothing itself — every row it serves
  // comes out of this database through the seam, which is what makes a mis-mapped field
  // fail instead of being echoed back.
  api = startV1StoreApi({ store: createSqliteEmailStore({ database: db, detail: "fixture" }) });
});

afterEach(() => {
  api.stop();
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  restoreInheritedProcessEnv();
});

function store(): EmailStore {
  return createHttpEmailStore({ baseUrl: api.baseUrl, credential: api.apiKey });
}

function totals(report: ConformanceReport): { passed: number; refused: number; failed: number } {
  const results = report.flatMap((implementation) => implementation.results);
  return {
    passed: results.filter((result) => result.status === "passed").length,
    refused: results.filter((result) => result.status === "refused").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

describe("HttpEmailStore conformance", () => {
  it(
    "executes every case and answers each one with behaviour or the typed refusal",
    async () => {
      const report = await runConformanceSuite([store()], CONFORMANCE_CASES);
      expect(conformanceFailures(report)).toEqual([]);
      expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();
      const counted = totals(report);
      expect(counted.failed).toBe(0);
      expect(counted.passed + counted.refused).toBe(CONFORMANCE_CASES.length);
      // Both halves non-empty: all-passed would mean the refusal channel was never
      // exercised, all-refused would mean the store does nothing.
      expect(counted.passed).toBeGreaterThan(0);
      expect(counted.refused).toBeGreaterThan(0);
      // A refused case must be one whose capability this store declares FALSE — never
      // one it claims to support.
      for (const result of report[0]?.results ?? []) {
        if (result.status !== "refused") continue;
        const declared = CONFORMANCE_CASES.find((testCase) => testCase.id === result.caseId);
        expect(declared?.requires, `${result.caseId} was refused without naming a capability`).not.toBeNull();
        const capability = declared?.requires;
        if (capability) expect(HTTP_STORE_CAPABILITIES[capability]).toBe(false);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it("leaves no declared capability unexercised", () => {
    expect(capabilityCoverageGaps()).toEqual([]);
  });

  it("declares every capability exactly once, and refuses precisely what it declares false", async () => {
    const subject = store();
    expect(Object.keys(subject.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    // One representative operation per false capability, so a capability flipped in the
    // declaration without an implementation is caught here rather than by a reviewer.
    const refusals: Array<[string, Promise<unknown>]> = [
      ["sendIntentLedger", subject.sendIntents.lookupSendIntent("k")],
      ["sendIntentLedger", subject.sendIntents.reserveSendIntent("k", { from_addr: "a@b.test", to_addrs: [] })],
      ["sendIntentLedger", subject.sendIntents.listUncertainSendIntents()],
      ["outboundPolicy", subject.addressLifecycle.getAddressSendability("a@b.test")],
      ["outboundPolicy", subject.sendKeys.isOwnerAuthorizedFrom("owner", "a@b.test")],
      ["outboundPolicy", subject.sendIntents.evaluateOutboundPolicy({ from_addr: "a@b.test", to_addrs: [] })],
      ["outboundPolicy", subject.sendIntents.markSendBlocked(uuid(), "sender_unverified")],
      ["attachmentRepair", subject.attachmentRepair.getAttachmentRepairRun(uuid())],
      ["attachmentRepair", subject.attachmentRepair.listPendingAttachmentRepairEntries(uuid())],
      ["attachmentRepair", subject.attachmentRepair.createOrGetAttachmentRepairRun({ manifest_key: "m" })],
    ];
    for (const [capability, answer] of refusals) {
      const value = await answer;
      expect(isCapabilityRefusal(value, capability as never), `${capability}: ${JSON.stringify(value)}`).toBe(true);
    }
    // A refusal for a capability this store LACKS must not be reachable by an operation
    // whose capability it HAS — the inverse mistake.
    for (const capability of ["keysetPagination", "attachmentContent", "rawMessage", "mailRollups"] as const) {
      expect(HTTP_STORE_CAPABILITIES[capability]).toBe(true);
    }
  });

  it("refuses every send-intent and repair operation, not merely the sampled ones", async () => {
    // The sample above is a spot check; a family where ONE method answered something
    // else would be exactly the partial-support mistake ledger.ts argues against.
    const subject = store();
    const ledger = subject.sendIntents;
    const answers: Array<[string, unknown]> = [
      ["lookupSendIntent", await ledger.lookupSendIntent("k")],
      ["reserveSendIntent", await ledger.reserveSendIntent("k", { from_addr: "a@b.test", to_addrs: [] })],
      ["claimSendIntent", await ledger.claimSendIntent(uuid())],
      ["completeSendIntent", await ledger.completeSendIntent(uuid(), "p")],
      ["markSendFailed", await ledger.markSendFailed(uuid(), "why")],
      ["cancelSendIntent", await ledger.cancelSendIntent("k")],
      ["listUncertainSendIntents", await ledger.listUncertainSendIntents()],
      ["markSendUncertain", await ledger.markSendUncertain(uuid(), "p")],
      ["rearmFailedSendIntent", await ledger.rearmFailedSendIntent(uuid())],
      ["reconcileUncertainSendIntent", await ledger.reconcileUncertainSendIntent(uuid(), "evidence")],
    ];
    for (const [operation, answer] of answers) {
      expect(isCapabilityRefusal(answer, "sendIntentLedger"), `${operation}: ${JSON.stringify(answer)}`).toBe(true);
    }
    const repair = subject.attachmentRepair;
    const repairAnswers: Array<[string, unknown]> = [
      ["createOrGetAttachmentRepairRun", await repair.createOrGetAttachmentRepairRun({})],
      ["getAttachmentRepairRun", await repair.getAttachmentRepairRun(uuid())],
      ["listPendingAttachmentRepairEntries", await repair.listPendingAttachmentRepairEntries(uuid(), 10)],
      ["claimAttachmentRepairEntry", await repair.claimAttachmentRepairEntry(uuid(), uuid())],
      ["recordAttachmentRepairEntryOutcome", await repair.recordAttachmentRepairEntryOutcome(uuid(), {})],
    ];
    for (const [operation, answer] of repairAnswers) {
      expect(isCapabilityRefusal(answer, "attachmentRepair"), `${operation}: ${JSON.stringify(answer)}`).toBe(true);
    }
  });

  it("wires every uniform family to a /v1 resource that exists", async () => {
    const subject = store();
    const families: Array<[string, () => Promise<unknown>]> = [
      ["contacts", () => subject.contacts.list()],
      ["groups", () => subject.groups.list()],
      ["owners", () => subject.owners.list()],
      ["providers", () => subject.providers.list()],
      ["templates", () => subject.templates.list()],
      ["sequences", () => subject.sequences.list()],
      ["scheduled", () => subject.scheduled.list()],
      ["aliases", () => subject.aliases.list()],
      ["forwarding", () => subject.forwarding.list()],
      ["warming", () => subject.warming.list()],
      ["events", () => subject.events.list()],
      ["emailDigests", () => subject.emailDigests.list()],
      ["webhookReceipts", () => subject.webhookReceipts.list()],
      ["sandbox", () => subject.sandbox.list()],
    ];
    // Every declared family is wired; nothing missing and nothing extra claimed.
    expect(families.map(([family]) => family).sort()).toEqual([...RESOURCE_FAMILIES].sort());
    // And each path is a resource the SERVICE actually registers — the check that
    // catches `sandbox` being served at `sandbox-emails` rather than `sandbox`.
    const registered = new Set(SELF_HOSTED_RESOURCES.map((resource) => resource.path));
    for (const [family, path] of Object.entries(RESOURCE_PATHS)) {
      expect(registered.has(path), `${family} is mapped to /v1/${path}, which the service does not register`).toBe(
        true,
      );
    }
    for (const [family, read] of families) {
      const answer = (await read()) as { ok: boolean };
      expect(answer.ok, `${family} could not be listed`).toBe(true);
    }
  });

  it("never exposes a credential through the diagnostics descriptor", () => {
    // A URL carrying userinfo and a query string is the realistic hazard: this string is
    // the one most likely to reach a log.
    const descriptor = httpStoreDescriptor("https://operator:sup3rsecret@mail.example.test/v1?token=abc#frag");
    expect(descriptor.kind).toBe("api");
    expect(descriptor.detail).toBe("Emails API at https://mail.example.test");
    for (const secret of ["sup3rsecret", "operator", "token", "abc", "?", "#"]) {
      expect(descriptor.detail).not.toContain(secret);
    }
    // The DEFAULT detail of a real store, not one this test supplied.
    const subject = store();
    expect(subject.descriptor.detail.length).toBeGreaterThan(0);
    expect(subject.descriptor.detail).not.toContain(api.apiKey);
  });

  it("treats a bad credential as a FAULT rather than a refusal", async () => {
    // The distinction this store's outcome.ts is built on. A 401 folded into a refusal
    // would make a misconfigured store look exactly like a store that legitimately
    // declines every operation — invisibly.
    const misconfigured = createHttpEmailStore({ baseUrl: api.baseUrl, credential: "not-the-key" });
    await expect(misconfigured.domains.listDomains()).rejects.toThrow(EmailsApiFault);
    // ...and it must not leak the credential it was carrying.
    try {
      await misconfigured.messages.messageCounts();
      throw new Error("a 401 must not be reported as a successful answer");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailsApiFault);
      expect((error as Error).message).not.toContain("not-the-key");
    }
  });

  it("refuses a write naming a column the resource does not have, and does so ITSELF", async () => {
    // POSITIVE CONTROL for the validation in store-http/resources.ts. The conformance
    // case asserts the refusal, but it cannot tell WHO refused — and that matters,
    // because the real service does NOT refuse: it ignores the unknown key and answers
    // 201 with the field dropped. So this test proves both halves:
    const subject = store();
    const refused = await subject.contacts.create({ email: "col@example.test", nonsense_column: 1 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toContain("nonsense_column");

    // ...and the FIXTURE would have accepted it, dropping the field, exactly as the
    // service does. If this half ever fails, the refusal above stopped being the
    // client's work and the guard would be testing the fixture.
    const accepted = await fetch(`${api.baseUrl}/v1/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dropped@example.test", nonsense_column: 1 }),
    });
    expect(accepted.status).toBe(201);
    const row = (await accepted.json()) as Record<string, unknown>;
    expect(row["email"]).toBe("dropped@example.test");
    expect(Object.keys(row)).not.toContain("nonsense_column");
  });

  it("refuses a filter the resource does not support instead of answering unfiltered", async () => {
    const subject = store();
    await subject.contacts.create({ email: "filter@example.test" });
    const refused = await subject.contacts.list({ filters: { not_a_filter: "x" } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toContain("not_a_filter");
  });

  it("refuses the send-ledger fields POST /v1/messages cannot carry instead of dropping them", async () => {
    // `createMessage` and `upsertMessage` are not capability-gated, so the capability
    // machinery gives a caller handing them an idempotency key no refusal — and the
    // route has no field for one. Accepting and dropping is the failure the seam exists
    // to remove, and it is the same rule the SQLite store applies for its own reason.
    const subject = store();
    const base = { from_addr: "a@example.test", to_addrs: ["b@example.test"], subject: "ledger fields" };
    for (const field of [
      { idempotency_key: "MY-KEY" },
      { send_payload_hash: "deadbeef" },
      { send_state: "pending" },
      { send_started_at: new Date().toISOString() },
    ]) {
      const refused = await subject.messages.createMessage({ ...base, ...field });
      expect(refused.ok, `${JSON.stringify(field)} must be refused`).toBe(false);
      if (refused.ok) continue;
      expect(refused.code).toBe("invalid_input");
      expect(refused.message).toContain(Object.keys(field)[0] as string);
    }
    // `send_state: "none"` is what this store reports anyway, so it is accepted.
    const accepted = await subject.messages.createMessage({ ...base, send_state: "none" });
    expect(accepted.ok).toBe(true);
  });

  it("refuses a createMessage carrying a source_id BEFORE it sends anything", async () => {
    // The route upserts when a source_id is present, overwriting every column of any row
    // it matches. An earlier version sent the request and refused on the 200 — so the
    // collided row was already clobbered when the caller was told nothing had happened.
    // This asserts the refusal AND that no request was made.
    const subject = store();
    // Warm the openapi fetch and settle the fixture's request count first.
    await subject.contacts.list();
    const before = api.requestCount();
    const refused = await subject.messages.createMessage({
      from_addr: "a@example.test",
      to_addrs: ["b@example.test"],
      subject: "fenced",
      source_id: "some-upstream-id",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("upsertMessage");
    // NOT ONE REQUEST. This is the half that matters: a refusal issued after a
    // destructive write is worse than no refusal at all.
    expect(api.requestCount()).toBe(before);
  });

  it("preserves an ownership assignment when the patch field is undefined", async () => {
    // `{ owner_id: undefined }` is legal for an optional field and is what a form handler
    // produces from an unfilled input. It must PRESERVE. An earlier version tested
    // `"owner_id" in patch` and coerced with `?? null`, so it silently UNASSIGNED the
    // owner — while the SQLite arm preserved, making one seam operation behave two ways.
    // The conformance case does not cover this input.
    const subject = store();
    const owner = await subject.owners.create({ type: "human", name: "keeper" });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const ownerId = String(owner.value["id"]);
    // An address needs its domain registered first, as the conformance helper does.
    const provider = await subject.providers.create({ name: `own-provider-${Date.now()}`, type: "sandbox" });
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;
    const domainName = `own-${Date.now()}.test`;
    const registered = await subject.domains.createDomain({
      domain: domainName,
      provider: String(provider.value["id"]),
    });
    expect(registered.ok, `createDomain: ${JSON.stringify(registered)}`).toBe(true);
    if (!registered.ok) return;
    const created = await subject.addresses.createAddress({ email: `owner-check@${domainName}` });
    expect(created.ok, `createAddress: ${JSON.stringify(created)}`).toBe(true);
    if (!created.ok) return;
    const assigned = await subject.addressLifecycle.applyAddressOwnership(created.value.id, { owner_id: ownerId });
    expect(assigned.ok && assigned.value?.owner_id).toBe(ownerId);

    const untouched = await subject.addressLifecycle.applyAddressOwnership(created.value.id, {
      owner_id: undefined,
    });
    expect(untouched.ok).toBe(true);
    const read = await subject.addresses.getAddress(created.value.id);
    expect(read.ok && read.value?.owner_id, "an undefined owner_id must not clear the assignment").toBe(ownerId);

    // And an explicit null still CLEARS — the other direction, without which "preserve"
    // could be implemented by ignoring the field entirely.
    await subject.addressLifecycle.applyAddressOwnership(created.value.id, { owner_id: null });
    const cleared = await subject.addresses.getAddress(created.value.id);
    expect(cleared.ok && cleared.value?.owner_id).toBeNull();
  });

  it("reports the three-state attachment lookup in all three states", async () => {
    // Conformance only exercises "available". A client collapsing the 409 into ok(null)
    // would pass all 48 cases, so the other two states are asserted directly.
    const subject = store();
    const withBytes = await subject.messages.createMessage({
      direction: "inbound",
      from_addr: "s@example.test",
      to_addrs: ["r@example.test"],
      subject: "three states",
      received_at: new Date().toISOString(),
      attachments: [
        { filename: "has.txt", content_type: "text/plain", size: 19, content_base64: "Y29uZm9ybWFuY2UgcGF5bG9hZA==" },
        { filename: "lost.txt", content_type: "text/plain", size: 4 },
      ],
    });
    expect(withBytes.ok).toBe(true);
    if (!withBytes.ok) return;

    const available = await subject.emailContent.getMessageAttachment(withBytes.value.id, 0);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value?.state).toBe("available");

    // METADATA WITHOUT BYTES must report `content_unavailable`, never null: a caller has to
    // tell "we lost the bytes" from "no such attachment".
    const unavailable = await subject.emailContent.getMessageAttachment(withBytes.value.id, 1);
    expect(unavailable.ok).toBe(true);
    if (!unavailable.ok) return;
    expect(unavailable.value?.state).toBe("content_unavailable");
    if (unavailable.value?.state !== "content_unavailable") return;
    // ...carrying the metadata that state exists to convey, not an invented blank.
    expect(unavailable.value.attachment.filename).toBe("lost.txt");
    expect(unavailable.value.attachment.content_type).toBe("text/plain");

    // An index past the end, and an unknown message, are both ABSENCE — a value, because
    // the seam declares `StoredAttachmentLookup | null`.
    const missingIndex = await subject.emailContent.getMessageAttachment(withBytes.value.id, 9);
    expect(missingIndex.ok && missingIndex.value).toBeNull();
    const missingMessage = await subject.emailContent.getMessageAttachment(uuid(), 0);
    expect(missingMessage.ok && missingMessage.value).toBeNull();
  });

  it("refuses an upsert with no source_id rather than inserting a duplicate per replay", async () => {
    const subject = store();
    const refused = await subject.messages.upsertMessage({
      from_addr: "a@example.test",
      to_addrs: ["b@example.test"],
      subject: "no fence",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toContain("source_id");
  });
});

// ---- the transport's two bounds ----------------------------------------------
//
// Driven through `createTransport` rather than through a store, because both bounds are
// about what happens when the SERVICE misbehaves, and a well-behaved fixture cannot
// produce either condition. Both were written wrong first and are tested because of it.

describe("the HTTP transport's bounds", () => {
  const oversized = (bytes: number): FetchImplementation => {
    return async () =>
      new Response("x".repeat(bytes), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  it("stops a response at the ceiling instead of after exceeding it", async () => {
    const transport = createTransport({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "k",
      fetchImpl: oversized(4096),
      maxResponseBytes: 512,
    });
    await expect(transport.request("GET", "/domains")).rejects.toThrow(EmailsApiFault);
    // A body UNDER the ceiling still reads normally — the other direction of the bound,
    // without which a ceiling of zero would pass this test.
    const ok = createTransport({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "k",
      fetchImpl: async () =>
        new Response(JSON.stringify({ domains: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      maxResponseBytes: 512,
    });
    const answer = await ok.request("GET", "/domains");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ domains: [] });
  });

  /**
   * A body that never arrives and NEVER HONOURS THE ABORT SIGNAL.
   *
   * The uncooperative half is the point. An earlier version of this test built a stalling
   * stream that also ignored the signal, and the transport awaited `reader.read()`
   * directly — so the deadline fired, nothing observed it, and the test hung the whole
   * file instead of failing it. Adversarial review caught that, and the fix belonged in
   * the transport rather than the stub: a deadline that only works when the injected
   * `fetch` cooperates is not a deadline. So the stub here stays deliberately
   * uncooperative, and the transport must still fail the call.
   */
  const stalling: FetchImplementation = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(): void {
          // Never enqueues, never closes, never listens for an abort.
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("times out a response whose headers arrive and whose body then stalls", async () => {
    const transport = createTransport({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "k",
      fetchImpl: stalling,
      timeoutMs: 150,
    });
    const started = Date.now();
    // The TYPED fault, not merely "something threw": callers discriminate on it.
    await expect(transport.request("GET", "/domains")).rejects.toThrow(EmailsApiFault);
    // It failed because the deadline fired, not because it returned immediately.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    // And it did not hang: this assertion is only reached if the promise settled.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("reports a mid-body failure as the typed fault rather than a raw error", async () => {
    // The body read used to sit outside the try/catch that types transport failures, so a
    // stream that errored mid-read escaped as a raw error while outcome.ts promised every
    // network failure would arrive as `EmailsApiFault`.
    const breaking: FetchImplementation = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode('{"domains":'));
            controller.error(new Error("connection reset mid-body"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const transport = createTransport({
      baseUrl: "http://127.0.0.1:1/v1",
      credential: "k",
      fetchImpl: breaking,
      timeoutMs: 5_000,
    });
    await expect(transport.request("GET", "/domains")).rejects.toThrow(EmailsApiFault);
  }, 10_000);

  it("splits 403 into a credential FAULT and a per-request refusal", async () => {
    // Both directions of the rule in outcome.ts. A credential with no tenant mapping
    // answers 403 `no_tenant` on EVERY data route, so folding that into a refusal made a
    // misconfigured store answer "I cannot" to everything, invisibly — the exact failure
    // RULE 1 exists to prevent. An authority decision that varies by operation
    // (`operator_required`) is a genuine refusal. Neither direction had a test.
    const answering = (body: unknown): FetchImplementation => {
      return async () =>
        new Response(JSON.stringify(body), { status: 403, headers: { "Content-Type": "application/json" } });
    };

    const misconfigured = createHttpEmailStore({
      baseUrl: "http://127.0.0.1:1",
      credential: "k",
      fetchImpl: answering({ error: "api key is not bound to a tenant", reason: "no_tenant" }),
    });
    await expect(misconfigured.domains.listDomains()).rejects.toThrow(EmailsApiFault);

    const underprivileged = createHttpEmailStore({
      baseUrl: "http://127.0.0.1:1",
      credential: "k",
      fetchImpl: answering({
        error: "minting a send key requires a tenant owner, admin, or operator API key",
        reason: "operator_required",
      }),
    });
    const refused = await underprivileged.sendKeys.mintSendKey({ owner_id: "o" });
    expect(refused.ok, "an operator gate is a decision about this request, not a broken store").toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("scope_violation");
    expect(refused.status).toBe(403);
  });

  it("strips a credential and a query string out of the base URL it reports", () => {
    const { requestBase, safeBase } = toV1BaseUrl("https://user:pw@mail.example.test/?a=b#c");
    expect(requestBase).toBe("https://mail.example.test/v1");
    expect(safeBase).toBe("https://mail.example.test");
    // A configured URL that ALREADY ends in /v1 must not gain a second one.
    expect(toV1BaseUrl("https://mail.example.test/v1").requestBase).toBe("https://mail.example.test/v1");
    expect(toV1BaseUrl("https://mail.example.test/v1/").requestBase).toBe("https://mail.example.test/v1");
  });
});

// ---- the routes are the service's own ----------------------------------------

describe("the /v1 routes this store depends on", () => {
  /**
   * NO ROUTE IS EXCUSED. Every entry in `ROUTES` must appear in the service's own
   * document, and this list being EMPTY is the strong form of that claim.
   *
   * It exists so that a future dependency on unbuilt server surface has to be NAMED here
   * rather than quietly dropped from the route table — where it would escape the oracle
   * entirely. See `HTTP_STORE_MISSING_ROUTES` for the operations `/v1` cannot serve; note
   * that this check verifies a path and method EXIST, not that the route accepts every
   * body, which is why the outbound-message gap is recorded there and not here.
   */
  const KNOWN_ABSENT: Array<{ method: string; template: string; why: string }> = [];

  it("names every route in the table, with no duplicates", () => {
    const keys = ROUTES.map((route) => `${route.method} ${route.template}`);
    expect(new Set(keys).size, `duplicated route entries: ${keys.join(", ")}`).toBe(keys.length);
    // A floor well above zero: a table that stopped resolving would otherwise certify
    // nothing, which is how a guard in this repo once blessed an empty tarball.
    expect(ROUTES.length).toBeGreaterThan(30);
    for (const route of ROUTES) {
      expect(route.template.startsWith("/v1/"), `${route.template} is not a /v1 route`).toBe(true);
      expect(route.operations.length, `${route.method} ${route.template} names no operation`).toBeGreaterThan(0);
    }
  });

  it("finds every route in the service's own OpenAPI document", () => {
    // The check that makes the capability declaration evidence: the document is
    // generated from the same registry the router dispatches on, so a route missing
    // here is a route the service does not serve — independently of the test fixture.
    const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, unknown>>;
    const absent: string[] = [];
    for (const route of ROUTES) {
      const operations = paths[route.template];
      if (!operations || !(route.method.toLowerCase() in operations)) {
        absent.push(`${route.method} ${route.template}`);
      }
    }
    const excused = KNOWN_ABSENT.map((entry) => `${entry.method} ${entry.template}`);
    expect(absent.sort()).toEqual(excused.sort());
  });

  it("proves the OpenAPI check can fail", () => {
    // Positive control. Without it, a document that stopped parsing — or a path table
    // read from the wrong property — would make the assertion above pass over nothing.
    const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, unknown>>;
    expect(paths["/v1/messages"]).toBeDefined();
    expect(paths["/v1/messages/i-do-not-exist"]).toBeUndefined();
    expect("delete" in (paths["/v1/messages"] ?? {})).toBe(false);
  });

  it("pins the missing-route list against the capabilities it explains", () => {
    // The list is a DELIVERABLE, so it is checked rather than trusted: every capability
    // declared false must appear in it with the route that would make it true. A
    // capability flipped to true without a route, or a route quietly dropped from the
    // list, fails here.
    expect(HTTP_STORE_MISSING_ROUTES.length).toBeGreaterThan(0);
    const explained = new Set(
      HTTP_STORE_MISSING_ROUTES.map((entry) => entry.capability).filter((name): name is string => name !== null),
    );
    const declaredFalse = CAPABILITY_KEYS.filter((key) => !HTTP_STORE_CAPABILITIES[key]);
    expect([...explained].sort()).toEqual([...declaredFalse].sort());
    for (const entry of HTTP_STORE_MISSING_ROUTES) {
      expect(entry.operations.length, `${entry.wanted} names no operation`).toBeGreaterThan(0);
      expect(entry.wanted.length).toBeGreaterThan(0);
      expect(entry.today.length).toBeGreaterThan(0);
    }
    // The entries that are NOT capability-shaped are the ungated operations, and the
    // category must not quietly disappear. SIX of them remain, each a cheaper or more
    // atomic verb this store composes around. The COUNT is asserted, not merely
    // `some(...)`: with a bare existence check five of the six could be deleted with this
    // test green — the same quiet-shrink failure the assertion is here to prevent, and an
    // earlier version of this comment claimed the wrong number precisely because nothing
    // checked it.
    expect(HTTP_STORE_MISSING_ROUTES.filter((entry) => entry.capability === null).length).toBe(6);
    // AND THE OUTBOUND-RECORD GAP IS CLOSED. It was the one entry in this list with no
    // legal answer available: `createMessage`/`upsertMessage` are ungated, so there was
    // no capability to declare false, and `/v1` had no route that recorded a message
    // without sending it. `POST /v1/messages/record` serves them now, so no entry may
    // name either operation again.
    for (const operation of ["createMessage", "upsertMessage"]) {
      const stale = HTTP_STORE_MISSING_ROUTES.filter((entry) => entry.operations.includes(operation));
      expect(stale.map((entry) => entry.wanted), `${operation} is served and must not be listed as missing`).toEqual(
        [],
      );
    }
    // ...and the route table says so for BOTH operations, pointing at the record route
    // rather than at the inbound-only import route. Checking only `createMessage` would
    // have left `upsertMessage` free to point anywhere.
    for (const operation of ["createMessage", "upsertMessage"]) {
      const writes = ROUTES.filter((route) => route.operations.includes(operation));
      expect(writes.map((route) => `${route.method} ${route.template}`), operation).toEqual([
        "POST /v1/messages/record",
      ]);
    }
  });

  it("records an outbound message through the record route, and the import route still refuses one", async () => {
    // THE POSITIVE CONTROL FOR THE NEW ROUTE, in both directions, because either half
    // alone would be satisfied by the wrong change:
    //
    //  * the store must SUCCEED at recording an outbound row — that is the gap that was
    //    closed;
    //  * `POST /v1/messages` must STILL answer 409 for one — the fix was to add a route,
    //    not to loosen the guard that keeps the send path from being bypassed. A change
    //    that lifted the 409 instead would pass every conformance case and quietly make
    //    an outbound row creatable with no provider invocation behind it.
    const subject = store();
    const outbound = {
      direction: "outbound",
      from_addr: "sender@example.test",
      to_addrs: ["recipient@example.test"],
      subject: "recorded, not sent",
      status: "queued",
    };
    const recorded = await subject.messages.createMessage(outbound);
    expect(recorded.ok, `createMessage: ${JSON.stringify(recorded)}`).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.direction).toBe("outbound");

    const refusedByImport = await fetch(`${api.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: outbound.from_addr, to: outbound.to_addrs, direction: "outbound" }),
    });
    expect(refusedByImport.status, "POST /v1/messages must keep refusing an outbound write").toBe(409);
    // The service's own document still declares that 409, so this is not a fixture-only
    // property.
    const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths["/v1/messages"]?.["post"]?.["responses"] as object)).toContain("409");
    // And the record route is the service's, not the fixture's invention.
    expect(paths["/v1/messages/record"]?.["post"]).toBeDefined();
  });

  it("refuses a send-ledger field at the fixture route as well as in the client", async () => {
    // The client refuses these before the request (asserted above); this asserts the
    // ROUTE refuses them too, so the only thing standing between a fabricated idempotency
    // fence and the ledger is not a client-side check.
    //
    // AGAINST THE FIXTURE, and named that way after review caught the earlier title
    // claiming "at the service". The fixture imports the service's own
    // `SEND_LEDGER_FIELDS`, so the LIST is the server's — but the refusal executing here
    // is the fixture's. The real service's own refusal is asserted directly in
    // src/server/self-hosted/message-record-route.test.ts.
    for (const field of ["idempotency_key", "send_payload_hash", "send_state", "send_started_at"]) {
      const answer = await fetch(`${api.baseUrl}/v1/messages/record`, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "a@example.test", to: ["b@example.test"], [field]: "x" }),
      });
      expect(answer.status, `${field} must be refused by the route`).toBe(400);
      const body = (await answer.json()) as Record<string, unknown>;
      expect(body["reason"]).toBe("send_ledger_field");
      expect(String(body["error"])).toContain(field);
    }
  });
});

// ---- the proof that the suite can fail --------------------------------------

interface Neutering {
  /** What was broken, in the words of the wrong answer it now gives. */
  label: string;
  /** The case that MUST turn red. */
  caseId: string;
  /** Substring the failure detail must contain, so the RIGHT thing failed. */
  detail: string;
  break(subject: EmailStore): EmailStore;
}

const NEUTERINGS: Neutering[] = [
  {
    label: "listThreads returns an empty array",
    caseId: "threads/a-reply-rolls-up-with-its-parent-subject",
    detail: "exactly one thread must carry the written subject key",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        threads: {
          ...subject.threads,
          async listThreads() {
            return { ok: true, value: [] };
          },
        },
      };
    },
  },
  {
    label: "messageCounts returns zeros",
    caseId: "messages/counts-follow-the-writes",
    detail: "total count",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        messages: {
          ...subject.messages,
          async messageCounts() {
            return {
              ok: true,
              value: {
                inbox: 0,
                unread: 0,
                starred: 0,
                sent: 0,
                archived: 0,
                spam: 0,
                trash: 0,
                total: 0,
                latest_received_at: null,
              },
            };
          },
        },
      };
    },
  },
  {
    label: "listMessages returns an empty page",
    caseId: "messages/keyset-scan-emits-every-row-exactly-once",
    detail: "the keyset scan order, exactly",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        messages: {
          ...subject.messages,
          async listMessages() {
            return { ok: true, value: { items: [], next_cursor: null } };
          },
        },
      };
    },
  },
  {
    label: "getMessageAttachment answers null instead of the bytes it declares it can serve",
    caseId: "attachments/content-lookup-answers-with-the-stored-bytes",
    detail: "attachment lookup",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        emailContent: {
          ...subject.emailContent,
          async getMessageAttachment() {
            return { ok: true, value: null };
          },
        },
      };
    },
  },
  {
    label: "listAttachmentsForMessageIds returns an empty map",
    caseId: "attachments/metadata-batch-reports-content-availability",
    detail: "attachment metadata for the written message",
    break(subject: EmailStore): EmailStore {
      return {
        ...subject,
        emailContent: {
          ...subject.emailContent,
          async listAttachmentsForMessageIds() {
            return { ok: true, value: {} };
          },
        },
      };
    },
  },
  {
    label: "a flag write silently does nothing while reads keep working",
    caseId: "inbound/starred-flag-round-trip",
    detail: "the star is persisted",
    break(subject: EmailStore): EmailStore {
      // THE MOST IMPORTANT CONTROL. Every other neutering here breaks a READ, and a
      // suite that only caught broken reads would miss the whole class of "the write was
      // accepted and dropped" bugs — which for an HTTP client is the likeliest bug there
      // is, because a request that was never sent and a request whose body lost a field
      // both come back 200.
      return {
        ...subject,
        inbound: {
          ...subject.inbound,
          async setInboundStarred(id: string) {
            return subject.messages.getMessage(id);
          },
        },
      };
    },
  },
  {
    label: "an unavailable capability answers a plausible default instead of the refusal",
    caseId: "policy/a-zero-quota-address-is-not-sendable",
    detail: "did not return the capability refusal",
    break(subject: EmailStore): EmailStore {
      // THE REFUSAL CHANNEL'S OWN CONTROL, and not a hypothetical one: this is verbatim
      // the bug records.ts records against the old local arm — for an address it knows
      // nothing about it answered `sendable: true`, i.e. "go ahead". The capability is
      // false here, so the only legal answer is the refusal; a store free to reply with
      // a cheerful default is how an unverified sender gets through.
      return {
        ...subject,
        addressLifecycle: {
          ...subject.addressLifecycle,
          async getAddressSendability() {
            return { ok: true, value: { sendable: true, reason: null, sent_today: 0, daily_quota: null } };
          },
        },
      };
    },
  },
  {
    label: "getMessageRaw answers an empty envelope instead of the written MIME",
    caseId: "messages/raw-mime-carries-the-written-headers",
    detail: "raw must be a non-empty string",
    break(subject: EmailStore): EmailStore {
      // `rawMessage` was the one TRUE read capability with no control proving its case can
      // go red. An empty string is the plausible wrong answer here: the call succeeds, the
      // shape is right, and every header the caller asked about is gone.
      return {
        ...subject,
        messages: {
          ...subject.messages,
          async getMessageRaw() {
            return { ok: true, value: { raw: "", message_id: null } };
          },
        },
      };
    },
  },
  {
    label: "a refusal names a capability other than the one that was asked for",
    caseId: "policy/a-suspended-sender-is-not-allowed",
    detail: "did not return the capability refusal",
    break(subject: EmailStore): EmailStore {
      // A single hard-coded refusal blob must not answer for every capability a store
      // lacks. `outboundPolicy` is false here, so the case expects a refusal — but one
      // that NAMES outboundPolicy.
      return {
        ...subject,
        sendIntents: {
          ...subject.sendIntents,
          async evaluateOutboundPolicy() {
            return capabilityRefusal("mailRollups", "api");
          },
        },
      };
    },
  },
];

describe("the conformance suite can fail for the HTTP store", () => {
  for (const neutering of NEUTERINGS) {
    it(
      `goes red when ${neutering.label}`,
      async () => {
        const broken = neutering.break(store());
        const report = await runConformanceSuite([broken], CONFORMANCE_CASES);
        const failures = conformanceFailures(report);
        // The named case failed...
        const named = failures.filter((entry) => entry.startsWith(`api/${neutering.caseId}:`));
        expect(named.length, `${neutering.caseId} did not fail; failures were ${JSON.stringify(failures)}`).toBe(1);
        expect(named[0]).toContain(neutering.detail);
        // ...and it failed by RUNNING, not by being skipped.
        expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();
        expect(totals(report).failed).toBeGreaterThan(0);
      },
      SUITE_TIMEOUT_MS,
    );
  }

  it(
    "does not fail for the unmodified store",
    async () => {
      // The other direction of the same control: the neuterings above are only evidence
      // if the store they were derived from is green.
      const report = await runConformanceSuite([store()], CONFORMANCE_CASES);
      expect(conformanceFailures(report)).toEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );
});
