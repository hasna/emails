// APP-LEVEL FORWARDING — the pipeline that copies inbound mail to a third party. ONE
// implementation; nothing here asks what kind of deployment this is.
//
// WHAT THIS FILE USED TO BE. A 16-line facade whose dispatch helper read the process-wide
// deployment word and handed its ONE export to one of two sibling modules:
//
//   * `forwarding.local.ts` (146 lines) — the whole pipeline: scan the pending-forward
//     projection, read each inbound body, pick a provider, send a copy, write the sent-mail
//     ledger and the message body, record the delivery;
//   * `forwarding.remote.ts` (39 lines) — a stub that THREW, plus BYTE-FOR-BYTE COPIES of
//     two of the three result interfaces and a fourth, incompatible, declaration of the
//     options.
//
// So the two arms did not disagree about what "forward the pending mail" MEANS. One of them
// could do it and one of them refused. That is not a product variant, and the arms are gone.
//
// ─── THE ONE THING A READER MUST KNOW ABOUT THIS FAMILY ──────────────────────────────
//
// THE DELETED STUB'S REFUSAL IS PRESERVED, AND PRESERVING IT IS THE WHOLE DESIGN PROBLEM.
// This pipeline is bound to ONE local SQLite database, in five places at once:
//
//   1. the pending-forward projection — `listPendingForwarding` joins `forwarding_rules`,
//      `inbound_recipients`, `inbound_emails` and the `forwarding_deliveries` ledger;
//   2. the delivery ledger write — `recordForwardingDelivery`;
//   3. the inbound BODY, read with `getInboundEmail`;
//   4. the provider choice, read from the local `providers` table;
//   5. the sent-mail ledger and the sent body, written by `src/lib/sent-ledger.local.ts`.
//
// `forwarding_deliveries` EXISTS IN LOCAL SQLITE AND NOWHERE ELSE — not on the seam
// (`src/store/repositories.ts` publishes one `ForwardingRepository`, over `forwarding_rules`),
// not on `/v1` (`src/store-http/routes.ts`, `RESOURCE_PATHS`), and not in the self-hosted
// Postgres schema (`src/server/self-hosted/migrations.ts` creates `forwarding_rules` and
// stops). `src/db/forwarding.ts` carries that evidence at length, and it is why its two ledger
// operations REQUIRE the `Database` they read.
//
// So on an API-configured installation this pipeline cannot run, and the question "did it
// run?" has a wrong answer that is very easy to give: `{ attempted: 0, sent: 0, failed: 0,
// skipped: 0 }`. That is the shape of a successful run over an already-forwarded inbox, it is
// what a default `getDatabase()` would produce (it would open, and CREATE, an empty local
// file), and it is indistinguishable from "your mail is fully forwarded". The deleted stub
// threw instead. A refusal must keep being a refusal.
//
// HOW THE REFUSAL IS DERIVED NOW, and every other route was closed:
//
//   * NOT the deployment word. That is the axis being deleted; reading it here would be the
//     collapse pretending to have happened.
//   * NOT `StoreDescriptor`. Branching on it is FORBIDDEN, in writing
//     (`src/store/descriptor.ts`), and the prohibition is not stylistic — five branches on its
//     predecessor label are exactly what the seam exists to delete.
//   * NOT a capability, because there is no capability for the forwarding delivery ledger and
//     `sendIntentLedger` CANNOT stand in: both stores declare it FALSE
//     (`src/store-sqlite/index.ts`, `src/store-http/index.ts`), so gating on it would ship a
//     forwarding pipeline that refuses on EVERY configuration this package can run in — the
//     trap `src/db/address-lifecycle.ts` records for `getAddressSendability`. The honest fix
//     is the seam widening `src/db/forwarding.ts` describes; it is DESCRIBED, NOT MADE here
//     either, because `src/store/` is a shared contract two audits are waiting on.
//   * SO: STORAGE CONFIGURATION, through `readStorageWiring` (`src/lib/storage-wiring.ts`),
//     which reads storage settings ONLY and answers "which store did you configure?". That
//     mechanism is already sanctioned for precisely this question — `src/lib/status-facts.ts`
//     uses it for the three facts about work THIS INSTALLATION performs itself when it owns
//     its database and the SERVICE performs otherwise — and forwarding is the same shape of
//     question one layer up. A contradictory configuration is a refusal here too, where the
//     deleted dispatcher silently picked a winner.
//
// The gate runs ONCE, before anything is read or sent, and only when the caller did NOT hand
// in a `Database`. A caller that supplies one has STATED its storage, which is
// `src/db/forwarding.ts`'s contract exactly, and gets today's behaviour unchanged.
//
// ─── WHERE THE GATE'S ANSWER DIFFERS FROM THE DELETED DISPATCHER'S, ENUMERATED ────────
//
// "THE REFUSAL IS PRESERVED" IS NOT THE SAME CLAIM AS "NOTHING CHANGED", and the difference
// has to be written down rather than implied, because the two questions are asked of DIFFERENT
// SETTINGS. The deleted dispatcher read the deployment word; the gate reads storage
// configuration. They disagree in five configurations, and an adversarial review of this
// change is what enumerated them:
//
//  1. API storage configured, deployment word UNSET. Was: the pipeline ran against a local
//     database — usually an empty one it had just created — and reported nothing to forward.
//     Now: refused. This is the whole point of the change.
//  2. Deployment word says local, but a STALE client-secret pointer is exported (a common shell
//     inheritance). Was: ran locally, because `src/lib/mode.ts` gives the word precedence over
//     the pointer on purpose. Now: refused, because the resolver treats the pointer as naming
//     API storage. The refusal names the setting, so this is recoverable rather than a mystery.
//  3. BOTH database-path settings configured, naming different files. Was: ran, on the
//     documented `HASNA_`-wins precedence. Now: refused as a contradiction.
//  4. Storage resolves but the data directory is unsafe (an untrusted ancestor, a symlink).
//     Was: the underlying path refusal surfaced raw. Now: the same message, wrapped in a
//     refusal that says whether this installation forwards its own mail is not known.
//  5. Deployment word says self-hosted, and NO storage setting names anything. Was: refused
//     outright by the stub. Now: THE PIPELINE RUNS, against the default local database, because
//     storage configuration names one and the word is no longer read.
//
// 1–4 align this pipeline with the two families that already collapsed and already refuse in
// those configurations (`src/db/forwarding.ts` and `src/lib/status-facts.ts`), so they are
// convergence rather than drift.
//
// 5 IS THE ONE A READER MUST NOT SKIP, AND IT CARRIES A TIME BOMB THAT IS NOT MINE TO DEFUSE.
// No mail escapes today: `sendWithFailover` reaches `getProvider`, which refuses in that
// configuration at `src/db/providers.local.ts` — and it refuses there through the shared
// resource-routing helper (`src/db/self-hosted-resource.local.ts`), which is ONE OF THE 44 CALL
// SITES THE `selfHostedResourceBranches` COUNTER IS DRIVING TO ZERO. (Spelled as a file path
// rather than as a call, because the ratchet's pattern is that identifier followed by an open
// parenthesis and this comment is inside the corpus it scans — writing it out would RAISE a
// counter that may only fall. That is not a detail: it is how a comment about the guard becomes
// a reason the guard's own metric moves backwards.) So the only thing standing between
// configuration 5 and a real outbound send is a guard scheduled for deletion. WHOEVER COLLAPSES
// `src/db/providers` MUST DECIDE WHAT
// HAPPENS HERE, because after that collapse `getProvider` answers from the configured store —
// the default local SQLite database in this configuration — and this pipeline reaches
// `adapter.sendEmail` in a configuration that refused before. The safe orderings are: delete the
// deployment word first (configuration 5 stops existing), or gate the send path on the same
// storage question this module asks. It is stated here, in the module the mail would leave
// from, rather than left for that collapse to discover.
//
// ─── THE DEDUP KEY IS UNCHANGED, WHICH IS THE ANSWER TO THE OBVIOUS RE-SEND QUESTION ──
//
// A collapse that moves an operation onto the seam can change WHICH COLUMN fences a repeat,
// and if the new key is not populated on rows that already exist the fence matches nothing and
// the next run re-sends everything. This collapse changes no key:
//
//   * the fence is `forwarding_deliveries UNIQUE(rule_id, inbound_email_id)`, consulted by the
//     pending-forward join's `LEFT JOIN … AND delivery.status = 'sent' … WHERE delivery.id IS
//     NULL`. It is local SQLite on both sides of this change, it was already collapsed
//     verbatim by `src/db/forwarding.ts`, and the rows that exist today are the rows that
//     fenced yesterday.
//   * NOTHING on this path goes through `upsertMessage` or `source_id`, so the seam's
//     idempotency fence is not involved at all. The sent-mail ledger row is still written by
//     `src/lib/sent-ledger.local.ts` → `createEmail` (`src/db/emails.local.ts`), an
//     UNCOLLAPSED family, as raw SQLite.
//   * `idempotency_key` (built below) IS NOT A FENCE AND NEVER HAS BEEN — see defect 2.
//
// ─── TWO LIVE DEFECTS THIS COLLAPSE INHERITS VERBATIM, NAMED RATHER THAN LEFT SILENT ──
//
// 1. A FAILURE RECORDED AFTER A SUCCESSFUL SEND MAKES THE NEXT RUN SEND AGAIN — duplicate
//    mail, with no concurrency required. The `try` below spans the provider call AND the two
//    local ledger writes that follow it, and its `catch` records `status: "failed"`. Because
//    the pending join excludes a pair only when its delivery row says `sent`, a copy that was
//    DELIVERED and then failed to be ledgered leaves the pair pending, and the next run calls
//    the provider a second time. (`src/db/forwarding.ts` records the concurrent sibling of
//    this: `recordForwardingDelivery` is an `INSERT OR REPLACE`, so a later `failed` REPLACES
//    an earlier `sent` and two overlapping runs produce the same duplicate. THAT DEFECT IS
//    INHERITED HERE TOO, explicitly.)
//
//    WHY IT IS NOT FIXED HERE. Every available fix is a product decision about what to report
//    when mail WAS delivered and the local record of it was not written. Recording `sent`
//    discards the error; recording a third state is a SCHEMA change — `forwarding_deliveries`
//    has `CHECK(status IN ('sent','failed'))` in both migration paths (`src/db/database.ts`);
//    and re-ordering the writes so the `sent` row lands first publishes an intermediate row
//    with a null `sent_email_id`. That is the line `src/db/address-lifecycle.ts` drew for the
//    unregistered-sender case, and the correct fix is not a tweak here: it is the
//    idempotency-fenced ledger where `sent` is TERMINAL for a pair, which is what the seam
//    widening above would bring. THE WRONG LOCAL FIX is to widen the pending join to exclude
//    `failed` rows too — that would strand every genuine retry. The suite beside this file
//    PINS the current behaviour under a name that says it is a defect, so neither direction of
//    change can happen silently.
//
//    WHAT THIS COLLAPSE OWES THAT DEFECT, and it is the reason the gate is where it is: it
//    must not ADD a throw that lands in that `catch`. The storage gate therefore runs before
//    the loop, not inside it, and this collapse introduces no new failure mode between the
//    provider call and the delivery record.
//
// 2. `idempotency_key` FENCES NOTHING ON THIS PATH. The key built below
//    (`forward:<rule>:<inbound>`) is handed to `sendWithFailover` and to
//    `createSentEmailLedger`, and it is consumed only by `createEmail` — AFTER the provider
//    call. `src/lib/send.local.ts` has no idempotency handling at all, and `createMessage`
//    REFUSES an `idempotency_key` on both stores (`src/store-sqlite/messages.ts:283-295`,
//    `src/store-http/messages.ts:143-152`). So there is no working idempotency fence between
//    this pipeline and a provider today; the only thing that stops a second copy is the
//    delivery ledger, and defect 1 is how that stops working. The real fence is the
//    send-intent ledger and it belongs to the send-path phase, not here. The key is kept
//    because removing a value the ledger row records is a change to stored data.
//
// ─── WHAT THE TWO ARMS DISAGREED ABOUT ───────────────────────────────────────────────
//
//  1. `db`. The local arm's options carried `db?: Database`; the stub's did not. The facade
//     published the LOCAL declaration (`export type * from "./forwarding.local.js"`), so the
//     stub's narrower options were unreachable through the family's own type — a caller could
//     hand a `Database` to an implementation that had no parameter for it. Resolved toward the
//     arm that can actually run: `db` stays, and its meaning is now stated.
//  2. `send`, THE INJECTION POINT, HAD TWO INCOMPATIBLE SHAPES. Local: `(providerId, opts, db)
//     => Promise<SendResult>`. Stub: `(providerId, opts) => Promise<SendResult>` — no database
//     parameter, and `opts` typed as `SendEmailOptions` rather than as `sendWithFailover`'s own
//     parameter. Since the published type was the local one, a caller writing to the contract
//     passed a three-argument function that the stub declared it could not accept and never
//     called. Resolved toward the local arm; the stub's ONE piece of extra documentation (that
//     this is a test seam) is kept, corrected to the real shape.
//  3. `ForwardingRunItem` and `ForwardingRunResult` were DUPLICATED, byte for byte. One
//     definition now. They were identical, so nothing had to be chosen — but two copies of a
//     published shape are one rename away from two different published shapes.
//  4. The stub imported `SendResult` from the send FACADE (`./send.js`) while the local arm
//     imported it from the send ARM (`./send.local.js`). They resolve to the same type today
//     only because the facade re-exports the arm's types; a reader of the two files could not
//     know that. One import now, from the module whose function is actually called.
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//  * IT DOES NOT MOVE THE INBOUND BODY READ, THE PROVIDER CHOICE OR THE SEND ONTO THE SEAM,
//    even though `EmailStore` has an inbound repository and a providers resource. Mixing them
//    would be strictly WORSE than not: the pending scan, the delivery ledger and the sent-mail
//    ledger are bound to the local database, so reading the body from a differently-resolved
//    source could forward one installation's mail using another installation's records. That
//    is the hazard `src/lib/delivery-doctor.ts` states as "a diagnosis that read some facts
//    from the configured store and others from a differently resolved source could describe
//    two different installations in one report". These reads move when their own families
//    collapse — `db/inbound`, `db/providers`, `lib/send`, `lib/sent-ledger`, `db/emails` — and
//    they move together, behind the widened ledger, or not at all.
//  * IT DOES NO PAGED SEAM READ, so the two stores' disagreement about list ORDER cannot reach
//    it. `listPendingForwarding` is a single SQLite statement with its own total order
//    (`inbound.received_at ASC, rules.source_address ASC`) and its own `LIMIT`; there is no
//    `ListOptions` push-down here and no window over a store-chosen order.
//  * IT DOES NOT TREAT `attempted` AS A TOTAL. A full page means there may be more pending
//    mail; `attempted` is what this run attempted, which is what the field has always meant,
//    and the remedy is another run. Nothing here reports a total it did not count.
//  * IT DOES NOT RE-CLAMP `limit`. `listPendingForwarding` owns that, refuses a non-finite
//    value and clamps the rest to 1..1000 — including mapping `limit: 0` to one row, which is
//    the deleted arm's arithmetic preserved exactly and is recorded there rather than
//    re-implemented here.
//
// ─── ONE REGION BELOW IS UNREACHABLE BY CONSTRUCTION ─────────────────────────────────
//
// Named here so a reviewer does not have to re-derive it and so nobody writes a test that only
// APPEARS to cover it. Mutation testing reverted each change in this file and in
// `src/lib/storage-wiring.ts` one at a time: 35 mutants, 34 killed and 1 survived on the first
// pass — and an adversarial review then showed one of the 34 was NOT killed, so the honest
// count is 34 killed and one further mutant that only appeared to die. Both are recorded, and
// the one that was hiding a weak assertion is now genuinely killed:
//
//   1. `if (!inbound)` AND ITS WHOLE BODY — the "inbound email no longer exists" skip, its
//      `skipped` counter and its item. The pending-forward scan JOINs `inbound_emails` and
//      projects `inbound.id`, so every pair it returns names a row that existed;
//      `getInboundEmail` then re-reads that row by primary key on the SAME connection two
//      statements later. Nothing a single run can do makes it absent, so `status: "skipped"` is
//      unobservable from this module's own tests. It is defence against a CONCURRENT deleter,
//      which is a real caller of `deleteInboundEmail`, so the branch stays — and it cannot be
//      killed without interleaving two writers on one connection, which would assert the
//      interleaving rather than this behaviour.
//   2. NOT unreachable, and the review was right to reject it: "the send seam receives the
//      pipeline's own database" was asserted against `getDatabase()`'s MEMOISED handle, so the
//      handle the test passed WAS the singleton and replacing the threaded one with a fresh
//      `getDatabase()` left the suite green. The suite now passes a SECOND handle to the same
//      file and asserts the seam receives that one, which kills it.
//
// The run also found TWO REAL COVERAGE GAPS, both closed: nothing exercised the on-disk
// `database_file` shape of local storage (every case configured `:memory:`, so deleting that
// branch of the gate stayed green), and nothing exercised the DEFAULT limit of 100 (every case
// passed `limit` explicitly, so raising it to the scan's own 1000 maximum was invisible).

