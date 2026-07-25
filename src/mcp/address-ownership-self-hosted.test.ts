// The five address-ownership MCP tools are NOT local-state tools: they read and
// write through `src/db/owners.ts`, which routes to `/v1/owners`,
// `/v1/addresses/<id>` (owner_id/administrator_id) and
// `/v1/address-ownership-events` in self_hosted mode. These tests drive the REAL
// tool handlers against the out-of-process /v1 stub (src/test-support/v1-stub.ts)
// to prove they work there rather than refusing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createAddress } from "../db/addresses.js";
import { createOwner } from "../db/owners.js";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { runDomainTool } from "./tools/domains-impl.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

function parseResult<T>(result: { content: Array<{ text: string }>; isError?: boolean }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

interface OwnershipDetail {
  address: { id: string; email: string; owner: { id: string; name: string; type: string } | null; administrator: { id: string; name: string } | null };
  ownership: { owner_id: string; owner_type: string; administrator_id: string } | null;
  history: Array<{ action: string; reason: string | null }>;
}

function seedOwnedAddress() {
  const address = createAddress({ provider_id: "prov-1", email: "svc@example.com" });
  const human = createOwner({ type: "human", name: "ada" });
  const agent = createOwner({ type: "agent", name: "ops-bot" });
  return { address, human, agent };
}

describe("MCP address-ownership tools in self_hosted mode", () => {
  it("set_address_owner writes ownership through /v1", async () => {
    const { address, human, agent } = seedOwnedAddress();

    const result = await runDomainTool("set_address_owner", { address: "svc@example.com", owner: "ada", administrator: "ops-bot" });

    expect(result.isError).toBeFalsy();
    expect(parseResult<OwnershipDetail>(result)).toMatchObject({
      address: { email: "svc@example.com", owner: { id: human.id, name: "ada" }, administrator: { id: agent.id, name: "ops-bot" } },
      ownership: { owner_id: human.id, owner_type: "human", administrator_id: agent.id },
    });
    const stored = (await stub.list("addresses")).find((a) => a["id"] === address.id);
    expect(stored).toMatchObject({ owner_id: human.id, administrator_id: agent.id });
  });

  it("get_address_owner reads ownership through /v1", async () => {
    const { human, agent } = seedOwnedAddress();
    await runDomainTool("set_address_owner", { address: "svc@example.com", owner: "ada", administrator: "ops-bot" });

    const result = await runDomainTool("get_address_owner", { address: "svc@example.com" });

    expect(result.isError).toBeFalsy();
    expect(parseResult<OwnershipDetail>(result)).toMatchObject({
      address: { owner: { id: human.id }, administrator: { id: agent.id } },
      ownership: { owner_id: human.id, administrator_id: agent.id },
    });
  });

  it("transfer_address_owner records the transfer and its audit event", async () => {
    seedOwnedAddress();
    const successor = createOwner({ type: "agent", name: "successor-bot" });
    await runDomainTool("set_address_owner", { address: "svc@example.com", owner: "ada", administrator: "ops-bot" });

    const result = await runDomainTool("transfer_address_owner", { address: "svc@example.com", owner: "successor-bot", reason: "handoff" });

    expect(result.isError).toBeFalsy();
    expect(parseResult<OwnershipDetail>(result)).toMatchObject({
      ownership: { owner_id: successor.id, owner_type: "agent", administrator_id: successor.id },
    });
    const events = await stub.list("address-ownership-events");
    expect(events.find((e) => e["action"] === "transfer")).toMatchObject({ reason: "handoff", actor: "mcp" });
  });

  it("unassign_address_owner clears ownership through /v1", async () => {
    const { address } = seedOwnedAddress();
    await runDomainTool("set_address_owner", { address: "svc@example.com", owner: "ada", administrator: "ops-bot" });

    const result = await runDomainTool("unassign_address_owner", { address: "svc@example.com", reason: "retired" });

    expect(result.isError).toBeFalsy();
    expect(parseResult<OwnershipDetail>(result)).toMatchObject({ address: { owner: null, administrator: null }, ownership: null });
    const stored = (await stub.list("addresses")).find((a) => a["id"] === address.id);
    expect(stored?.["owner_id"] ?? null).toBeNull();
  });

  it("list_address_owner_history returns the audit trail newest first", async () => {
    seedOwnedAddress();
    await runDomainTool("set_address_owner", { address: "svc@example.com", owner: "ada", administrator: "ops-bot" });
    await runDomainTool("unassign_address_owner", { address: "svc@example.com", reason: "retired" });

    const result = await runDomainTool("list_address_owner_history", { address: "svc@example.com" });

    expect(result.isError).toBeFalsy();
    const history = parseResult<{ history: Array<{ action: string; reason: string | null }> }>(result).history;
    expect(history.map((e) => e.action)).toEqual(["unassign", "assign"]);
    expect(history[0]).toMatchObject({ reason: "retired" });
  });

  it("reports a real not-found error rather than a mode refusal", async () => {
    const result = await runDomainTool("get_address_owner", { address: "missing@example.com" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("Address not found");
    expect(result.content[0]?.text ?? "").not.toContain("self_hosted API-only mode");
  });
});
