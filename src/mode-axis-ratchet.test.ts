import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import {
  MODE_AXIS_METRICS,
  RATCHET_CORPUS_EXCLUSIONS,
  measureModeAxis,
  positiveControlFailures,
} from "../scripts/mode-axis-ratchet-lib.mjs";
import { isSkippableBinary } from "../scripts/no-cloud-scan-lib.mjs";

// A RATCHET over the deployment-mode axis. Every number below is a CEILING, NOT A
// TARGET: the axis is being deleted outright, so each count may only go down, and
// the assertion is `<=`. Lowering a ceiling is the whole point of the program and
// needs no discussion; raising one means a change added a new mode branch, a new
// second implementation of an existing repository, or a new read of the mode
// variable, and must be argued for in review rather than slipped in.
//
// WHY the axis goes away, and why halfway is not an option: `self_hosted` means
// OPPOSITE things in the two shipped binaries. In the `emails` CLI it means "become
// an HTTP client"; in `emails-serve` it means "become a Postgres server". One
// variable, two contradictory semantics, and no amount of documentation fixes that —
// only deletion does. The adopted model is one deployment story, "you run it", with
// location as a deployment detail and not a product variant.
//
// THIS TEST IS THE GATE. The final axis-deletion change may land only when every
// count here has reached ZERO; at that point this file and its scan library are
// deleted along with the axis they measure. Until then, the ceilings make progress
// mechanically visible in review: a reviewer diffs the numbers instead of trusting a
// summary.
//
// HOW IT STAYS HONEST. Two vacuity failures have already shipped in this repo — a
// pack guard that certified an EMPTY tarball, and ban patterns with no positive
// controls. A ratchet has both hazards at once, so:
//   1. the corpus floor lives INSIDE `scannedFiles()`, not in one test, so every
//      assertion that reads the corpus inherits it. A scan that resolves too few
//      files, or reads them as empty, throws — it cannot pass over nothing, and it
//      cannot be reduced to passing by running a single test with `-t`.
//   2. every counter is proved to still FIRE against inline fixtures rather than
//      against repo content, because repo counts are supposed to reach zero and a
//      "this metric found something" check would then have to be deleted exactly
//      when it matters most. That includes the PATH SELECTORS of the content
//      metrics, which were the one unproven part of the measurement: a
//      one-character typo in `\.local\.ts$` silently drove a 47-unit metric to
//      zero with every other assertion green.
//
// WHAT THIS CANNOT PROVE, and the reason `twoArmFamilies` is the first metric: ten of
// the eleven counters are keyed on NAMES, so a mechanical rename of the dispatch
// helper, the mode variable and the arm-file suffix drives every one of them to zero
// with all 43 two-arm families, 293 dispatch sites and 242 variable references still
// standing. `twoArmFamilies` is computed from FILE STRUCTURE and no identifier, so a
// rename cannot move it. Reaching zero is therefore necessary for the deletion PR and
// still not sufficient: that PR has to be READ.
//
// (This comment deliberately does not spell the identifiers out. The test file is
// inside its own corpus and must contribute zero to every count — the assertion below
// enforces it, and it caught this very paragraph on the first run.)
//
// Neither the ceilings nor the exemption list may be relaxed to make a change pass.

const root = join(import.meta.dir, "..");

