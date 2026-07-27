// The send-intent ledger and attachment repair: the two families this store REFUSES.
//
// Every method here returns the typed capability refusal. That is the whole file, and
// it is the most important file in the directory, so it says why in detail rather than
// leaving a reader to assume the work was skipped.
//
// WHY NOT PARTIAL SUPPORT — the temptation, and why it is wrong.
//
// The ledger is not entirely absent from `/v1`. FOUR of its twelve operations have
// routes: `POST /v1/messages/send-intents/lookup`, `.../cancel`, `.../reconcile` and
// `GET .../uncertain`. A store could wire those four and refuse the other eight. It
// must not, and the reason is the fence itself:
//
//   `reserveSendIntent` HAS NO ROUTE. Nothing on `/v1` records a send intent except
//   `POST /v1/messages/send`, which RESERVES AND THEN SENDS in one indivisible
//   operation — it dispatches real mail through a provider. So a store wired to the
//   four readable routes could look up, cancel and reconcile intents it can never
//   create. `claimSendIntent`, `completeSendIntent`, `markSendFailed`,
//   `markSendUncertain`, `rearmFailedSendIntent` and `markSendBlocked` have no routes
//   either: the service drives all six internally from that one send path.
//
// A ledger you can read but not write is not a ledger, and a capability declared TRUE
// on the strength of its read half would make `reserveSendIntent` — the operation that
// decides whether a message is sent once or twice — the one that refuses, at the exact
// moment a caller had been told the ledger was available. `sendIntentLedger` is
// therefore FALSE, and every operation in the family refuses uniformly. The seam says
// this outright: a non-atomic reserve hands one intent to two senders and mails the
// message twice, which is strictly worse than refusing to accept the send at all.
//
// ATTACHMENT REPAIR is the same shape with a different missing half.
// `POST /v1/attachments/repairs` and `.../{id}/resume` and `GET .../{id}` exist, so a
// run can be created and read — but the ENTRY operations have no routes at all:
// `listPendingAttachmentRepairEntries`, `claimAttachmentRepairEntry` and
// `recordAttachmentRepairEntryOutcome` are driven only inside the service's own page
// processor. Repair rewrites stored bytes under a lease; a client that can create a run
// but cannot claim an entry cannot hold the lease, and the seam is explicit that a
// store which cannot hold it must not perform the rewrite. The create route also takes
// a different shape from the seam's operation — it requires a full `entries` manifest
// and an idempotency key, where `createOrGetAttachmentRepairRun` takes a
// `ResourceInput` — so wiring it would need the seam's shape changed to match one
// server's body, which is the tail wagging the dog.
//
// `outboundPolicy` covers the two operations in this file that are about POLICY rather
// than the ledger: `markSendBlocked` records WHY a send was refused using a policy
// code, and `evaluateOutboundPolicy` is the evaluation itself. Neither has a route —
// policy is evaluated only inside `POST /v1/messages/send` and never exposed as a
// probe — and the seam's warning applies exactly: a store that cannot evaluate policy
// must refuse the send, never allow it, because "no policy configured" and "policy
// passed" are different facts.

import type { AttachmentRepairRepository, SendIntentsRepository } from "../store/repositories.js";
import type { Outcome } from "../store/outcome.js";
import type {
  ListOptions,
  MessageInput,
  MessageRecord,
  OutboundPolicyCode,
  OutboundPolicyDecision,
  OutboundPolicyInput,
  ResourceInput,
  ResourceRow,
  SendIntentCancellationResult,
  SendIntentLookupResult,
} from "../store/records.js";
import { unavailable } from "./outcome.js";

export function createSendIntentsRepository(): SendIntentsRepository {
  return {
    async lookupSendIntent(key: string): Promise<Outcome<SendIntentLookupResult>> {
      void key;
      return unavailable("sendIntentLedger");
    },

    async reserveSendIntent(key: string, input: MessageInput): Promise<Outcome<MessageRecord>> {
      void key;
      void input;
      return unavailable("sendIntentLedger");
    },

    async claimSendIntent(id: string): Promise<Outcome<MessageRecord | null>> {
      void id;
      return unavailable("sendIntentLedger");
    },

    async completeSendIntent(id: string, providerMessageId: string): Promise<Outcome<MessageRecord>> {
      void id;
      void providerMessageId;
      return unavailable("sendIntentLedger");
    },

    async markSendFailed(id: string, reason: string): Promise<Outcome<MessageRecord | null>> {
      void id;
      void reason;
      return unavailable("sendIntentLedger");
    },

    async cancelSendIntent(key: string): Promise<Outcome<SendIntentCancellationResult>> {
      void key;
      return unavailable("sendIntentLedger");
    },

    async listUncertainSendIntents(opts?: ListOptions): Promise<Outcome<MessageRecord[]>> {
      void opts;
      // An empty array here would tell a reconciliation sweep that nothing is
      // outstanding. That is the single most dangerous wrong answer in the family.
      return unavailable("sendIntentLedger");
    },

    async markSendUncertain(id: string, providerMessageId?: string | null): Promise<Outcome<MessageRecord | null>> {
      void id;
      void providerMessageId;
      return unavailable("sendIntentLedger");
    },

    async rearmFailedSendIntent(id: string): Promise<Outcome<MessageRecord | null>> {
      void id;
      return unavailable("sendIntentLedger");
    },

    async reconcileUncertainSendIntent(id: string, evidence: string): Promise<Outcome<MessageRecord | null>> {
      void id;
      void evidence;
      return unavailable("sendIntentLedger");
    },

    async markSendBlocked(id: string, reason: OutboundPolicyCode): Promise<Outcome<MessageRecord | null>> {
      void id;
      void reason;
      return unavailable("outboundPolicy");
    },

    async evaluateOutboundPolicy(input: OutboundPolicyInput): Promise<Outcome<OutboundPolicyDecision>> {
      void input;
      // Note the double discriminant the seam describes: this refusal says the store
      // could not EVALUATE the policy. It must never be answered with
      // `{ allowed: true }`, which would say the policy passed.
      return unavailable("outboundPolicy");
    },
  };
}

export function createAttachmentRepairRepository(): AttachmentRepairRepository {
  return {
    async createOrGetAttachmentRepairRun(input: ResourceInput): Promise<Outcome<ResourceRow>> {
      void input;
      return unavailable("attachmentRepair");
    },

    async getAttachmentRepairRun(runId: string): Promise<Outcome<ResourceRow | null>> {
      void runId;
      return unavailable("attachmentRepair");
    },

    async listPendingAttachmentRepairEntries(runId: string, limit?: number): Promise<Outcome<ResourceRow[]>> {
      void runId;
      void limit;
      return unavailable("attachmentRepair");
    },

    async claimAttachmentRepairEntry(runId: string, entryId: string): Promise<Outcome<ResourceRow | null>> {
      void runId;
      void entryId;
      return unavailable("attachmentRepair");
    },

    async recordAttachmentRepairEntryOutcome(entryId: string, result: ResourceInput): Promise<Outcome<ResourceRow>> {
      void entryId;
      void result;
      return unavailable("attachmentRepair");
    },
  };
}