import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import {
  listPendingForwarding,
  recordForwardingDelivery,
  type ForwardingRule,
  // The `src/db/forwarding` family has ONE implementation, so this reaches the facade rather
  // than a deleted `.local` arm. Both operations imported here take the local `Database` this
  // pipeline threads, and REQUIRE it — see that module's header for why the pending-forward
  // join and the delivery ledger cannot go through the store seam.
} from "../db/forwarding.js";
import { getInboundEmail } from "../db/inbound.local.js";
import { getLatestActiveProviderId } from "../db/providers.local.js";
import { sendWithFailover, type SendResult } from "./send.local.js";
import { createSentEmailLedger, storeSentEmailContent } from "./sent-ledger.local.js";
import { readStorageWiring } from "./storage-wiring.js";
import { API_BASE_URL_SETTING } from "../store-resolution.js";

export interface ForwardingRunOptions {
  providerId?: string;
  fromAddress?: string;
  limit?: number;
  backfill?: boolean;
  /**
   * The local database this run reads and writes — the pending-forward projection, the
   * delivery ledger, the inbound bodies, the provider table and the sent-mail ledger, all of
   * which must be the SAME database or the run would forward one installation's mail against
   * another's records.
   *
   * Supplying it STATES the storage, and the storage-configuration gate is then skipped: the
   * caller has already answered the question the gate exists to ask. Omitting it means "use
   * the database this installation is configured for", and the gate refuses when the
   * configuration does not name one.
   */
  db?: Database;
  /**
   * @internal for testing — inject a send implementation.
   *
   * Three parameters, matching `sendWithFailover`. The deleted stub declared two and never
   * called them.
   */
  send?: (providerId: string, opts: Parameters<typeof sendWithFailover>[1], db: Database) => Promise<SendResult>;
}