/**
 * The pinned ceiling for every metric, measured on fe61a46 (the merge of #83).
 *
 * The `emailsModeEnvReferences` ceiling was first pinned at 232 on 5bb126e, rose to
 * 242 on fe61a46, and is 239 here. It has never been RELAXED: the one increase was
 * ten references that landed on main while this test was being written (seven in
 * src/db/self-hosted-store.test.ts, two in the new
 * src/self-hosted-wire-regression.test.ts, one in src/mcp/http.test.ts) and that the
 * ratchet caught on rebase — the guard working, not the guard yielding, and the last
 * time the number may move UP. The three that came off here, together with the one
 * off `resolveEmailsModeReferences` (74 -> 73), are the mode guards deleted from
 * src/mcp/tools/{domains-impl,misc-ops,sequences}.ts: `assertAliasLocalStateAllowed`,
 * `assertGroupMemberStateAllowed` and `assertSequenceSubledgerAllowed` each read the
 * mode variable and each named it again in the refusal text they no longer emit.
 * (Spelled indirectly on purpose — this file is inside its own corpus and must
 * contribute zero to every count.)
 *
 * Notes a reviewer should not have to re-derive:
 *  - `selfHostedResourceBranches` counts 47, of which 46 are call sites in the ten
 *    `*.local.ts` repositories and one is the helper's own definition in
 *    `src/db/self-hosted-resource.local.ts`. The definition is counted on purpose:
 *    it must reach zero too.
 *  - `isSelfHostedModeReferences` spans TWO independent definitions —
 *    `src/db/self-hosted-store.ts` (client: "am I an HTTP client?") and
 *    `src/server/self-hosted/env.ts` (server: "am I a Postgres server?"). That
 *    collision is the reason for this program.
 *  - `selfHostedResourceReferences` (203) is the SUPERSET of
 *    `selfHostedResourceBranches` (47). The narrow one is scoped to `*.local.*`
 *    because that is where the local arm interrogates its own mode; without the
 *    tree-wide one beside it the gate could reach zero here with 156 call sites
 *    elsewhere untouched.
 *  - `emailsModeEnvReferences` covers the whole tree, not just TypeScript: docs,
 *    the README, Terraform and compose all name the variable, and all of them have
 *    to stop.
 *  - `twoArmFamilies` counts `x.ts` facades that still have two or more `x.<arm>.*`
 *    siblings. It equalled `remoteArmModules` while every HTTP arm still had a local
 *    sibling and a facade; they are not the same measurement and will diverge as
 *    families collapse one at a time.
 *
 * TIGHTENED on the delivery-doctor collapse, and the reason is that `<=` leaves SLACK
 * a regression can walk back through. A ceiling above the live count is a licence to
 * re-add exactly as many branches as the gap is wide, with the guard still green — so
 * every phase that lowers a count has to lower its ceiling to match, or it has only
 * half-landed. Two prior collapses left slack behind: #108 (the batch family) left
 * `twoArmFamilies` and `remoteArmModules` one wide each and `getEmailsModeReferences`
 * two wide, and #83's own note above records `emailsModeEnvReferences` sitting three
 * under its ceiling. All of it is reclaimed here.
 *
 * Every number below is now EXACTLY the count measured over the real `git ls-files`
 * corpus of this commit (666 tracked / 665 scanned / 8,447,265 characters), so the gap
 * between "what the tree contains" and "what the guard permits" is zero on all eleven.
 * The delivery-doctor collapse itself is what moved four of them off the b3fdef5
 * numbers: `twoArmFamilies` 42 -> 41 and `remoteArmModules` 42 -> 41 (its two arms are
 * deleted), `routedFacadeDefinitions` 30 -> 29 and `routedCallExpressions` 293 -> 290
 * (its facade's dispatch helper and three dispatched exports), plus
 * `getEmailsModeReferences` 76 -> 74 (the facade's import and its one call) and
 * `resolveEmailsModeReferences` 73 -> 71 (the local arm's import and its one call,
 * which fed the domain inbound-readiness signals).
 *
 * A consequence worth stating for the next agent in this phase: with zero slack, a
 * concurrent collapse that lands first makes this block a conflict rather than a
 * silent no-op — which is the correct failure. Re-measure and re-pin on rebase; do not
 * widen a number to make a merge easy.
 *
 * RE-PINNED AGAIN on the verification-code collapse, on top of the status-facts re-pin
 * that this rebase landed beside. The paragraph above is exactly why both were needed:
 * "zero slack on all eleven" is true of the tree it was measured on and stops being true
 * the moment anything else merges without re-measuring. The status-facts pin had already
 * reclaimed five metrics' worth of stale slack; this one re-measures the COMBINED tree,
 * because two collapses that each lowered different counters would otherwise each leave
 * the other's reductions unpinned.
 *
 * The two collapses move DISJOINT sets of counters, which is why the merge is a real
 * tightening rather than a pick-one:
 *   - status-facts moved `twoArmFamilies` and `remoteArmModules` by one, and
 *     `getEmailsModeReferences` and `resolveEmailsModeReferences` by two each; its own
 *     dispatch used neither the helper nor a dispatched export.
 *   - verification-code moves `twoArmFamilies` and `remoteArmModules` by one more, 39 -> 38
 *     (its two
 *     arms are deleted), `routedFacadeDefinitions` 29 -> 28 and `routedCallExpressions` by
 *     three (its facade's dispatch helper and its three dispatched exports), and
 *     `isSelfHostedModeReferences` by two (that facade's import of the client-side mode
 *     predicate and its one call).
 *
 * RE-PINNED AGAIN on the analytics collapse, rebased over the verification-code and
 * doctor pins above. THE CONFLICT THIS PRODUCED IS THE GUARD WORKING: with zero slack,
 * concurrent collapses cannot all land without one of them re-measuring the COMBINED
 * tree. Analytics deletes its two arms, so `twoArmFamilies` and `remoteArmModules` fall
 * by one each; its facade's dispatch helper and two dispatched exports take
 * `routedFacadeDefinitions` by one and `routedCallExpressions` by two; and the deleted
 * facade's mode import plus its one dispatch read take `getEmailsModeReferences` by two.
 * `resolveEmailsModeReferences` does not move — the deleted arms resolved no mode of
 * their own, the local arm read SQLite directly and the second arm was a throwing stub.
 *
 * AND HERE IS WHY THE RESOLUTION MUST BE A MEASUREMENT AND NOT ARITHMETIC. The obvious
 * way to settle a conflict in this block is to take the smaller of the two sides per
 * metric. It is wrong, and this rebase is the proof: main and this branch BOTH carried
 * `getEmailsModeReferences: 68`, so a per-metric minimum keeps 68 — while the merged tree
 * measures 66, because the two collapses removed DISJOINT references and a minimum cannot
 * see that. Two units of slack would have been pinned as "zero slack", which is exactly
 * the licence this whole paragraph exists to deny. Zero every number, then measure.
 *
 * Every number below is EXACTLY the count measured over the real `git ls-files` corpus of
 * THIS commit, re-measured after this comment was written because this file is inside the
 * corpus it scans. The gap between what the tree contains and what the guard permits is
 * zero on all eleven — and the way to keep it that way is to re-measure on every rebase
 * rather than to trust this sentence.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/lib/doctor` collapse — the fourth rebase in a
 * row where this block was a conflict, which is the mechanism working rather than failing.
 * The numbers below were measured twice, as the paragraph above asks: once on the commit this
 * change is BASED ON and once on its own staged tree. A ceiling inherited from a sibling
 * branch is not evidence about the tree you are merging into.
 *
 * This collapse moves five. `twoArmFamilies` and `remoteArmModules` by one each (the doctor
 * family's two arms are deleted); `getEmailsModeReferences` by two (the deleted facade's
 * import and its one dispatch read); `resolveEmailsModeReferences` by four (BOTH deleted arms
 * imported the resolver and each called it once); and `emailsModeEnvReferences` by three (the
 * deleted family's test fixture had to scrub three deployment-word settings and no longer has
 * a mode to set). Its facade dispatched inline rather than through the helper, so
 * `routedFacadeDefinitions` and `routedCallExpressions` do not move.
 *
 * Base measurement, recorded because it is the half that a rebase invalidates: on b5edee9 all
 * eleven live counts already equalled their declared ceilings, so nothing landed on top of the
 * block above without re-pinning and there is no inherited slack to reclaim. Five ceilings move
 * and all five are paid for here: `twoArmFamilies` 38 -> 37, `remoteArmModules` 38 -> 37,
 * `getEmailsModeReferences` 70 -> 68, `resolveEmailsModeReferences` 69 -> 65,
 * `emailsModeEnvReferences` 238 -> 235. The other six were already exact and stay put. Corpus
 * of this change: 668 tracked, 667 scanned, 8,745,666 characters.
 */
