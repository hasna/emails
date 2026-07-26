// The conformance suite: ONE set of behavioural cases, run against EVERY store.
//
// This is the scaffolding only. `CONFORMANCE_CASES` is deliberately empty — cases
// arrive with the implementations they describe. What has to exist FIRST is the
// harness and, above all, the assertion that makes skipping impossible, because a
// suite that quietly runs 40 cases against one store and 12 against the other proves
// nothing about the store that got 12, and that shortfall is invisible in a green
// summary line.
//
// THE TWO RULES THE HARNESS ENFORCES
//
// 1. EVERY IMPLEMENTATION EXECUTES EVERY CASE. There is no per-store skip, no
//    `it.if`, no capability-based exclusion. `assertUniformCaseCoverage` fails unless
//    each store's executed case-id list is EXACTLY the declared list.
//
// 2. A MISSING CAPABILITY IS STILL A BEHAVIOUR. A case whose capability the store
//    declares false is not skipped: it is run, and the store is required to answer
//    with the canonical typed refusal. That is what closes the "return an empty array
//    and move on" escape hatch — under this harness, an empty success FAILS the case
//    a refusal would have passed.
//
// Nothing here reads a deployment mode, and nothing branches on
// `descriptor.kind`. The suite's only inputs are the declared capabilities and the
// observed answers.

import { CAPABILITY_KEYS, isCapabilityRefusal, type CapabilityKey } from "./capabilities.js";
import type { EmailStore } from "./email-store.js";

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
 * Empty on purpose. Cases land with the implementations they describe; the harness
 * and its coverage assertion land first so no implementation can arrive without them.
 *
 * `capabilityCoverageGaps()` below is the gate: the first implementation PR may not
 * land while any declared capability has no case, because an untested capability is
 * exactly where "false" quietly becomes "returns nothing".
 */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = Object.freeze([]);

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

/**
 * Capabilities with no case exercising them.
 *
 * The gate for the first implementation PR: a capability nobody exercises is a
 * capability whose `false` branch has never been observed, and that is precisely where
 * a refusal degenerates into "returns nothing". Must be empty before implementations
 * land.
 */
export function capabilityCoverageGaps(cases: readonly ConformanceCase[] = CONFORMANCE_CASES): CapabilityKey[] {
  const covered = new Set(cases.map((testCase) => testCase.requires));
  return CAPABILITY_KEYS.filter((key) => !covered.has(key));
}