export interface ForwardingRunItem {
  rule_id: string;
  inbound_email_id: string;
  target_address: string;
  status: "sent" | "failed" | "skipped";
  sent_email_id: string | null;
  error: string | null;
}

export interface ForwardingRunResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  items: ForwardingRunItem[];
}

/**
 * The local database this pipeline runs against, or a REFUSAL naming why there is none.
 *
 * Reached only when the caller supplied no `Database`. See the header: every alternative way to
 * answer "can this installation forward its own mail?" is either the deleted deployment axis, a
 * forbidden branch on the store's identity, or a capability that does not exist — so the answer
 * comes from STORAGE CONFIGURATION, which is the sanctioned source for facts about work this
 * installation performs itself.
 *
 * NOTHING RETURNS `{ attempted: 0 }` FROM HERE. An empty result is the shape of a healthy run
 * over an already-forwarded inbox, and handing that back for "there is no ledger on this side
 * to read" is the exact substitution this programme exists to remove.
 */
function configuredForwardingLedger(): Database {
  const wiring = readStorageWiring(process.env);
  switch (wiring.kind) {
    case "database_file":
    case "database_in_memory":
      // The configuration names a local database, so this installation keeps its own mail and
      // performs its own forwarding. `getDatabase()` resolves the same path this wiring read
      // did, through the same function.
      return getDatabase();
    case "api":
      // THE SETTING IS NAMED, and that is not a refusal documenting its own bypass. Naming a
      // variable to flip is forbidden when it would step around a CAPABILITY gate — an operation
      // the store cannot perform. This is not that: the operator has told this installation where
      // its mail lives, and where its mail lives is exactly what decides whether it can forward
      // its own. `planEmailStore`'s own refusals name their settings for the same reason. It is
      // read from the resolver's exported constant rather than spelled, so it cannot drift.
      throw new Error(
        "This installation reads its mail through an Emails API, so app-level forwarding belongs to "
          + "that service: the forwarding delivery ledger, the sent-mail ledger and the inbound message "
          + "bodies this pipeline needs exist only in a local database. Reporting nothing forwarded "
          + `would be a claim about mail this side never looked at. Unset ${API_BASE_URL_SETTING} to `
          + "forward from a local database, or run forwarding on the service that owns the mail.",
      );
    case "unresolved":
      // "DID NOT RESOLVE" RATHER THAN "DOES NOT NAME ONE STORE", because this arm catches TWO
      // different faults and only one of them is about naming. `readStorageWiring` also lands here
      // when the configuration is the unambiguous DEFAULT and the data directory itself is
      // refused — an untrusted ancestor, a symlink — and telling that operator their settings
      // contradict each other is a misdiagnosis. The resolver's own message says which it was.
      throw new Error(
        "This installation's storage did not resolve to one store, so whether it forwards its own "
          + `mail is not known: ${wiring.message}`,
      );
  }
}

