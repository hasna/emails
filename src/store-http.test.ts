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

// ---- the routes are the service's own ----------------------------------------

describe("the /v1 routes this store depends on", () => {
  /**
   * The ONE route this store uses that the service does not offer.
   *
   * Named, reasoned and pinned rather than omitted from the table, so it shows up in
   * review as a dependency on unbuilt server surface instead of disappearing. See
   * `HTTP_STORE_MISSING_ROUTES` for the full accounting.
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
    // The entries that are NOT capability-shaped are the uncomfortable ones — ungated
    // operations depending on surface that does not exist. At least one exists today
    // (the outbound-record route), and this asserts the list keeps saying so rather
    // than quietly losing the category.
    expect(HTTP_STORE_MISSING_ROUTES.some((entry) => entry.capability === null)).toBe(true);
    const outbound = HTTP_STORE_MISSING_ROUTES.find((entry) => entry.operations.includes("createMessage"));
    expect(outbound?.capability, "the outbound-record gap must be recorded as capability-less").toBeNull();
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
