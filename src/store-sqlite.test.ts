// SqliteEmailStore against the shared conformance suite — plus the proof that the
// suite can FAIL.
//
// The second half is the point of this file. A conformance suite that cannot go
// red proves nothing, and this repo has already shipped three guards that
// certified nothing (a pack guard that blessed an empty tarball, ban patterns
// with no positive controls, a coverage assertion over a mutated case list). So
// the neutering block below takes the working store, replaces exactly one method
// with the plausible wrong answer that method would otherwise be free to
// return — an empty array, a zero count, an empty page, a null instead of a
// refusal — and asserts that the corresponding case turns red while coverage
// stays uniform. Those four neuterings ARE the positive control for the suite,
// and they keep working when every count in it reaches zero.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, type Database } from "./db/database.js";
import { now, uuid } from "./db/runtime.js";
import { CAPABILITY_KEYS, isCapabilityRefusal } from "./store/capabilities.js";
import {
  CONFORMANCE_CASES,
  assertUniformCaseCoverage,
  capabilityCoverageGaps,
  conformanceFailures,
  runConformanceSuite,
  type ConformanceReport,
} from "./store/conformance.js";
import type { EmailStore } from "./store/email-store.js";
import { RESOURCE_TABLES } from "./store-sqlite/resources.js";
import { SQLITE_STORE_CAPABILITIES, createSqliteEmailStore } from "./store-sqlite/index.js";

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

// Forty cases, each writing a handful of rows, run five times over (once clean and
// once per neutering). Well past the 5s default on a loaded runner.
const SUITE_TIMEOUT_MS = 60_000;

let db: Database;

beforeEach(() => {
  captureInheritedProcessEnv();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  restoreInheritedProcessEnv();
});

function store(): EmailStore {
  return createSqliteEmailStore({ database: db, detail: "SQLite in-memory (test)" });
}

