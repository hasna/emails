// Domains, addresses, address lifecycle and provisioning, over `/v1`.
//
// THREE OPERATIONS HERE HAVE NO ROUTE OF THEIR OWN and are COMPOSED from routes
// that do exist. Composition is not the same thing as faking, and the line between
// them is worth stating because this file sits on both sides of it:
//
//   * `suspendAddress` / `activateAddress` / `setAddressQuota` are composed as a
//     `PATCH /v1/addresses/{id}` with the field the operation names. The write really
//     happens, the service really persists it, and the answer is the service's own
//     updated row. The only thing missing is a dedicated verb.
//   * `getDomainByName` is composed as a PAGED SCAN of `GET /v1/domains`, because that
//     route accepts no name filter. It really answers the question, at a cost the
//     comment below states plainly.
//
// Neither returns a value this store made up, which is the test. Contrast the
// operations in ledger.ts, which cannot be composed from anything and therefore
// refuse.

import type {
  AddressLifecycleRepository,
  AddressesRepository,
  DomainsRepository,
  ProvisioningRepository,
} from "../store/repositories.js";
import type {
  AddressInput,
  AddressOwnershipPatch,
  AddressPatch,
  AddressProvisioningPatch,
  AddressRecord,
  AddressSendability,
  DomainInput,
  DomainPatch,
  DomainProvisioningPatch,
  DomainRecord,
  ListOptions,
  ResourceInput,
  ResourceRow,
} from "../store/records.js";
import type { Outcome } from "../store/outcome.js";
import { addressRecord, asArrayOf, domainRecord, envelope } from "./mapping.js";
import { invalidInput, ok, refusalForStatus, unavailable } from "./outcome.js";
import type { ResourceGateway } from "./resources.js";
import type { QueryValue, Transport } from "./wire.js";

/** The service's list ceiling (`limit` is clamped to 500, `offset` to 100000). */
const MAX_PAGE = 500;
const MAX_OFFSET = 100_000;

function listQuery(opts: ListOptions | undefined): Record<string, QueryValue> {
  return { limit: opts?.limit, offset: opts?.offset };
}

/** Drop the keys a caller left undefined so an absent field stays absent on the wire. */
function present(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

export function createDomainsRepository(transport: Transport): DomainsRepository {
  return {
    async listDomains(opts?: ListOptions): Promise<Outcome<DomainRecord[]>> {
      const answer = await transport.request("GET", "/domains", { query: listQuery(opts) });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listDomains");
      const rows = asArrayOf(envelope(answer.body, "domains", "listDomains"), "listDomains");
      return ok(rows.map((row) => domainRecord(row, "listDomains")));
    },

    async getDomain(id: string): Promise<Outcome<DomainRecord | null>> {
      const answer = await transport.request("GET", `/domains/${encodeURIComponent(id)}`);
      // Absence is a VALUE here: the seam declares `DomainRecord | null`.
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getDomain");
      return ok(domainRecord(envelope(answer.body, "domain", "getDomain"), "getDomain"));
    },

    /**
     * NO ROUTE: `GET /v1/domains` accepts `limit`/`offset` and no filters, so a
     * name lookup is a paged scan.
     *
     * It is O(domains) per call, which is the honest cost of the missing filter and is
     * recorded in the missing-route list in index.ts. It is NOT allowed to degrade into
     * "check the first page and answer null", which would report an unregistered domain
     * for any tenant holding more than one page of them — the plausible-wrong-answer
     * failure, reintroduced by an optimisation.
     */
    async getDomainByName(domain: string): Promise<Outcome<DomainRecord | null>> {
      const wanted = domain.toLowerCase();
      for (let offset = 0; offset <= MAX_OFFSET; offset += MAX_PAGE) {
        const answer = await transport.request("GET", "/domains", {
          query: { limit: MAX_PAGE, offset },
        });
        if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getDomainByName");
        const rows = asArrayOf(envelope(answer.body, "domains", "getDomainByName"), "getDomainByName");
        for (const row of rows) {
          const record = domainRecord(row, "getDomainByName");
          if (record.domain.toLowerCase() === wanted) return ok(record);
        }
        // A short page is the last page. Only a FULL page can be followed by another.
        if (rows.length < MAX_PAGE) return ok(null);
      }
      // THE SCAN RAN OUT OF REACH, WHICH IS NOT THE SAME AS "NO SUCH DOMAIN".
      //
      // The service clamps `offset` at 100000, so a tenant holding more domains than that
      // has rows this scan cannot address. An earlier version answered `ok(null)` here —
      // reporting a domain unregistered because the CLIENT gave up looking, which is the
      // plausible-wrong-answer failure the doc comment above forbids, reintroduced at the
      // ceiling instead of at the first page. Adversarial review caught it.
      //
      // `clearInboundEmails` gets the analogous case right by refusing, and so does this:
      // a caller told "I could not finish looking" can act on it, and a caller told "it
      // does not exist" cannot.
      return invalidInput(
        `getDomainByName: scanned ${MAX_OFFSET} domains without finding ${domain} and the ` +
          "service's offset ceiling allows no further pages, so absence cannot be established; " +
          "this lookup needs a name filter on GET /v1/domains",
      );
    },

    async createDomain(input: DomainInput): Promise<Outcome<DomainRecord>> {
      const answer = await transport.request("POST", "/domains", {
        body: present({
          domain: input.domain,
          status: input.status,
          provider: input.provider,
          verified: input.verified,
          notes: input.notes,
        }),
      });
      if (answer.status !== 201) return refusalForStatus(answer.status, answer.body, "createDomain");
      return ok(domainRecord(envelope(answer.body, "domain", "createDomain"), "createDomain"));
    },

    async updateDomain(id: string, patch: DomainPatch): Promise<Outcome<DomainRecord | null>> {
      const answer = await transport.request("PATCH", `/domains/${encodeURIComponent(id)}`, {
        body: present({
          status: patch.status,
          provider: patch.provider,
          verified: patch.verified,
          notes: patch.notes,
        }),
      });
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "updateDomain");
      return ok(domainRecord(envelope(answer.body, "domain", "updateDomain"), "updateDomain"));
    },

    async deleteDomain(id: string): Promise<Outcome<boolean>> {
      const answer = await transport.request("DELETE", `/domains/${encodeURIComponent(id)}`);
      // Absence is a VALUE: the seam declares `boolean`, and a second delete of the
      // same row must report false rather than refusing.
      if (answer.status === 404) return ok(false);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "deleteDomain");
      return ok(true);
    },
  };
}