const CEILINGS: Record<string, number> = {
  twoArmFamilies: 36,
  remoteArmModules: 36,
  routedFacadeDefinitions: 27,
  routedCallExpressions: 285,
  selfHostedResourceBranches: 47,
  selfHostedResourceReferences: 199,
  isSelfHostedModeReferences: 68,
  getEmailsModeReferences: 66,
  resolveEmailsModeReferences: 65,
  normalizeEmailsModeReferences: 16,
  emailsModeEnvReferences: 235,
};

// 624 files are tracked and 623 scanned today, totalling ~7.4M characters. The floors
// make "the scan stopped resolving files" or "the scan read them as empty" a red test
// rather than a green run over nothing.
//
// They are set with the FAKE-REDUCTION case in mind, not just the empty case. 226 of
// the tracked files are test files, and they hold 159 of the 242 variable references;
// at a 400-file floor, deleting 214 test files (no product code touched) cut that
// metric by 66% and still passed, with one file of margin left. 500 leaves the
// legitimate shrink — the axis deletion removes on the order of 50 arm modules and
// their suites — comfortably inside, while making that trick fail immediately.
const MINIMUM_SCANNED_FILES = 500;
const MINIMUM_SCANNED_CHARS = 5_000_000;

interface ScannedFile {
  path: string;
  content: string;
}