export async function processForwardingRules(opts: ForwardingRunOptions = {}): Promise<ForwardingRunResult> {
  const db = opts.db ?? configuredForwardingLedger();
  const pending = listPendingForwarding(opts.limit ?? 100, db, { backfill: opts.backfill });
  const result: ForwardingRunResult = { attempted: pending.length, sent: 0, failed: 0, skipped: 0, items: [] };

  for (const pendingItem of pending) {
    const inbound = getInboundEmail(pendingItem.inbound_email_id, db);
    if (!inbound) {
      result.skipped++;
      result.items.push(item(pendingItem.rule, pendingItem.inbound_email_id, "skipped", null, "Inbound email no longer exists"));
      continue;
    }

    const providerId = opts.providerId ?? pendingItem.rule.provider_id ?? getLatestActiveProviderId(undefined, db);
    const from = opts.fromAddress ?? pendingItem.rule.from_address ?? pendingItem.rule.source_address;
    if (!providerId) {
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        status: "failed",
        error: "No active provider available for app-level forwarding",
      }, db);
      result.failed++;
      result.items.push(item(pendingItem.rule, inbound.id, "failed", null, "No active provider available for app-level forwarding"));
      continue;
    }

    const subject = /^fwd?:/i.test(inbound.subject.trim()) ? inbound.subject : `Fwd: ${inbound.subject}`;
    const body = formatForwardedBody(inbound.from_address, inbound.received_at, inbound.text_body ?? "");
    const sendOpts = {
      from,
      to: pendingItem.rule.target_address,
      subject,
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`,
      // NOT A FENCE — see defect 2 in the header. Consumed only by the sent-mail ledger, after
      // the provider call.
      idempotency_key: `forward:${pendingItem.rule.id}:${inbound.id}`,
      headers: {
        "X-Hasna-Forwarded-For": pendingItem.rule.source_address,
        "X-Hasna-Inbound-Id": inbound.id,
      },
    };

    // INHERITED DEFECT 1 LIVES IN THIS `try`/`catch`, unchanged and deliberately so: a throw
    // from either ledger write AFTER a successful send is recorded as `failed`, which leaves
    // the pair pending and makes the next run send a second copy. This collapse adds nothing
    // between the provider call and the delivery record.
    try {
      const send = opts.send ?? sendWithFailover;
      const sent = await send(providerId, sendOpts, db);
      const email = await createSentEmailLedger(sent.providerId, sendOpts, sent.messageId, db);
      await storeSentEmailContent(email.id, { text: body, html: sendOpts.html }, db);
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        sent_email_id: email.id,
        status: "sent",
      }, db);
      result.sent++;
      result.items.push(item(pendingItem.rule, inbound.id, "sent", email.id, null));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        status: "failed",
        error: message,
      }, db);
      result.failed++;
      result.items.push(item(pendingItem.rule, inbound.id, "failed", null, message));
    }
  }

  return result;
}

function item(
  rule: ForwardingRule,
  inboundEmailId: string,
  status: ForwardingRunItem["status"],
  sentEmailId: string | null,
  error: string | null,
): ForwardingRunItem {
  return {
    rule_id: rule.id,
    inbound_email_id: inboundEmailId,
    target_address: rule.target_address,
    status,
    sent_email_id: sentEmailId,
    error,
  };
}

function formatForwardedBody(from: string, receivedAt: string, body: string): string {
  return [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${receivedAt}`,
    "",
    body,
  ].join("\n");
}

/**
 * `&`, `<` and `>` only, which is correct HERE and would not be everywhere.
 *
 * The result is interpolated into `<pre>…</pre>` TEXT CONTENT and never into an attribute, so
 * `"` and `'` cannot terminate anything. Reused in an attribute context it would be unsafe.
 * The deleted arm's behaviour is preserved exactly.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