/**
 * The address PATCH body, shared by every operation that writes an address.
 *
 * `daily_quota` is sent when the caller set `dailyQuotaSet` OR supplied a value, and
 * omitted otherwise — the same rule store-sqlite's `updateAddress` applies, and the
 * one the service reads (`parseDailyQuota` treats the key's PRESENCE as the signal).
 * Omitting it preserves the stored quota; sending null clears it. Collapsing the two
 * is how an explicit clear silently becomes a no-op.
 */
function addressPatchBody(patch: AddressPatch): Record<string, unknown> {
  const body = present({
    display_name: patch.display_name,
    status: patch.status,
    verified: patch.verified,
  });
  if (patch.dailyQuotaSet || patch.daily_quota !== undefined) {
    body["daily_quota"] = patch.daily_quota ?? null;
  }
  return body;
}

async function patchAddress(
  transport: Transport,
  id: string,
  body: Record<string, unknown>,
  what: string,
): Promise<Outcome<AddressRecord | null>> {
  const answer = await transport.request("PATCH", `/addresses/${encodeURIComponent(id)}`, { body });
  if (answer.status === 404) return ok(null);
  if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, what);
  return ok(addressRecord(envelope(answer.body, "address", what), what));
}

export function createAddressesRepository(transport: Transport): AddressesRepository {
  return {
    async listAddresses(opts?: ListOptions): Promise<Outcome<AddressRecord[]>> {
      const answer = await transport.request("GET", "/addresses", { query: listQuery(opts) });
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "listAddresses");
      const rows = asArrayOf(envelope(answer.body, "addresses", "listAddresses"), "listAddresses");
      return ok(rows.map((row) => addressRecord(row, "listAddresses")));
    },

    async getAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      const answer = await transport.request("GET", `/addresses/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "getAddress");
      return ok(addressRecord(envelope(answer.body, "address", "getAddress"), "getAddress"));
    },

    async createAddress(input: AddressInput): Promise<Outcome<AddressRecord>> {
      const answer = await transport.request("POST", "/addresses", {
        body: present({
          email: input.email,
          display_name: input.display_name,
          status: input.status,
          verified: input.verified,
          daily_quota: input.daily_quota,
        }),
      });
      if (answer.status !== 201) return refusalForStatus(answer.status, answer.body, "createAddress");
      return ok(addressRecord(envelope(answer.body, "address", "createAddress"), "createAddress"));
    },

    async updateAddress(id: string, patch: AddressPatch): Promise<Outcome<AddressRecord | null>> {
      return patchAddress(transport, id, addressPatchBody(patch), "updateAddress");
    },

    async deleteAddress(id: string): Promise<Outcome<boolean>> {
      const answer = await transport.request("DELETE", `/addresses/${encodeURIComponent(id)}`);
      if (answer.status === 404) return ok(false);
      if (answer.status !== 200) return refusalForStatus(answer.status, answer.body, "deleteAddress");
      return ok(true);
    },
  };
}

export function createAddressLifecycleRepository(transport: Transport): AddressLifecycleRepository {
  return {
    /** NO ROUTE of its own; composed as the status write it is. */
    async suspendAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      return patchAddress(transport, id, { status: "suspended" }, "suspendAddress");
    },

    /** NO ROUTE of its own; composed as the status write it is. */
    async activateAddress(id: string): Promise<Outcome<AddressRecord | null>> {
      return patchAddress(transport, id, { status: "active" }, "activateAddress");
    },

    /**
     * NO ROUTE of its own; composed as the quota write it is. A null clears the limit,
     * and the service refuses a negative quota with a 400 that maps to
     * `invalid_input` — this store does NOT pre-validate it, because a second copy of
     * the service's validation rule would drift from the one that decides.
     */
    async setAddressQuota(id: string, dailyQuota: number | null): Promise<Outcome<AddressRecord | null>> {
      return patchAddress(transport, id, { daily_quota: dailyQuota }, "setAddressQuota");
    },

    async applyAddressOwnership(id: string, patch: AddressOwnershipPatch): Promise<Outcome<AddressRecord | null>> {
      const body: Record<string, unknown> = {};
      // `null` CLEARS an assignment and must be sent; only an ABSENT field is omitted, and
      // `undefined` counts as absent.
      //
      // This used to test `"owner_id" in patch` and then coerce with `?? null`, which made
      // `{ owner_id: undefined }` — legal TypeScript for an optional field, and what a
      // form handler produces from an unfilled input — into an explicit CLEAR. The SQLite
      // arm checks `!== undefined` and preserves, so the two implementations of one seam
      // operation disagreed on the same input, and this side silently UNASSIGNED an owner.
      // Ownership decides who may send as an address, which is why the service gates the
      // write behind an operator check; a silent unassignment there is not a small bug.
      // Adversarial review caught it, and the conformance case does not cover it: it
      // exercises a real id and an explicit null, never `undefined`.
      if (patch.owner_id !== undefined) body["owner_id"] = patch.owner_id;
      if (patch.administrator_id !== undefined) body["administrator_id"] = patch.administrator_id;
      return patchAddress(transport, id, body, "applyAddressOwnership");
    },

    /**
     * Capability `outboundPolicy` is FALSE for this store: there is NO `/v1` route
     * that answers whether an address may send. The one client that used to answer it
     * built the reply out of the address row and reported `sent_today: 0` — a made-up
     * number for a question about quota, which is exactly the failure the refusal
     * channel exists to replace.
     */
    async getAddressSendability(email: string): Promise<Outcome<AddressSendability>> {
      void email;
      return unavailable("outboundPolicy");
    },
  };
}

export function createProvisioningRepository(
  transport: Transport,
  provisioningEvents: ResourceGateway,
): ProvisioningRepository {
  return {
    async applyDomainProvisioning(id: string, patch: DomainProvisioningPatch): Promise<Outcome<DomainRecord | null>> {
      // The provisioning fields ride on the domain PATCH, which is where the service
      // reads them (`extractDomainProvisioning`). Only the keys the caller set are
      // sent: an absent key leaves the stored value alone, an explicit null clears it.
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) body[key] = value;
      }
      const answer = await transport.request("PATCH", `/domains/${encodeURIComponent(id)}`, { body });
      if (answer.status === 404) return ok(null);
      if (answer.status !== 200) {
        return refusalForStatus(answer.status, answer.body, "applyDomainProvisioning");
      }
      return ok(
        domainRecord(
          envelope(answer.body, "domain", "applyDomainProvisioning"),
          "applyDomainProvisioning",
        ),
      );
    },

    async applyAddressProvisioning(
      id: string,
      patch: AddressProvisioningPatch,
    ): Promise<Outcome<AddressRecord | null>> {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) body[key] = value;
      }
      return patchAddress(transport, id, body, "applyAddressProvisioning");
    },

    /** The provisioning-event log is the `/v1/provisioning` resource. */
    async recordProvisioningEvent(event: ResourceInput): Promise<Outcome<ResourceRow>> {
      return provisioningEvents.create(event);
    },

    async listProvisioningEvents(opts?: ListOptions): Promise<Outcome<ResourceRow[]>> {
      return provisioningEvents.list(opts);
    },
  };
}