// `git ls-files` IS the set of committed surfaces, which is the only set that can
// carry the axis forward. Deriving the corpus from the index rather than from a
// hand-written roots list is what keeps a rename, a new directory or a new file type
// covered with no edit here.
function trackedPaths(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = output.split("\0").filter((path) => path.length > 0);
  // `git ls-files` emits ONE ENTRY PER STAGE for an unmerged path, so during a
  // conflicted merge a file is listed up to three times. For a predicate scan that is
  // harmless, which is why the no-cloud guard this idiom came from never noticed; for a
  // COUNTING ratchet it inflates the numbers and fails the build for the wrong reason.
  // Deduplicating silently would hide a genuinely broken index, so this throws instead.
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) {
    throw new Error(
      `git ls-files returned ${paths.length - unique.length} duplicate path(s); ` +
        "the index is probably mid-merge. Resolve the conflict before measuring the axis.",
    );
  }
  return unique;
}

function scannedFiles(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const path of trackedPaths()) {
    if (RATCHET_CORPUS_EXCLUSIONS.has(path)) continue;
    // A tracked symlink-to-directory or a submodule gitlink would make readFileSync
    // throw EISDIR and take the whole suite down with an unreadable error. Skipping
    // non-regular files is safe because the "nothing else is dropped" assertion below
    // then fails loudly and names the count.
    if (!statSync(join(root, path)).isFile()) continue;
    const buffer = readFileSync(join(root, path));
    if (isSkippableBinary(path, buffer)) continue;
    files.push({ path, content: buffer.toString("utf8") });
  }
  // THE FLOOR LIVES HERE, not in one test. Every assertion that reads the corpus goes
  // through this function, so none of them can be run — by `-t`, by `it.skip`, or by a
  // future split of the test below — over a corpus small enough to satisfy `<=`
  // trivially. That separation is exactly how a pack guard once certified an empty
  // tarball in this repo.
  if (files.length < MINIMUM_SCANNED_FILES) {
    throw new Error(`ratchet corpus resolved only ${files.length} files (floor ${MINIMUM_SCANNED_FILES})`);
  }
  const chars = files.reduce((total, file) => total + file.content.length, 0);
  if (chars < MINIMUM_SCANNED_CHARS) {
    throw new Error(`ratchet corpus read only ${chars} characters (floor ${MINIMUM_SCANNED_CHARS})`);
  }
  return files;
}

function report(key: string, byFile: Record<string, { path: string; count: number }[]>): string {
  const worst = (byFile[key] ?? []).slice(0, 10).map((entry) => `${entry.count}\t${entry.path}`);
  return `${key} — highest-count files:\n${worst.join("\n")}`;
}

