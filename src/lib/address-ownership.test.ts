import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createAddress } from "../db/addresses.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { createProvider } from "../db/providers.js";
import { getAddressOwnershipDetail, listEnrichedAddresses, resolveAddressRef } from "./address-ownership.js";

// Address ownership enrichment reads addresses/owners/providers via the /v1 API.
// NOTE on the self-hosted model: the self-hosted address record does NOT persist
// provider_id (addresses have no server-side provider association), so
// provider_name enrichment and provider-scoped listing are no longer meaningful
// here — the previous local-SQLite assertions for those validated removed
// behavior. What remains meaningful (and covered below) is owner/administrator
// hydration and address resolution by id/email.

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("address ownership enrichment", () => {
  it("hydrates owner and administrator for the address list", () => {
    const provider = createProvider({ name: "included", type: "sandbox" });
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "agent-admin" });
    const included = createAddress({ provider_id: provider.id, email: "human@example.com" });
    assignAddressOwner(included.id, human.id, agent.id);

    const addresses = listEnrichedAddresses();
    const found = addresses.find((a) => a.email === "human@example.com");

    expect(found).toBeDefined();
    expect(found).toMatchObject({
      id: included.id,
      email: "human@example.com",
      owner: { id: human.id, name: "human-user" },
      administrator: { id: agent.id, name: "agent-admin" },
    });
  });

  it("returns ownership detail with owner metadata for a single address", () => {
    const provider = createProvider({ name: "ops-provider", type: "sandbox" });
    const owner = createOwner({ type: "agent", name: "ops-agent" });
    const address = createAddress({ provider_id: provider.id, email: "ops@example.com" });
    assignAddressOwner(address.id, owner.id);

    const detail = getAddressOwnershipDetail(address.id);

    expect(detail.address.email).toBe("ops@example.com");
    expect(detail.address.owner?.name).toBe("ops-agent");
    expect(detail.ownership).toMatchObject({ owner_id: owner.id, owner_type: "agent" });
  });

  it("resolves an exact address id back to its address", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "direct@example.com" });

    expect(resolveAddressRef(address.id).email).toBe("direct@example.com");
  });

  it("resolves an address by its unique email", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "unique@example.com" });

    expect(resolveAddressRef("unique@example.com").email).toBe("unique@example.com");
  });

  it("throws for an unknown address ref", () => {
    expect(() => resolveAddressRef("nope@example.com")).toThrow(/Address not found/);
  });
});