function totals(report: ConformanceReport): { passed: number; refused: number; failed: number } {
  const results = report.flatMap((implementation) => implementation.results);
  return {
    passed: results.filter((result) => result.status === "passed").length,
    refused: results.filter((result) => result.status === "refused").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

describe("SqliteEmailStore conformance", () => {
  it(
    "executes every case and answers each one with behaviour or the typed refusal",
    async () => {
      const report = await runConformanceSuite([store()], CONFORMANCE_CASES);
      expect(conformanceFailures(report)).toEqual([]);
      // The coverage assertion is the one that makes a green summary mean something:
      // every case ran, for this store, with none silently excluded.
      expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();
      const counted = totals(report);
      expect(counted.failed).toBe(0);
      expect(counted.passed + counted.refused).toBe(CONFORMANCE_CASES.length);
      // Both halves must be non-empty. All-passed would mean the refusal channel was
      // never exercised; all-refused would mean the store does nothing.
      expect(counted.passed).toBeGreaterThan(0);
      expect(counted.refused).toBeGreaterThan(0);
      // A refused case must be a case whose capability this store declares false —
      // never one it claims to support.
      for (const result of report[0]?.results ?? []) {
        const declared = CONFORMANCE_CASES.find((testCase) => testCase.id === result.caseId);
        if (result.status !== "refused") continue;
        expect(declared?.requires, `${result.caseId} was refused without naming a capability`).not.toBeNull();
        const capability = declared?.requires;
        if (capability) expect(SQLITE_STORE_CAPABILITIES[capability]).toBe(false);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it("leaves no declared capability unexercised", () => {
    expect(capabilityCoverageGaps()).toEqual([]);
    expect(CONFORMANCE_CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("declares every capability exactly once, and refuses precisely what it declares false", async () => {
    const subject = store();
    expect(Object.keys(subject.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());
    // Each false capability, checked against ONE representative operation, so a
    // capability flipped in the declaration without an implementation is caught here
    // rather than by a reviewer.
    const refusals: Array<[string, Promise<unknown>]> = [
      ["rawMessage", subject.messages.getMessageRaw(uuid())],
      ["attachmentContent", subject.emailContent.getMessageAttachment(uuid(), 0)],
      ["attachmentContent", subject.emailContent.listAttachmentsForMessageIds([uuid()])],
      ["sendIntentLedger", subject.sendIntents.lookupSendIntent("k")],
      ["sendIntentLedger", subject.sendIntents.listUncertainSendIntents()],
      ["outboundPolicy", subject.addressLifecycle.getAddressSendability("a@b.test")],
      ["outboundPolicy", subject.sendKeys.isOwnerAuthorizedFrom("owner", "a@b.test")],
      ["outboundPolicy", subject.sendIntents.evaluateOutboundPolicy({ from_addr: "a@b.test", to_addrs: [] })],
      ["outboundPolicy", subject.sendIntents.markSendBlocked(uuid(), "sender_unverified")],
      ["attachmentRepair", subject.attachmentRepair.getAttachmentRepairRun(uuid())],
      ["attachmentRepair", subject.attachmentRepair.listPendingAttachmentRepairEntries(uuid())],
    ];
    for (const [capability, answer] of refusals) {
      const value = await answer;
      // Naming the capability matters: one hard-coded refusal blob must not answer for
      // every capability the store lacks.
      expect(isCapabilityRefusal(value, capability as never), `${capability}: ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("wires every uniform family to a table that exists", async () => {
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
    // Every declared family is wired; nothing is missing and nothing extra is claimed.
    expect(families.map(([family]) => family).sort()).toEqual(Object.keys(RESOURCE_TABLES).sort());
    for (const [family, read] of families) {
      const answer = (await read()) as { ok: boolean };
      expect(answer.ok, `${family} could not be listed`).toBe(true);
    }
  });

  it("round-trips a row through the family whose table has no single-column key", async () => {
    // `webhook_receipts` is keyed on (provider, event_id), so the generic path
    // addresses it by rowid. That is the one non-derivable choice in resources.ts and
    // it needs a behavioural check of its own.
    const subject = store();
    const eventId = `evt-${uuid()}`;
    const created = await subject.webhookReceipts.create({ provider: "ses", event_id: eventId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = String((created.value as Record<string, unknown>)["rowid"]);
    const read = await subject.webhookReceipts.get(id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("the receipt did not read back");
    expect(read.value["event_id"]).toBe(eventId);
    const removed = await subject.webhookReceipts.remove(id);
    expect(removed.ok && removed.value).toBe(true);
  });

  it("reads the legacy sent ledger through the unified stream", async () => {
    // Rows in `emails` are not written through the seam (that table's NOT NULL
    // provider FK is the storage artifact this store declines to lift), but they MUST
    // still be readable: a Sent folder that omits them is the under-reporting failure
    // in miniature.
    const subject = store();
    const providerId = uuid();
    db.run("INSERT INTO providers (id, name, type, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, ?)", [
      providerId,
      "legacy",
      now(),
      now(),
    ]);
    const ledgerId = uuid();
    db.run(
      `INSERT INTO emails (id, provider_id, from_address, to_addresses, subject, status, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
      [ledgerId, providerId, "ledger@example.test", JSON.stringify(["dest@example.test"]), "ledger row", now(), now(), now()],
    );
    const read = await subject.messages.getMessage(ledgerId);
    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) throw new Error("the ledger row is invisible through the seam");
    expect(read.value.direction).toBe("outbound");
    expect(read.value.subject).toBe("ledger row");
    expect(read.value.to_addrs).toEqual(["dest@example.test"]);
    const counts = await subject.messages.messageCounts();
    expect(counts.ok && counts.value.sent).toBe(1);

    // And a flag write against such a row is REFUSED rather than silently dropped:
    // the legacy table has nowhere to put read/star/archive state.
    const refused = await subject.inbound.setInboundRead(ledgerId, true);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("invalid_input");
    expect(refused.status).toBe(422);
  });

  it("joins a transaction the caller already owns instead of opening a second one", async () => {
    // `withImmediateTransaction` takes the write lock up front, and SQLite rejects a
    // nested BEGIN. A store operation inside a caller's transaction must therefore
    // join it — and the write must still be visible after the caller commits.
    const subject = store();
    db.exec("BEGIN IMMEDIATE");
    const created = await subject.messages.createMessage({
      direction: "inbound",
      from_addr: "nested@example.test",
      to_addrs: ["dest@example.test"],
      subject: "written inside a caller transaction",
    });
    expect(created.ok).toBe(true);
    db.exec("COMMIT");
    if (!created.ok) return;
    const read = await subject.messages.getMessage(created.value.id);
    expect(read.ok && read.value !== null).toBe(true);
  });

  it("never exposes a credential through the diagnostics descriptor", () => {
    const subject = store();
    expect(subject.descriptor.kind).toBe("sqlite");
    expect(subject.descriptor.detail.length).toBeGreaterThan(0);
    for (const secret of ["password", "secret", "token", "api_key", "?"]) {
      expect(subject.descriptor.detail.toLowerCase()).not.toContain(secret);
    }
  });
});

// ---- the proof that the suite can fail --------------------------------------

interface Neutering {
  /** What was broken, in the words of the wrong answer it now gives. */
  label: string;
  /** The case that MUST turn red. */
  caseId: string;
  /** Substring the failure detail must contain, so the right thing failed. */
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
    detail: "a keyset scan must emit every row exactly once",
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
    label: "getMessageAttachment answers null instead of the capability refusal",
    caseId: "attachments/content-lookup-answers-with-the-stored-bytes",
    detail: "did not return the capability refusal",
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
];

describe("the conformance suite can fail", () => {
  for (const neutering of NEUTERINGS) {
    it(
      `goes red when ${neutering.label}`,
      async () => {
        const broken = neutering.break(store());
        const report = await runConformanceSuite([broken], CONFORMANCE_CASES);
        const failures = conformanceFailures(report);
        // The named case failed...
        const named = failures.filter((entry) => entry.startsWith(`sqlite/${neutering.caseId}:`));
        expect(named.length, `${neutering.caseId} did not fail; failures were ${JSON.stringify(failures)}`).toBe(1);
        expect(named[0]).toContain(neutering.detail);
        // ...and it failed by RUNNING, not by being skipped. A neutering that reduced
        // coverage would be the other bug this harness exists to prevent.
        expect(() => assertUniformCaseCoverage(report, CONFORMANCE_CASES)).not.toThrow();
        expect(totals(report).failed).toBeGreaterThan(0);
      },
      SUITE_TIMEOUT_MS,
    );
  }

  it("does not fail for the unmodified store", async () => {
    // The other direction of the same control: the four neuterings above are only
    // evidence if the store they were derived from is green.
    const report = await runConformanceSuite([store()], CONFORMANCE_CASES);
    expect(conformanceFailures(report)).toEqual([]);
  }, SUITE_TIMEOUT_MS);
});
