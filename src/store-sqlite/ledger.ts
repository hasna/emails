// The two families this store REFUSES, in full.
//
// Both are declared unavailable, and that makes every operation below a
// one-line refusal. Three things about that are deliberate:
//
// 1. EVERY METHOD IS WRITTEN OUT. There is no base object, no `Proxy`, no
//    generated map of names, and nothing spread in. That is the same rule the
//    seam enforces on itself: with no shared parent, `tsc` turns a method that
//    the interface gains and this file forgets into a build error instead of an
//    inherited answer nobody wrote.
//
// 2. THE REFUSAL NAMES ITS OWN CAPABILITY. `markSendBlocked` and
//    `evaluateOutboundPolicy` sit on the send-intent repository but are gated on
//    `outboundPolicy`, not on `sendIntentLedger`, and they refuse accordingly —
//    a blanket "this store cannot do send intents" would be a different, wrong
//    answer, and the conformance harness checks the distinction.
//
// 3. NOTHING HERE RETURNS AN EMPTY VALUE. `listUncertainSendIntents` does not
//    return `[]`. That would be indistinguishable from "there are no uncertain
//    intents", which is exactly the lie this program exists to delete: a
//    reconciliation sweep reading `[]` from a store with no ledger concludes
//    everything is settled.
//
// WHY THEY ARE FALSE
//
// `sendIntentLedger` — the fence is the point, and this schema has none of it:
// no reserve/claim/complete/fail state machine, no lease, no tombstone, no
// reconciliation record. The `emails.idempotency_key` unique index is a
// duplicate-insert guard, not a ledger: nothing marks an intent as claimed, so
// two senders can both read "not sent yet" and both send. Refusing the send is
// strictly better than mailing the message twice.
//
// `attachmentRepair` — repair rewrites stored payload bytes under a lease and
// records the outcome in a ledger. There are no run or entry tables here, no
// lease column, and (see the `attachmentContent` refusal) no stored payload bytes
// to rewrite. A store that cannot hold the lease must not perform the rewrite.

import type { Outcome } from "../store/outcome.js";
import type {
  MessageInput,
  MessageRecord,
  OutboundPolicyCode,
  OutboundPolicyDecision,
  OutboundPolicyInput,
  ListOptions,
  ResourceInput,
  ResourceRow,
  SendIntentCancellationResult,
  SendIntentLookupResult,
} from "../store/records.js";
import type { AttachmentRepairRepository, SendIntentsRepository } from "../store/repositories.js";
import { unavailable } from "./outcome.js";

export function createSendIntentsRepository(): SendIntentsRepository {
  return {
    async lookupSendIntent(_key: string): Promise<Outcome<SendIntentLookupResult>> {
      return unavailable("sendIntentLedger");
    },

    async reserveSendIntent(_key: string, _input: MessageInput): Promise<Outcome<MessageRecord>> {
      return unavailable("sendIntentLedger");
    },

    async claimSendIntent(_id: string): Promise<Outcome<MessageRecord | null>> {
      return unavailable("sendIntentLedger");
    },

    async completeSendIntent(_id: string, _providerMessageId: string): Promise<Outcome<MessageRecord>> {
      return unavailable("sendIntentLedger");
    },

    async markSendFailed(_id: string, _reason: string): Promise<Outcome<MessageRecord | null>> {
      return unavailable("sendIntentLedger");
    },

    async cancelSendIntent(_key: string): Promise<Outcome<SendIntentCancellationResult>> {
      return unavailable("sendIntentLedger");
    },

    async listUncertainSendIntents(_opts?: ListOptions): Promise<Outcome<MessageRecord[]>> {
      return unavailable("sendIntentLedger");
    },

    async markSendUncertain(_id: string, _providerMessageId?: string | null): Promise<Outcome<MessageRecord | null>> {
      return unavailable("sendIntentLedger");
    },

    async rearmFailedSendIntent(_id: string): Promise<Outcome<MessageRecord | null>> {
      return unavailable("sendIntentLedger");
    },

    async reconcileUncertainSendIntent(_id: string, _evidence: string): Promise<Outcome<MessageRecord | null>> {
      return unavailable("sendIntentLedger");
    },

    async markSendBlocked(_id: string, _reason: OutboundPolicyCode): Promise<Outcome<MessageRecord | null>> {
      // Gated on `outboundPolicy`: recording WHY a send was blocked is part of
      // evaluating policy, not part of the ledger.
      return unavailable("outboundPolicy");
    },

    async evaluateOutboundPolicy(_input: OutboundPolicyInput): Promise<Outcome<OutboundPolicyDecision>> {
      // The double discriminant matters here. The OUTER answer says whether the
      // store could evaluate the policy; the inner one would say whether the
      // policy allows the send. This store cannot evaluate, so it refuses the
      // outer one — it must never allow the inner one, because "no policy
      // configured" and "policy passed" are different facts and conflating them is
      // how an unverified sender gets through.
      return unavailable("outboundPolicy");
    },
  };
}

export function createAttachmentRepairRepository(): AttachmentRepairRepository {
  return {
    async createOrGetAttachmentRepairRun(_input: ResourceInput): Promise<Outcome<ResourceRow>> {
      return unavailable("attachmentRepair");
    },

    async getAttachmentRepairRun(_runId: string): Promise<Outcome<ResourceRow | null>> {
      return unavailable("attachmentRepair");
    },

    async listPendingAttachmentRepairEntries(_runId: string, _limit?: number): Promise<Outcome<ResourceRow[]>> {
      return unavailable("attachmentRepair");
    },

    async claimAttachmentRepairEntry(_runId: string, _entryId: string): Promise<Outcome<ResourceRow | null>> {
      return unavailable("attachmentRepair");
    },

    async recordAttachmentRepairEntryOutcome(_entryId: string, _result: ResourceInput): Promise<Outcome<ResourceRow>> {
      return unavailable("attachmentRepair");
    },
  };
}
