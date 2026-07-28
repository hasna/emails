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
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/lib/email-digest` collapse, on top of the
 * doctor re-pin above, which this rebase landed under.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, measured against the commit it was written on (b5edee9,
 * where all eleven live counts equalled their declared ceilings): `twoArmFamilies` and
 * `remoteArmModules` by one each (the digest family's two arms are deleted);
 * `routedFacadeDefinitions` by one and `routedCallExpressions` by four (its facade held a
 * dispatch helper and four dispatched exports); and `getEmailsModeReferences` by two — that
 * dispatcher read the process-wide setting directly rather than through the client-side
 * predicate, which is also why `isSelfHostedModeReferences` does not move. Its arms carried
 * no resource branches, so neither `selfHostedResource*` counter moves.
 *
 * THE NUMBERS BELOW ARE THE COMBINED TREE'S, NOT A PER-METRIC MINIMUM, and two consecutive
 * rebases here are exactly the case where the difference is visible. Sibling collapses in
 * this phase lower OVERLAPPING counters, and each branch pins the count for its own tree —
 * so the same number appearing on both sides is not agreement, it is two independent
 * measurements of two different trees.
 *
 * THE SILENT HALF, WHICH IS THE PART WORTH RECORDING: when both sides pin a counter to the
 * SAME value, git auto-merges the line with NO conflict marker, and the result is exactly the
 * per-metric minimum. On the rebase onto the analytics collapse that happened to four of the
 * eleven at once — `twoArmFamilies` and `remoteArmModules` (both sides 36, merged tree 35),
 * `routedFacadeDefinitions` (both 27, merged tree 26) and `getEmailsModeReferences` (both 66,
 * merged tree 64) — and only ONE counter conflicted loudly. A rebase that resolves the
 * visible conflict and trusts the rest therefore ships five counters between one and two
 * wide with the guard green. The only safe procedure is to RE-MEASURE every counter on the
 * merged tree after every rebase, which is what produced the numbers below.
 *
 * Corpus of the merged change: 664 tracked, 663 scanned, 8,851,815 characters.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/address-lifecycle` collapse — the FIRST
 * `src/db/*` family to go, which is why the shape of the reduction is worth reading and not
 * just the size of it.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, measured on the commit it was written on (8df9247, where
 * all eleven live counts equalled their then-declared ceilings): `twoArmFamilies` and
 * `remoteArmModules` by one each (the family's two arms are deleted, so the facade has no
 * siblings left); `routedFacadeDefinitions` by one and `routedCallExpressions` by SIX — this
 * facade held a dispatch helper and dispatched all six of its exports through it;
 * `isSelfHostedModeReferences` by two (the deleted facade imported the client-side predicate
 * and called it once). Neither deleted arm imported the resource helper or either mode
 * resolver — they reached data sideways through ANOTHER family's arms instead — so the two
 * `selfHostedResource*` counters, both mode-resolver counters and the env counter do not move.
 *
 * THE NUMBERS BELOW WERE RE-MEASURED ON THE MERGED TREE AFTER THIS REBASE, and the paragraph
 * above about the silent half is why. Only ONE line conflicted here
 * (`isSelfHostedModeReferences` / `getEmailsModeReferences`, where the two sides genuinely
 * disagreed); `resolveEmailsModeReferences`, `normalizeEmailsModeReferences` and
 * `emailsModeEnvReferences` sit BELOW the conflict region and were auto-merged with no marker
 * at all. Trusting that silence is how a counter ships wide with the guard green.
 *
 * WHAT THE MERGED MEASUREMENT ACTUALLY CHANGED, stated as arithmetic so a reviewer can check
 * it rather than trust it. Main at a2c940b pinned 35 / 35 / 26 / 281 / 47 / 199 / 68 / 64 /
 * 65 / 16 / 235 and this branch had pinned 36 / 36 / 27 / 281 / 47 / 199 / 66 / 68 / 65 / 16 /
 * 235 for its own tree. A per-metric minimum of those two lists is
 * 35 / 35 / 26 / 281 / 47 / 199 / 66 / 64 / 65 / 16 / 235. The MERGED tree measures
 * 34 / 34 / 25 / 275 / 47 / 199 / 66 / 64 / 65 / 16 / 235 — so the minimum would have shipped
 * `twoArmFamilies`, `remoteArmModules` and `routedFacadeDefinitions` one wide each and
 * `routedCallExpressions` SIX wide, with the guard green on all four, because `<=` cannot see
 * slack. Corpus of the merged change: 662 tracked, 661 scanned, 8,902,586 characters.
 *
 * A NOTE FOR THE `src/db/*` FAMILIES BEHIND THIS ONE, since each will hit this block: a db
 * family whose arms read the deployment word directly will move more counters than this one
 * did; one that only reaches sideways into a sibling family's arm will move exactly these
 * five. Either way the number to lower is the one you MEASURED, on the combined tree, after
 * rebasing — and zeroing all eleven before measuring is what stops the previous pins from
 * anchoring the new ones.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the delivery-statistics collapse, by the procedure the
 * two paragraphs above prescribe rather than by resolving what git showed. This is the fifth
 * consecutive rebase on this block and it reproduced THE SILENT HALF twice over: on the
 * rebase onto the analytics/digest tree only `routedCallExpressions` conflicted while four
 * other counters auto-merged with no marker at the value both sides shared, and on this one
 * `twoArmFamilies`, `remoteArmModules` and `routedFacadeDefinitions` auto-merged the same way.
 * Every counter was therefore ZEROED and re-measured over the real `git ls-files` corpus of
 * the MERGED tree, then measured again after this paragraph was written because this file is
 * inside the corpus it scans.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, as the difference between the commit it merges into (where
 * all eleven live counts equalled the ceilings declared above) and the merged tree:
 * `twoArmFamilies` and `remoteArmModules` by one each (that family's two arms are deleted);
 * `routedFacadeDefinitions` by one and `routedCallExpressions` by two (its facade held a
 * dispatch helper and dispatched its two exports through it); and `getEmailsModeReferences` by
 * two — that dispatcher read the process-wide setting directly rather than through the
 * client-side predicate, which is also why `isSelfHostedModeReferences` does not move. Neither
 * arm carried a resource branch, called either mode resolver, or named the environment
 * variable, so the remaining five counters do not move.
 *
 * Corpus of this merged change: 660 tracked, 659 scanned, 8,970,424 characters.
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/scheduled` collapse, rebased three times in
 * a row as the sibling collapses landed under it.
 *
 * THIS BRANCH HIT EVERY FAILURE MODE THIS BLOCK WARNS ABOUT, on three consecutive rebases,
 * which is the clearest evidence yet that the PROCEDURE and not the conflict is what protects
 * these numbers. Onto a2c940b: NO line conflicted at all, because this branch had not yet
 * touched the block — so all eleven arrived from main silently, which is the per-metric
 * minimum by another route, and the tree measured seven counters lower. Onto 1546869: three
 * of eleven conflicted and eight merged with no marker. Onto 832d3c7: two regions conflicted
 * and the rest merged silently again. Every time the answer was identical — zero all eleven,
 * then measure the merged tree over the real `git ls-files` corpus. An absent conflict is not
 * agreement; it is the absence of a question.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, measured on the commit it was rebased onto (832d3c7, where
 * all eleven live counts equalled their declared ceilings) and again on the merged tree:
 * `twoArmFamilies` and `remoteArmModules` by one each (the schedule family's two arms are
 * deleted); `routedFacadeDefinitions` by one and `routedCallExpressions` by EIGHT — its facade
 * held a dispatch helper and dispatched all eight of its exports through it, the largest
 * dispatch table collapsed so far; `selfHostedResourceBranches` by two and
 * `selfHostedResourceReferences` by seven (the local arm asked twice whether it was really the
 * local arm, and the second arm reached the resource store five times); and
 * `isSelfHostedModeReferences` by two (the deleted facade imported the client-side predicate
 * and called it once). Neither deleted arm named the deployment setting or parsed it, so the
 * three resolver/parser counters and the env counter do not move.
 *
 * ARITHMETIC A REVIEWER CAN CHECK RATHER THAN TRUST. Main at 832d3c7 pinned
 * 33 / 33 / 24 / 273 / 47 / 199 / 66 / 62 / 65 / 16 / 235 and this branch had pinned
 * 33 / 33 / 24 / 267 / 45 / 192 / 64 / 64 / 65 / 16 / 235 for its own tree. A per-metric
 * minimum is 33 / 33 / 24 / 267 / 45 / 192 / 64 / 62 / 65 / 16 / 235. The MERGED tree measures
 * 32 / 32 / 23 / 265 / 45 / 192 / 64 / 62 / 65 / 16 / 235 — so the minimum would have shipped
 * twoArmFamilies, remoteArmModules and routedFacadeDefinitions one wide each and
 * routedCallExpressions TWO wide, all four green under `<=`, because the two collapses removed
 * DISJOINT references and a minimum cannot see that.
 *
 * Corpus of the merged change: 658 tracked, 657 scanned, 9,001,510 characters — two fewer
 * tracked files than main, which is exactly the two deleted arms.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/email-digests` collapse — the persisted
 * digest-ROW family. It is a different family from the digest MODULE re-pinned further up, and
 * it is the one that module still imported its period parser from.
 *
 * WHAT THIS COLLAPSE MOVES, as the difference between the commit it was rebased onto (06b7f42,
 * where all eleven live counts equalled the ceilings declared above — measured, not assumed)
 * and the merged tree: `twoArmFamilies` 32 -> 31 and `remoteArmModules` 32 -> 31 (its two arms
 * are deleted); `routedFacadeDefinitions` 23 -> 22 and `routedCallExpressions` 265 -> 259 (its
 * facade held a dispatch helper and dispatched all SIX of its exports through it — and two of
 * those six were PURE functions that touch no storage and were byte-identical in both arms, so
 * the deployment word decided nothing about them at all); `isSelfHostedModeReferences`
 * 64 -> 62 (the deleted facade imported the client-side predicate and called it once, which is
 * also why `getEmailsModeReferences` does NOT move — this dispatcher went through the predicate
 * rather than reading the process-wide setting directly); and `selfHostedResourceReferences`
 * 192 -> 188 (the deleted second arm's four generic-resource calls).
 * `selfHostedResourceBranches` does NOT move even though a `*.local.*` module was deleted:
 * that metric counts the local arm asking whether it is really the local arm, and this one
 * never did — it talked to SQLite directly. The two resolver counters, the parser counter and
 * the env counter do not move either; neither arm resolved or named the setting, and the new
 * suite needs no deployment-word setting to scrub because the collapsed module has no mode to
 * read.
 *
 * RE-MEASURED AFTER THE FINAL REBASE RATHER THAN TRUSTING GIT'S MERGE — and this rebase is the
 * most emphatic instance of the hazard recorded in this block so far, so it is worth the
 * arithmetic. Git showed TWO conflict regions: the prose, and a ceiling region covering exactly
 * `routedCallExpressions`, `selfHostedResourceBranches` and `selfHostedResourceReferences`.
 * The other EIGHT counters auto-merged with no marker, because both sides had pinned them to
 * the same numbers — and FOUR of those eight were wrong on the merged tree: `twoArmFamilies`
 * (both sides 32, merged tree 31), `remoteArmModules` (both 32, merged 31),
 * `routedFacadeDefinitions` (both 23, merged 22) and `isSelfHostedModeReferences` (both 64,
 * merged 62). Resolving only what git asked about would therefore have shipped FIVE units of
 * slack across four counters with `<=` green — a licence to re-add two arms, a facade
 * dispatcher and two predicate reads. An absent conflict is not agreement.
 *
 * The procedure that produced the numbers below: keep BOTH sides' prose, set all eleven
 * ceilings to zero, measure the merged tree over the real `git ls-files` corpus, pin what was
 * measured, then measure again after writing this paragraph because this file sits inside the
 * corpus it scans. The ceiling-and-comment edit contributes zero to every metric.
 *
 * Corpus of this change: 657 tracked, 656 scanned, 9,061,157 characters — both floors
 * (500 files / 5,000,000 characters) cleared with room. One file fewer than 06b7f42: two arm
 * modules deleted, one test file added.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/email-content` collapse, which was rebased
 * TWICE as sibling collapses landed under it, and the two rebases produced OPPOSITE-LOOKING
 * invitations to get it wrong:
 *
 *  * onto 06b7f42, THIS FILE DID NOT CONFLICT AT ALL. `git diff origin/main` over it was EMPTY,
 *    because that branch had not yet touched the block — so all eleven ceilings arrived from
 *    main verbatim, git reported nothing to resolve, and the guard was green. There was no
 *    visible resolution to be tempted by and no per-metric minimum to compute: the invitation
 *    was simply to DO NOTHING. Measuring found SEVEN counters standing wide.
 *  * onto 65ed3a8, THREE of eleven lines conflicted (`routedCallExpressions`,
 *    `selfHostedResourceBranches`, `selfHostedResourceReferences`) and the other EIGHT
 *    auto-merged with no marker, at values the two sides happened to share AFTER the digest-row
 *    collapse had moved them — which is the worst case, because agreement on a number is not
 *    agreement about a tree.
 *
 * Both times the answer was the same: zero all eleven, then measure the merged tree over the
 * real `git ls-files` corpus. An absent conflict is not agreement; it is the absence of a
 * question.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, as the difference between the commit it merges into
 * (65ed3a8, where all eleven live counts equalled the ceilings it declared) and the merged
 * tree: `twoArmFamilies` and `remoteArmModules` by one each (the family's two arms are
 * deleted); `routedFacadeDefinitions` by one and `routedCallExpressions` by two (its facade
 * held a dispatch helper and dispatched both of its exports through it);
 * `selfHostedResourceBranches` by one and `selfHostedResourceReferences` by three (the local
 * arm asked once whether it was really the local arm, and the two arms reached the resource
 * store between them); and `isSelfHostedModeReferences` by two (the deleted facade imported the
 * client-side predicate and called it once). Neither deleted arm named the deployment setting or
 * parsed it, so the three resolver/parser counters and the env counter do not move.
 *
 * ARITHMETIC A REVIEWER CAN CHECK RATHER THAN TRUST. Main at 65ed3a8 pinned
 * 31 / 31 / 22 / 259 / 45 / 188 / 62 / 62 / 65 / 16 / 235; this branch had pinned
 * 31 / 31 / 22 / 263 / 44 / 189 / 62 / 62 / 65 / 16 / 235 for its own pre-rebase tree. The
 * MERGED tree measures 30 / 30 / 21 / 257 / 44 / 185 / 60 / 62 / 65 / 16 / 235. So git's own
 * resolution — the eight silently merged lines, plus a per-metric minimum on the three that
 * conflicted — would have shipped `twoArmFamilies`, `remoteArmModules`,
 * `routedFacadeDefinitions` one wide each, `routedCallExpressions` and
 * `isSelfHostedModeReferences` two wide each, and `selfHostedResourceReferences` THREE wide:
 * SIX counters and ten units of slack, all green under `<=`, because the two collapses removed
 * DISJOINT references and neither a merge nor a minimum can see that.
 * (`selfHostedResourceBranches` would have been right, by luck, which is the point.)
 *
 * Corpus of the merged change: 655 tracked, 654 scanned, ~9.11M characters — both floors
 * cleared with room. Measured a second time after this paragraph was written, because this file
 * is inside the corpus it scans; the eleven counts were unchanged.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/forwarding` collapse — app-level inbound
 * forwarding. Note that `src/lib/forwarding.*` is a DIFFERENT family with the same word in its
 * name and, AT THAT COMMIT, still had both of its arms; nothing in that pin counted it as
 * collapsed. (It is collapsed now — see the last block in this comment, which re-pins on it.)
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, as the difference between the commit it was branched from
 * (65ed3a8, where all eleven live counts equalled the ceilings it declared — MEASURED, not
 * assumed) and that branch's own tree: `twoArmFamilies` 31 -> 30 and `remoteArmModules` 31 -> 30
 * (its two arms are deleted); `routedFacadeDefinitions` 22 -> 21 and `routedCallExpressions`
 * 259 -> 252 (its facade held a dispatch helper and dispatched all SEVEN of its exports through
 * it); `selfHostedResourceReferences` 188 -> 183 (the deleted second arm reached the generic
 * resource store five times); and `isSelfHostedModeReferences` 62 -> 60 (the deleted facade
 * imported the client-side predicate and called it once, which is also why
 * `getEmailsModeReferences` does NOT move — this dispatcher went through the predicate rather
 * than reading the process-wide setting). `selfHostedResourceBranches` does NOT move even though
 * a `*.local.*` module was deleted, for the reason recorded for the digest-row collapse: that
 * metric counts a local arm asking whether it is really the local arm, and this one never did —
 * it talked to SQLite directly. The two resolver counters, the parser counter and the env counter
 * do not move either; neither deleted arm resolved or named the setting, and the rebuilt suites
 * name their storage settings through the resolution's OWN exported constants, which are not the
 * deployment word.
 *
 * THE REBASE ONTO e7ef9c1 IS THE THIRD MEASURED INSTANCE OF THE HAZARD THIS BLOCK KEEPS
 * RECORDING, and it is the worst-numbered one so far. Git flagged exactly THREE ceiling lines
 * (`routedCallExpressions`, `selfHostedResourceBranches`, `selfHostedResourceReferences`) and
 * auto-merged the other EIGHT with no marker, at values the two sides happened to share. FIVE of
 * those eight were WRONG on the merged tree:
 *
 *   twoArmFamilies           both sides 30, merged tree 29   (1 wide)
 *   remoteArmModules         both sides 30, merged tree 29   (1 wide)
 *   routedFacadeDefinitions  both sides 21, merged tree 20   (1 wide)
 *   isSelfHostedModeReferences both sides 60, merged tree 58 (2 wide)
 *   ... and on the three git DID flag, a per-metric minimum gives
 *   routedCallExpressions        min(257, 252) = 252, merged tree 250  (2 wide)
 *   selfHostedResourceReferences min(185, 183) = 183, merged tree 180  (3 wide)
 *   selfHostedResourceBranches   min(44, 45)  = 44,  merged tree 44   (right, by luck)
 *
 * So resolving only what git asked about, and taking the minimum where it did ask, would have
 * shipped TEN units of slack across SIX counters with `<=` green — a licence to re-add two arms,
 * a facade dispatcher, two predicate reads, two dispatch sites and three resource calls. The two
 * collapses removed DISJOINT references, and neither a silent merge nor a minimum can see that.
 *
 * The procedure that produced the numbers below: keep BOTH sides' prose, set all eleven ceilings
 * to ZERO, measure the merged tree over the real `git ls-files` corpus, pin what was measured,
 * then measure again after writing this paragraph because this file sits inside the corpus it
 * scans. The ceiling-and-comment edit contributes zero to every metric.
 *
 * Corpus of the merged change: 653 tracked, 652 scanned, 9,202,221 characters — both floors
 * (500 files / 5,000,000 characters) cleared with room. Two files fewer than e7ef9c1, which is
 * exactly this family's two deleted arms; no test file was added, because its suite already
 * existed and was rewritten in place.
 *
 * RE-MEASURED AND RE-PINNED on the `src/lib/s3-sync` REGISTRY collapse — and this entry is the
 * first PARTIAL one in this block, which is the thing a reader most needs to notice.
 *
 * ONLY FOUR OF THAT FAMILY'S FIVE EXPORTS COLLAPSED. `listS3Sources`, `listLiveS3Sources`,
 * `registerS3Source` and `retireS3Source` never touched a database in either arm — they read and
 * write a `mail_sources` array in the local CONFIG FILE, and the two arms' copies were
 * character-for-character identical — so there was nothing for the deployment word to decide and
 * they are now one implementation. `syncS3Inbox` is STILL ROUTED, and BOTH ARM MODULES REMAIN,
 * because migrating that one onto the store seam loses five things the seam has no field or
 * operation for, one of which is a data-safety regression (`inbound_emails.provider_id` would be
 * NULL on every ingested row, which disarms `PROVIDER_DELETE_GUARD_SQL` and lets a provider DELETE
 * through). It is sequenced after `src/db/inbound`.
 *
 * SO ONLY TWO COUNTERS MOVE, and the seven-that-usually-move pattern does NOT apply here:
 *
 *   routedFacadeDefinitions  20 -> 19   the facade's mode-dispatch helper is deleted; the one
 *                                       remaining routed export is a plain async function with a
 *                                       dynamic import, which also stops every consumer that only
 *                                       wanted a source list from eval-loading the SQLite
 *                                       ingestion path and `@aws-sdk/client-s3` behind it
 *   routedCallExpressions   250 -> 245   the four dispatched registry exports are gone, and so is
 *                                       the fifth's dispatch EXPRESSION: the one still-routed export
 *                                       now picks its module with a plain conditional dynamic import
 *                                       instead of going through the helper
 *
 * AND HERE IS THE UNCOMFORTABLE PART, MEASURED RATHER THAN GLOSSED: those two deltas are IDENTICAL
 * to what the FULL collapse of this family measured on branch `p4/9e1ea854-s3-sync` (19 and 245).
 * They have to be — both metrics count dispatch-helper SHAPES in module source, and this facade now
 * contains none of them either way. So `routedFacadeDefinitions` and `routedCallExpressions` CANNOT
 * distinguish a finished family from one whose ingestion is still routed through a dynamic import.
 * `twoArmFamilies` and `remoteArmModules` are the two that can, and they are exactly the two that do
 * NOT move here. Anyone reading this delta as completion should read those two first.
 *
 * NINE DO NOT MOVE, and each absence is the honest consequence of stopping halfway:
 *
 *   twoArmFamilies      29  both `s3-sync.local.ts` and `s3-sync.remote.ts` still exist. A reduced
 *   remoteArmModules    29  `routedCallExpressions` must NOT be read as this family being done —
 *                           these two are the counters that say it is not, and they are correct.
 *   getEmailsModeReferences  62  the facade still imports the process-wide read and still calls it
 *                                once, for the one export that is still routed.
 *   isSelfHostedModeReferences 58 · resolveEmailsModeReferences 65 · normalizeEmailsModeReferences 16
 *   selfHostedResourceBranches 44 · selfHostedResourceReferences 180 · emailsModeEnvReferences 235
 *                           nothing in the registry half resolved, normalized or named the setting,
 *                           and nothing in it reached the generic resource store.
 *
 * A SMALLER HONEST DELTA IS THE POINT. The full collapse of this family measured 28 · 28 · 19 · 245
 * · 44 · 180 · 58 · 60 · 65 · 16 · 235 on branch `p4/9e1ea854-s3-sync`; those numbers are NOT
 * carried across, because that tree also carried six probe-verified majors. All eleven were zeroed
 * and the SPLIT tree measured from scratch.
 *
 * Pristine `a8aa241` verified independently over the real `git ls-files` corpus at 653 tracked /
 * 652 scanned / 9,232,117 characters: all eleven live counts equalled the eleven ceilings it
 * declared, ZERO slack. That is the baseline both deltas above are taken from. This tree: 653
 * tracked / 652 scanned — the SAME file count, because the split adds and deletes no module.
 *
 * Procedure, unchanged: zero all eleven, measure the merged tree over the real corpus, pin what was
 * measured, then measure AGAIN after writing this paragraph because this file sits inside the corpus
 * it scans. That second measurement was taken and the eleven were unchanged.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/lib/forwarding` collapse — the app-level
 * forwarding PIPELINE, the consumer of the `src/db/forwarding` family re-pinned above. Two
 * families, one word, and this is the second of the pair to go.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, as the difference between the tree it merges into (016da25,
 * where all eleven live counts equalled the ceilings it declared) and the merged tree:
 * `twoArmFamilies` 29 -> 28 and `remoteArmModules` 29 -> 28 (its two arms are deleted);
 * `routedFacadeDefinitions` 19 -> 18 and `routedCallExpressions` 245 -> 244 (its facade held a
 * dispatch helper and dispatched its ONE export through it — the smallest facade in the
 * programme so far, and why the call-expression counter moves by one rather than by several);
 * and `getEmailsModeReferences` 62 -> 60 (the deleted facade imported the process-wide read and
 * called it once, which is also why `isSelfHostedModeReferences` does NOT move — this
 * dispatcher read the setting directly rather than through the client-side predicate). The
 * other six do not move: neither deleted arm carried a resource branch, called either resolver,
 * parsed the setting, or named the environment variable.
 *
 * TWO REBASES, AND THE SECOND ONE IS THE MOST INSTRUCTIVE INSTANCE THIS BLOCK HAS RECORDED,
 * because the two rebases failed in OPPOSITE ways and the same procedure caught both.
 *
 * Onto a8aa241 (#126, comment-only): git flagged NOTHING here. A rebase that read the absent
 * conflict as agreement would have carried the pre-rebase pin forward untested. All eleven were
 * zeroed in their own commit first and then measured; they came back identical, which is the
 * answer the procedure has to be ABLE to give — "unchanged" as a measurement, not an assumption.
 *
 * Onto 016da25 (#128, the s3-sync registry split, plus #129): git flagged ONE region, and it
 * ENDED MID-BLOCK. Four ceiling lines were inside the markers and the remaining SEVEN merged
 * with no marker at all, at this branch's pre-rebase values. Arithmetic a reviewer can check
 * rather than trust — main pinned 29/29/19/245/44/180/58/62/65/16/235 and this branch had pinned
 * 28/28/19/249/44/180/58/60/65/16/235 for its own pre-rebase tree, so git's own resolution (the
 * silent seven, plus a per-metric minimum on the four it flagged) gives
 * 28/28/19/245/44/180/58/60/65/16/235. The MERGED tree measures
 * 28/28/18/244/44/180/58/60/65/16/235. So `routedFacadeDefinitions` would have shipped ONE wide
 * and `routedCallExpressions` ONE wide, both green under `<=` — because the two changes removed
 * DISJOINT dispatchers and neither a silent merge nor a minimum can see that. The seven silent
 * ones happened to be right, which is the point: luck is not a method.
 *
 * THE ENV COUNTER IS THE ONE WORTH READING HERE, because it is the counter this collapse could
 * most easily have RAISED. The deleted second arm was a stub that THREW, so preserving its
 * refusal without the deployment word was the whole design problem — and the tempting way to
 * prove the refusal survived is a test that SETS the deployment word and asserts the pipeline
 * runs anyway. That test would have added `emailsModeEnvReferences`, a substring match no
 * spelling escapes (not even an exported constant), and this counter may only fall. So the
 * rebuilt suite does not name it at all: it configures storage through the resolution's OWN
 * exported constants, and the absence of the mode read is left to THIS test, which is the guard
 * designed for it and now has zero slack under it. The same reasoning kept the dispatch-helper
 * and mode-read identifiers out of that suite's assertions.
 *
 * AND THIS BRANCH RAISED A COUNTER ONCE, FROM PROSE, which is #128's lesson arriving
 * independently: a paragraph added to the collapsed module — explaining which guard currently
 * stops one configuration from sending mail — named the routing helper AS A CALL, and
 * `selfHostedResourceReferences` went 180 -> 181. A sentence about a guard pushing that guard's
 * own metric backwards, in a file inside the scanned corpus, caught by re-measuring rather than
 * by review. It is spelled as a FILE PATH now. The scan does not strip comments: never write a
 * tracked token you are describing, name it by role, and re-measure after editing prose.
 *
 * Corpus of this change: 653 tracked, 652 scanned, 9,314,203 characters — both floors
 * (500 files / 5,000,000 characters) cleared with room. The SAME tracked count as 016da25, and
 * the arithmetic is worth spelling out because it is not "nothing moved": TWO arm modules are
 * deleted and TWO are added — `src/lib/storage-wiring.ts`, the storage-configuration read
 * extracted out of `src/lib/status-facts.ts` so the pipeline and the status payload share one
 * definition site, and `src/lib/storage-wiring.test.ts`, which exists because a mutation run
 * showed that inverting that module's in-memory discrimination survived the pipeline's own suite
 * and was killed only by the status suite several layers away. The suite beside the collapsed
 * module already existed and was rewritten in place, so it adds no file. The character total was
 * measured with this paragraph in place, since editing it changes the corpus it describes; the
 * eleven counts were identical before and after.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/aliases` collapse — per-domain aliases and
 * catch-all routing. It is the largest single-family reduction in this phase so far, and the
 * shape of it is worth reading rather than only the size.
 *
 * WHAT THIS COLLAPSE ITSELF MOVES, as the difference between the tree it merges into (55de52c,
 * verified INDEPENDENTLY over the real `git ls-files` corpus at 653 tracked / 652 scanned /
 * 9,314,203 characters, where all eleven live counts equalled the ceilings it declared, ZERO
 * slack) and the merged tree:
 *
 *   twoArmFamilies               28 -> 27   both of the family's arm modules are deleted, so its
 *   remoteArmModules             28 -> 27   facade has no siblings left. THESE TWO ARE THE PAIR
 *                                           that says a family is finished; the s3-sync split
 *                                           moved the next two by a full collapse's amounts
 *                                           while both its arms survived.
 *   routedFacadeDefinitions      18 -> 17   the facade's dispatch helper is deleted
 *   routedCallExpressions       244 -> 234  it dispatched all TEN of its exports through that
 *                                           helper — the largest dispatch table collapsed in
 *                                           this programme
 *   selfHostedResourceReferences 180 -> 173 the deleted second arm reached the generic resource
 *                                           helper seven times: once per read or write, which is
 *                                           also why every one of those operations answered out
 *                                           of a single clamped page
 *   isSelfHostedModeReferences    58 -> 56  the deleted facade imported the client-side mode
 *                                           predicate and called it once
 *
 * FIVE DO NOT MOVE, and each absence is a fact rather than an omission.
 * `selfHostedResourceBranches` stays at 44 even though a `*.local.*` module was deleted: that
 * metric counts a local arm asking whether it is really the local arm, and this one never did —
 * it talked to SQLite directly. `getEmailsModeReferences` stays at 60 and the two resolver/parser
 * counters stay at 65 and 16, because this dispatcher went through the predicate rather than
 * reading or parsing the process-wide setting. And `emailsModeEnvReferences` stays at 235,
 * which took deliberate care: the most natural way to prove the deleted second arm's clamped-page
 * defect is a test that SETS the deployment word and drives that arm, and such a test would have
 * RAISED a counter that may only fall — the env metric is a plain substring match that no
 * spelling escapes. Both rebuilt suites therefore name their storage through the resolution's OWN
 * exported constants, and the two 520-alias cases prove the defect through the store seam instead.
 *
 * THE REBASE ONTO 55de52c IS THE QUIETEST FORM OF THIS BLOCK'S HAZARD, and it is worth the
 * arithmetic because git offered NO conflict at all in the version that mattered. This branch had
 * not touched this file through its first two commits, so its copy was byte-identical to 016da25's
 * — meaning a rebase would have taken main's block WHOLESALE, with no marker, no question, and the
 * guard green. Main pinned 28/28/18/244/44/180/58/60/65/16/235 for ITS tree; the merged tree
 * measures 27/27/17/234/44/173/56/60/65/16/235. So doing nothing would have shipped SIX counters
 * and TWENTY-TWO units of slack — one each on the two arm counters and the facade counter, TEN on
 * the dispatch-call counter, SEVEN on the resource-helper counter and TWO on the predicate counter
 * — a licence to re-add two arm modules, a facade dispatcher, ten dispatch sites, seven resource
 * calls and two predicate reads. A per-metric minimum of the two sides gives main's own numbers
 * exactly, so it would have shipped the same twenty-two.
 *
 * WHAT PREVENTED IT was the strongest form of the defence this block records, taken from the
 * `src/lib/forwarding` collapse: all eleven ceilings were committed as LITERAL ZEROS in their own
 * commit BEFORE the rebase, so the block could not merge silently and the guard could not pass
 * until every number had been re-measured. The rebase then conflicted on exactly the eleven lines,
 * which is the loud failure the procedure is designed to force. Then: keep both sides' prose, keep
 * the zeros, measure the merged tree over the real corpus, pin what was measured, and measure
 * AGAIN after writing this paragraph because this file sits inside the corpus it scans.
 *
 * That second measurement was taken and the eleven were unchanged. The prose above names the
 * dispatch helper, the generic resource helper and the mode predicate BY ROLE and never as the
 * tokens the scan counts, which is #128's lesson (a ceiling comment that spelled a dispatch call
 * while describing its deletion measured 247 against a code-only truth of 245) and #130's
 * independently (a paragraph about a guard named that guard as a call and pushed its own metric
 * from 180 to 181).
 *
 * Corpus of this change: 652 tracked, 651 scanned, 9,437,236 characters — both floors
 * (500 files / 5,000,000 characters) cleared with room. ONE file fewer than 55de52c, and the
 * arithmetic is worth spelling out: this family's two arms are deleted, and one test file is added
 * — a suite for the CLI `inbox explain` handler, which adversarial review found was the only
 * consumer whose call shape changed structurally and had no executable coverage at all. Both of
 * this family's own suites already existed and were rewritten in place, so they add nothing.
 *
 * MEASURED FOUR TIMES, because three later rounds of review fixes changed the corpus after the
 * first pin: once when the ceilings were first measured on the merged tree, once after this
 * paragraph was written, and once after each of the two reviewers' findings landed. All eleven
 * counts were identical every time — the added file and every edited comment contribute ZERO to all
 * eleven, verified PER FILE rather than inferred from the total, which is the only way to see that
 * a paragraph has not raised the very counter it describes.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/lib/webhook` collapse — the standalone provider
 * webhook receiver. What it moves is small and the SHAPE of what it does NOT move is the part worth
 * reading, because a reviewer expecting a collapse to move the dispatch counters will otherwise
 * think the pin is wrong:
 *
 *   twoArmFamilies               27 -> 26   both arm modules deleted, so the facade has no
 *   remoteArmModules             27 -> 26   siblings left. THE PAIR THAT SAYS A FAMILY IS DONE.
 *   getEmailsModeReferences      60 -> 58   the facade's import of the process-wide read, and its
 *                                           one call.
 *
 * EIGHT DO NOT MOVE, and two of those absences are facts a reviewer should not have to re-derive.
 * The dispatch pair — the helper definition count and the dispatched-call count — stays at 17 and
 * 234 because THIS FACADE NEVER USED THE HELPER: it was a hand-written conditional over the
 * process-wide read, dispatching a single export, so there was no helper to delete and no
 * dispatched call to remove. That is also why the process-wide-read counter falls by exactly two
 * here rather than by a helper's usual larger amount. `selfHostedResourceBranches` stays at 44 for
 * the same reason the alias collapse recorded: the deleted local arm talked to SQLite directly and
 * never asked whether it was really the local arm. The resolver/parser counters and the env counter
 * are untouched at 65, 16 and 235 — and the last of those took the same deliberate care the block
 * above describes, because the deleted second arm here was a stub that THREW, so the tempting way
 * to prove its refusal survived is a case that SETS the deployment word, and that case would have
 * raised a counter that may only fall. All three rebuilt suites name their storage through the
 * resolution's OWN exported constants instead.
 *
 * THE REBASE ONTO THE ALIAS COLLAPSE IS THE CLEAREST WORKED EXAMPLE THIS BLOCK HAS OF ITS OWN
 * HAZARD, and the arithmetic is worth checking rather than trusting, because git flagged SIX of
 * the eleven lines and let FIVE through in silence.
 *
 * All eleven were committed as literal ZEROS before the rebase, so the guard could not pass until
 * the merged tree was measured. Git then produced a conflict covering exactly six ceiling lines —
 * the dispatch pair, the resource pair, the mode predicate and the process-wide read — while
 * `twoArmFamilies`, `remoteArmModules` and the three parser/env counters merged with NO MARKER AT
 * ALL, at whichever side git preferred.
 *
 * The base pinned 27/27/17/234/44/173/56/60/65/16/235 and this branch had pinned
 * 27/27/18/244/44/180/58/58/65/16/235 for its own pre-rebase tree. On the six git flagged, a
 * per-metric minimum happens to give the right answer. ON THE FIVE IT DID NOT FLAG IT DOES NOT:
 * both sides carried 27 for the structural pair, the merged tree measures 26, so
 * `twoArmFamilies` and `remoteArmModules` would each have shipped ONE WIDE — two units of slack,
 * on the one metric in this file that a rename cannot fake, both green under `<=`, with no signal
 * of any kind. The cause is the same one the block above names: the two collapses finish DIFFERENT
 * families, and neither a silent merge nor a minimum can see that two disjoint reductions compose.
 * Measuring is the only thing that can.
 *
 * Corpus of this change: 651 tracked, 650 scanned, 9,516,645 characters — both floors cleared with
 * room. ONE fewer tracked file than the base: two arm modules deleted, one test file added
 * (`src/cli/commands/serve.local.test.ts`, for a consumer that had no test at all and now has to
 * surface a refusal), and both of this family's own suites rewritten in place. Measured with this
 * paragraph in place, and the eleven counts were re-measured AFTER writing it, per file as well as
 * in total.
 *
 * `src/db/provisioning` collapse (#134). BASE 7f5b5dd, verified INDEPENDENTLY over the real
 * `git ls-files` corpus — 651 tracked / 650 scanned / 9,516,645 characters — with all eleven
 * live counts equal to the ceilings it declared and ZERO slack. That family was the largest
 * dispatch table in the programme: NINETEEN exports handed to a 509-line SQLite arm and a
 * 401-line HTTP arm.
 *
 * Six counters move and five do not. Both arm modules are deleted, so the structural pair
 * falls by one each (26 -> 25). The facade's dispatch helper goes with them, taking its own
 * definition (17 -> 16) and all nineteen of its dispatch sites (234 -> 215) — the largest
 * single reduction of that counter so far. The deleted HTTP arm reached the generic resource
 * helper seventeen times, once per read or write (173 -> 156), which is also exactly why every
 * one of those operations answered out of a single clamped page. The deleted facade imported
 * the client-side mode predicate and called it once (56 -> 54).
 *
 * The five that do not move: `selfHostedResourceBranches` counts a LOCAL arm asking whether it
 * is really the local arm, and this one never did — it held a `Database` and talked to SQLite
 * directly. This dispatcher went through the predicate rather than reading the process-wide
 * setting, and neither arm resolved or parsed it, so three more stay put. And the env counter
 * stayed at 235 ON PURPOSE: the most natural way to prove the deleted HTTP arm's clamped-page
 * defect is a test that SETS the deployment word and drives that arm, and that test would have
 * RAISED a counter that may only fall — the env metric is a plain substring match no spelling
 * escapes. The rebuilt suite names its storage through the resolution's own exported constants
 * instead and proves the defect through the store seam.
 *
 * PROCEDURE, unchanged from the collapse before it and for the reason its note records: all
 * eleven ceilings were committed as LITERAL ZEROS in their own commit before rebasing, so the
 * block could not be inherited silently. Main had not moved (7f5b5dd), so the rebase was a
 * no-op this time — the zeros were committed anyway, because "main did not move" is only
 * knowable after the fetch and the discipline has to survive the case where it did. They were
 * zeroed a SECOND time after adversarial review changed eight files: a pin is only valid for
 * the tree it was measured on, and prose is part of the corpus. Measured in the WORKTREE, not
 * the shared checkout, which sits on a different commit and yields a plausible wrong answer.
 * A concurrent collapse (`db/sandbox`) moves these same counters, so whichever of the two
 * lands second has to repeat all of this — two disjoint reductions merge cleanly and are
 * still wrong, which is why a per-metric minimum is never taken.
 *
 * Corpus of this change: 650 tracked, 649 scanned, 9,636,309 characters — both floors cleared
 * with room. ONE fewer tracked file than the base: two arm modules deleted, one config file
 * added (`tsconfig.targeted.json`, the strict check this family and its consumers are verified
 * with), and this family's suite rewritten in place. The eleven were measured on the merged
 * tree, then measured AGAIN after this paragraph was written — this file sits inside the corpus
 * it scans — and PER FILE on both trees, which showed every file this change touches
 * contributing exactly what it contributed on main. The comment names the dispatch helper, the
 * generic resource helper and the mode predicate by ROLE and never as the tokens the scan
 * counts.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/sandbox` collapse — captured outbound mail for
 * the sandbox provider. BASE `12c98f6`, verified INDEPENDENTLY over the real `git ls-files`
 * corpus (650 tracked / 649 scanned) with all eleven live counts equal to the ceilings the
 * provisioning collapse declared and ZERO slack. This is the first family in the phase whose
 * SECOND arm was a full working implementation rather than a refusal or a stub, so the collapse
 * is a resolution of eight measured disagreements; six counters move:
 *
 *   twoArmFamilies                25 -> 24   both arm modules deleted, so the facade has no
 *   remoteArmModules              25 -> 24   siblings left. THE PAIR THAT SAYS A FAMILY IS DONE.
 *   routedFacadeDefinitions       16 -> 15   the facade's dispatch helper is deleted.
 *   routedCallExpressions        215 -> 209  it dispatched all SIX exports through that helper.
 *   selfHostedResourceReferences 156 -> 151  the deleted second arm reached the generic resource
 *                                            helper five times — once per operation except the
 *                                            summary listing, which borrowed the full one. Those
 *                                            five reads and writes are also exactly why four of
 *                                            the six operations answered out of one clamped page.
 *   isSelfHostedModeReferences    54 -> 52   the deleted facade imported the client-side
 *                                            deployment predicate and called it once.
 *
 * FIVE DO NOT MOVE, for the reasons the two blocks above already record: that arm never asked
 * whether it was really the local arm (44), this dispatcher went through the predicate rather
 * than the process-wide read (58), and neither arm resolved or parsed the setting (65, 16).
 * The env counter stayed at 235 under the same discipline — the tempting way to prove the
 * deleted arm counted, listed and DELETED out of one clamped page is a case that SETS the
 * deployment word, and that case would have raised a counter that may only fall. Both rebuilt
 * suites name their storage through the resolution's own exported constants, including the
 * database-path key, and the clamp is proved through the store seam by `src/db/sandbox.test.ts`
 * with a control asserting that one 1000-row request really comes back holding 500 of 520.
 *
 * THE PROCEDURE EARNED ITS KEEP TWICE ON THIS BRANCH, in opposite ways, which is the whole
 * argument for it. The FIRST rebase (onto the webhook follow-up) produced NO CONFLICT AT ALL on
 * these eleven lines — the branch's first commits never touched this file — so without the zeros
 * the tree would have inherited that main's block verbatim and shipped six counters and thirteen
 * units of slack, green under `<=`, with no marker of any kind. The SECOND rebase (onto this
 * base) conflicted LOUDLY on all eleven, because the zeros were there to conflict with. Neither
 * outcome is predictable in advance, and only one of them is safe to rely on.
 *
 * A PER-METRIC MINIMUM WOULD HAVE BEEN WRONG HERE IN A WAY THAT LOOKS RIGHT. The provisioning
 * collapse and this one finish DIFFERENT families, so their reductions compose: main declares
 * 215 and 156 for the dispatch and resource counters and this branch had pinned 228 and 168 for
 * its own pre-rebase tree, while the merged tree measures 209 and 151 — LOWER THAN EITHER SIDE.
 * A minimum gives 215 and 156, six and five units wide. And four of the eleven were IDENTICAL on
 * both sides (44, 58, 65, 16, 235), which reads as agreement and is two measurements of two
 * different trees. Measuring the merged tree is the only thing that can tell the difference.
 *
 * Corpus of this change: 649 tracked, 648 scanned, ~9.73M characters — both floors cleared with
 * room. ONE fewer tracked file than the base: two arm modules deleted and one test file added
 * (`src/server/routes/core-sandbox.test.ts`, which pins the one consumer decision this collapse
 * had to make — the local dashboard keeps reading local SQLite rather than following the
 * environment — a decision mutation testing showed nothing else could kill), with both of this
 * family's own suites rewritten in place. The character total is given to three figures on
 * purpose: this paragraph is inside the corpus it describes. The two FILE counts and all eleven
 * metric counts are exact, were measured on the merged tree and measured AGAIN after this
 * paragraph was written, and were measured PER FILE: every file this change AUTHORS contributes
 * zero to all eleven, and every file it EDITS has a per-file count unchanged by the edit. The
 * dispatch helper, the generic resource helper and the deployment predicate are named by ROLE
 * here and never as the tokens the scan counts.
 *
 * RE-MEASURED AND RE-PINNED AGAIN on the `src/db/send-keys` collapse — scoped send keys, the
 * credential that decides which of an installation's addresses an agent may send as. BASE
 * `7c32937`, verified INDEPENDENTLY over the real `git ls-files` corpus (649 tracked / 648
 * scanned, 9,737,437 characters) with all eleven live counts equal to the ceilings the sandbox
 * collapse declared and ZERO slack. EIGHT counters move — the most any family in this phase has
 * moved, because this family's SQLite arm carried a deployment branch of its own in addition to
 * the facade's dispatch:
 *
 *   twoArmFamilies                24 -> 23   both arm modules deleted, so the facade has no
 *   remoteArmModules              24 -> 23   siblings left. THE PAIR THAT SAYS A FAMILY IS DONE.
 *   routedFacadeDefinitions       15 -> 14   the facade's dispatch helper is deleted.
 *   routedCallExpressions        209 -> 199  it dispatched all TEN exports through that helper.
 *   selfHostedResourceBranches    44 -> 41   THE ONLY FAMILY IN THE PHASE SO FAR TO MOVE THIS
 *                                            ONE. The deleted SQLite arm asked THREE TIMES
 *                                            whether it was really the local arm — once to
 *                                            refuse a mint outright, twice to answer a listing
 *                                            from the HTTP bridge instead — so a single call
 *                                            could take either path depending on which of the
 *                                            two modules the caller reached first.
 *   selfHostedResourceReferences 151 -> 139  those three, plus the nine reads and writes the
 *                                            deleted HTTP arm made through the generic resource
 *                                            helper. Four of those nine are also exactly why
 *                                            four listings answered out of one clamped page.
 *   isSelfHostedModeReferences    52 -> 50   the deleted facade imported the client-side
 *                                            deployment predicate and called it once.
 *   emailsModeEnvReferences      235 -> 234  ONE occurrence, and it is worth naming because it
 *                                            is the first time this counter has moved for a
 *                                            reason other than a test: the deleted SQLite arm's
 *                                            refusal message told the operator which value to
 *                                            set to get a working send key — a refusal
 *                                            documenting its own bypass, deleted with the arm.
 *
 * THREE DO NOT MOVE, for the reasons the blocks above already record: this dispatcher went
 * through the predicate rather than the process-wide read (58), and neither arm resolved or
 * parsed the setting (65, 16). The env counter moved by exactly one and under the same
 * discipline as every block above — the tempting way to prove the deleted arm refused a mint on
 * one configuration is a case that SETS the deployment word, and that case would have raised a
 * counter that may only fall. Both rebuilt suites name their storage through the resolution's
 * own exported constants, and the clamp is proved through the store seam by
 * `src/db/send-keys.test.ts` with a control asserting that one 1000-row request really comes
 * back holding 500 of 520.
 *
 * Corpus of this change: 647 tracked, 646 scanned, ~9.80M characters — both floors cleared with
 * room. TWO fewer tracked files than the base, and no new ones: the two arm modules are deleted
 * and BOTH of this family's suites were rewritten in place. The character total is given to
 * three figures on purpose: this paragraph is inside the corpus it describes. The two FILE
 * counts and all eleven metric counts are exact, were measured on the merged tree and measured
 * AGAIN after this paragraph was written, and were measured PER FILE: every file this change
 * AUTHORS contributes zero to all eleven, and every file it EDITS has a per-file count
 * unchanged by the edit — which was checked against the base rather than assumed, and holds for
 * all three edited files that carry a non-zero count.
 */
const CEILINGS: Record<string, number> = {
  twoArmFamilies: 23,
  remoteArmModules: 23,
  routedFacadeDefinitions: 14,
  routedCallExpressions: 199,
  selfHostedResourceBranches: 41,
  selfHostedResourceReferences: 139,
  isSelfHostedModeReferences: 50,
  getEmailsModeReferences: 58,
  resolveEmailsModeReferences: 65,
  normalizeEmailsModeReferences: 16,
  emailsModeEnvReferences: 234,
};

// 649 files are tracked and 648 scanned today, totalling ~9.7M characters. (The figures in
// this paragraph were written when the corpus was 624/623 and ~7.4M and had gone stale, and
// the first correction of them was itself one file behind — adversarial review caught that.
// The floors and the reasoning below are unchanged.) The floors
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
