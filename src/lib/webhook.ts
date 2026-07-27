// The standalone PROVIDER WEBHOOK RECEIVER: one implementation, gated on one storage
// question.
//
// WHAT THIS FILE WAS. A 14-line facade whose one export was handed to one of two siblings
// according to the process-wide deployment word:
//
//   * `webhook.local.ts` (159 lines) — the receiver itself. A `Bun.serve` listener on a
//     caller-chosen port that bounds and reads the request body, verifies a Resend svix
//     signature or an SNS envelope against an allowlist, parses the payload into a
//     `WebhookEvent`, and PERSISTS it into the local SQLite `events` table through an
//     idempotency-fenced upsert.
//   * `webhook.remote.ts` (23 lines) — a stub that THREW, plus a byte-identical re-export
//     of the four pure parsers/verifiers.
//
// So the two arms did not disagree about what "receive a provider callback" means. One
// could do it and one refused. The whole of the collapse is deciding what that refusal is
// derived from, once the word it used to be derived from is gone.
//
// ─── THE REFUSAL IS PRESERVED, AND EVERY OTHER ROUTE TO IT WAS CLOSED ──────────────────
//
// Most collapses in this phase replace a deleted arm's throw with the STORE's own typed
// refusal. This one cannot, and the reason is not stylistic:
//
//   * NOT the deployment word — that is the axis being deleted.
//   * NOT `StoreDescriptor` — branching on it is forbidden in writing
//     (`src/store/descriptor.ts`).
//   * NOT a capability — there is no capability for the delivery-event table, and no
//     existing one may stand in. `CAPABILITY_KEYS` (`src/store/capabilities.ts`) has seven
//     entries and none of them is about events; the closest by subject matter,
//     `sendIntentLedger`, is declared FALSE by BOTH shipped stores, so gating on it would
//     ship a receiver that refuses in every configuration this package can run in.
//   * SO: STORAGE CONFIGURATION, through `readStorageWiring` (`src/lib/storage-wiring.ts`),
//     which reads storage settings only, answers "which store did you configure?", never
//     reads the deployment word, and states in its own header the rule that decides who may
//     ask it: facts about work THIS INSTALLATION PERFORMS ITSELF when it owns its database,
//     and that the SERVICE performs instead when the mail is reached through an Emails API.
//
// ─── WHY RECEIVING A PROVIDER CALLBACK IS EXACTLY THAT KIND OF WORK ────────────────────
//
// Three reasons, the first two citable inside this repository rather than argued from first
// principles.
//
// 1. THE SEAM CANNOT EXPRESS THIS WRITE, and the missing piece is the FENCE rather than the
//    row. `EmailStore.events` is `EventsRepository`, an alias of the generic
//    `ResourceRepository<ResourceRow>` (`src/store/repositories.ts:358`), whose entire write
//    surface is `create(input)`, `update(id, patch)` and `remove(id)`. The receiver's write is an UPSERT
//    whose fence is the partial unique index `idx_events_provider_event` on
//    `(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL`
//    (`src/db/database.ts:1264`, re-ensured at `:2407`), consulted by `INSERT OR IGNORE` and
//    reported back as `{ created }` (`src/db/events.local.ts`). Providers RETRY, so that
//    fence is the only thing between a retried callback and a duplicated delivery event; a
//    bare `create` through the seam would fabricate one row per retry, and a client-side
//    read-then-create would race its own retries. The widening this needs is DESCRIBED
//    BELOW AND NOT MADE.
//
// 2. THE DURABLE RECEIVER ALREADY EXISTS ON THE OTHER SIDE, and says so in writing.
//    `src/server/webhooks/receivers.ts:1-19` is "ONE implementation, mounted twice" — the
//    local dashboard at `POST /webhook/*` over SQLite and the self-hosted service at
//    `POST /v1/webhooks/*` over the operator's Postgres — and states its invariant as "when
//    we host it, inbound mail AND delivery events are pulled into the storage the operator
//    defines." So on an API-configured installation, delivery-event ingestion is the
//    SERVICE's job and is already implemented there. That is the deleted stub's claim,
//    independently corroborated by the code that fulfils it.
//
// 3. A PROVIDER POSTS TO A URL REGISTERED WITH THE PROVIDER, which neither the seam nor a
//    capability can see. On an API-configured installation that URL is the operator's
//    server, so a client that binds a local port is not reachable by the provider at all.
//    A listener that starts "successfully" there is a claim the installation cannot honour,
//    and the failure it produces is not an exception but SILENCE: a receiver that runs
//    forever and receives nothing is indistinguishable from a quiet mailbox.
//
// ─── THE SEAM WIDENING THIS FAMILY NEEDS: DESCRIBED, NOT MADE ──────────────────────────
//
// `src/store/` is byte-identical on this branch. Closing the gap in reason 1 means, in order:
//
//   a. `EventsRepository` stops being the generic alias and gains
//      `upsertEvent(input): Promise<Outcome<{ row: ResourceRow; created: boolean }>>`, so the
//      fence outcome is part of the contract rather than inferred from a row count;
//   b. the server side grows the same partial-unique constraint on
//      `(provider_id, provider_event_id)` and a `/v1` route that reports whether the row was
//      newly created — note the service ALREADY has an idempotency ledger of this exact
//      shape (`webhook_receipts`, keyed on `(provider, event_id)`,
//      `src/server/self-hosted/webhooks.ts`), so the fence exists on that side; what is
//      missing is a client-facing operation that exposes it;
//   c. a capability, because a store that cannot fence must refuse the write rather than
//      duplicate it.
//
// Even with all three, this module's gate would not simply disappear — reason 3 outlives it.
// (a)-(c) would move the refusal's REASON from "this side cannot store the event" to "this
// side is not where the callback arrives": a better message, not a different outcome.
//
// ─── WHERE THE GATE RUNS, AND WHAT CHANGES ────────────────────────────────────────────
//
// ONCE, before the listener binds. Not per request: a bound port that answers 503 to every
// callback IS a receiver as far as the provider is concerned, and provider retry budgets are
// finite — an installation that cannot store the event must not accept the delivery attempt
// at all. The deleted stub also refused at construction, with `never` as its declared return
// type, so this keeps the moment of the refusal as well as the fact of it.
//
// "The refusal is preserved" is NOT the claim that nothing changed: the two are asked of
// DIFFERENT settings, so the honest form of the claim is an enumeration and the enumeration is
// MEASURED rather than reasoned about.
//
// THE GRID, stated precisely enough to reproduce, because a reviewer checked the arithmetic and
// an earlier, vaguer sentence here did not multiply out: the database-path dimension is
// ASYMMETRIC — the first setting takes 3 values (absent, in-memory, file A) and the second takes
// 4 (absent, in-memory, file A, file B), so that a same-path pair and a different-path pair are
// both reachable. Crossed with an API url (absent / valid / unparseable), a credential (none /
// session token / operator key), the client-env pointer (absent / present) and the deployment
// word (absent / local / server-side): 3 x 4 x 3 x 3 x 2 x 3 = 648 combinations. Each was run
// against main and against this module and the answers compared. Result: **48 both run, 300 both
// refuse, 276 change to a refusal, 24 change to a run** — seven classes inside the grid, each
// named below with its count. The line that matters most: the only direction that needs
// justifying has ONE class in it.
//
// MAIN RAN, THIS MODULE REFUSES — 276 combinations, six classes:
//
//    231  a database path AND an API setting are both configured. `planEmailStore` refuses a
//         contradiction rather than picking a winner, and the receiver inherits that. THE
//         LARGEST CLASS BY FAR — 84% of the change — and therefore the likeliest way a consumer
//         notices this release.
//     24  both database-path settings set, naming DIFFERENT files. Main ran on the documented
//         precedence; the resolver treats "which did you mean?" as unanswerable.
//      9  an API url that does not parse.
//      6  API STORAGE, RESOLVED — the class the deleted arm existed for. The receiver belongs
//         to the service.
//      3  an API url with NO credential. A url alone cannot produce a working store.
//      3  a client-env pointer set whose API url is not present in the environment.
//
// The last four are ordered by count and the 9/3 split is not a typo: `planEmailStore` PARSES
// the url (`credentialFreeOrigin`, `src/store-resolution.ts:252`) BEFORE it looks for a
// credential (`:253`), so an unparseable url with no credential is a parse failure. An earlier
// version of this list said 6/6 — the check order read backwards — and the error was invisible
// because the two figures cancel in the 276 total. Corrected against the resolver, not against
// intuition.
//
// Five of the six converge with the families that already collapsed and already refuse there
// (`src/db/forwarding`, `src/lib/forwarding`, `src/lib/status-facts`).
//
// MAIN REFUSED, THIS MODULE RUNS — 24 combinations, ONE class, and it is the one to read
// twice: storage resolves to a LOCAL DATABASE while the deployment word claims a server-side
// deployment. In 21 of the 24 that local database is EXPLICITLY configured, so this is not
// merely "nothing was set". Two things about it. First, main's refusal there does NOT come from
// the deleted arm at all — the mode read itself throws ("the self-hosted client is not
// configured") before any arm is chosen, so main never reached the stub. Second, running is the
// correct answer: the storage settings say local SQLite, which is where the events would go, and
// the word that disagreed is the axis being deleted. This class disappears with it.
//
// AN EIGHTH CLASS IS OUTSIDE THAT GRID and is stated rather than counted, because an untrusted
// data-directory ancestor cannot be varied as an environment value: storage resolves but the
// data directory is refused (a symlink, an untrusted ancestor). Main bound the port and then
// answered 500 to every callback; this refuses at construction. That is a strict improvement in
// the direction that matters for a webhook — refusing to start leaves the callbacks queued at
// the provider instead of draining its finite retry budget against a 500.
//
// A NEW SIDE EFFECT AT CONSTRUCTION, which the enumeration does not show and which is worth
// knowing before calling this in a test or a probe: resolving local storage goes through
// `getDatabasePath()`, which CREATES AND HARDENS the data directory. Main created it on the
// FIRST CALLBACK instead, so on this branch `createWebhookServer` touches the filesystem where
// it previously did not. That is the same work opening the database would have done moments
// later, and it is the price of answering "can this installation store an event?" before
// accepting one — but it is a change, it is asserted by a case in the suite, and a caller that
// expected construction to be inert should know.
//
// WHAT MAIN ACTUALLY DID IN THE API CLASS, measured on main rather than assumed, because it is
// two different failures and the second is the dangerous one. With no local file yet: main
// bound a listener, CREATED a phantom database under the home directory, and answered 500 to
// every valid callback — the phantom database has no `providers` row for the id the CLI
// resolved out of the real store, and `events.provider_id` is a foreign key under
// `PRAGMA foreign_keys = ON` — while the CLI's own output said the listener had started. With a
// STALE local file present, which needs no fault at all and is just an installation that moved
// from a local database to an Emails API and kept its old file: main answered 200 and WROTE the
// event into that stale file, so the provider was told "done", never retried, and the row
// landed where nothing reads it. Both are pinned by cases in the suite.
//
// WHAT THE CONSUMERS DO WITH THE REFUSAL, checked rather than assumed. `emails webhook
// listen` (`src/cli/commands/email-log.local.ts`) already wraps the call and surfaces it
// through `handleError`, which exits non-zero. `emails serve --webhook-port` / `--all`
// (`src/cli/commands/serve.local.ts`) did NOT, and an unhandled rejection there would have
// taken down an HTTP server that had already bound successfully — so that one call is
// wrapped, reports the reason, and marks the process failed while leaving the listeners that
// DID start running. `src/index.ts` re-exports the function transparently and the break is
// recorded at the export site. Neither `*.remote.*` CLI arm reaches this module at all:
// `serve.remote.ts` has no webhook option, and `email-log.remote.ts:624` refuses
// `emails webhook listen` through its own server-side guard.
//
// ─── WHY THIS WRITES THROUGH `db/events.local.ts` AND NOT THE `db/events` FACADE ───────
//
// Deliberate, and it is the gate above that makes it honest: the gate has already
// established that this installation's mail is in local SQLite, so the local arm is the
// implementation that matches the established fact. Reaching for the family facade instead
// would dispatch on the very axis being deleted, and would — in the one configuration where
// the deployment word and the storage settings disagree — send the event over HTTP to a
// service that is already receiving the same callback directly. That is a behaviour change
// dressed as a cleanup. When `src/db/events` collapses, this import follows it and needs no
// edit here.
//
// ─── INHERITED DEFECT, NAMED AND NOT FIXED ────────────────────────────────────────────
//
// The in-memory replay-suppression set is CONSULTED on the Resend path only, and WRITTEN on
// both. An SNS `MessageId` is added to it after every newly-created event and never read, so
// a busy SES installation spends the shared 10,000-entry budget evicting exactly the Resend
// svix ids the set exists to remember. Correctness is unaffected — the partial unique index
// is the authoritative fence and catches every duplicate on both paths, which the suite
// proves for a repeated SNS delivery — so this is a cache that degrades under load rather
// than a data defect, and every fix is a choice between a per-path budget and a keyed cache.
// Recorded here rather than changed inside a collapse.
//
// ─── MUTATION SURVIVORS, EACH NAMED ───────────────────────────────────────────────────
//
// 48 mutants over this module and `src/cli/commands/serve.local.ts`, reverted one at a time:
// 42 killed, 6 survived. Five of the six are here (the sixth is recorded in that file), and
// none of them is "the test suite is thin" — each is a specific, stated reason:
//
//   * the API refusal NAMES THE SETTING TWICE, once to identify the configuration and once as
//     the remedy, and the assertion requires it once. Removing either mention alone is
//     invisible. Not closed, because asserting a mention count pins prose rather than
//     behaviour.
//   * `if (result.created)` on the replay-cache write. A persist that THROWS leaves for the
//     `catch` before reaching it, so its only observable effect is which 200-body a
//     re-delivery of an ALREADY-STORED envelope receives. Either choice is arbitrary; pinning
//     one would fix a detail rather than a behaviour.
//   * `Number.isFinite(declared)` on the declared body length. UNREACHABLE OVER HTTP, and
//     measured rather than argued: Bun's request parser answers its own 400 to
//     `Content-Length: 1e400`, to a 24-digit value and to `abc` before this handler runs, so
//     the handler can only ever see a decimal string, which `Number()` maps to a finite value.
//     The guard defends this function's own contract, not the transport.
//   * the 10,000-entry cache eviction bound. Observing it needs 10,001 distinct SIGNED
//     envelopes, and what it protects is memory rather than correctness.
//   * the `default:` arm of the colour helper. Unreachable — but a review found the reason this
//     comment first gave for that ("no event either parser can produce reaches it") to be FALSE,
//     and the correction is worth more than the survivor. `webhook-events.ts:57` and `:77` index
//     a PLAIN OBJECT LITERAL with `typeMap[body.type]`, so INHERITED keys escape the
//     `if (!eventType) return null` guard: measured directly, `type: "constructor"`,
//     `"toString"` and `"valueOf"` all yield an event whose `type` is a FUNCTION, and
//     `"__proto__"` yields one whose `type` is an object. The arm is still never reached, because
//     binding a function into the `events` row throws and the request becomes a 500 before the
//     console line — which is also the shape of the PRE-EXISTING DEFECT this exposes: a signed
//     payload naming a prototype key gets a permanent 500 and is retried by the provider forever,
//     where it should get the 200 "Unrecognized event type" that every other unknown type gets.
//     NOT FIXED HERE, and the reason is blast radius rather than doubt: the fix belongs in
//     `webhook-events.ts` (`Object.hasOwn`, or a null-prototype map), which is NOT part of this
//     family and is shared with the server-side receiver in `src/server/webhooks/receivers.ts`,
//     so changing it changes that receiver's behaviour too and wants its own change with its own
//     tests on both mounts.
//
// The two bounds on the body are NOT redundant and the suite now separates them, which it did
// not at first: removing the declared-length check left every case green, because the
// streaming check reached the same 413 by reading the payload it exists to avoid reading. A
// client that DECLARES an oversize and then sends nothing distinguishes them — without the
// declared check the reader waits for bytes that never arrive and the request hangs.

