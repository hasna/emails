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
//    surface is `create(input)` and `update(id, patch)`. The receiver's write is an UPSERT
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
// different settings. Every configuration in which the answer moved:
//
// | configuration                                | main                                      | now                         |
// |----------------------------------------------|-------------------------------------------|-----------------------------|
// | API storage, deployment word unset           | BOUND a listener and wrote events into a  | refuses, names the setting  |
// |                                              | freshly CREATED, empty local SQLite file  |                             |
// | word says local, stale API pointer exported  | as above                                  | refuses, names the setting  |
// | both database-path settings, different files | ran on the documented precedence          | refuses as a contradiction  |
// | storage resolves, data directory unsafe      | bound, then 500 on every callback         | refuses at construction     |
// | word says server-side, NO storage setting    | THREW                                     | RUNS the receiver           |
//
// The first three CONVERGE with the families that already collapsed and already refuse
// there (`src/db/forwarding`, `src/lib/forwarding`, `src/lib/status-facts`). The fourth is a
// strict improvement in the direction that matters for a webhook: on main the port was
// bound, so callbacks were ACCEPTED and then dropped one 500 at a time until the provider's
// retry budget ran out and the events were lost for good; refusing to start leaves them
// queued at the provider. The fifth is the mirror image of the first three and is the one to
// read twice — a listener now starts where it previously threw. It is the correct answer for
// that configuration (an unset storage setting IS a local SQLite installation, which is what
// `planEmailStore` resolves), and it is the configuration the axis deletion removes.
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
