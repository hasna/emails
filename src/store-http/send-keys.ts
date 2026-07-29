// Scoped send keys, over `/v1`.
//
// TWO OPERATIONS ARE NOT WHAT THEY LOOK LIKE:
//
// `revokeSendKey` HAS NO ROUTE. The service exposes mint and verify as bespoke
// operations but revocation only through the generic resource write, so this is a
// `PATCH /v1/send-keys/{id}` stamping `revoked_at` — which means the REVOCATION
// INSTANT COMES FROM THIS CLIENT'S CLOCK rather than the service's. That is a real
// weakness and it is in the missing-route list in index.ts: under clock skew the
// stamp can sit slightly before or after the true instant, and a revocation audit
// reads a client's time as if it were the server's. A `POST /v1/send-keys/{id}/revoke`
// would fix it. It is still preferable to the alternative — DELETE removes the row,
// so the key's existence and its revocation become indistinguishable, and a revoked
// key must remain readable to be auditable.
//
// `isOwnerAuthorizedFrom` REFUSES. `POST /v1/send-keys/verify` does answer an
// `authorized` field, but only for a TOKEN it was handed — it cannot answer the
// question this operation asks, which is about an OWNER ID and carries no token. The
// capability is `outboundPolicy` and it is false, so the refusal is the only legal
// answer; returning `false` would report "this owner may not send" for an owner who
// may, and returning `true` is worse.

import type { SendKeysRepository } from "../store/repositories.js";
import type { Outcome } from "../store/outcome.js";
import type { ListOptions, MintedSendKey, SendKeyRecord } from "../store/records.js";
import { asArrayOf, asRecord, envelope, sendKeyRecord } from "./mapping.js";
import { ok, refusalForStatus, unavailable } from "./outcome.js";
import type { Transport } from "./wire.js";

export function createSendKeysRepository(transport: Transport): SendKeysRepository {
  return {
    async listSendKeys(opts?: ListOptions): Promise<Outcome<SendKeyRecord[]>> {
      const answer = await transport.request("GET", "/send-keys", {
        query: { limit: opts?.limit, offset: opts?.offset },
      });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listSendKeys");
      // A generic resource list: `{ items: [...] }`, unlike the bespoke mint route.
      const rows = asArrayOf(envelope(answer.body, "items", "listSendKeys"), "listSendKeys");
      return ok(rows.map((row) => sendKeyRecord(row, "listSendKeys")));
    },

    async getSendKey(id: string): Promise<Outcome<SendKeyRecord | null>> {
      const answer = await transport.request("GET", `/send-keys/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getSendKey");
      // A generic resource read answers with a BARE row.
      return ok(sendKeyRecord(answer.body, "getSendKey"));
    },

    async mintSendKey(input: { owner_id: string; label?: string | null }): Promise<Outcome<MintedSendKey>> {
      const body: Record<string, unknown> = { owner_id: input.owner_id };
      if (input.label !== undefined) body["label"] = input.label;
      const answer = await transport.request("POST", "/send-keys/mint", { body });
      if (answer.status !== 201) return refusalForStatus(answer.status, answer.body, "mintSendKey");
      // Unwrapped: `{ token, key }` rather than an envelope.
      const minted = asRecord(answer.body, "mintSendKey");
      const token = minted["token"];
      if (typeof token !== "string" || token.length === 0) {
        return refusalForStatus(200, answer.body, "mintSendKey: the response carries no plaintext token");
      }
      return ok({ token, key: sendKeyRecord(minted["key"], "mintSendKey") });
    },

    async verifySendKey(token: string): Promise<Outcome<SendKeyRecord | null>> {
      const answer = await transport.request("POST", "/send-keys/verify", { body: { token } });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "verifySendKey");
      const verdict = asRecord(answer.body, "verifySendKey");
      // `valid: false` is the service's answer for an unknown, malformed OR revoked
      // token, which is exactly the null the seam documents. It is a real verdict from
      // the service, not this store's interpretation of a missing field.
      if (verdict["valid"] !== true) return ok(null);
      return ok(sendKeyRecord(verdict["key"], "verifySendKey"));
    },

    /** NO dedicated route; see the header note on the client-supplied instant. */
    async revokeSendKey(id: string): Promise<Outcome<SendKeyRecord | null>> {
      // READ BEFORE WRITE, so a repeat revoke is a no-op rather than a rewrite. The
      // generic PATCH persists whatever `revoked_at` it is sent, so revoking an
      // already-revoked key would stamp a SECOND, later instant over the first — and
      // the revocation instant is an audit fact with exactly one true value. The
      // SQLite arm writes it `WHERE revoked_at IS NULL`; skipping the PATCH is this
      // arm's equivalent. (Two revokes racing between the read and the write can
      // still both PATCH — the atomic conditional write this route lacks is part of
      // the missing-route note in index.ts, beside the clock-skew weakness.)
      const read = await transport.request("GET", `/send-keys/${encodeURIComponent(id)}`);
      if (read.status === 404) return ok(null);
      if (read.status !== 200) return refusalForStatus(read.status, read.body, "revokeSendKey");
      const current = sendKeyRecord(read.body, "revokeSendKey");
      if (current.revoked_at !== null) return ok(current);
      const answer = await transport.request("PATCH", `/send-keys/${encodeURIComponent(id)}`, {
        body: { revoked_at: new Date().toISOString() },
      });
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "revokeSendKey");
      return ok(sendKeyRecord(answer.body, "revokeSendKey"));
    },

    /** Capability `outboundPolicy` is FALSE; see the header note. */
    async isOwnerAuthorizedFrom(ownerId: string, fromEmail: string): Promise<Outcome<boolean>> {
      void ownerId;
      void fromEmail;
      return unavailable("outboundPolicy");
    },
  };
}