import { parseResendWebhook, parseSesWebhook, verifyResendSignature, verifySnsStructure } from "./webhook-events.js";
import type { WebhookEvent } from "./webhook-events.js";
import { snsMessageAllowed, snsPolicyFromEnv, verifyAwsSnsSignature } from "./sns-signature.js";
import { API_BASE_URL_SETTING } from "../store-resolution.js";
import { readStorageWiring } from "./storage-wiring.js";

export {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook-events.js";
export type { WebhookEvent } from "./webhook-events.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Refuse to stand up a receiver this installation cannot honour — or return, having
 * established that it can.
 *
 * Reads the storage configuration ONCE and throws, so the caller's failure arrives before a
 * port is bound rather than as a stream of 500s against a provider's finite retry budget.
 *
 * The two refusals are DIFFERENT faults and say so. The API one names the setting to unset,
 * read from the resolver's own constant rather than spelled here, so it cannot drift from
 * the setting that actually decided. The `unresolved` one is deliberately NOT phrased as a
 * contradiction: `readStorageWiring` lands there for two different faults — a configuration
 * that names two stores at once, and the unambiguous default whose data directory is refused
 * (an untrusted ancestor, a symlink) — and its own `message` says which, so this one only
 * has to say what it could not determine.
 */
function requireLocalEventStorage(): void {
  const wiring = readStorageWiring(process.env);
  switch (wiring.kind) {
    case "database_file":
    case "database_in_memory":
      return;
    case "api":
      throw new Error(
        "the durable provider webhook receiver runs where the mail is stored. This installation reads its mail "
          + `through an Emails API (${API_BASE_URL_SETTING}), so delivery-event callbacks are received and `
          + "persisted by that service and a listener started here would be unreachable by the provider and have "
          + `nowhere local to record what it received. Unset ${API_BASE_URL_SETTING} to run the receiver against `
          + "this machine's own database.",
      );
    case "unresolved":
      throw new Error(
        "the provider webhook receiver cannot start because it cannot tell where this installation's delivery "
          + `events would be stored: ${wiring.message}`,
      );
  }
}

async function readBoundedWebhookBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) throw new RangeError("webhook body too large");
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("webhook body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function colorEventType(type: string, chalk: typeof import("chalk").default): string {
  switch (type) {
    case "delivered": return chalk.green(type);
    case "bounced": return chalk.red(type);
    case "complained": return chalk.red(type);
    case "opened": return chalk.blue(type);
    case "clicked": return chalk.cyan(type);
    default: return type;
  }
}