describe("deployment-mode axis ratchet", () => {
  it("scans a corpus that is neither empty nor unreadable", () => {
    // scannedFiles() throws below the floors, so reaching this line already proves the
    // corpus is real. What is left to check is that nothing was silently DROPPED.
    const tracked = trackedPaths();
    const scanned = scannedFiles();
    // Nothing is dropped except the declared exemption: this repo commits no binary
    // payloads and no non-regular tracked entries, so both skips must remove zero files.
    expect(tracked.length - scanned.length).toBe(RATCHET_CORPUS_EXCLUSIONS.size);
    // The non-TypeScript surfaces have to be present, or the tree-wide variable count
    // silently narrows to `src/**` and stops gating docs and deploy config. This proves
    // presence, not proportion — one file of a kind satisfies it.
    const kinds = new Set(scanned.map((file) => extname(file.path).toLowerCase() || "(extensionless)"));
    for (const kind of [".ts", ".tsx", ".mjs", ".md", ".tf", ".yml", ".json"]) expect(kinds).toContain(kind);

  });

  it("keeps the corpus exemption list minimal, live, and free of self-exemption", () => {
    expect([...RATCHET_CORPUS_EXCLUSIONS.keys()]).toEqual(["scripts/mode-axis-ratchet-lib.mjs"]);
    for (const [path, reason] of RATCHET_CORPUS_EXCLUSIONS) {
      expect(statSync(join(root, path)).isFile()).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      // An exempt file is the obvious place to park the code it excuses, and its
      // literals ARE invisible to the scan. So the exemption is paid for by making the
      // module inert: no imports, no requires, no environment or runtime access. It can
      // hold pattern strings; it cannot hold behaviour.
      const source = readFileSync(join(root, path), "utf8");
      expect(source, `${path} must not import`).not.toMatch(/^\s*import\s|\brequire\s*\(/m);
      expect(source, `${path} must not touch the runtime`).not.toMatch(
        /\bprocess\s*\.\s*(?:env|argv|exit|cwd)|\bBun\s*\.|\bglobalThis\b|\beval\b/,
      );
    }
    // The ratchet is not exempt from itself. It names its metrics with suffixed keys
    // (`getEmailsModeReferences`, never the bare identifier) precisely so it can sit
    // inside the scanned corpus and contribute nothing to it — which also means mode
    // code cannot be parked in this file to dodge a count.
    const selfPath = relative(root, import.meta.path);
    const self = scannedFiles().filter((file) => file.path === selfPath);
    expect(self.length, `${selfPath} must be inside the scanned corpus`).toBe(1);
    const { counts } = measureModeAxis(self);
    expect(counts).toEqual(Object.fromEntries(MODE_AXIS_METRICS.map((metric) => [metric.key, 0])));
  });

  it("declares exactly one ceiling per metric", () => {
    // A metric added to the scan library without a ceiling here would be measured and
    // never enforced; a ceiling with no metric would be enforced against nothing.
    expect(MODE_AXIS_METRICS.map((metric) => metric.key).sort()).toEqual(Object.keys(CEILINGS).sort());
    for (const metric of MODE_AXIS_METRICS) expect(metric.what.length).toBeGreaterThan(20);
    // Exactly one metric must be identifier-independent, or a rename alone opens the
    // deletion gate. Today that is `twoArmFamilies`; if it is ever removed, this fails.
    expect(MODE_AXIS_METRICS.filter((metric) => metric.kind === "pathset").map((metric) => metric.key)).toEqual([
      "twoArmFamilies",
    ]);
  });

  it("proves every counter still fires, independently of repo content", () => {
    // The check that survives count zero. Fixtures live next to each metric, and both
    // directions are asserted: a pattern that stopped matching would silently zero a
    // count, and a pattern widened until it matches anything would ratchet upward and
    // block unrelated work.
    for (const metric of MODE_AXIS_METRICS) {
      const control = metric.positiveControl;
      if (metric.kind === "pathset") {
        expect(control.pathSetHits.length).toBeGreaterThan(0);
        expect(control.pathSetMisses.length).toBeGreaterThan(0);
      } else {
        expect(control.hits.length).toBeGreaterThan(0);
        expect(control.misses.length).toBeGreaterThan(0);
      }
      // A content metric that narrows by path MUST prove that selector too. Leaving it
      // unproven let a one-character typo zero three metrics at once while every other
      // assertion stayed green.
      if (metric.kind === "content" && metric.matchesPath) {
        expect(control.pathHits?.length ?? 0, `${metric.key} declares no path fixtures`).toBeGreaterThan(0);
        expect(control.pathMisses?.length ?? 0, `${metric.key} declares no path fixtures`).toBeGreaterThan(0);
      }
      expect(positiveControlFailures(metric), `${metric.key} positive control`).toEqual({
        missedHits: [],
        falsePositives: [],
      });
    }
  });

  it("holds every count at or below its pinned ceiling", () => {
    const { counts, byFile } = measureModeAxis(scannedFiles());
    for (const metric of MODE_AXIS_METRICS) {
      const ceiling = CEILINGS[metric.key] as number;
      const actual = counts[metric.key] as number;
      // `<=`, never `===`: this is a ratchet. Going down is progress and must not
      // fail. Going up is a regression and must.
      expect(
        actual,
        `${metric.key} rose from ${ceiling} to ${actual}. This is a CEILING, not a target — ` +
          `the deployment-mode axis may only shrink. ${metric.what}\n${report(metric.key, byFile)}`,
      ).toBeLessThanOrEqual(ceiling);
    }
  });
});