export function createWebhookServer(
  port: number,
  providerId?: string,
  webhookSecret?: string,
  deps: { verifySns?: (body: Record<string, unknown>) => Promise<boolean> } = {},
) {
  // BEFORE the port is bound, and before anything is read. See the header: an installation
  // that cannot store the event must not accept the provider's delivery attempt.
  requireLocalEventStorage();

  const maxRememberedWebhookIds = 10_000;
  const seenWebhookIds = new Set<string>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let event: WebhookEvent | null = null;
      let bodyText: string;
      let body: any;

      try {
        bodyText = await readBoundedWebhookBody(req);
        body = JSON.parse(bodyText);
      } catch (error) {
        if (error instanceof RangeError) return new Response("Payload too large", { status: 413 });
        return new Response("Invalid JSON", { status: 400 });
      }

      if (url.pathname === "/webhook/resend") {
        if (!webhookSecret) return new Response("Resend webhook secret is not configured", { status: 503 });
        const webhookId = req.headers.get("svix-id");
        if (!webhookId) return new Response("Resend svix-id is required", { status: 400 });
        const headers: Record<string, string | null> = {
          "svix-id": webhookId,
          "svix-timestamp": req.headers.get("svix-timestamp"),
          "svix-signature": req.headers.get("svix-signature"),
        };
        const valid = await verifyResendSignature(bodyText, headers, webhookSecret).catch(() => false);
        if (!valid) return new Response("Invalid signature", { status: 401 });
        if (seenWebhookIds.has(webhookId)) return new Response("Webhook already processed", { status: 200 });
        event = parseResendWebhook(body, webhookId);
      } else if (url.pathname === "/webhook/ses") {
        if (!verifySnsStructure(body)) return new Response("Invalid SNS payload", { status: 400 });
        let policy;
        try { policy = snsPolicyFromEnv(); } catch { return new Response("SNS allowlist is not configured", { status: 503 }); }
        if (!snsMessageAllowed(body, policy)) return new Response("SNS topic or account is not allowed", { status: 401 });
        if (!(await (deps.verifySns ?? verifyAwsSnsSignature)(body).catch(() => false))) return new Response("Invalid SNS signature", { status: 401 });
        const snsMessageId = typeof body.MessageId === "string" ? body.MessageId : "";
        if (!snsMessageId) return new Response("SNS MessageId is required", { status: 400 });
        let inner: unknown = body;
        if (body.Type === "Notification" && typeof body.Message === "string") {
          try { inner = JSON.parse(body.Message); } catch { return new Response("Invalid SNS Message", { status: 400 }); }
        }
        event = parseSesWebhook(inner, snsMessageId);
      } else {
        return new Response("Not found", { status: 404 });
      }

      if (!event) {
        return new Response("Unrecognized event type", { status: 200 });
      }

      // Durable persistence must be associated with an explicit provider.
      if (!providerId) return new Response("A provider id is required for durable webhook persistence", { status: 503 });
      const pId = providerId;

      try {
        const [{ getDatabase }, { upsertEventWithResult }] = await Promise.all([
          import("../db/database.js"),
          import("../db/events.local.js"),
        ]);
        const result = upsertEventWithResult(
          {
            provider_id: pId,
            provider_event_id: event.provider_event_id,
            type: event.type,
            recipient: event.recipient || null,
            metadata: event.metadata || {},
            occurred_at: event.occurred_at,
          },
          getDatabase(),
        );
        if (result.created) {
          const webhookId = req.headers.get("svix-id") ?? event.provider_event_id;
          seenWebhookIds.add(webhookId);
          if (seenWebhookIds.size > maxRememberedWebhookIds) {
            const oldest = seenWebhookIds.values().next().value;
            if (oldest) seenWebhookIds.delete(oldest);
          }
        }
      } catch {
        return new Response("Webhook persistence failed", { status: 500 });
      }

      const timestamp = new Date().toLocaleTimeString();
      const { default: chalk } = await import("chalk");
      console.log(
        `${chalk.gray(`[${timestamp}]`)} ${colorEventType(event.type, chalk)}  ${event.recipient || "unknown"}  ${chalk.dim(event.provider_event_id.slice(0, 12))}`,
      );

      return new Response("OK", { status: 200 });
    },
  });

  return server;
}
